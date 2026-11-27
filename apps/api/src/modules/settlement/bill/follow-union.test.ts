// 单元测试（不连库）：B2-18 账单日任务与补充发起遇金额不一致「跟随联盟」（BR-FUND-04 ④ 2026-11-21、
// BR-FUND-01 R7、BR-CALC-02 / 15；编排 D10-2415、D10-2532）。Kysely 跑在记录语句的脚本化驱动上，订单行、
// 结算记录与账单行是内存场景；快照读口、淘礼金读口与重生成端口是替身。真实 PG 行为由
// test/spec/settlement/bill-follow-union 覆盖。逐条对应实现必满足项 2–5（必满足项 1 见
// no-union-conclusion-read.test.ts）。
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AMOUNT_MISMATCH_ALERT,
  REGENERATION_CAP,
  REGENERATION_DEFERRED_EVENT,
  SETTLEMENT_CHANGED_AFTER_CUTOFF_NOTE,
  convertBase,
  isZeroSettlementBlocked,
  regenerationCapOf,
  settlementChangedAfterCutoff,
} from './follow-union.ts';
import {
  createBillJob,
  type BillJobDependencies,
  type BillSourceOrder,
  type BillSourceRow,
  type BillValidation,
} from './job.ts';
import {
  createBillSnapshotRegeneration,
  type BillSnapshotRegeneration,
  type BillSnapshotRegenerationInput,
} from './regenerate.ts';
import { createSupplementCommand } from './supplement/command.ts';

const APP = 'unit-app';
const MONTH = '2032-06';
const RUN = new Date('2032-07-24T00:01:00+08:00');
const NOW = new Date('2032-07-24T00:10:00+08:00');
const BEFORE = new Date('2032-07-20T10:00:00+08:00');
const ATTR = new Date('2032-06-10T10:00:00+08:00');
const SUB = 'unit-sub-order-77';
const OWNER = 'unit-user-self';

type Row = Record<string, unknown>;
type Entry = { readonly sql: string; readonly params: readonly unknown[] } | string;

interface Scene {
  /** The orders row as read under the order key lock (mutable: a concurrent writer edits it). */
  order: Row;
  settlements: Row[];
  bill: Row;
  failBillUpdate?: boolean;
  failItemInsert?: boolean;
  /** r2：别的订单各自的行与结算记录（按 order_id 查；不在这里的订单用 order / settlements）。 */
  others?: Record<string, { order: Row; settlements: Row[] }>;
}

function orderRow(values: Row = {}): Row {
  return {
    app_id: APP,
    order_id: 'order-1',
    attr_at: ATTR,
    platform: 'taobao',
    sub_order_id: SUB,
    rebate_status: 'WAITING',
    settle_period: MONTH,
    hold: false,
    rights_pending: false,
    commission_version: 1,
    row_version: 7,
    ...values,
  };
}

function settlementRow(seq: number, fen: bigint, source = 'STATEMENT', at = BEFORE): Row {
  return {
    seq,
    source,
    created_at: at,
    settled_at: at,
    settle_commission_fen: fen,
  };
}

function billRow(values: Row = {}): Row {
  return {
    app_id: APP,
    bill_id: MONTH,
    generation_started_at: NOW,
    generated_at: null,
    platform_order_counts: null,
    platform_settle_commission_totals: null,
    beneficiary_total_fen: null,
    platform_retained_fen: null,
    error_count: null,
    held_count: null,
    unsettled_count: null,
    amount_mismatch_count: null,
    ...values,
  };
}

