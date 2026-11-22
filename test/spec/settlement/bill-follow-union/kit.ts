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
// - 第 3 次写测：直接组装的账单日任务经依赖里的 logger（与 SupplementDependencies.logger 同名、可选）告警；
//   重生成前对该单加锁（订单键锁 / 订单行锁），与持锁的订单同步串行，锁后以重读到的结算记录与版本为准；
//   出账与补充都不再调用「以联盟为准」结论读口（端口保留）。
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { splitCommission, type CommissionBeneficiary } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type QueryId,
  type Selectable,
  type Transaction,
} from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type EventBus,
  type JobHandler,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { AdminSent, Fixture as AdminFixture } from '../admin-settle-commands/kit.ts';
import {
  createPendingEarningsSource,
  type PendingEarningsDependencies,
} from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import type { SettlementWorkerPorts } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
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
  /**
   * 快照的淘礼金扣减（commission_splits.tlj_deduct_fen；非 0 时 rebate_mode = normal，BR-CALC-02 / 19）；缺省 0。
   */
  readonly tljDeductFen?: bigint;
  readonly people?: readonly PersonSpec[];
  readonly hold?: boolean;
  readonly rightsPending?: boolean;
  readonly platform?: string;
  readonly subOrderId?: string;
}

export interface Seeded extends SeededOrder {
  readonly appId: string;
  readonly reserveBp: number;
  /** 快照的淘礼金扣减（缺省 0）。 */
  readonly tljDeductFen: bigint;
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
  const tljDeductFen = spec.tljDeductFen ?? 0n;
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
  const { base, reserve } = baseOf(spec.snapshotN, reserveBp, tljDeductFen);
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
      // 第 4 次写测（§12.4）：tljDeductFen 非 0 时（[AC-B2-18#18] 的 100）这是直接预置的快照行（rebate_mode=normal、
      // tlj_deduct_fen=100），不经淘礼金来源流水线（活动类型为空、v1 红包面额记 0）；该条验证的是出账读到已落库
      // 的扣减后按 BR-CALC-02 得 758。
      rebate_mode: tljDeductFen === 0n ? null : 'normal',
      paid_at: at,
      paid_at_source: 'platform',
      raw_n_fen: spec.snapshotN,
      subsidy_commission_fen: 0n,
      reserve_bp: reserveBp,
      reserve_fen: reserve,
      tlj_deduct_fen: tljDeductFen,
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
    tljDeductFen,
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

/** 联盟结算佣金 n 在 o 的快照条款下的拆分（预留 o.reserveBp、淘礼金 o.tljDeductFen、全部受益人 active）。 */
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
    tlj_deduct_fen: o.tljDeductFen,
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

export function capturingLogger(entry = 'worker'): {
  readonly logger: RootLogger;
  readonly lines: LogLine[];
} {
  const lines: LogLine[] = [];
  const logger = createRootLogger(
    { level: 'info', entry, appEnv: 'test' },
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
  /**
   * 换掉 app.module 交给 forWorker 的个别端口（其余照捕获的原样）；用于把一个本单起不该再调用的读口
   * 换成「一调用就抛错并计数」的替身。
   */
  readonly ports?: (captured: SettlementWorkerPorts) => SettlementWorkerPorts;
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
  const assembled = options.ports === undefined ? ports : options.ports(ports);
  const context = await workerContext(SettlementModule.forWorker(assembled), {
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

// ---------------------------------------------------------------------------------------------
// 第 3 次写测追加（评审 9 条 S1）：只做搭建与取数，不 expect（断言都在用例体里）。

/** 单连接池当前那条连接的后端 pid（取不到时为 -1，由用例断言）。 */
export async function pidOf(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  return rows[0]?.pid ?? -1;
}

// 观察连接的有界查询（第 5 次写测，§13.2）：单次观察查询本身能被终止，观察连接卡住时用例也能收尾、连接池能关闭。

/** 观察连接上单条观察查询的服务端上限：同一事务里 set_config('statement_timeout', …, true)，到时由 PostgreSQL 终止该查询。 */
export const OBSERVE_STATEMENT_MS = 2_000;
/** 服务端上限之外的客户端余量：到了还没落定，就从另一个池 pg_cancel_backend 观察连接的后端，再等它归还。 */
const OBSERVE_GRACE_MS = 500;
/** 一整段锁等待观察的明确时限：轮询上限 WAIT_MS，再加最后一次观察查询的最长收尾（远小于用例的 TIMEOUT）。 */
export const OBSERVATION_MS = WAIT_MS + 5_000;

/** 观察用的连接（pools.control）与取消它的另一个池（pools.db）。 */
export interface Observer {
  readonly db: Kysely<DB>;
  readonly canceller: Kysely<DB>;
}

export function observerOf(pools: Pools): Observer {
  return { db: pools.control, canceller: pools.db };
}

/**
 * 在观察连接上跑一条观察查询，本身有界且可终止：一个事务里先取本后端 pid 并 SET LOCAL statement_timeout
 * （OBSERVE_STATEMENT_MS，服务端到时终止查询、事务回滚、连接归还），外层再有客户端上限；外层到时查询还没落定，就从
 * canceller 对那个 pid 发 pg_cancel_backend 取消查询本身，并有界地等它归还连接，然后抛出明确的观察错误。
 */
export async function observe<T>(
  observer: Observer,
  label: string,
  query: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
  const backend = { pid: -1 };
  const pending = tracked(
    observer.db.transaction().execute(async (trx) => {
      const limit = String(OBSERVE_STATEMENT_MS);
      const { rows } = await sql<{ pid: number }>`
        SELECT pg_backend_pid() AS pid, set_config('statement_timeout', ${limit}, true) AS applied
      `.execute(trx);
      backend.pid = rows[0]?.pid ?? -1;
      return query(trx);
    }),
  );
  const settled = await within(pending.result, label, OBSERVE_STATEMENT_MS + OBSERVE_GRACE_MS);
  if (settled.ok) {
    const result = settled.value;
    if (result.ok) return result.value;
    throw new Error(`${label}: observation query failed: ${errorText(result.error)}`);
  }
  if (!pending.settled && backend.pid > 0) {
    await within(
      sql`SELECT pg_cancel_backend(${backend.pid}::int)`.execute(observer.canceller),
      `${label}: cancelling the observer backend`,
      OBSERVE_GRACE_MS,
    );
    await within(pending.result, `${label}: cancelled observation`, OBSERVE_GRACE_MS);
  }
  throw new Error(`${label}: ${errorText(settled.error)}`);
}

/**
 * 有界地等「有一个后端正被 holderPid 阻塞」（pg_blocking_pids，服务端观察，不靠全库锁等待计数）：
 * 'blocked' 观察到了；'done' 对方在被观察到阻塞之前就落定了；'timeout' 到了上限。每次观察查询经 observe（§13.2）。
 */
export async function blockedBy(
  observer: Observer,
  holderPid: number,
  done: () => boolean,
  limitMs = WAIT_MS,
): Promise<'blocked' | 'done' | 'timeout'> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const rows = await observe(observer, 'observing pg_blocking_pids', async (trx) => {
      const { rows: found } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
      `.execute(trx);
      return found;
    });
    if ((rows[0]?.n ?? 0) >= 1) return 'blocked';
    if (done()) return 'done';
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return 'timeout';
}

/**
 * 有界地等「waiterPid 正等着 holderPid 的锁」（pg_blocking_pids(waiter) 含 holder；与 ../bill-unsettled-count/kit.ts
 * waitBlocked 同一判据，只是每次观察查询经 observe、整体有上限）：'blocked' 观察到了，'timeout' 到了上限。
 */
export async function waitsOn(
  observer: Observer,
  waiterPid: number,
  holderPid: number,
  limitMs = WAIT_MS,
): Promise<'blocked' | 'timeout'> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const rows = await observe(observer, 'observing the bill row lock wait', async (trx) => {
      const { rows: found } = await sql<{ blocked: boolean }>`
        SELECT ${holderPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked
      `.execute(trx);
      return found;
    });
    if (rows[0]?.blocked === true) return 'blocked';
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return 'timeout';
}

/** 一单在账上的痕迹：uniq_key 以 `{order_key}:` 开头的凭证键（排序）与它们的分录行数。 */
export async function ledgerOf(
  a: App,
  o: Pick<Seeded, 'orderKey'>,
): Promise<{ keys: string[]; entries: number }> {
  const vouchers = await a.db
    .selectFrom('ledger_vouchers')
    .select(['id', 'uniq_key'])
    .where('app_id', '=', a.appId)
    .execute();
  const mine = vouchers.filter((v) => v.uniq_key.startsWith(`${o.orderKey}:`));
  const ids = mine.map((v) => v.id);
  const entries =
    ids.length === 0
      ? []
      : await a.db
          .selectFrom('ledger_entries')
          .select('voucher_id')
          .where('app_id', '=', a.appId)
          .where('voucher_id', 'in', ids)
          .execute();
  return { keys: mine.map((v) => v.uniq_key).sort(), entries: entries.length };
}

/** 这些会员的可提现余额（没有钱包账户为 null），按入参顺序。 */
export async function availables(a: App, userIds: readonly string[]): Promise<(bigint | null)[]> {
  const out: (bigint | null)[] = [];
  for (const id of userIds) out.push(await availableOf(a, id));
  return out;
}

const ITEMS_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?settle_batch_items"?/i;

export interface TracedQuery {
  readonly sql: string;
  /** 参数（JSON）+ SQL：用来判断语句是否针对某单。 */
  readonly text: string;
}

/**
 * 写批次明细（INSERT settle_batch_items）的语句在 PostgreSQL 执行之后抛错，直到 disarm()；同时记下经
 * 返回的 db 执行的每条语句（查询构造器与原生 SQL 都经同一执行器）。重生成端口不被替换：故障只落在
 * 「写明细」这一步。
 */
export function itemWriteFault(db: Kysely<DB>) {
  const pending = new Set<QueryId>();
  const state = { armed: true, fired: 0 };
  const queries: TracedQuery[] = [];
  const faulty = db.withPlugin({
    transformQuery(args) {
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      const text = `${parametersText(compiled.parameters)} ${compiled.sql}`;
      queries.push({ sql: compiled.sql, text });
      if (state.armed && ITEMS_INSERT.test(compiled.sql)) pending.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        state.fired += 1;
        throw new Error('injected supplement item write failure');
      }
      return args.result;
    },
  });
  return {
    db: faulty,
    queries,
    disarm() {
      state.armed = false;
    },
    get fired() {
      return state.fired;
    },
  };
}

/**
 * 这些语句里：为 orderId 写金额版本合计行（INSERT commission_split_totals）的第一条的下标，与第一条
 * 写批次明细的下标（没有为 -1）。
 */
export function regenerationAndItemWrites(
  queries: readonly TracedQuery[],
  orderId: string,
): { totals: number; items: number } {
  return {
    totals: queries.findIndex((q) => TOTALS_INSERT.test(q.sql) && q.text.includes(orderId)),
    items: queries.findIndex((q) => ITEMS_INSERT.test(q.sql)),
  };
}

// ---------------------------------------------------------------------------------------------
// 第 4 次写测追加（编排 D10-2544，任务书 §12）；第 5 次写测（编排 D10-2567，§13.1）把「认出旧查询的那一种写法」
// 改成白名单。只做搭建与取数，不 expect。

const RECON_DIFFS_TABLE = /\brecon_diffs\b/gi;
const RECON_DIFFS_INSERT_TARGET = /^\s*insert\s+into\s+(?:app\s*\.\s*)?recon_diffs\b/i;
const DO_UPDATE = /\bdo\s+update\b/i;

/**
 * 后台补充请求里允许读 recon_diffs 的语句（§13.1 允许清单）：**空——零读取**。核过的读取点（apps/api/src，第 5 次
 * 写测时的代码；场景：一张 WAITING 单、快照 1234、联盟结算 1100、另有一张已结案且结论为以联盟为准的旧差错单，
 * 重生成成功、不登记任何差错单）：
 * - ledger infra/recon-diffs-store.ts selectUnionConclusions（readUnionAuthoritativeOrderKeys；settlement
 *   bill/infra/bill-source.ts readSource 调用）：就是要消除的旧结论读取，不是必要读取。
 * - 同文件 findReconDiffByDedupeKey / findReconDiffByBusinessKey / findReconDiffByMonthEnd /
 *   findUnresolvedReconDiff（ledger application/recon-diffs.ts findExisting）：只在 registerReconDiff(Once) 的
 *   INSERT … ON CONFLICT DO NOTHING 冲突后回读；补充只在登记差错单时调 registerDiff（bill/supplement/command.ts
 *   的金额不一致与 union_mismatch 两处），本场景不登记 → 不该出现。
 * - 同文件 selectReconDiffs（ledger getReconDiffs；payment pay-admin-reads.ts 的后台收款差错读取）：补充不调。
 * - 同文件 countAdminReconDiffs / pageAdminReconDiffs / findAdminReconDiff / lockAdminReconDiff（后台差错单
 *   列表、详情、结案、核销、恢复、余额重算与看板计数）：别的后台路由，补充不调。
 * - ledger application/credit-postcheck-open-read.ts readCreditPostcheckOpen（entry.ts 的 worker gauge，抓取
 *   /metrics 时才读）：补充请求不读。
 * 没有一条是本场景必要的，所以清单为空；清单外任何对这张表的读都算违规。
 */
const RECON_DIFFS_READ_ALLOWLIST: readonly RegExp[] = [];

/**
 * 判定一条已编译的语句是不是「读 recon_diffs」（§13.1，白名单；查询构造器与原生 SQL 都经执行器编译到这里）。
 * 规则：去掉标识符的双引号后，语句文本里出现表名 recon_diffs（`\brecon_diffs\b`，大小写不论）就算读取——SELECT（含
 * `SELECT *`、整列 resolution、子查询、EXISTS、CTE、JOIN、SELECT … FOR UPDATE）、INSERT … SELECT / UPDATE … FROM /
 * DELETE … USING 里把它当数据来源的、以及以它为目标的 UPDATE / DELETE（按 WHERE 读行、可 RETURNING resolution）
 * 都算；唯一的例外是纯写入：语句以 `INSERT INTO [app.]recon_diffs` 开头、全句只在这个目标处出现一次表名、且没有
 * `DO UPDATE`（即 INSERT … VALUES、INSERT … ON CONFLICT [ON CONSTRAINT …] DO NOTHING [RETURNING]——returning 只回
 * 本条刚插入的行，不回已有行）。约束与索引名（recon_diffs_business_key 等）不是表名，不命中。字符串字面量与注释
 * 不剥：本场景的正确实现根本不碰这张表，从严。允许清单（RECON_DIFFS_READ_ALLOWLIST）里的形状不计——现为空。
 */
export function isReconDiffsRead(compiledSql: string): boolean {
  const text = compiledSql.replace(/"/g, '');
  const mentions = text.match(RECON_DIFFS_TABLE)?.length ?? 0;
  if (mentions === 0) return false;
  const pureInsert =
    RECON_DIFFS_INSERT_TARGET.test(text) && mentions === 1 && !DO_UPDATE.test(text);
  if (pureInsert) return false;
  return !RECON_DIFFS_READ_ALLOWLIST.some((allowed) => allowed.test(text));
}

/** reconDiffsReadFault 注入的错误文字。 */
export const INJECTED_READ = 'injected: recon_diffs must not be read';

/**
 * 在这条执行器上观察并注入故障（§13.1）：凡是读 recon_diffs 的语句（isReconDiffsRead），一执行就计数（executed）
 * 并在 PostgreSQL 返回后抛错（fired，事务随之回滚）；其余语句照常，只计总数（statements，用来证明观察确实装在请求
 * 所用的执行器上）。违规语句原文记在 violations。不替换任何端口。
 */
export function reconDiffsReadFault(db: Kysely<DB>) {
  const pending = new Set<QueryId>();
  const state = { executed: 0, fired: 0, statements: 0 };
  const violations: string[] = [];
  const faulty = db.withPlugin({
    transformQuery(args) {
      state.statements += 1;
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (isReconDiffsRead(compiled.sql)) {
        state.executed += 1;
        violations.push(compiled.sql);
        pending.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        state.fired += 1;
        throw new Error(INJECTED_READ);
      }
      return args.result;
    },
  });
  return {
    db: faulty,
    violations,
    get executed() {
      return state.executed;
    },
    get fired() {
      return state.fired;
    },
    get statements() {
      return state.statements;
    },
  };
}

/**
 * 订单同步把预估改为 estAfter——部分退款后联盟回传的新预估（§12.2，被删旧用例 monthly [AC-B2-09h#21] 的
 * 「基数 1234 → 600」）。走生产途径、不手写版本行：orders 的列计划（../../commission/estimate-port/kit.ts
 * syncColumns：订单键锁、est_commission_fen、预估变了 commission_version + 1）与 settlement 的
 * rebate.onUpdated（R7 COMMISSION_CHANGED → commission 真实的 createCommissionEstimates.refresh 按新预估写
 * 新版本的合计与金额行），同一事务提交。只在该单还没有结算数据时调用：有结算佣金时有效基数取结算额，预估变化
 * 只存档、不推版本（BR-FUND-09「结算额写入前的预估变化……只重算预估（迁移 R7）」）。estimate-port kit 在这里
 * 按需加载，只 import 不改。
 */
export async function syncEstimate(a: App, o: Seeded, estAfter: bigint): Promise<void> {
  const port = await import('../../commission/estimate-port/kit.ts');
  const rebate = port.rebateOf(a.clock, port.estimatesOf(a.clock));
  await a.db.transaction().execute(async (trx) => {
    const { change, source } = await port.syncColumns(trx, o, { estAfter });
    await rebate.onUpdated(trx, change, source);
  });
}

/**
 * 联盟结算数据后到（夹具写法同 seedOrder 的结算记录）：写一条 order_settlements（写在 a.at）并把订单行的
 * settle_commission_fen 与 platform_status（SETTLED）跟上；不动版本。
 */
export async function settleLater(a: App, o: Seeded, s: SettlementSpec): Promise<void> {
  await a.db
    .insertInto('order_settlements')
    .values({
      app_id: a.appId,
      order_id: o.orderId,
      seq: s.seq,
      source: s.source ?? 'STATEMENT',
      settle_commission_fen: s.fen,
      settled_at: a.at,
      content_hash: randomUUID(),
      created_at: a.at,
    })
    .execute();
  await a.db
    .updateTable('orders')
    .set((eb) => ({
      settle_commission_fen: s.fen,
      platform_status: 'SETTLED',
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', a.appId)
    .where('order_id', '=', o.orderId)
    .execute();
}

// ---------------------------------------------------------------------------------------------
// 后台入口的生产装配（createHttpApp('admin')），日志收进 lines。与 ../admin-settle-commands/kit.ts
// withCommandsAdmin 同一做法，只是那里的根 logger 是 silent、不可换（冻结 kit 不改），这里换成收集日志的。

const REPO = new URL('../../../../', import.meta.url);

interface AdminHttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

export interface SupplementAdmin {
  /** 后台入口根 logger 写出的每一行（JSON）。 */
  readonly lines: LogLine[];
  /** POST /admin/v1/settle-bills/{bill_id}/supplement-batches（settle.bill 账号、totp step-up）。 */
  supplement(
    billId: string,
    body: unknown,
    options?: { readonly key?: string },
  ): Promise<AdminSent>;
}

/** 契约格式的 Idempotency-Key（8–64 位 [A-Za-z0-9_-]）。 */
export function idempotencyKey(): string {
  return `bfu_${randomBytes(12).toString('hex')}`;
}

/** 在夹具的库（f.db，可带故障插件）、Clock 与 Redis 上起后台入口，根 logger 收日志。 */
export async function withSupplementAdmin(
  f: AdminFixture,
  run: (h: SupplementAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', REPO).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<AdminHttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', REPO));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-18-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const { logger, lines } = capturingLogger('admin');
  let server: AdminHttpApp | undefined;
  try {
    server = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_18_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger,
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await server.init();
    const app = server;
    const redis = app.get<RedisHandle>(REDIS);
    const adminId = randomUUID();
    await f.db
      .insertInto('admin_users')
      .values({
        id: adminId,
        app_id: f.appId,
        login_name: `bfu_${adminId}`,
        password_hash: 'unused-test-login',
        is_super: false,
        status: 'active',
        password_must_change: false,
        totp_bound_at: f.clock.now(),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await f.db
      .insertInto('admin_permissions')
      .values({
        app_id: f.appId,
        admin_id: adminId,
        permission_key: 'settle.bill',
        granted_by: adminId,
        granted_at: f.clock.now(),
      })
      .execute();
    const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
      adminId,
      appId: f.appId,
    });
    await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
      claims.sessionId,
      {
        adminId,
        appId: f.appId,
        expiresAtMs: claims.expiresAt * 1000,
        lastSeenMs: f.clock.now().getTime(),
      },
    );
    await run({
      lines,
      async supplement(billId, body, options = {}) {
        const grant = await createAdminStepUpTokens({
          clock: f.clock,
          redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
        }).issue({ appId: f.appId, adminId, sessionId: claims.sessionId, tier: 'totp' });
        const response = await app.inject({
          method: 'POST',
          url: `/admin/v1/settle-bills/${encodeURIComponent(billId)}/supplement-batches`,
          headers: {
            'content-type': 'application/json',
            'x-trace-id': randomUUID(),
            authorization: `Bearer ${token}`,
            'idempotency-key': options.key ?? idempotencyKey(),
            'x-step-up-token': grant.step_up_token,
          },
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return {
          op: 'supplement',
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as ReturnType<AdminSent['json']>,
        };
      },
    });
  } finally {
    try {
      await server?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
