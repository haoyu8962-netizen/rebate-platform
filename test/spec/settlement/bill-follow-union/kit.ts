// B2-18 规则测试夹具（claude-independent，SPEC_REF 693f6a6）：BR-FUND-04 ④ 2026-11-21 改写、细则校验结果表第 2 行、
// 例 2；BR-FUND-01 R7、BR-CALC-02 / 10 / 15。联盟结算基数 B_settle 与分佣快照当前版本基数之差超过容差时，系统按
// R7 以联盟结算数据追加一个金额版本再校验一次：一致进批次候选、不登记差错单；仍不一致、重生成失败或端口未注入、
// 联盟结算佣金为 0 而快照基数 > 0 的告警工程、保持 WAITING、计入 settle_bills.amount_mismatch_count。
//
// 真实部件：PostgreSQL（@couli/db/testing，couli_app）；生产装配——app.module 在 worker 入口交给
// SettlementModule.forWorker 的端口（../worker/kit.ts capturedPorts，不另造），在 Nest 上下文里建出的 settle
// 处理器（真实账单任务、生产 readSource、saveBillValidations、批次执行器与 R5 入账）；后台入口
// （../admin-settle-commands/kit.ts withCommandsAdmin）的补充发起。
// 合成：订单行、order_keys、order_settlements、分佣快照 v1（commission_splits / 版本金额行 / 受益人事件）、用户、
// 规则版本、开关、后台账号、确认后的批次状态、维权扣减行；作业队列是记录器（../worker/kit.ts fakeQueue），
// 事件总线写 event_log；字段密钥是不解密的替身（本目录没有实名行）。没有真实用户数据。
//
// 本目录钉住的约定（任务书 §9.2；评审核对用）：
// - 重生成端口 BillJobDependencies.regenerateSnapshot（可选，类型在 apps/api/src/modules/settlement/bill/
//   regenerate.ts）：regenerate(trx, { appId, orderId, commissionVersion, settleCommissionFen, bSettleFen })
//   在出账 / 补充的同一事务里调用；
// - 告警工程：一条 pino error 级（50）结构化日志，alert = ALERT，带 app_id、bill_id、order_id；不带平台子订单号、
//   order_key 与受益人 user_id；
// - 新版本：版本号 = 当前最大版本 + 1，orders.commission_version 指向它；基数 = B_settle；受益人、角色与 v1
//   逐项相同；旧版本行不改不删；created_at 取注入的 Clock。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { splitCommission, type CommissionBeneficiary } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import { PostgresQueryCompiler, sql, type Kysely, type QueryId, type Selectable } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  FixedClock,
  createRootLogger,
  type EventBus,
  type JobHandler,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createPendingEarningsSource,
  type PendingEarningsDependencies,
} from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import {
  BEFORE,
  NOW,
  PERIOD,
  TIMEOUT,
  baseOf,
  shareOf,
  type SeededOrder,
  type SeededPerson,
} from '../credit/kit.ts';
import {
  BILL,
  EXECUTE,
  FAKE_CRYPTO,
  capturedPorts,
  fakeQueue,
  receivedJob,
  settleHandler,
  settlementModule,
  workerContext,
} from '../worker/kit.ts';

export { TIMEOUT };
export { creditKey, platformKey, platformLines, userCreditLines } from '../credit/kit.ts';

// ---------------------------------------------------------------------------------------------
// 连接池。