/** 脚本化驱动：记录每条语句与 BEGIN / COMMIT / ROLLBACK；marks 供替身在日志里插入标记。 */
function fakeDb(scene: Scene) {
  const log: Entry[] = [];
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      log.push({ sql: text, params: compiled.parameters });
      if (/^(savepoint|rollback to savepoint|release savepoint) /i.test(text)) {
        return Promise.resolve(result([]));
      }
      if (/^select pg_advisory_xact_lock/.test(text)) return Promise.resolve(result([]));
      if (/^insert into "app"\."settle_jobs"/.test(text)) {
        return Promise.resolve(result([{ id: 'job-1' }]));
      }
      if (/^update "app"\."settle_jobs"/.test(text)) return Promise.resolve(result([], 1n));
      if (/^select .* from "app"\."settle_jobs"/.test(text)) return Promise.resolve(result([]));
      if (/^insert into "app"\."settle_bills"/.test(text)) return Promise.resolve(result([], 0n));
      if (/^select .* from "app"\."settle_bills".* for update$/.test(text)) {
        return Promise.resolve(result([scene.bill]));
      }
      if (/^update "app"\."settle_bills"/.test(text)) {
        if (scene.failBillUpdate === true) {
          return Promise.reject(new Error('injected bill count failure'));
        }
        return Promise.resolve(result([], 1n));
      }
      if (/^insert into "app"\."settle_batch_items"/.test(text) && scene.failItemInsert === true) {
        return Promise.reject(new Error('injected item write failure'));
      }
      if (/^insert into "app"\."settle_batch(es|_items)"/.test(text)) {
        return Promise.resolve(result([], 1n));
      }
      if (
        /^select .* from "app"\."(settle_batches|settle_batch_items|beneficiary_credits)"/.test(
          text,
        )
      ) {
        return Promise.resolve(result([]));
      }
      const other = scene.others?.[String(compiled.parameters[1])];
      const order = other?.order ?? scene.order;
      if (/^select "platform", "sub_order_id", "attr_at" from "app"\."orders"/.test(text)) {
        const { platform, sub_order_id, attr_at } = order;
        return Promise.resolve(result([{ platform, sub_order_id, attr_at }]));
      }
      if (/^select \* from "app"\."orders"/.test(text)) {
        return Promise.resolve(result([{ ...order }]));
      }
      if (/^update "app"\."orders"/.test(text)) return Promise.resolve(result([], 1n));
      if (/^select .* from "app"\."order_settlements"/.test(text)) {
        const rows = other?.settlements ?? scene.settlements;
        return Promise.resolve(result(rows.map((s) => ({ ...s }))));
      }
      return Promise.reject(new Error(`unscripted statement: ${text}`));
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      log.push('BEGIN');
    },
    commitTransaction: async () => {
      log.push('COMMIT');
    },
    rollbackTransaction: async () => {
      log.push('ROLLBACK');
    },
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  /** 日志里每一项的简称：BEGIN / COMMIT / ROLLBACK / 标记原样，语句取前缀。 */
  const trail = () =>
    log.map((e) => {
      if (typeof e === 'string') return e;
      const s = e.sql;
      if (/^savepoint /i.test(s)) return 'SAVEPOINT';
      if (/^rollback to savepoint /i.test(s)) return 'ROLLBACK TO SAVEPOINT';
      if (/^release savepoint /i.test(s)) return 'RELEASE SAVEPOINT';
      // B2-04re：平台结算互斥锁（两段 hashtext 键）与订单键锁（hashtextextended 键）分开记。
      if (/^select pg_advisory_xact_lock\(hashtext\(/.test(s)) return 'LOCK credit_gate';
      if (/^select pg_advisory_xact_lock\(hashtextextended\(/.test(s)) return 'LOCK order_key';
      if (/^select \* from "app"\."orders"/.test(s)) return 'READ order';
      if (/^select .* from "app"\."order_settlements"/.test(s)) return 'READ settlements';
      if (/^insert into "app"\."settle_batch_items"/.test(s)) return 'INSERT items';
      if (/^update "app"\."settle_bills"/.test(s)) return 'UPDATE bill';
      return s.slice(0, 40);
    });
  const statements = () => log.filter((e): e is Exclude<Entry, string> => typeof e !== 'string');
  /** 写 settle_bills 的 UPDATE：列名 → 参数值。 */
  const billUpdates = () =>
    statements()
      .filter((s) => /^update "app"\."settle_bills"/.test(s.sql))
      .map((s) => {
        const set = /^update "app"\."settle_bills" set (.*) where /.exec(s.sql)![1]!;
        const out: Record<string, unknown> = {};
        for (const part of set.split(', ')) {
          const m = /^"([a-z_]+)" = \$(\d+)$/.exec(part)!;
          out[m[1]!] = s.params[Number(m[2]) - 1];
        }
        return out;
      });
  const itemInserts = () =>
    statements().filter((s) => /^insert into "app"\."settle_batch_items"/.test(s.sql));
  return { db, log, trail, statements, billUpdates, itemInserts };
}

function sourceOrder(values: Partial<BillSourceOrder> = {}): BillSourceOrder {
  return {
    orderId: 'order-1',
    rebateStatus: 'WAITING',
    settlePeriod: MONTH,
    hold: false,
    rightsPending: false,
    commissionVersion: 1,
    unionAuthoritative: false,
    ...values,
  };
}

function sourceRow(order: BillSourceOrder | null, settlements: readonly Row[]): BillSourceRow {
  return {
    orderKey: `taobao:${order?.orderId ?? 'orphan'}`,
    order,
    settlements: settlements.map((s) => ({
      seq: s['seq'] as number,
      source: s['source'] as 'API' | 'STATEMENT',
      createdAt: s['created_at'] as Date,
      settledAt: s['settled_at'] as Date,
      commissionFen: s['settle_commission_fen'] as bigint,
    })),
  };
}

function capturingLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

interface Harness {
  readonly dependencies: BillJobDependencies;
  readonly saved: BillValidation[];
  readonly registerDiff: ReturnType<typeof vi.fn>;
  readonly logger: ReturnType<typeof capturingLogger>;
}

/**
 * 账单日任务的依赖：快照基数按版本取 bases（预留 0、自购 5000 / 直推 1000bp），淘礼金 0。
 */
function harness(
  rows: readonly BillSourceRow[],
  bases: Record<number, bigint>,
  options: { config?: Record<string, unknown>; port?: BillSnapshotRegeneration } = {},
): Harness {
  const saved: BillValidation[] = [];
  const registerDiff = vi.fn(async () => {
    throw new Error('registerDiff must not be called for an amount mismatch');
  });
  const logger = capturingLogger();
  const config: Record<string, unknown> = { 'credit.enabled.taobao': 'on', ...options.config };
  const dependencies: BillJobDependencies = {
    clock: new FixedClock(NOW),
    config: { get: async (_app, key) => config[key] ?? null },
    readSource: async () => rows,
    readSnapshot: async (_trx, selection) => {
      const baseFen = bases[selection.commissionVersion];
      if (baseFen === undefined) throw new Error('no such version');
      return {
        baseFen,
        reserveBp: 0,
        beneficiaries: [
          { userId: OWNER, role: 'self', ratioBp: 5000, initialStatus: 'active' },
          { userId: 'unit-user-direct', role: 'direct', ratioBp: 1000, initialStatus: 'active' },
        ],
        forfeitedEvents: [],
      };
    },
    readTljDeductFen: async () => 0n,
    snapshotStatus: async () => ({ state: 'complete', snapshotId: 's-1', waitingComparable: true }),
    registerDiff: registerDiff as unknown as BillJobDependencies['registerDiff'],
    saveValidations: async (_trx, _input, validations) => {
      saved.push(...validations);
    },
    logger,
    ...(options.port === undefined ? {} : { regenerateSnapshot: options.port }),
  };
  return { dependencies, saved, registerDiff, logger };
}

/** 记录调用、在语句日志里插入标记的重生成端口替身；behave 决定这一次的结果。 */
function recordingPort(
  log: Entry[],
  behave: (input: BillSnapshotRegenerationInput, call: number) => number,
) {
  const calls: BillSnapshotRegenerationInput[] = [];
  const port: BillSnapshotRegeneration = {
    async regenerate(_trx, input) {
      calls.push(input);
      log.push('REGENERATE');
      return { commissionVersion: behave(input, calls.length) };
    },
  };
  return { port, calls };
}

const runJob = (deps: BillJobDependencies, db: Kysely<DB>) =>
  createBillJob(deps).run(db, { appId: APP, platform: 'taobao', runAt: RUN });

it('[AC-B2-18-UNIT#1] 必满足项 ②：新版本号取锁后重读的当前版本 + 1——来源读到 v1、锁后重读到 v3 时端口入参为 v3（不是写死 2，也不是锁前读到的 v1）；锁先于重读', async () => {
  // 来源读到 v1（基数 1234）；订单同步在出账读完来源后已把版本推到 v3（基数仍 1234）。
  const settlements = [settlementRow(1, 1100n)];
  const scene: Scene = {
    order: orderRow({ commission_version: 3 }),
    settlements,
    bill: billRow(),
  };
  const f = fakeDb(scene);
  const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const h = harness(
    [sourceRow(sourceOrder({ commissionVersion: 1 }), settlements)],
    { 1: 1234n, 3: 1234n, 4: 1100n },
    { port },
  );

  const result = await runJob(h.dependencies, f.db);

  expect(result.outcome).toBe('generated');
  expect(calls).toEqual([
    {
      appId: APP,
      orderId: 'order-1',
      commissionVersion: 3,
      settleCommissionFen: 1100n,
      bSettleFen: 1100n,
    },
  ]);
  const trail = f.trail();
  expect(trail.indexOf('LOCK order_key')).toBeGreaterThan(-1);
  expect(trail.indexOf('LOCK order_key')).toBeLessThan(trail.indexOf('READ order'));
  expect(trail.indexOf('READ order')).toBeLessThan(trail.indexOf('REGENERATE'));
  expect(h.saved.map((v) => v.result)).toEqual(['candidate']);
  expect(f.itemInserts()).toHaveLength(1);
});

it('[AC-B2-18-UNIT#2] 必满足项 ②：重生成撞唯一约束（23505）时回滚到保存点、按锁后重读的结果重新判定——并发写者已写好一致的 v2 → 候选入批，端口不再调第二次、不告警、不计金额不一致', async () => {
  const settlements = [settlementRow(1, 1100n)];
  const scene: Scene = { order: orderRow(), settlements, bill: billRow() };
  const f = fakeDb(scene);
  const calls: BillSnapshotRegenerationInput[] = [];
  const port: BillSnapshotRegeneration = {
    async regenerate(_trx, input) {
      calls.push(input);
      f.log.push('REGENERATE');
      // 另一写者抢先提交了同一版本号（基数 1100）：本次写入撞唯一约束。
      scene.order = orderRow({ commission_version: 2, row_version: 8 });
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    },
  };
  const h = harness([sourceRow(sourceOrder(), settlements)], { 1: 1234n, 2: 1100n }, { port });

  await runJob(h.dependencies, f.db);

  expect(calls).toHaveLength(1);
  const trail = f.trail();
  const first = trail.indexOf('REGENERATE');
  expect(trail.slice(first, first + 4)).toEqual([
    'REGENERATE',
    'ROLLBACK TO SAVEPOINT',
    'RELEASE SAVEPOINT',
    'SAVEPOINT',
  ]);
  expect(trail.filter((t) => t === 'LOCK order_key')).toHaveLength(2);
  expect(h.saved.map((v) => v.result)).toEqual(['candidate']);
  expect(f.itemInserts()).toHaveLength(1);
  expect(f.itemInserts()[0]!.params).toContain(1100n);
  expect(h.logger.error).not.toHaveBeenCalled();
  expect(f.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 0, error_count: 0 });
});

it('[AC-B2-18-UNIT#3] 必满足项 ③：账单日任务的重生成、批次明细与账单计数在同一 BEGIN…COMMIT 里，顺序为保存点 → 锁 → 重读 → 重生成 → 释放保存点 → 写明细 → 写账单；写账单计数失败时整笔 ROLLBACK、不提交', async () => {
  const settlements = [settlementRow(1, 1100n)];
  const ok: Scene = { order: orderRow(), settlements, bill: billRow() };
  const f = fakeDb(ok);
  const { port } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const h = harness([sourceRow(sourceOrder(), settlements)], { 1: 1234n, 2: 1100n }, { port });

  await runJob(h.dependencies, f.db);

  const trail = f.trail();
  expect(trail.filter((t) => t === 'BEGIN')).toHaveLength(1);
  expect(trail.filter((t) => t === 'COMMIT')).toHaveLength(1);
  const at = (t: string) => trail.indexOf(t);
  const order = [
    'BEGIN',
    'SAVEPOINT',
    'LOCK order_key',
    'READ order',
    'REGENERATE',
    'RELEASE SAVEPOINT',
    'INSERT items',
    'UPDATE bill',
    'COMMIT',
  ].map(at);
  expect(order.every((i) => i > -1)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);

  const failing: Scene = {
    order: orderRow(),
    settlements,
    bill: billRow(),
    failBillUpdate: true,
  };
  const g = fakeDb(failing);
  const second = recordingPort(g.log, (input) => input.commissionVersion + 1);
  const k = harness(
    [sourceRow(sourceOrder(), settlements)],
    { 1: 1234n, 2: 1100n },
    {
      port: second.port,
    },
  );
  await expect(runJob(k.dependencies, g.db)).rejects.toThrow('injected bill count failure');
  const failed = g.trail();
  const regenerated = failed.indexOf('REGENERATE');
  const rolledBack = failed.indexOf('ROLLBACK');
  expect(regenerated).toBeGreaterThan(-1);
  expect(rolledBack).toBeGreaterThan(regenerated);
  expect(failed.slice(0, rolledBack)).not.toContain('COMMIT');
});

it('[AC-B2-18-UNIT#4] 必满足项 ③：补充发起的重生成与补充批次同一事务——重生成先于写明细，都在同一 BEGIN…COMMIT 里；写明细失败时整笔 ROLLBACK，重生成不单独提交；补充不写 settle_bills', async () => {
  const settlements = [settlementRow(1, 1100n)];
  const generated = billRow({
    generated_at: NOW,
    platform_order_counts: { taobao: 0 },
  });
  const run = async (failItemInsert: boolean) => {
    const scene: Scene = { order: orderRow(), settlements, bill: generated, failItemInsert };
    const f = fakeDb(scene);
    const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
    const h = harness([sourceRow(sourceOrder(), settlements)], { 1: 1234n, 2: 1100n }, { port });
    const outcome = await createSupplementCommand(h.dependencies)
      .launch(f.db, { appId: APP, billId: MONTH, platform: 'taobao', requestedAt: BEFORE })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    return { f, calls, outcome };
  };

  const ok = await run(false);
  expect(ok.outcome.ok).toBe(true);
  expect(ok.calls).toHaveLength(1);
  const trail = ok.f.trail();
  const order = ['BEGIN', 'REGENERATE', 'INSERT items', 'COMMIT'].map((t) => trail.indexOf(t));
  expect(order.every((i) => i > -1)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  expect(trail.filter((t) => t === 'COMMIT')).toHaveLength(1);
  expect(ok.f.billUpdates()).toEqual([]);

  const failed = await run(true);
  expect(failed.outcome.ok).toBe(false);
  const t2 = failed.f.trail();
  const regenerated = t2.indexOf('REGENERATE');
  const rolledBack = t2.indexOf('ROLLBACK');
  expect(regenerated).toBeGreaterThan(-1);
  expect(rolledBack).toBeGreaterThan(regenerated);
  expect(t2.slice(0, rolledBack)).not.toContain('COMMIT');
});

it('[AC-B2-18-UNIT#5] 必满足项 ④：零结算拦截先于容差——容差 5 分、联盟结算 0、基数 3 → 不调重生成端口、逐单结果 amount_mismatch、不入批、告警一次（固定 alert、app_id / bill_id / order_id，不带子订单号与受益人）、计入 amount_mismatch_count；基数 0 结算 0 仍候选', async () => {
  expect(isZeroSettlementBlocked(0n, 3n)).toBe(true);
  expect(isZeroSettlementBlocked(0n, 0n)).toBe(false);
  expect(isZeroSettlementBlocked(1n, 3n)).toBe(false);
  // BR-CALC-02：floor(1010 × 8500 / 10000) − 100 = 758；扣到负数取 0。
  expect(convertBase(1010n, 1500, 100n)).toBe(758n);
  expect(convertBase(100n, 0, 300n)).toBe(0n);

  const zero = [settlementRow(1, 0n)];
  const scene: Scene = { order: orderRow(), settlements: zero, bill: billRow() };
  const f = fakeDb(scene);
  const { port, calls } = recordingPort(f.log, () => 2);
  const bothZeroOrder = sourceOrder({ orderId: 'order-2' });
  const h = harness(
    [sourceRow(sourceOrder(), zero), sourceRow(bothZeroOrder, zero)],
    // order-1 基数 3（v1），order-2 基数 0：按订单区分不了版本，用读口区分。
    { 1: 3n },
    { port, config: { 'settle.batch.match_tolerance_fen': '5' } },
  );
  const readSnapshot = h.dependencies.readSnapshot;
  const deps: BillJobDependencies = {
    ...h.dependencies,
    readSnapshot: async (trx, selection) => {
      const snapshot = await readSnapshot(trx, selection);
      return selection.orderId === 'order-2' && snapshot !== null
        ? { ...snapshot, baseFen: 0n }
        : snapshot;
    },
  };

  await runJob(deps, f.db);

  expect(calls).toEqual([]);
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['order-1', 'amount_mismatch'],
    ['order-2', 'candidate'],
  ]);
  expect(f.itemInserts()).toHaveLength(1);
  expect(f.itemInserts()[0]!.params).toContain('order-2');
  expect(f.itemInserts()[0]!.params).not.toContain('order-1');
  expect(h.logger.error).toHaveBeenCalledTimes(1);
  const [fields] = h.logger.error.mock.calls[0]! as [Record<string, unknown>, string];
  expect(fields).toMatchObject({
    alert: AMOUNT_MISMATCH_ALERT,
    app_id: APP,
    bill_id: MONTH,
    order_id: 'order-1',
    reason: 'zero_settlement',
  });
  const text = JSON.stringify(h.logger.error.mock.calls, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  expect(text).not.toContain(SUB);
  expect(text).not.toContain(OWNER);
  expect(h.registerDiff).not.toHaveBeenCalled();
  expect(f.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 1, error_count: 0 });
});

it('[AC-B2-18-UNIT#6] 必满足项 ⑤：amount_mismatch_count 与 unsettled_count 在同一条 UPDATE 里按「账单行锁内旧值 + 本平台数」累加（旧值 3 / 2，本平台金额不一致 1、应结未结 1 → 4 / 3），不取较大值、不另起 UPDATE；端口未注入按失败处理、不登记差错单', async () => {
  const settled = [settlementRow(1, 1100n)];
  const scene: Scene = {
    order: orderRow(),
    settlements: settled,
    bill: billRow({
      platform_order_counts: { jd: 0 },
      platform_settle_commission_totals: { jd: '0' },
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
      amount_mismatch_count: 3,
    }),
  };
  const f = fakeDb(scene);
  const missing = sourceOrder({ orderId: 'order-9' });
  const h = harness([sourceRow(sourceOrder(), settled), sourceRow(missing, [])], { 1: 1234n });

  await runJob(h.dependencies, f.db);

  const updates = f.billUpdates();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    unsettled_count: 3,
    amount_mismatch_count: 4,
    error_count: 0,
  });
  expect(h.registerDiff).not.toHaveBeenCalled();
  expect(h.logger.error).toHaveBeenCalledTimes(1);
  expect(h.logger.error.mock.calls[0]![0]).toMatchObject({
    alert: AMOUNT_MISMATCH_ALERT,
    order_id: 'order-1',
    reason: 'regeneration_unavailable',
  });
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['order-1', 'amount_mismatch'],
    ['order-9', 'missing_settlement'],
  ]);
});

