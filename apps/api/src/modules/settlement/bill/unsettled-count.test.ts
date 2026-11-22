// 单元测试（不连库）：B2-18a 应结未结只计数（BR-FUND-04 ④，2026-11-21 改写）。账单日任务与补充发起遇
// missing_settlement 不登记差错单、不计 error_count；账单日任务把本平台应结未结数与 error_count、held_count
// 写在同一条 UPDATE、同一事务里；补充发起不写 settle_bills；任何路径都不写订单行（含 settle_period）。
// Kysely 跑在记录语句的脚本化驱动上；真实 PG 行为由 test/spec/settlement/bill-unsettled-count 覆盖。
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
  createBillJob,
  type BillJobDependencies,
  type BillSourceOrder,
  type BillSourceRow,
  type BillValidation,
} from './job.ts';
import { createSupplementCommand } from './supplement/command.ts';

const APP = 'unit-app';
const MONTH = '2032-06';
const RUN = new Date('2032-07-24T00:01:00+08:00');
const NOW = new Date('2032-07-24T00:10:00+08:00');
const BEFORE = new Date('2032-07-20T10:00:00+08:00');

type Row = Record<string, unknown>;

interface Logged {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** 账单行初值（迁移前形状的行两新列为 NULL）。 */
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

/**
 * 记录每条语句与 BEGIN / COMMIT / ROLLBACK 的脚本化驱动。账单行由 bill 给出；failBillUpdate 让写账单计数的
 * UPDATE 抛错（模拟提交前故障）。
 */
function fakeDb(options: { bill?: Row; failBillUpdate?: boolean } = {}) {
  const log: (Logged | 'BEGIN' | 'COMMIT' | 'ROLLBACK')[] = [];
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      log.push({ sql: text, params: compiled.parameters });
      if (/^insert into "app"\."settle_jobs"/.test(text)) {
        return Promise.resolve(result([{ id: 'job-1' }]));
      }
      if (/^update "app"\."settle_jobs"/.test(text)) return Promise.resolve(result([], 1n));
      if (/^insert into "app"\."settle_bills"/.test(text)) return Promise.resolve(result([], 0n));
      if (/^select .* from "app"\."settle_bills".* for update$/.test(text)) {
        return Promise.resolve(result([options.bill ?? billRow()]));
      }
      if (/^update "app"\."settle_bills"/.test(text)) {
        if (options.failBillUpdate === true) {
          return Promise.reject(new Error('injected bill count failure'));
        }
        return Promise.resolve(result([], 1n));
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
  const statements = () => log.filter((e): e is Logged => typeof e !== 'string');
  /** 写 settle_bills 计数的 UPDATE：列名 → 参数值。 */
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
  return { db, log, statements, billUpdates };
}

let seq = 0;
function waiting(values: Partial<BillSourceOrder> = {}): BillSourceOrder {
  seq += 1;
  return {
    orderId: `order-${String(seq)}`,
    rebateStatus: 'WAITING',
    settlePeriod: MONTH,
    hold: false,
    rightsPending: false,
    commissionVersion: 1,
    unionAuthoritative: false,
    ...values,
  };
}

function row(order: BillSourceOrder | null, commissionFen?: bigint): BillSourceRow {
  return {
    orderKey: `taobao:${order?.orderId ?? `none-${String((seq += 1))}`}`,
    order,
    settlements:
      commissionFen === undefined
        ? []
        : [{ seq: 1, source: 'API', createdAt: BEFORE, settledAt: BEFORE, commissionFen }],
  };
}

function deps(rows: readonly BillSourceRow[], config: Record<string, unknown> = {}) {
  const registerDiff = vi.fn<BillJobDependencies['registerDiff']>(
    async (_trx, input) =>
      ({
        expected_fen: input.expectedFen,
        actual_fen: input.actualFen,
      }) as Awaited<ReturnType<BillJobDependencies['registerDiff']>>,
  );
  const saveValidations = vi.fn<BillJobDependencies['saveValidations']>(async () => undefined);
  const dependencies: BillJobDependencies = {
    clock: new FixedClock(NOW),
    config: { get: async (_app, key) => config[key] ?? null },
    readSource: async () => rows,
    // 1000 分结算佣金、预留 15% → B_settle 850 = 快照基数，候选。
    readSnapshot: async () => ({
      baseFen: 850n,
      reserveBp: 1500,
      beneficiaries: [{ userId: 'u-1', role: 'self', ratioBp: 6500, initialStatus: 'active' }],
      forfeitedEvents: [],
    }),
    readTljDeductFen: async () => 0n,
    snapshotStatus: async () => ({ state: 'complete', snapshotId: 's-1', waitingComparable: true }),
    registerDiff,
    saveValidations,
  };
  return { dependencies, registerDiff, saveValidations };
}

function savedResults(saveValidations: ReturnType<typeof deps>['saveValidations']) {
  return saveValidations.mock.calls.flatMap((call) =>
    (call[2] as readonly BillValidation[]).map((v) => [v.orderKey, v.result]),
  );
}

it('[AC-B2-18a-UNIT#1] 账单日任务遇应结未结：不调 registerDiff、不计 error_count，unsettled_count 与 error_count / held_count 同一条 UPDATE 写入，amount_mismatch_count 不写', async () => {
  const missingA = row(waiting());
  const missingB = row(waiting());
  const voided = row(waiting({ rebateStatus: 'VOID' }), 1000n);
  const held = row(waiting({ hold: true }), 1000n);
  const d = deps([missingA, missingB, voided, held]);
  const f = fakeDb();

  const result = await createBillJob(d.dependencies).run(f.db, {
    appId: APP,
    platform: 'taobao',
    runAt: RUN,
  });

  expect(result.outcome).toBe('generated');
  expect(d.registerDiff.mock.calls.map((c) => [c[1].type, c[1].refId])).toEqual([
    ['union_mismatch', voided.orderKey],
  ]);
  expect(f.billUpdates()).toEqual([
    expect.objectContaining({ error_count: 1, held_count: 1, unsettled_count: 2 }),
  ]);
  expect(f.billUpdates()[0]).not.toHaveProperty('amount_mismatch_count');
  expect(savedResults(d.saveValidations)).toEqual([
    [missingA.orderKey, 'missing_settlement'],
    [missingB.orderKey, 'missing_settlement'],
    [voided.orderKey, 'unexpected_settlement'],
    [held.orderKey, 'deferred'],
  ]);
});

it('[AC-B2-18a-UNIT#2] 应结未结数按账单行锁内读出的旧值累加：旧值 3 → 5；迁移前的 NULL 按 0 起加；本平台没有应结未结时落 0 而不是 NULL', async () => {
  const run = async (bill: Row, rows: readonly BillSourceRow[]) => {
    const f = fakeDb({ bill });
    await createBillJob(deps(rows).dependencies).run(f.db, {
      appId: APP,
      platform: 'taobao',
      runAt: RUN,
    });
    return f.billUpdates();
  };
  const jdDone = {
    platform_order_counts: { jd: 0 },
    platform_settle_commission_totals: { jd: '0' },
  };
  expect(
    await run(billRow({ ...jdDone, error_count: 1, held_count: 0, unsettled_count: 3 }), [
      row(waiting()),
      row(waiting()),
    ]),
  ).toEqual([expect.objectContaining({ error_count: 1, held_count: 0, unsettled_count: 5 })]);
  expect(
    await run(billRow({ ...jdDone, error_count: 4, held_count: 1 }), [row(waiting())]),
  ).toEqual([expect.objectContaining({ error_count: 4, held_count: 1, unsettled_count: 1 })]);
  expect(await run(billRow(), [row(waiting(), 1000n)])).toEqual([
    expect.objectContaining({ error_count: 0, held_count: 0, unsettled_count: 0 }),
  ]);
});

it('[AC-B2-18a-UNIT#3] 必满足项 ①：本账单第一个平台（出账前没有账单行）的计数在出账事务内写入——INSERT 账单行、行锁、计数 UPDATE、任务完成都在同一 BEGIN…COMMIT 之间，提交后不再写 settle_bills', async () => {
  const d = deps([row(waiting()), row(waiting(), 1000n)], { 'credit.enabled.taobao': 'on' });
  const f = fakeDb();

  await createBillJob(d.dependencies).run(f.db, { appId: APP, platform: 'taobao', runAt: RUN });

  const begin = f.log.indexOf('BEGIN');
  const commit = f.log.indexOf('COMMIT');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(f.log.filter((e) => e === 'BEGIN' || e === 'COMMIT')).toEqual(['BEGIN', 'COMMIT']);
  const at = (pattern: RegExp) =>
    f.log.findIndex((e) => typeof e !== 'string' && pattern.test(e.sql));
  const insertBill = at(/^insert into "app"\."settle_bills"/);
  const lockBill = at(/^select .* from "app"\."settle_bills".* for update$/);
  const countWrite = at(/^update "app"\."settle_bills" set .*"unsettled_count" = /);
  const jobDone = at(/^update "app"\."settle_jobs"/);
  expect(begin < insertBill && insertBill < lockBill && lockBill < countWrite).toBe(true);
  expect(countWrite < jobDone && jobDone < commit).toBe(true);
  expect(f.log.slice(commit + 1)).toEqual([]);
  expect(f.billUpdates()).toEqual([expect.objectContaining({ unsettled_count: 1 })]);
});

it('[AC-B2-18a-UNIT#4] 必满足项 ①：计数 UPDATE 失败时整笔回滚、不提交，之后不另起语句补写计数', async () => {
  const d = deps([row(waiting())]);
  const f = fakeDb({ failBillUpdate: true });

  await expect(
    createBillJob(d.dependencies).run(f.db, { appId: APP, platform: 'taobao', runAt: RUN }),
  ).rejects.toThrow('injected bill count failure');

  const first = f.log.indexOf('ROLLBACK');
  expect(first).toBeGreaterThan(0);
  expect(f.log.slice(0, first)).not.toContain('COMMIT');
  // 回滚之后只有把任务键记为 failed 的语句，不再写 settle_bills。
  const after = f.log.slice(first + 1).filter((e): e is Logged => typeof e !== 'string');
  expect(after.every((s) => !s.sql.includes('"settle_bills"'))).toBe(true);
  expect(after.some((s) => /"settle_jobs"/.test(s.sql))).toBe(true);
});

it('[AC-B2-18a-UNIT#5] 必满足项 ③：应结未结的单下一期有了结算数据进主批次——任何语句都不写订单表、不碰 settle_period，来源事实不变', async () => {
  const late = waiting({ settlePeriod: '2032-05' });
  // 下一期（账单月 2032-06）的任务：上期应结未结的单 settle_period 仍是 2032-05，有了结算数据就是候选。
  const source = [row(late, 1000n), row(waiting())];
  const before = structuredClone(source);
  const d = deps(source, { 'credit.enabled.taobao': 'on' });
  const f = fakeDb();

  await createBillJob(d.dependencies).run(f.db, { appId: APP, platform: 'taobao', runAt: RUN });

  expect(savedResults(d.saveValidations)).toEqual([
    [source[0]!.orderKey, 'candidate'],
    [source[1]!.orderKey, 'missing_settlement'],
  ]);
  const items = f
    .statements()
    .filter((s) => /^insert into "app"\."settle_batch_items"/.test(s.sql));
  expect(items).toHaveLength(1);
  expect(items[0]!.params).toContain(late.orderId);
  for (const s of f.statements()) {
    expect(s.sql).not.toMatch(/"orders"/);
    expect(s.sql).not.toMatch(/settle_period/);
  }
  expect(source).toEqual(before);
  expect(d.registerDiff).not.toHaveBeenCalled();
});

it('[AC-B2-18a-UNIT#6] 补充发起遇应结未结：不调 registerDiff、不写 settle_bills（只读锁账单行），逐单结果仍是 missing_settlement', async () => {
  const missing = row(waiting());
  const late = row(waiting(), 1000n);
  const d = deps([missing, late], { 'credit.enabled.taobao': 'on' });
  const f = fakeDb({
    bill: billRow({
      generated_at: NOW,
      platform_order_counts: { taobao: 0 },
      error_count: 0,
      held_count: 0,
      unsettled_count: 2,
    }),
  });

  const result = await createSupplementCommand(d.dependencies).launch(f.db, {
    appId: APP,
    billId: MONTH,
    platform: 'taobao',
    requestedAt: new Date('2032-07-26T10:00:00+08:00'),
  });

  expect(result.outcome).toBe('generated');
  expect(result.batchIds).toHaveLength(1);
  expect(d.registerDiff).not.toHaveBeenCalled();
  expect(f.statements().some((s) => s.sql.includes('"settle_bills"'))).toBe(true);
  expect(f.billUpdates()).toEqual([]);
  expect(
    f
      .statements()
      .filter((s) => /^(insert into|update|delete from) "app"\."settle_bills"/.test(s.sql)),
  ).toEqual([]);
  expect(savedResults(d.saveValidations)).toEqual([
    [missing.orderKey, 'missing_settlement'],
    [late.orderKey, 'candidate'],
  ]);
});