interface TestDatabaseLike {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/**
 * 一个测试库上的连接池：db 供夹具、断言与单个 worker；left / right / control 各一条连接（手写的并发事务、
 * 观察锁等待）；workerLeft / workerRight 是两个运行器各自的池（各 4 条连接）——生产装配的配置读（content 的
 * configValue）在出账事务之外另取一条连接，worker 跑在单连接池上会自锁，所以运行器不用 left / right。
 */
export interface Pools {
  readonly db: Kysely<DB>;
  readonly left: Kysely<DB>;
  readonly right: Kysely<DB>;
  readonly control: Kysely<DB>;
  readonly workerLeft: Kysely<DB>;
  readonly workerRight: Kysely<DB>;
}

/** 每个测试文件一个测试库。 */
export function databaseFixture(create: () => Promise<TestDatabaseLike>): Pools {
  let database: TestDatabaseLike | undefined;
  let pools: Pools | undefined;
  beforeAll(async () => {
    database = await create();
    const connectionString = database.urlFor('couli_app');
    pools = {
      db: createDb({ connectionString, max: 6 }),
      left: createDb({ connectionString, max: 1 }),
      right: createDb({ connectionString, max: 1 }),
      control: createDb({ connectionString, max: 1 }),
      workerLeft: createDb({ connectionString, max: 4 }),
      workerRight: createDb({ connectionString, max: 4 }),
    };
  }, TIMEOUT);
  afterAll(async () => {
    try {
      const open: Kysely<DB>[] = [];
      if (pools !== undefined) {
        open.push(pools.db, pools.left, pools.right, pools.control);
        open.push(pools.workerLeft, pools.workerRight);
      }
      await Promise.all(open.map((db) => destroyDb(db)));
    } finally {
      await database?.drop();
    }
  }, TIMEOUT);
  const get = (): Pools => {
    if (pools === undefined) throw new Error('bill-follow-union pools are not open');
    return pools;
  };
  return {
    get db() {
      return get().db;
    },
    get left() {
      return get().left;
    },
    get right() {
      return get().right;
    },
    get control() {
      return get().control;
    },
    get workerLeft() {
      return get().workerLeft;
    },
    get workerRight() {
      return get().workerRight;
    },
  };
}

/** 告警工程的固定标识（alert 字段）。 */
export const ALERT = 'settle_amount_mismatch_unresolved';
/** pino 的 error 级。 */
export const ERROR_LEVEL = 50;
export const TAOBAO = 'taobao';
/** 生产装配的账单日：2032-07-24（settle.bill_day 缺省 24），账单月 2032-06；Clock 在当日 10:00 +08:00。 */
export const BILL_DAY = '2032-07-24';
export const BILL_MONTH = PERIOD;

type Role = 'self' | 'share' | 'direct' | 'indirect';

export interface PersonSpec {
  readonly role: Role;
  readonly ratioBp: number;
}

/** 例 1 / 例 2 的受益人：自购 5000bp、直推 1000bp（预留 0）。 */
export const EXAMPLE_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
];

/** 自拟三方：自购 5000、直推 1000、间推 500（bp）。 */
export const THREE_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000 },
  { role: 'indirect', ratioBp: 500 },
];

// ---------------------------------------------------------------------------------------------
// 一个应用。

export interface App {
  readonly db: Kysely<DB>;
  readonly appId: string;
  readonly clock: FixedClock;
  /** 订单的 settle_period（= 账单月）。 */
  readonly period: string;
  /** 订单、快照与结算记录的写入时刻（早于出账）。 */
  readonly at: Date;
  readonly ruleVersionId: string;
}

export interface AppOptions {
  readonly appId?: string;
  readonly clock?: FixedClock;
  readonly period?: string;
  readonly at?: Date;
}

/** 一个应用与它的已发布规则版本；缺省 Clock 停在账单日 10:00 +08:00（资产快照已超时，可出账）。 */
export async function app(db: Kysely<DB>, options: AppOptions = {}): Promise<App> {
  const appId = options.appId ?? `bfu-${randomUUID()}`;
  const at = options.at ?? new Date(BEFORE);
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: at,
      indirect_enabled: true,
      created_at: at,
    })
    .execute();
  return {
    db,
    appId,
    clock: options.clock ?? new FixedClock(NOW),
    period: options.period ?? PERIOD,
    at,
    ruleVersionId,
  };
}