it('[AC-B2-18-UNIT#7] 重生成后再校验仍不一致：回滚到保存点（版本写入不留）、告警 still_mismatched、不入批；重生成端口：版本号 = 锁后重读版本 + 1，经 CAS（WHERE commission_version = 旧版本）推进 orders.commission_version 之后才调 commission refresh（按联盟结算佣金估值），版本已变或非 WAITING 时抛错、不写', async () => {
  const settlements = [settlementRow(1, 1100n)];
  const scene: Scene = { order: orderRow(), settlements, bill: billRow() };
  const f = fakeDb(scene);
  const { port } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  // v2 的基数 1107 ≠ B_settle 1100。
  const h = harness([sourceRow(sourceOrder(), settlements)], { 1: 1234n, 2: 1107n }, { port });

  await runJob(h.dependencies, f.db);

  const trail = f.trail();
  const regenerated = trail.indexOf('REGENERATE');
  expect(trail.slice(regenerated + 1, regenerated + 3)).toContain('ROLLBACK TO SAVEPOINT');
  expect(f.itemInserts()).toEqual([]);
  expect(h.logger.error.mock.calls[0]![0]).toMatchObject({ reason: 'still_mismatched' });
  expect(f.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 1 });

  // 端口本身。
  const portScene: Scene = {
    order: orderRow({ commission_version: 3 }),
    settlements,
    bill: billRow(),
  };
  const g = fakeDb(portScene);
  const refresh = vi.fn(async () => {
    g.log.push('REFRESH');
  });
  const regeneration = createBillSnapshotRegeneration({ clock: new FixedClock(NOW), refresh });
  const input = {
    appId: APP,
    orderId: 'order-1',
    commissionVersion: 3,
    settleCommissionFen: 1100n,
    bSettleFen: 1100n,
  };
  const written = await g.db.transaction().execute((trx) => regeneration.regenerate(trx, input));
  expect(written).toEqual({ commissionVersion: 4 });
  const update = g.statements().find((s) => /^update "app"\."orders"/.test(s.sql))!;
  expect(update.sql).toMatch(/"commission_version" = \$\d+/);
  expect(update.sql).toMatch(/where .*"commission_version" = \$\d+/);
  expect(update.params).toContain(4);
  expect(update.params).toContain(3);
  const order = g.log.map((e) => (typeof e === 'string' ? e : e.sql.slice(0, 22)));
  expect(order.indexOf('REFRESH')).toBeGreaterThan(order.indexOf('update "app"."orders" '));
  expect(refresh).toHaveBeenCalledWith(
    expect.anything(),
    { appId: APP, orderId: 'order-1', attrAt: ATTR },
    { commissionFen: 1100n },
  );

  const stale = fakeDb({ ...portScene, order: orderRow({ commission_version: 5 }) });
  const staleRefresh = vi.fn(async () => undefined);
  await expect(
    stale.db.transaction().execute((trx) =>
      createBillSnapshotRegeneration({
        clock: new FixedClock(NOW),
        refresh: staleRefresh,
      }).regenerate(trx, input),
    ),
  ).rejects.toThrow('commission_version moved');
  expect(stale.statements().some((s) => /^update "app"\."orders"/.test(s.sql))).toBe(false);
  expect(staleRefresh).not.toHaveBeenCalled();

  const credited = fakeDb({
    ...portScene,
    order: orderRow({ commission_version: 3, rebate_status: 'CREDITED' }),
  });
  await expect(
    credited.db.transaction().execute((trx) =>
      createBillSnapshotRegeneration({
        clock: new FixedClock(NOW),
        refresh: staleRefresh,
      }).regenerate(trx, input),
    ),
  ).rejects.toThrow('no longer WAITING');
});

// ---- r2（资金评审 r1 三条并发问题 + 排除顺序，编排 D10-2618 / D10-2620）----

it('[AC-B2-18-UNIT#10] r2 第 1 条：锁后发现截点之后又来了改变结算额的结算记录（API seq 2 结算 900，取得于截点后）→ 不调重生成端口、不写版本与订单指针、逐单 amount_mismatch、不登记差错单、告警 reason settlement_changed_after_cutoff 且写明属并发时序、amount_mismatch_count +1；下一次出账（截点已含 seq 2、当前快照 v2 基数 900 与之相符）正常入批一次：不重生成、不告警、不计不一致', async () => {
  // 判断条件本身：同一条记录、或换算基数相同都不算「截点后变化」。
  const a = { seq: 1, commissionFen: 1100n };
  expect(settlementChangedAfterCutoff(a, a, 0, 0n)).toBe(false);
  expect(settlementChangedAfterCutoff(a, null, 0, 0n)).toBe(false);
  expect(settlementChangedAfterCutoff(a, { seq: 2, commissionFen: 1100n }, 0, 0n)).toBe(false);
  // 淘礼金扣减把两者都扣到 0：基数相同，不算变化。
  expect(settlementChangedAfterCutoff(a, { seq: 2, commissionFen: 900n }, 0, 2000n)).toBe(false);
  expect(settlementChangedAfterCutoff(a, { seq: 2, commissionFen: 900n }, 0, 0n)).toBe(true);

  const AFTER = new Date(NOW.getTime() + 60_000);
  const lockedSettlements = [settlementRow(1, 1100n, 'API'), settlementRow(2, 900n, 'API', AFTER)];

  // 第一次出账：来源读到 v1（基数 1234）与截点内的 seq 1；等锁期间同步写入截点后的 seq 2 并按 900 写好 v2。
  const scene: Scene = {
    order: orderRow({ commission_version: 2, row_version: 8 }),
    settlements: lockedSettlements,
    bill: billRow(),
  };
  const f = fakeDb(scene);
  const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const h = harness(
    [sourceRow(sourceOrder(), [settlementRow(1, 1100n, 'API')])],
    { 1: 1234n, 2: 900n },
    { port },
  );
  const first = await runJob(h.dependencies, f.db);

  expect(first.outcome).toBe('generated');
  expect(calls).toEqual([]);
  expect(f.statements().some((x) => /^update "app"\."orders"/.test(x.sql))).toBe(false);
  expect(f.trail()).toContain('ROLLBACK TO SAVEPOINT');
  expect(f.trail()).not.toContain('ROLLBACK');
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([['order-1', 'amount_mismatch']]);
  expect(f.itemInserts()).toEqual([]);
  expect(h.registerDiff).not.toHaveBeenCalled();
  expect(h.logger.error).toHaveBeenCalledTimes(1);
  const [fields, message] = h.logger.error.mock.calls[0]! as [Record<string, unknown>, string];
  expect(fields).toMatchObject({
    alert: AMOUNT_MISMATCH_ALERT,
    order_id: 'order-1',
    reason: 'settlement_changed_after_cutoff',
    note: SETTLEMENT_CHANGED_AFTER_CUTOFF_NOTE,
  });
  expect(message).toContain('属并发时序');
  expect(message).toContain('无需人工处理');
  expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(SUB);
  expect(f.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 1, error_count: 0 });

  // 第二次出账：截点晚于 seq 2；来源读到 v2 与两条记录，当前快照 v2 基数 900 = 结算 900。
  const later = new Date(NOW.getTime() + 2 * 3_600_000);
  const scene2: Scene = {
    order: orderRow({ commission_version: 2, row_version: 8 }),
    settlements: lockedSettlements,
    bill: billRow({ generation_started_at: later }),
  };
  const g = fakeDb(scene2);
  const second = recordingPort(g.log, (input) => input.commissionVersion + 1);
  const k = harness(
    [sourceRow(sourceOrder({ commissionVersion: 2 }), lockedSettlements)],
    { 2: 900n },
    { port: second.port },
  );
  const again = await runJob({ ...k.dependencies, clock: new FixedClock(later) }, g.db);

  expect(again.outcome).toBe('generated');
  expect(second.calls).toEqual([]);
  expect(g.trail()).not.toContain('LOCK order_key');
  expect(k.saved.map((v) => [v.orderId, v.result, v.settleSeq])).toEqual([
    ['order-1', 'candidate', 2],
  ]);
  expect(g.itemInserts()).toHaveLength(1);
  expect(g.itemInserts()[0]!.params).toContain(900n);
  expect(g.itemInserts()[0]!.params).toContain(2);
  expect(k.logger.error).not.toHaveBeenCalled();
  expect(g.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 0, error_count: 0 });
});