/** config_items 的一项（content 存的 JSON 值），已有则覆盖。 */
export async function setConfig(a: App, key: string, value: unknown): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${a.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value,
      version = app.config_items.version + 1`.execute(a.db);
}

/** credit.enabled.taobao = on。 */
export function creditOn(a: App): Promise<void> {
  return setConfig(a, `credit.enabled.${TAOBAO}`, true);
}

/** 一个会员（users 行）。 */
export async function user(a: App): Promise<string> {
  const id = randomUUID();
  await a.db
    .insertInto('users')
    .values({
      id,
      app_id: a.appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status: 'normal',
      register_method: 'phone',
    })
    .execute();
  return id;
}

/** 一个超管账号（确认批次的人）。 */
export async function admin(a: App): Promise<string> {
  const id = randomUUID();
  await a.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: a.appId,
      login_name: `bfu-${id}`,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  return id;
}

// ---------------------------------------------------------------------------------------------
// 订单。

export interface SettlementSpec {
  readonly seq: number;
  readonly source?: 'API' | 'STATEMENT';
  readonly fen: bigint;
}

export interface OrderSpec {
  /** 分佣快照 v1 取的 N（预估）；v1 基数 = BR-CALC-02 换算。 */
  readonly snapshotN: bigint;
  /** 联盟结算佣金（seq 1 的 STATEMENT 记录）；null：没有结算数据。 */
  readonly settleFen: bigint | null;
  /** 改写结算记录（优先于 settleFen）。 */
  readonly settlements?: readonly SettlementSpec[];
  readonly reserveBp?: number;
  readonly people?: readonly PersonSpec[];
  readonly hold?: boolean;
  readonly rightsPending?: boolean;
  readonly platform?: string;
  readonly subOrderId?: string;
}

export interface Seeded extends SeededOrder {
  readonly appId: string;
  readonly reserveBp: number;
  /** v1 的基数与各受益人金额（夹具值）。 */
  readonly snapshotBase: bigint;
}

/** 决定金额的结算记录：最新的 STATEMENT，没有时最新的 API（BR-FUND-09 R1）。 */
function decidingFen(settlements: readonly SettlementSpec[]): bigint | null {
  const sorted = [...settlements].sort((x, y) => x.seq - y.seq);
  const statements = sorted.filter((s) => (s.source ?? 'STATEMENT') === 'STATEMENT');
  const chosen = statements[statements.length - 1] ?? sorted[sorted.length - 1];
  return chosen === undefined ? null : chosen.fen;
}

/**
 * 一张 WAITING 子订单：order_keys、orders、快照 v1（commission_splits、版本 1 的合计与金额行、受益人初始事件）
 * 与结算记录，都写在 a.at；settle_period = a.period。
 */
export async function seedOrder(a: App, spec: OrderSpec): Promise<Seeded> {
  const orderId = randomUUID();
  const platform = spec.platform ?? TAOBAO;
  const subOrderId = spec.subOrderId ?? `bfu-sub-${randomUUID()}`;
  const reserveBp = spec.reserveBp ?? 0;
  const settlements: readonly SettlementSpec[] =
    spec.settlements ??
    (spec.settleFen === null ? [] : [{ seq: 1, source: 'STATEMENT', fen: spec.settleFen }]);
  const settled = decidingFen(settlements);
  const people: SeededPerson[] = [];
  for (const p of spec.people ?? EXAMPLE_PEOPLE) {
    people.push({
      userId: await user(a),
      role: p.role,
      ratioBp: p.ratioBp,
      initialStatus: 'active',
    });
  }
  const owner = people.find((p) => p.role === 'self' || p.role === 'share') ?? people[0]!;
  const { base, reserve } = baseOf(spec.snapshotN, reserveBp);
  const amounts = people.map((p) => shareOf(base, p.ratioBp));
  const userTotal = amounts.reduce((sum, x) => addFen(sum, x), 0n);
  const at = a.at;

  await a.db
    .insertInto('order_keys')
    .values({ app_id: a.appId, order_id: orderId, platform, sub_order_id: subOrderId, attr_at: at })
    .execute();
  await a.db
    .insertInto('orders')
    .values({
      app_id: a.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: at,
      raw_item_id: 'synthetic',
      user_id: owner.userId,
      user_basis: 'param',
      buy_type: owner.role === 'share' ? 'share' : 'self',
      platform_status: settlements.length === 0 ? 'RECEIVED' : 'SETTLED',
      rebate_status: 'WAITING',
      hold: spec.hold ?? false,
      hold_reason: spec.hold === true ? 'RISK' : null,
      rights_pending: spec.rightsPending ?? false,
      commission_version: 1,
      est_commission_fen: spec.snapshotN,
      settle_commission_fen: settled,
      subsidy_commission_fen: 0n,
      initial_est_fen: spec.snapshotN,
      n_total_fen: spec.snapshotN,
      pre_base_deduct_fen: subFen(spec.snapshotN, base),
      base_fen: base,
      platform_est_profit_fen: subFen(spec.snapshotN, userTotal),
      activity_type: null,
      paid_at: at,
      received_at: at,
      settle_period: a.period,
      quantity: 1,
      refunded_quantity: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await a.db
    .insertInto('commission_splits')
    .values({
      app_id: a.appId,
      order_id: orderId,
      rule_version_id: a.ruleVersionId,
      order_type: owner.role === 'share' ? 'share' : 'self',
      activity_type: null,
      rebate_mode: null,
      paid_at: at,
      paid_at_source: 'platform',
      raw_n_fen: spec.snapshotN,
      subsidy_commission_fen: 0n,
      reserve_bp: reserveBp,
      reserve_fen: reserve,
      tlj_deduct_fen: 0n,
      base_fen: base,
      platform_retain_fen: subFen(base, userTotal),
      beneficiaries: JSON.stringify(
        people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
        })),
      ),
      created_at: at,
    })
    .execute();
  await a.db
    .insertInto('commission_split_totals')
    .values({
      app_id: a.appId,
      order_id: orderId,
      commission_version: 1,
      n_total_fen: spec.snapshotN,
      pre_base_deduct_fen: subFen(spec.snapshotN, base),
      base_fen: base,
      user_share_total_fen: userTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(spec.snapshotN, userTotal),
      subsidy_commission_fen: 0n,
      created_at: at,
    })
    .execute();
  await a.db
    .insertInto('commission_split_amounts')
    .values(
      people.map((p, i) => ({
        app_id: a.appId,
        order_id: orderId,
        commission_version: 1,
        user_id: p.userId,
        role: p.role,
        base_fen: base,
        amount_fen: amounts[i]!,
        created_at: at,
      })),
    )
    .execute();
  for (const p of people) {
    await a.db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: a.appId,
        order_id: orderId,
        user_id: p.userId,
        role: p.role,
        status: 'active',
        reason: null,
        created_at: at,
      })
      .execute();
  }
  for (const s of settlements) {
    await a.db
      .insertInto('order_settlements')
      .values({
        app_id: a.appId,
        order_id: orderId,
        seq: s.seq,
        source: s.source ?? 'STATEMENT',
        settle_commission_fen: s.fen,
        settled_at: at,
        content_hash: randomUUID(),
        created_at: at,
      })
      .execute();
  }
  return {
    appId: a.appId,
    orderId,
    platform,
    subOrderId,
    orderKey: `${platform}:${subOrderId}`,
    attrAt: at,
    seq: settlements.length === 0 ? 1 : Math.max(...settlements.map((s) => s.seq)),
    settleFen: settled ?? 0n,
    people,
    reserveBp,
    snapshotBase: base,
    user(role) {
      const found = people.find((p) => p.role === role);
      if (found === undefined) throw new Error(`kit: no ${role} beneficiary`);
      return found.userId;
    },
  };
}

/** 一条成功、带扣减、尚未被联盟更新应答的维权结果（R5 入账时自扣，BR-FUND-06）。 */
export async function openDeduction(a: App, o: Seeded, deductionFen: bigint): Promise<void> {
  await a.db
    .insertInto('order_rights')
    .values({
      id: randomUUID(),
      app_id: a.appId,
      order_id: o.orderId,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: deductionFen,
      occurred_at: a.at,
      platform_rights_no: `rights-${randomUUID()}`,
      answered_at: null,
    })
    .execute();
}

/** 一张已结案、结论「以联盟为准」的账单金额不一致差错单（B2-09h 的形状；本单起不再读）。 */
export async function unionConclusion(
  a: App,
  o: Seeded,
  expectedFen: bigint,
  actualFen: bigint,
): Promise<void> {
  const closedAt = new Date(a.clock.now().getTime() - 3_600_000);
  await a.db
    .insertInto('recon_diffs')
    .values({
      id: randomUUID(),
      app_id: a.appId,
      type: 'settle_amount_mismatch',
      source: 'R1',
      period: a.period,
      ref_type: 'order',
      ref_id: o.orderKey,
      expected_fen: expectedFen,
      actual_fen: actualFen,
      diff_fen: subFen(expectedFen, actualFen),
      status: 'closed',
      handler_id: null,
      closed_at: closedAt,
      dedupe_key: null,
      resolution: sql<
        Selectable<DB['recon_diffs']>['resolution']
      >`${JSON.stringify({ reason: '财务核实以联盟为准', outcome: 'union' })}::jsonb`,
      created_at: closedAt,
      updated_at: closedAt,
    })
    .execute();
}

/** 工程处置：按 v(n+1) 追加一版金额行（基数 base、各方 amounts，按 people 顺序）并推进 orders.commission_version。 */
export async function engineeringVersion(
  a: App,
  o: Seeded,
  version: number,
  base: bigint,
  amounts: readonly bigint[],
): Promise<void> {
  const userTotal = amounts.reduce((sum, x) => addFen(sum, x), 0n);
  await a.db
    .insertInto('commission_split_totals')
    .values({
      app_id: a.appId,
      order_id: o.orderId,
      commission_version: version,
      n_total_fen: base,
      pre_base_deduct_fen: 0n,
      base_fen: base,
      user_share_total_fen: userTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(base, userTotal),
      subsidy_commission_fen: 0n,
      created_at: a.clock.now(),
    })
    .execute();
  await a.db
    .insertInto('commission_split_amounts')
    .values(
      o.people.map((p, i) => ({
        app_id: a.appId,
        order_id: o.orderId,
        commission_version: version,
        user_id: p.userId,
        role: p.role,
        base_fen: base,
        amount_fen: amounts[i]!,
        created_at: a.clock.now(),
      })),
    )
    .execute();
  await a.db
    .updateTable('orders')
    .set((eb) => ({ commission_version: version, row_version: eb('row_version', '+', 1) }))
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// 期望值：与 commission 写版本行同一个拆分函数（@couli/domain splitCommission）对同一输入的结果。

export interface Split {
  readonly base: bigint;
  /** 按 o.people 顺序。 */
  readonly shares: readonly bigint[];
  readonly retain: bigint;
}

/** 联盟结算佣金 n 在 o 的快照条款下的拆分（预留 o.reserveBp、淘礼金 0、全部受益人 active）。 */
export function splitOf(o: Seeded, n: bigint): Split {
  const person = (role: Role): CommissionBeneficiary | null => {
    const p = o.people.find((x) => x.role === role);
    return p === undefined
      ? null
      : { user_id: p.userId, ratio_bp: BigInt(p.ratioBp), status: 'active' };
  };
  const owner = person('self') ?? person('share');
  if (owner === null) throw new Error('kit: no owner');
  const result = splitCommission({
    n_base_fen: n,
    reserve_bp: BigInt(o.reserveBp),
    tlj_deduct_fen: 0n,
    order_type: o.people.some((p) => p.role === 'share') ? 'share' : 'self',
    indirect_enabled: o.people.some((p) => p.role === 'indirect'),
    owner,
    direct: person('direct'),
    indirect: person('indirect'),
  });
  const shares = o.people.map(
    (p) => result.shares.find((s) => s.role === p.role && s.user_id === p.userId)?.amount_fen ?? 0n,
  );
  const sum = shares.reduce((x, y) => addFen(x, y), 0n);
  return { base: result.base_fen, shares, retain: subFen(result.base_fen, sum) };
}

/** 一单新版本应有的金额行（按 o.people 顺序）。 */
export function versionRows(o: Seeded, version: number, split: Split, at: Date) {
  return o.people.map((p, i) => ({
    commission_version: version,
    user_id: p.userId,
    role: p.role,
    base_fen: split.base,
    amount_fen: split.shares[i]!,
    created_at: at,
  }));
}

// ---------------------------------------------------------------------------------------------
// 读。

/** 一单的全部金额版本：合计行（按版本）与金额行（按版本、角色）。 */
export async function versionsOf(a: App, o: Pick<Seeded, 'orderId'>) {
  const totals = await a.db
    .selectFrom('commission_split_totals')
    .select(['commission_version', 'base_fen', 'user_share_total_fen', 'created_at'])
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .orderBy('commission_version')
    .execute();
  const amounts = await a.db
    .selectFrom('commission_split_amounts')
    .select(['commission_version', 'user_id', 'role', 'base_fen', 'amount_fen', 'created_at'])
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .orderBy('commission_version')
    .orderBy('role')
    .execute();
  return { totals, amounts };
}

/** 某版本的金额行（按角色）。 */
export async function amountsAt(a: App, o: Seeded, version: number) {
  return (await versionsOf(a, o)).amounts.filter((r) => r.commission_version === version);
}

/** 按角色排序的版本行期望（与 versionsOf 的排序一致）。 */
export function byRole<T extends { readonly role: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => (x.role < y.role ? -1 : x.role > y.role ? 1 : 0));
}

export function orderRow(a: App, o: Pick<Seeded, 'orderId'>) {
  return a.db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
}

export function billRow(a: App, billId: string = a.period) {
  return a.db
    .selectFrom('settle_bills')
    .selectAll()
    .where('app_id', '=', a.appId)
    .where('bill_id', '=', billId)
    .executeTakeFirst();
}

export function diffsOf(a: App) {
  return a.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', a.appId)
    .orderBy('id')
    .execute();
}

export function batchesOf(a: App) {
  return a.db
    .selectFrom('settle_batches')
    .selectAll()
    .where('app_id', '=', a.appId)
    .orderBy('created_at')
    .orderBy('batch_id')
    .execute();
}

export function itemsOf(a: App) {
  return a.db
    .selectFrom('settle_batch_items')
    .selectAll()
    .where('app_id', '=', a.appId)
    .orderBy('id')
    .execute();
}

/** 本应用某单的批次明细。 */
export async function itemsFor(a: App, o: Pick<Seeded, 'orderId'>) {
  return (await itemsOf(a)).filter((i) => i.order_id === o.orderId);
}

export function settleJobsOf(a: App) {
  return a.db
    .selectFrom('settle_jobs')
    .select(['job', 'platform', 'run_at', 'status'])
    .where('app_id', '=', a.appId)
    .orderBy('run_at')
    .execute();
}

/** 账单的四个计数。 */
export async function countsOf(a: App, billId: string = a.period) {
  const row = await billRow(a, billId);
  expect(row, `settle_bills ${billId}`).toBeDefined();
  return {
    error_count: row!.error_count,
    held_count: row!.held_count,
    unsettled_count: row!.unsettled_count,
    amount_mismatch_count: row!.amount_mismatch_count,
  };
}

/** 一张凭证的分录：排序后的 `subject|owner|amount`。 */
export async function voucherLines(a: App, uniqKey: string): Promise<string[]> {
  const rows = await a.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
    )
    .innerJoin('ledger_accounts as acc', (join) =>
      join.onRef('acc.id', '=', 'e.account_id').onRef('acc.app_id', '=', 'e.app_id'),
    )
    .select(['acc.subject', 'acc.owner_id', 'e.amount_fen'])
    .where('e.app_id', '=', a.appId)
    .where('v.uniq_key', '=', uniqKey)
    .execute();
  return rows.map((r) => `${r.subject}|${r.owner_id}|${String(r.amount_fen)}`).sort();
}

/** 本应用的全部凭证键。 */
export async function voucherKeys(a: App): Promise<string[]> {
  const rows = await a.db
    .selectFrom('ledger_vouchers')
    .select('uniq_key')
    .where('app_id', '=', a.appId)
    .execute();
  return rows.map((r) => r.uniq_key).sort();
}

/** 一个会员的可提现余额（没有钱包账户时为 null）。 */
export async function availableOf(a: App, userId: string): Promise<bigint | null> {
  const rows = await createLedger({ clock: a.clock }).getBalances(a.db, {
    appId: a.appId,
    userIds: [userId],
  });
  return rows[0]?.available_fen ?? null;
}

// commission 的公开出口（运行时加载，Nest 装饰器不进测试工程的编译），供用户侧待入账预估读。
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readonly readCommissionSnapshot: PendingEarningsDependencies['readSnapshot'];
  readonly readTljDeductFen: PendingEarningsDependencies['readTljDeductFen'];
};

/** 会员的待入账预估（BR-FUND-18 钱包读，订单当前版本的快照；入账开关按 on 读）。 */
export function pendingOf(a: App, userId: string) {
  const source = createPendingEarningsSource({
    clock: a.clock,
    config: { get: async (_appId, key) => (key.startsWith('credit.enabled.') ? true : undefined) },
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
  });
  return a.db
    .transaction()
    .setAccessMode('read only')
    .execute((trx) => source.forUser(trx, { appId: a.appId, userId }));
}

/** 把本应用 DRAFT 批次确认为立即结算（SB2 之后的行状态）。 */
export async function confirmDrafts(a: App, adminId: string): Promise<void> {
  await a.db
    .updateTable('settle_batches')
    .set((eb) => ({
      status: 'CONFIRMED',
      settle_mode: 'IMMEDIATE',
      confirmed_by: adminId,
      confirmed_at: a.clock.now(),
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', a.appId)
    .where('status', '=', 'DRAFT')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// 日志。

export type LogLine = Record<string, unknown>;

export function capturingLogger(): { readonly logger: RootLogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'worker', appEnv: 'test' },
    {
      write(line: string) {
        lines.push(JSON.parse(line) as LogLine);
      },
    },
  );
  return { logger, lines };
}

/** 某单的告警工程行（error 级、alert = ALERT、order_id = 该单）。 */
export function alertsFor(lines: readonly LogLine[], o: Pick<Seeded, 'orderId'>): LogLine[] {
  return lines.filter(
    (l) => l['level'] === ERROR_LEVEL && l['alert'] === ALERT && l['order_id'] === o.orderId,
  );
}

/** 全部告警工程行。 */
export function allAlerts(lines: readonly LogLine[]): LogLine[] {
  return lines.filter((l) => l['alert'] === ALERT);
}

/** 告警行带 app_id、bill_id、order_id，且不带平台子订单号、order_key 与受益人 user_id。 */
export function expectAlertShape(
  line: LogLine,
  a: App,
  o: Seeded,
  billId: string = a.period,
): void {
  expect(line).toMatchObject({
    level: ERROR_LEVEL,
    alert: ALERT,
    app_id: a.appId,
    bill_id: billId,
    order_id: o.orderId,
  });
  const text = JSON.stringify(line);
  expect(text).not.toContain(o.subOrderId);
  for (const p of o.people) expect(text).not.toContain(p.userId);
}

// ---------------------------------------------------------------------------------------------
// 事件总线：事务内写 event_log（随事务回滚）。

export function eventBus(a: App): EventBus {
  const bus: EventBus = {
    async publish(trx, event) {
      const eventId = event.eventId ?? randomUUID();
      await trx
        .insertInto('event_log')
        .values({
          app_id: event.appId,
          event_id: eventId,
          name: event.name,
          payload: JSON.stringify(event.payload),
          occurred_at: a.clock.now(),
          created_at: a.clock.now(),
        })
        .execute();
      return { eventId, duplicate: false };
    },
  };
  return bus;
}

// ---------------------------------------------------------------------------------------------
// 生产装配的 worker。

export interface Worker {
  readonly lines: LogLine[];
  /** 账单日 BILL_DAY 的 bill 投递。 */
  bill(platform?: string): Promise<void>;
  /** batch_execute 投递。 */
  execute(batchId: string): Promise<void>;
}

export interface WorkerOptions {
  /** worker 的数据库句柄（缺省 a.db；注入故障时给包了插件的句柄）。 */
  readonly db?: Kysely<DB>;
}

/**
 * app.module 在 worker 入口交给 SettlementModule.forWorker 的端口（捕获，不改）建出的 Nest 模块，Clock 为 a.clock，
 * 日志收进 lines；body 用它注册在 settle 队列上的处理器投递任务。
 */
export async function withWorker(
  a: App,
  body: (w: Worker) => Promise<void>,
  options: WorkerOptions = {},
): Promise<void> {
  const ports = await capturedPorts('worker');
  expect(
    ports,
    'app.module assembles SettlementModule.forWorker on the worker entry',
  ).not.toBeNull();
  if (ports === null) throw new Error('unreachable: the expect above failed');
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const { logger, lines } = capturingLogger();
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: a.clock,
    logger,
    db: options.db ?? a.db,
    queue,
    crypto: FAKE_CRYPTO,
    events: eventBus(a),
  });
  try {
    const handler: JobHandler = settleHandler(queue);
    await body({
      lines,
      bill: (platform = TAOBAO) =>
        handler(receivedJob(BILL, { app_id: a.appId, platform, accounting_date: BILL_DAY })),
      execute: (batchId) => handler(receivedJob(EXECUTE, { app_id: a.appId, batch_id: batchId })),
    });
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 库层故障。

function parametersText(parameters: readonly unknown[]): string {
  return JSON.stringify(parameters, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

const TOTALS_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?commission_split_totals"?/i;

/**
 * 给这些订单写金额版本合计行的 INSERT 在 PostgreSQL 执行之后抛错（每次都抛）：重生成失败，且失败前那条
 * 语句与之前的金额行确实已写进事务（必须回滚到原样）。查询构造器与原生 SQL 都算。
 */
export function failVersionWrite(db: Kysely<DB>, orderIds: readonly string[]) {
  const pending = new Set<QueryId>();
  const record = { fired: 0 };
  const faulty = db.withPlugin({
    transformQuery(args) {
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      const text = parametersText(compiled.parameters) + compiled.sql;
      if (TOTALS_INSERT.test(compiled.sql) && orderIds.some((id) => text.includes(id))) {
        pending.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        record.fired += 1;
        throw new Error('injected commission version write failure');
      }
      return args.result;
    },
  });
  return {
    db: faulty,
    get fired() {
      return record.fired;
    },
  };
}

/** 屏障与并发等待的上限（远小于用例的 TIMEOUT：等不到时落到断言，不跑满超时）。 */
export const WAIT_MS = 20_000;

/**
 * 本库上等锁的后端数达到 count、done() 为真或过了 limitMs 时返回（有界）；返回值是是否观察到了等锁
 * （'lock'）、对方已落定（'done'）还是到了上限（'timeout'）。
 */
export async function lockWaitOrDone(
  observer: Kysely<DB>,
  count: number,
  done: () => boolean,
  limitMs = WAIT_MS,
): Promise<'lock' | 'done' | 'timeout'> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(observer);
    if ((rows[0]?.n ?? 0) >= count) return 'lock';
    if (done()) return 'done';
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return 'timeout';
}

export type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * promise 在 limitMs 内落定则给它的结果（成败都不抛），否则给 { ok: false, error: 超时 }——等待一律有界，
 * 骨架上等不到的事件落到断言失败而不是用例超时。
 */
export async function within<T>(
  promise: Promise<T>,
  label: string,
  limitMs = WAIT_MS,
): Promise<Outcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        error: new Error(`${label}: not settled within ${String(limitMs)} ms`),
      });
    }, limitMs);
  });
  const settled = promise.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 错误的文字（Outcome 的 error 是 unknown）。 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 一个 Promise 是否已落定（不论成败）。 */
export function tracked<T>(promise: Promise<T>) {
  const state = { settled: false };
  const watched = promise.then(
    (value) => {
      state.settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      state.settled = true;
      return { ok: false as const, error };
    },
  );
  return {
    result: watched,
    get settled() {
      return state.settled;
    },
  };
}