it('[AC-B2-18-UNIT#11] r2 第 2 条：来源读出后别的事务把 order-1 推到 v2，读快照报「期望版本不是当前版本」→ 只这一张转入保存点与订单键锁内按 v2 重判（v2 基数 1100 = 结算 → 候选、不重生成）；order-2 照常候选；事务不中止、一次 COMMIT；版本没变的读快照错误照旧让整次出账失败', async () => {
  const settled = [settlementRow(1, 1100n)];
  const scene: Scene = {
    order: orderRow({ commission_version: 2, row_version: 8 }),
    settlements: settled,
    bill: billRow(),
    others: { 'order-2': { order: orderRow({ order_id: 'order-2' }), settlements: settled } },
  };
  const f = fakeDb(scene);
  const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const second = sourceOrder({ orderId: 'order-2' });
  const h = harness(
    [sourceRow(sourceOrder(), settled), sourceRow(second, settled)],
    { 1: 1100n, 2: 1100n },
    { port },
  );
  const readSnapshot = h.dependencies.readSnapshot;
  const current: Record<string, number> = { 'order-1': 2, 'order-2': 1 };
  const deps: BillJobDependencies = {
    ...h.dependencies,
    // 同生产读口：期望版本不是最大版本时抛错（不是 SQL 错误，事务仍可用）。
    readSnapshot: async (trx, selection) => {
      if (selection.commissionVersion !== current[selection.orderId]) {
        throw new Error(
          `commission: expected commission_version ${String(selection.commissionVersion)} is not the current version`,
        );
      }
      return readSnapshot(trx, selection);
    },
  };

  const result = await runJob(deps, f.db);

  expect(result.outcome).toBe('generated');
  expect(calls).toEqual([]);
  const trail = f.trail();
  expect(trail.filter((t) => t === 'BEGIN')).toHaveLength(1);
  expect(trail.filter((t) => t === 'COMMIT')).toHaveLength(1);
  expect(trail).not.toContain('ROLLBACK');
  expect(trail.filter((t) => t === 'SAVEPOINT')).toHaveLength(1);
  expect(trail.filter((t) => t === 'LOCK order_key')).toHaveLength(1);
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['order-1', 'candidate'],
    ['order-2', 'candidate'],
  ]);
  const items = f.itemInserts();
  expect(items).toHaveLength(1);
  expect(items[0]!.params).toContain('order-1');
  expect(items[0]!.params).toContain('order-2');
  expect(h.logger.error).not.toHaveBeenCalled();

  // 版本没变（order-1 仍是 v1）却读不出快照：不是并发推进，整次出账照旧失败、不提交。
  const broken = fakeDb({ order: orderRow(), settlements: settled, bill: billRow() });
  const k = harness([sourceRow(sourceOrder(), settled)], { 1: 1100n }, { port });
  const failing: BillJobDependencies = {
    ...k.dependencies,
    readSnapshot: async () => {
      throw new Error('commission: snapshot version 1 has no totals row');
    },
  };
  await expect(runJob(failing, broken.db)).rejects.toThrow('has no totals row');
  // 生成事务整体回滚（之后的 COMMIT 只属于另起的记失败事务）。
  const t = broken.trail();
  expect(t.indexOf('ROLLBACK')).toBeGreaterThan(-1);
  expect(t.slice(0, t.indexOf('ROLLBACK'))).not.toContain('COMMIT');
  expect(t).not.toContain('SAVEPOINT');
});

it('[AC-B2-18-UNIT#12] r2 第 3 条：锁后重读到订单已被同步转为 VOID（结算记录仍在）→ 与锁前判出 unexpected_settlement 同一分支：账单日任务调 registerDiff（union_mismatch、实际 1100）且 error_count +1、不计不一致、不重生成；补充入口同样登记；锁后被 hold 的计入 held_count', async () => {
  const settled = [settlementRow(1, 1100n)];
  const diffs = vi.fn().mockResolvedValue({});

  const f = fakeDb({
    order: orderRow({ rebate_status: 'VOID' }),
    settlements: settled,
    bill: billRow(),
  });
  const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const h = harness([sourceRow(sourceOrder(), settled)], { 1: 1234n }, { port });
  await runJob(
    { ...h.dependencies, registerDiff: diffs as unknown as BillJobDependencies['registerDiff'] },
    f.db,
  );

  expect(calls).toEqual([]);
  expect(diffs).toHaveBeenCalledTimes(1);
  expect(diffs.mock.calls[0]![1]).toMatchObject({
    appId: APP,
    type: 'union_mismatch',
    period: MONTH,
    refId: 'taobao:order-1',
    expectedFen: 0n,
    actualFen: 1100n,
  });
  expect(f.billUpdates()[0]).toMatchObject({ error_count: 1, amount_mismatch_count: 0 });
  expect(h.saved.map((v) => v.result)).toEqual(['unexpected_settlement']);
  expect(h.logger.error).not.toHaveBeenCalled();

  const supplementDiffs = vi.fn().mockResolvedValue({});
  const g = fakeDb({
    order: orderRow({ rebate_status: 'VOID' }),
    settlements: settled,
    bill: billRow({ generated_at: NOW, platform_order_counts: { taobao: 0 } }),
  });
  const sp = recordingPort(g.log, (input) => input.commissionVersion + 1);
  const k = harness([sourceRow(sourceOrder(), settled)], { 1: 1234n }, { port: sp.port });
  await createSupplementCommand({
    ...k.dependencies,
    registerDiff: supplementDiffs as unknown as BillJobDependencies['registerDiff'],
  }).launch(g.db, {
    appId: APP,
    billId: MONTH,
    platform: 'taobao',
    requestedAt: BEFORE,
  });
  expect(sp.calls).toEqual([]);
  expect(supplementDiffs).toHaveBeenCalledTimes(1);
  expect(supplementDiffs.mock.calls[0]![1]).toMatchObject({
    type: 'union_mismatch',
    actualFen: 1100n,
  });

  const held = fakeDb({ order: orderRow({ hold: true }), settlements: settled, bill: billRow() });
  const hp = recordingPort(held.log, (input) => input.commissionVersion + 1);
  const m = harness([sourceRow(sourceOrder(), settled)], { 1: 1234n }, { port: hp.port });
  await runJob(m.dependencies, held.db);
  expect(hp.calls).toEqual([]);
  expect(held.billUpdates()[0]).toMatchObject({
    held_count: 1,
    error_count: 0,
    amount_mismatch_count: 0,
  });
});

it('[AC-B2-18-UNIT#13] B2-04re 重接：补充发起遇一张金额不一致的候选——平台结算互斥锁（排他）恰取一次，先于任何订单键锁、也先于 follow-union 的保存点；follow-union 保存点之内的订单键锁先于重生成，重生成后释放该保存点、再写明细', async () => {
  const settlements = [settlementRow(1, 1100n)];
  const scene: Scene = {
    order: orderRow(),
    settlements,
    bill: billRow({ generated_at: NOW, platform_order_counts: { taobao: 0 } }),
  };
  const f = fakeDb(scene);
  const { port, calls } = recordingPort(f.log, (input) => input.commissionVersion + 1);
  const h = harness([sourceRow(sourceOrder(), settlements)], { 1: 1234n, 2: 1100n }, { port });

  const result = await createSupplementCommand(h.dependencies).launch(f.db, {
    appId: APP,
    billId: MONTH,
    platform: 'taobao',
    requestedAt: BEFORE,
  });

  expect(result.outcome).toBe('generated');
  expect(result.batchIds).toHaveLength(1);
  expect(calls).toHaveLength(1);
  // 语句轨迹：保存点按名字区分；锁按键形区分。
  const steps = f.log.map((e) => {
    if (typeof e === 'string') return e;
    if (/^savepoint settle_bill_follow_union$/i.test(e.sql)) return 'SAVEPOINT follow_union';
    if (/^release savepoint settle_bill_follow_union$/i.test(e.sql)) return 'RELEASE follow_union';
    if (/^select pg_advisory_xact_lock\(hashtext\(/.test(e.sql)) return 'LOCK credit_gate';
    if (/^select pg_advisory_xact_lock\(hashtextextended\(/.test(e.sql)) return 'LOCK order_key';
    if (/^insert into "app"\."settle_batch_items"/.test(e.sql)) return 'INSERT items';
    return e.sql.slice(0, 40);
  });
  const gate = steps.indexOf('LOCK credit_gate');
  expect(steps.filter((s) => s === 'LOCK credit_gate')).toHaveLength(1);
  const orderLocks = steps.flatMap((s, i) => (s === 'LOCK order_key' ? [i] : []));
  expect(orderLocks.length).toBeGreaterThan(0);
  expect(orderLocks.every((i) => i > gate)).toBe(true);
  const followSavepoint = steps.indexOf('SAVEPOINT follow_union');
  expect(followSavepoint).toBeGreaterThan(gate);
  const lockInside = orderLocks.find((i) => i > followSavepoint);
  expect(lockInside).toBeDefined();
  const regenerated = steps.indexOf('REGENERATE');
  const released = steps.indexOf('RELEASE follow_union');
  expect(regenerated).toBeGreaterThan(lockInside!);
  expect(released).toBeGreaterThan(regenerated);
  expect(steps.indexOf('INSERT items')).toBeGreaterThan(released);
  expect(steps.filter((s) => s === 'COMMIT')).toHaveLength(1);
  expect(h.logger.error).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// B2-18d：一次出账的重生成上限（BR-FUND-04 ④ 细则「一次出账的重生成上限」，编排 D10-2982 ①、D10-3046）。
// 多张单的场景：每张单的订单行（sub_order_id = order_id，便于按键认锁）、结算记录与各版本基数分开给。

interface Many {
  readonly id: string;
  /** 锁前来源行上的订单事实（缺省 WAITING、v1）。 */
  readonly source?: Partial<BillSourceOrder>;
  /** 锁后重读到的订单行（缺省与来源一致）。 */
  readonly row?: Row;
  /** 联盟结算佣金；null = 没有结算记录。 */
  readonly settle: bigint | null;
  /** 各版本的快照基数。 */
  readonly bases: Record<number, bigint>;
  /** 读该版本快照时抛「期望版本不是当前版本」（模拟来源读出后版本被别的事务推进）。 */
  readonly staleAt?: number;
}

function manyScene(orders: readonly Many[], bill: Row = billRow()) {
  const others: Record<string, { order: Row; settlements: Row[] }> = {};
  const rows: BillSourceRow[] = [];
  for (const o of orders) {
    const settlements = o.settle === null ? [] : [settlementRow(1, o.settle)];
    others[o.id] = {
      order: orderRow({ order_id: o.id, sub_order_id: o.id, ...o.row }),
      settlements,
    };
    rows.push(sourceRow(sourceOrder({ orderId: o.id, ...o.source }), settlements));
  }
  const f = fakeDb({ order: orderRow(), settlements: [], bill, others });
  return { f, rows };
}

function manyHarness(
  orders: readonly Many[],
  rows: readonly BillSourceRow[],
  options: { port?: BillSnapshotRegeneration; cap?: number; config?: Record<string, unknown> } = {},
) {
  const h = harness(
    rows,
    { 1: 0n },
    {
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.config === undefined ? {} : { config: options.config }),
    },
  );
  const byId = new Map(orders.map((o) => [o.id, o]));
  const base = h.dependencies.readSnapshot;
  const registerDiff = vi.fn().mockResolvedValue({ inserted: true });
  const dependencies: BillJobDependencies = {
    ...h.dependencies,
    registerDiff: registerDiff as unknown as BillJobDependencies['registerDiff'],
    readSnapshot: async (trx, selection) => {
      const o = byId.get(selection.orderId);
      if (o === undefined) throw new Error('no such order');
      if (o.staleAt === selection.commissionVersion) {
        throw new Error(
          `commission: expected commission_version ${String(selection.commissionVersion)} is not the current version`,
        );
      }
      const baseFen = o.bases[selection.commissionVersion];
      if (baseFen === undefined) throw new Error('no such version');
      const snapshot = await base(trx, { ...selection, commissionVersion: 1 });
      return { ...snapshot!, baseFen };
    },
    ...(options.cap === undefined ? {} : { regenerationCap: options.cap }),
  };
  return { ...h, dependencies, registerDiff };
}

/** 订单键锁语句各锁的是哪张单（键文本以 `:<order_id>` 结尾，见 manyScene）。 */
function lockedOrders(f: ReturnType<typeof fakeDb>, ids: readonly string[], from = 0): string[] {
  return f.log
    .slice(from)
    .flatMap((e) =>
      typeof e !== 'string' && /^select pg_advisory_xact_lock\(hashtextextended\(/.test(e.sql)
        ? [String(e.params[0])]
        : [],
    )
    .map((text) => ids.find((id) => text.endsWith(`:${id}`)) ?? text);
}

function deferredEvents(logger: ReturnType<typeof capturingLogger>) {
  return logger.warn.mock.calls.filter((c) => c[1] === REGENERATION_DEFERRED_EVENT);
}

const okPort = (log: Entry[]) => recordingPort(log, (input) => input.commissionVersion + 1);

const runSupplement = (deps: BillJobDependencies, db: Kysely<DB>) =>
  createSupplementCommand(deps).launch(db, {
    appId: APP,
    billId: MONTH,
    platform: 'taobao',
    requestedAt: BEFORE,
  });

const SUPPLEMENT_BILL = billRow({ generated_at: NOW, platform_order_counts: { taobao: 0 } });

it('[AC-B2-18d-UNIT#1] 名额只在重生成成功时 +1；名额满了之后要进取锁路的单（锁前超差的、版本刚被推进而 current === null 的）都不开保存点、不发取锁语句就留下：不调端口、不入批、不进逐单结果、不告警，四个计数不变；金额相符的照常入批；日志恰一条 warn 的 settle_regeneration_deferred（字段 app_id / bill_id / platform / run / deferred_count，没有订单号与 alert）', async () => {
  const orders: Many[] = [
    { id: 'o1', settle: 1100n, bases: { 1: 1234n, 2: 1100n } },
    { id: 'o2', settle: 1100n, bases: { 1: 1234n, 2: 1100n } },
    // 来源读到 v1，读快照时版本已被推进到 v2（锁前无从判断）。
    {
      id: 'o3',
      settle: 1100n,
      bases: { 2: 1234n, 3: 1100n },
      staleAt: 1,
      row: { commission_version: 2 },
    },
    { id: 'o4', settle: 1100n, bases: { 1: 1100n } },
  ];
  const { f, rows } = manyScene(orders);
  const { port, calls } = okPort(f.log);
  const h = manyHarness(orders, rows, { port, cap: 1 });

  const result = await runJob(h.dependencies, f.db);

  expect(result.outcome).toBe('generated');
  expect(calls.map((c) => c.orderId)).toEqual(['o1']);
  const ids = orders.map((o) => o.id);
  expect(lockedOrders(f, ids)).toEqual(['o1']);
  expect(f.trail().filter((t) => t === 'SAVEPOINT')).toHaveLength(1);
  expect(f.trail().filter((t) => t === 'ROLLBACK TO SAVEPOINT')).toHaveLength(0);
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['o1', 'candidate'],
    ['o4', 'candidate'],
  ]);
  expect(f.itemInserts()).toHaveLength(1);
  const params = f.itemInserts()[0]!.params;
  expect(params).toContain('o1');
  expect(params).toContain('o4');
  expect(params).not.toContain('o2');
  expect(params).not.toContain('o3');
  expect(f.billUpdates()[0]).toMatchObject({
    error_count: 0,
    held_count: 0,
    unsettled_count: 0,
    amount_mismatch_count: 0,
  });
  expect(h.logger.error).not.toHaveBeenCalled();
  expect(h.registerDiff).not.toHaveBeenCalled();
  const events = deferredEvents(h.logger);
  expect(events).toEqual([
    [
      { app_id: APP, bill_id: MONTH, platform: 'taobao', run: 'bill', deferred_count: 2 },
      REGENERATION_DEFERRED_EVENT,
    ],
  ]);
  expect(JSON.stringify(events)).not.toMatch(/o[1-4]|alert/);
});

it.each([
  { variant: 'pushed' as const, label: '锁后重读即相符（来源读出后版本被推进到与联盟一致）' },
  {
    variant: 'voided' as const,
    label: '锁后已不是候选（被同步转为 VOID，按 unexpected_settlement 登记一次）',
  },
])(
  '[AC-B2-18d-UNIT#2] 取锁后没有重生成的回滚放锁、不占名额（D10-3046 (1)）——$label：语句序列是 保存点 → 取锁 → 重读 → 回滚到保存点 → 释放保存点；上限 1 时后面那张照常重生成并入批，没有 settle_regeneration_deferred',
  async ({ variant }) => {
    const orders: Many[] = [
      variant === 'pushed'
        ? {
            id: 'o1',
            settle: 1100n,
            bases: { 2: 1100n },
            staleAt: 1,
            row: { commission_version: 2 },
          }
        : { id: 'o1', settle: 1100n, bases: { 1: 1234n }, row: { rebate_status: 'VOID' } },
      { id: 'o2', settle: 1100n, bases: { 1: 1234n, 2: 1100n } },
    ];
    const { f, rows } = manyScene(orders);
    const { port, calls } = okPort(f.log);
    const h = manyHarness(orders, rows, { port, cap: 1 });

    await runJob(h.dependencies, f.db);

    const keep = new Set([
      'SAVEPOINT',
      'LOCK order_key',
      'READ order',
      'REGENERATE',
      'ROLLBACK TO SAVEPOINT',
      'RELEASE SAVEPOINT',
    ]);
    const steps = f.trail().filter((t) => keep.has(t));
    const o1 = [
      'SAVEPOINT',
      'LOCK order_key',
      'READ order',
      'ROLLBACK TO SAVEPOINT',
      'RELEASE SAVEPOINT',
    ];
    const o2 = ['SAVEPOINT', 'LOCK order_key', 'READ order', 'REGENERATE', 'RELEASE SAVEPOINT'];
    // pushed：锁前读快照报版本已变，先无锁读一次当前版本（READ order）确认确已推进。
    expect(steps).toEqual([...(variant === 'pushed' ? ['READ order'] : []), ...o1, ...o2]);
    expect(lockedOrders(f, ['o1', 'o2'])).toEqual(['o1', 'o2']);
    expect(calls.map((c) => c.orderId)).toEqual(['o2']);
    expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
      ['o1', variant === 'pushed' ? 'candidate' : 'unexpected_settlement'],
      ['o2', 'candidate'],
    ]);
    expect(h.registerDiff).toHaveBeenCalledTimes(variant === 'pushed' ? 0 : 1);
    expect(deferredEvents(h.logger)).toEqual([]);
    expect(h.logger.error).not.toHaveBeenCalled();
  },
);

it.each([
  { variant: 'still' as const, label: '端口正常返回但再校验仍不一致' },
  { variant: 'throws' as const, label: '端口抛错' },
])(
  '[AC-B2-18d-UNIT#3] $label：回滚到保存点（锁随之放掉）、告警一次、不入批、不占名额——上限 1 时后面那张照常重生成成功并入批，没有 settle_regeneration_deferred',
  async ({ variant }) => {
    const orders: Many[] = [
      { id: 'o1', settle: 1100n, bases: { 1: 1234n, 2: 1107n } },
      { id: 'o2', settle: 1100n, bases: { 1: 1234n, 2: 1100n } },
    ];
    const { f, rows } = manyScene(orders);
    const calls: string[] = [];
    const port: BillSnapshotRegeneration = {
      async regenerate(_trx, input) {
        calls.push(input.orderId);
        f.log.push('REGENERATE');
        if (variant === 'throws' && input.orderId === 'o1') throw new Error('injected');
        return { commissionVersion: input.commissionVersion + 1 };
      },
    };
    const h = manyHarness(orders, rows, { port, cap: 1 });

    await runJob(h.dependencies, f.db);

    expect(calls).toEqual(['o1', 'o2']);
    const trail = f.trail();
    const first = trail.indexOf('REGENERATE');
    expect(trail.slice(first, first + 3)).toEqual([
      'REGENERATE',
      'ROLLBACK TO SAVEPOINT',
      'RELEASE SAVEPOINT',
    ]);
    expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
      ['o1', 'amount_mismatch'],
      ['o2', 'candidate'],
    ]);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.logger.error.mock.calls[0]![0]).toMatchObject({
      alert: AMOUNT_MISMATCH_ALERT,
      order_id: 'o1',
      reason: variant === 'still' ? 'still_mismatched' : 'regeneration_failed',
    });
    expect(f.billUpdates()[0]).toMatchObject({ amount_mismatch_count: 1 });
    expect(deferredEvents(h.logger)).toEqual([]);
  },
);

const ids = Array.from({ length: 501 }, (_, i) => `o${String(i).padStart(3, '0')}`);
const orders: Many[] = ids.map((id) => ({ id, settle: 1100n, bases: { 1: 1234n, 2: 1100n } }));
const last = ids[500]!;

const bill = (cap?: number) => {
  const { f, rows } = manyScene(orders);
  const p = okPort(f.log);
  const h = manyHarness(orders, rows, { port: p.port, ...(cap === undefined ? {} : { cap }) });
  return { f, h, calls: p.calls };
};

it('[AC-B2-18d-UNIT#4] 月结：缺省上限是 500 且与注入 500 逐句相同：501 张都要重生成的单 → 只重生成来源顺序前 500 张，第 501 张不开保存点、不取锁，事件 deferred_count 为 1', async (): Promise<void> => {
  expect(REGENERATION_CAP).toBe(500);
  const unset = bill();
  await runJob(unset.h.dependencies, unset.f.db);
  const injected = bill(500);
  await runJob(injected.h.dependencies, injected.f.db);

  expect(unset.calls).toHaveLength(500);
  expect(unset.calls.map((c) => c.orderId)).not.toContain(last);
  expect(lockedOrders(unset.f, ids)).not.toContain(last);
  expect(lockedOrders(unset.f, ids)).toHaveLength(500);
  expect(unset.h.saved).toHaveLength(500);
  expect(unset.h.saved.map((v) => v.orderId)).not.toContain(last);
  expect(deferredEvents(unset.h.logger)).toEqual([
    [
      { app_id: APP, bill_id: MONTH, platform: 'taobao', run: 'bill', deferred_count: 1 },
      REGENERATION_DEFERRED_EVENT,
    ],
  ]);
  // 不注入与注入 500：语句与轨迹逐句相同（参数里只有 uuid 不同，比 SQL 文本与轨迹）。
  expect(unset.f.statements().map((s) => s.sql)).toEqual(injected.f.statements().map((s) => s.sql));
  expect(unset.f.trail()).toEqual(injected.f.trail());
  expect(deferredEvents(injected.h.logger)).toEqual(deferredEvents(unset.h.logger));
});

it('[AC-B2-18d-UNIT#4] 月结：注入 501 时 501 张都要重生成的单没有留下', async (): Promise<void> => {
  const roomy = bill(501);
  await runJob(roomy.h.dependencies, roomy.f.db);
  expect(roomy.calls).toHaveLength(501);
  expect(deferredEvents(roomy.h.logger)).toEqual([]);
});

it('[AC-B2-18d-UNIT#4] 补充入口与月结同一个缺省上限 500：501 张都要重生成的单 → 只重生成来源顺序前 500 张，第 501 张只在分块重读时短暂取过锁、之后不开保存点、不取锁，事件 deferred_count 为 1', async (): Promise<void> => {
  // 补充入口：同一个缺省。
  const { f, rows } = manyScene(orders, SUPPLEMENT_BILL);
  const sp = okPort(f.log);
  const k = manyHarness(orders, rows, { port: sp.port });
  await runSupplement(k.dependencies, f.db);
  expect(sp.calls).toHaveLength(500);
  expect(sp.calls.map((c) => c.orderId)).not.toContain(last);
  const followUnion = f.log.findIndex(
    (e) => typeof e !== 'string' && /^savepoint settle_bill_follow_union$/i.test(e.sql),
  );
  expect(followUnion).toBeGreaterThan(-1);
  // 分块重读（B2-04re，D10-3046 (7)）里 501 张都短暂取过锁；之后被留下的那张不再取锁。
  expect(lockedOrders(f, ids).filter((id) => id === last)).toHaveLength(1);
  expect(lockedOrders(f, ids, followUnion)).not.toContain(last);
  expect(lockedOrders(f, ids, followUnion)).toHaveLength(500);
  expect(
    f.log.filter(
      (e) => typeof e !== 'string' && /^savepoint settle_bill_follow_union$/i.test(e.sql),
    ),
  ).toHaveLength(500);
  expect(deferredEvents(k.logger)).toEqual([
    [
      { app_id: APP, bill_id: MONTH, platform: 'taobao', run: 'supplement', deferred_count: 1 },
      REGENERATION_DEFERRED_EVENT,
    ],
  ]);
});

it.each([0, -1, 1.5, Number.NaN])(
  '[AC-B2-18d-UNIT#5] 非法上限 %s：月结、补充发起、开关打开重校验、后台补充都抛 RangeError，此前没有任何语句（不写任务行、账单行、批次、差错单），端口不被调用；regenerationCapOf 缺省取 500',
  async (cap) => {
    expect(regenerationCapOf(undefined)).toBe(500);
    expect(regenerationCapOf(3)).toBe(3);
    expect(() => regenerationCapOf(cap)).toThrow(RangeError);

    const orders: Many[] = [{ id: 'o1', settle: 1100n, bases: { 1: 1234n, 2: 1100n } }];
    const { f, rows } = manyScene(orders, SUPPLEMENT_BILL);
    const { port, calls } = okPort(f.log);
    const h = manyHarness(orders, rows, { port, cap });

    await expect(runJob(h.dependencies, f.db)).rejects.toThrow(RangeError);
    await expect(runSupplement(h.dependencies, f.db)).rejects.toThrow(RangeError);
    const command = createSupplementCommand(h.dependencies);
    await expect(
      command.recheckCurrentBill(f.db, { appId: APP, platform: 'taobao', requestedAt: BEFORE }),
    ).rejects.toThrow(RangeError);
    await expect(
      f.db.transaction().execute((trx) =>
        command.launchInTransaction(trx, {
          appId: APP,
          billId: MONTH,
          platform: 'taobao',
          requestedAt: BEFORE,
        }),
      ),
    ).rejects.toThrow(RangeError);

    expect(f.statements()).toEqual([]);
    expect(calls).toEqual([]);
    expect(h.registerDiff).not.toHaveBeenCalled();
  },
);

it('[AC-B2-18d-UNIT#6] 名额用完之后分类照旧（r1 第 4 节第 1、7、9 条）：我方已作废而联盟有结算、金额超差（快照 1200、结算 1000）的单照常登记恰一次 union_mismatch、逐单 unexpected_settlement；只在维权中的超差单照常 deferred；零结算正基数照常告警；应结未结照常计数；相符的入批；只有待入账、超差的那张留下（deferred_count 1）', async () => {
  const orders: Many[] = [
    { id: 'a-regen', settle: 1000n, bases: { 1: 1200n, 2: 1000n } },
    { id: 'b-void', settle: 1000n, bases: { 1: 1200n }, source: { rebateStatus: 'VOID' } },
    { id: 'c-rights', settle: 1000n, bases: { 1: 1200n }, source: { rightsPending: true } },
    { id: 'd-over', settle: 1000n, bases: { 1: 1200n, 2: 1000n } },
    { id: 'e-zero', settle: 0n, bases: { 1: 1000n } },
    { id: 'f-missing', settle: null, bases: { 1: 1000n } },
    { id: 'g-match', settle: 1000n, bases: { 1: 1000n } },
  ];
  const ids = orders.map((o) => o.id);

  const { f, rows } = manyScene(orders);
  const { port, calls } = okPort(f.log);
  const h = manyHarness(orders, rows, { port, cap: 1 });
  await runJob(h.dependencies, f.db);

  expect(calls.map((c) => c.orderId)).toEqual(['a-regen']);
  expect(lockedOrders(f, ids)).toEqual(['a-regen']);
  expect(h.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['a-regen', 'candidate'],
    ['b-void', 'unexpected_settlement'],
    ['c-rights', 'deferred'],
    ['e-zero', 'amount_mismatch'],
    ['f-missing', 'missing_settlement'],
    ['g-match', 'candidate'],
  ]);
  expect(h.registerDiff).toHaveBeenCalledTimes(1);
  expect(h.registerDiff.mock.calls[0]![1]).toMatchObject({
    type: 'union_mismatch',
    refId: 'taobao:b-void',
    expectedFen: 0n,
    actualFen: 1000n,
  });
  expect(f.billUpdates()[0]).toMatchObject({
    error_count: 1,
    held_count: 1,
    unsettled_count: 1,
    amount_mismatch_count: 1,
  });
  expect(h.logger.error).toHaveBeenCalledTimes(1);
  expect(h.logger.error.mock.calls[0]![0]).toMatchObject({
    order_id: 'e-zero',
    reason: 'zero_settlement',
  });
  expect(deferredEvents(h.logger)).toEqual([
    [
      { app_id: APP, bill_id: MONTH, platform: 'taobao', run: 'bill', deferred_count: 1 },
      REGENERATION_DEFERRED_EVENT,
    ],
  ]);

  // 补充入口同样分类；补充不写账单计数。
  const s = manyScene(orders, SUPPLEMENT_BILL);
  const sp = okPort(s.f.log);
  const k = manyHarness(orders, s.rows, { port: sp.port, cap: 1 });
  await runSupplement(k.dependencies, s.f.db);
  expect(sp.calls.map((c) => c.orderId)).toEqual(['a-regen']);
  expect(k.saved.map((v) => [v.orderId, v.result])).toEqual([
    ['a-regen', 'candidate'],
    ['b-void', 'unexpected_settlement'],
    ['c-rights', 'deferred'],
    ['e-zero', 'amount_mismatch'],
    ['f-missing', 'missing_settlement'],
    ['g-match', 'candidate'],
  ]);
  expect(k.registerDiff).toHaveBeenCalledTimes(1);
  expect(s.f.billUpdates()).toEqual([]);
  const followUnion = s.f.log.findIndex(
    (e) => typeof e !== 'string' && /^savepoint settle_bill_follow_union$/i.test(e.sql),
  );
  expect(lockedOrders(s.f, ids, followUnion)).toEqual(['a-regen']);
  expect(deferredEvents(k.logger)).toEqual([
    [
      { app_id: APP, bill_id: MONTH, platform: 'taobao', run: 'supplement', deferred_count: 1 },
      REGENERATION_DEFERRED_EVENT,
    ],
  ]);
});

it('[AC-B2-18d-UNIT#7] 留下 0 张时不打 settle_regeneration_deferred（月结与补充）', async () => {
  const orders: Many[] = [
    { id: 'o1', settle: 1100n, bases: { 1: 1234n, 2: 1100n } },
    { id: 'o2', settle: 1100n, bases: { 1: 1100n } },
  ];
  const { f, rows } = manyScene(orders);
  const h = manyHarness(orders, rows, { port: okPort(f.log).port, cap: 1 });
  await runJob(h.dependencies, f.db);
  expect(h.saved.map((v) => v.result)).toEqual(['candidate', 'candidate']);
  expect(deferredEvents(h.logger)).toEqual([]);

  const s = manyScene(orders, SUPPLEMENT_BILL);
  const k = manyHarness(orders, s.rows, { port: okPort(s.f.log).port, cap: 1 });
  await runSupplement(k.dependencies, s.f.db);
  expect(k.saved.map((v) => v.result)).toEqual(['candidate', 'candidate']);
  expect(deferredEvents(k.logger)).toEqual([]);
});
