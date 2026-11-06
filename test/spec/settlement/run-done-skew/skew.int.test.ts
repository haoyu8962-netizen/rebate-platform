// B2-04zu rule tests on a real PostgreSQL (BR-FUND-04 ⑦, BR-TEXT-09; D10-719 ②, FU-B204ZF-CLOCK-SKEW),
// carried into B2-04zy and judged by the count watermark (D10-726): when the executor that publishes
// a rest runs on a clock that lags the worker that finished a batch or credited an order, the run
// must not count an earlier execution's work again and send one more partial part (and one more
// CREDITED notification). BR-TEXT-09: CREDITED only for what was credited, 0 笔不发. "Did this
// execution credit anything" is the sum of app.settle_batches.credited_count over the run's batches
// being greater than app.settle_runs.published_credited_count; no timestamp is compared
// (part_started_at is still written, for audit only, and not asserted here).
//
// Layout of every case: two executors on the same database, each with its own FixedClock — worker Y
// on the harness clock (the one the credit writes credited_at with) and worker X on a FixedClock
// SKEW_MS behind it (re-synced to that lag at the start of each of its deliveries). One run of
// taobao batches: A (one order) finishes on Y; B (three orders) runs on X and is stopped by
// settle.auto.enabled. The executors are built here (the frozen run-done kit's build() always uses the
// harness clock); seeding, the credit, the switch map, resume (SB8) and the event reads come from
// ../run-done/kit.ts unchanged; the counters are read through ../run-credit-watermark/kit.ts.
//
// Each of three timestamps is on its own the latest instant in one case, so an implementation that
// still compares any of them with the start of the execution publishes one more part on a
// zero-credit continue:
//   - order credited_at: AC#1 (B's first order is credited on X after A finished on Y);
//   - batch finished_at: the finished_at case (A's order is credited, A finishes 20 s later, B's
//     first execution credits nothing: its first item is skipped by a changed settlement seq);
//   - obligation closed_at: the closed_at case (a beneficiary batch C closes an obligation on Y after
//     A finished, then stops; B's first execution on X credits nothing). Obligations and their
//     beneficiary items are seeded with the batch-executor kit's beneficiaryItem(); the executors
//     here get a beneficiary port that closes the obligation the way B2-04q does (status done,
//     closed_by R5a, closed_ref = the item id, closed_at = that executor's own clock). The credited
//     beneficiary item counts in C's credited_count like an order item.
// Boundary (separate case, for the rule-test review): the slow worker may move the last batch to
// DONE with finished_at before instants the faster worker already wrote. Its run is then DONE by the
// batch states, and the credits of that execution must still be announced (part=2 done,
// BR-TEXT-09); the other cases move the clock past the lag before the final DONE and do not depend
// on this.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createBatchExecutor,
  type BatchExecuteResult,
  type BeneficiaryItemInput,
  type BeneficiaryItemResult,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import type { SeededOrder } from '../credit/kit.ts';
import {
  BILL,
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  untouched,
  type Fixture,
  type SeededBatch,
} from '../run-done/kit.ts';
import {
  creditedCount,
  runCredited,
  runState,
  watermarkReady,
  type RunState,
} from '../run-credit-watermark/kit.ts';

const p = databaseFixture(createTestDatabase);

/** How far worker X's clock is behind worker Y's (the harness clock). */
const SKEW_MS = 30_000;
/** Past the 10-second bound of the switch reads. */
const SWITCH_STEP_MS = 11_000;
/** finished_at case: time between A's last credit and A's DONE on Y. */
const FINISH_GAP_MS = 20_000;
/** closed_at case: time between A's DONE and the obligation's close on Y. */
const CLOSE_GAP_MS = 5_000;
/** Boundary case: wide enough that X still lies before A's finish when it completes B. */
const WIDE_SKEW_MS = 120_000;

interface Worker {
  /** The FixedClock injected into this executor. */
  readonly clock: FixedClock;
  deliver(b: SeededBatch): Promise<BatchExecuteResult>;
}

/** Executors with their own clocks over one fixture, and the switch helpers they share. */
function rig(f: Fixture) {
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write() {
        // Lines are not asserted here.
      },
    },
  );
  /** Runs inside the credit call of that order (on its transaction), before the real credit. */
  const hooks = new Map<string, (trx: Transaction<DB>) => Promise<void>>();
  /** Runs inside the credit call of that order, after the real credit returned. */
  const afterHooks = new Map<string, () => Promise<void>>();
  /** Runs inside the beneficiary call of that obligation, after it was closed. */
  const closeHooks = new Map<string, () => Promise<void>>();

  /**
   * The beneficiary port as B2-04q completes an obligation, on the item transaction and with the
   * executing worker's own clock: open → done, closed_by R5a, closed_ref = the item id.
   */
  async function closeObligation(
    trx: Transaction<DB>,
    input: BeneficiaryItemInput,
    clock: FixedClock,
  ): Promise<BeneficiaryItemResult> {
    const closed = await trx
      .withSchema('app')
      .updateTable('beneficiary_credits')
      .set({
        status: 'done',
        closed_by: 'R5a',
        closed_ref: input.itemId,
        closed_at: clock.now(),
        row_version: sql<number>`row_version + 1`,
      })
      .where('app_id', '=', input.appId)
      .where('beneficiary_credit_id', '=', input.beneficiaryCreditId)
      .where('status', '=', 'open')
      .executeTakeFirst();
    if (closed.numUpdatedRows !== 1n) throw new Error('the obligation is not open');
    const hook = closeHooks.get(input.beneficiaryCreditId);
    if (hook !== undefined) {
      closeHooks.delete(input.beneficiaryCreditId);
      await hook();
    }
    return { result: 'credited', amountFen: 80n };
  }

  /** lagMs 0: the harness clock itself; otherwise a FixedClock kept lagMs behind it. */
  function worker(lagMs: number): Worker {
    const clock = lagMs === 0 ? f.clock : new FixedClock(f.clock.now());
    const executor = createBatchExecutor({
      db: f.db,
      clock,
      logger,
      config: f.config,
      snapshotStatus: getAssetSnapshotStatus,
      creditOrder: {
        credit: async (trx, input) => {
          const hook = hooks.get(input.orderId);
          if (hook !== undefined) {
            hooks.delete(input.orderId);
            await hook(trx);
          }
          const answer = await f.h.boot().credit(trx, input);
          const after = afterHooks.get(input.orderId);
          if (after !== undefined) {
            afterHooks.delete(input.orderId);
            await after();
          }
          return answer;
        },
      },
      creditBeneficiary: { execute: (trx, input) => closeObligation(trx, input, clock) },
      events: { publish: (trx, event) => f.write(trx, event) },
    });
    return {
      clock,
      deliver(b) {
        // The lag holds at the start of each delivery; the clock stays put during it.
        if (clock !== f.clock) clock.set(new Date(f.clock.now().getTime() - lagMs));
        return executor.run({ appId: f.appId, batchId: b.batchId });
      },
    };
  }

  /** Inside the credit of `o`, settle.auto.enabled goes off: the run stops before the next item. */
  function stopAfter(o: SeededOrder): void {
    hooks.set(o.orderId, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(SWITCH_STEP_MS);
    });
  }

  /** settle.auto.enabled off before the next delivery. */
  function switchOff(): void {
    f.switches.set('settle.auto.enabled', false);
    f.clock.advanceMs(SWITCH_STEP_MS);
  }

  /** After the credit of `o` was written, the harness clock moves on by `ms`. */
  function afterCredit(o: SeededOrder, ms: number): void {
    afterHooks.set(o.orderId, async () => {
      f.clock.advanceMs(ms);
    });
  }

  /** Once the obligation is closed, settle.auto.enabled goes off: the run stops after it. */
  function stopAfterClose(beneficiaryCreditId: string): void {
    closeHooks.set(beneficiaryCreditId, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(SWITCH_STEP_MS);
    });
  }

  return { worker, stopAfter, switchOff, afterCredit, stopAfterClose };
}

/** One delivery of `b` by `w`, with the outcome and the batch status it must leave. */
async function delivered(
  f: Fixture,
  w: Worker,
  b: SeededBatch,
  outcome: 'done' | 'partial',
): Promise<void> {
  expect(await w.deliver(b)).toMatchObject({ outcome });
  expect(await f.status(b)).toBe(outcome === 'done' ? 'DONE' : 'PARTIAL');
}

interface RunRow {
  readonly part: number;
  readonly last_outcome: string | null;
}

function runRow(f: Fixture, runId: string): Promise<RunRow | undefined> {
  return f.db
    .selectFrom('settle_runs')
    .select(['part', 'last_outcome'])
    .where('app_id', '=', f.appId)
    .where('settle_run_id', '=', runId)
    .executeTakeFirst();
}

/** part and last_outcome of the run (part 0 and no outcome while there is no row). */
async function published(f: Fixture, runId: string) {
  const row = await runRow(f, runId);
  return { part: row?.part ?? 0, last_outcome: row?.last_outcome ?? null };
}

/**
 * The run row with its watermark, and the watermark equal to the sum of credited_count over the
 * run's batches (D10-726: what was published is exactly what the batches counted).
 */
async function counted(f: Fixture, runId: string, state: RunState): Promise<void> {
  expect(await runState(f, runId)).toEqual(state);
  expect(await runCredited(f, runId)).toBe(state.watermark);
}

async function creditedAt(f: Fixture, o: SeededOrder): Promise<Date | null> {
  const row = await f.db
    .selectFrom('orders')
    .select('credited_at')
    .where('app_id', '=', f.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  return row.credited_at;
}

/** credited_at of an order that must have been credited, in ms. */
async function creditedMs(f: Fixture, o: SeededOrder): Promise<number> {
  const credited = await creditedAt(f, o);
  if (credited === null) throw new Error('the order has no credited_at');
  return credited.getTime();
}

/** finished_at of a batch that must be DONE, in ms. */
async function finishedMs(f: Fixture, b: SeededBatch): Promise<number> {
  const finished = (await f.stored(b)).finished_at;
  if (finished === null) throw new Error('the batch has no finished_at');
  return finished.getTime();
}

function obligation(f: Fixture, beneficiaryCreditId: string) {
  return f.db
    .selectFrom('beneficiary_credits')
    .select(['status', 'closed_by', 'closed_ref', 'closed_at'])
    .where('app_id', '=', f.appId)
    .where('beneficiary_credit_id', '=', beneficiaryCreditId)
    .executeTakeFirstOrThrow();
}

/** closed_at of an obligation that must have been closed, in ms. */
async function closedMs(f: Fixture, beneficiaryCreditId: string): Promise<number> {
  const closed = (await obligation(f, beneficiaryCreditId)).closed_at;
  if (closed === null) throw new Error('the obligation has no closed_at');
  return closed.getTime();
}

/** One run, one batch per group; `seqs` overrides the settlement seq an order item carries. */
async function seedRunWith(
  f: Fixture,
  groups: readonly (readonly SeededOrder[])[],
  seqs: ReadonlyMap<string, number>,
): Promise<{ runId: string; batches: SeededBatch[] }> {
  const runId = randomUUID();
  const batches: SeededBatch[] = [];
  for (const orders of groups) {
    batches.push(await f.batch(orders, { settle_run_id: runId }, seqs));
  }
  return { runId, batches };
}

/** An order item whose seq no longer matches: the credit skips it (settlement_changed). */
function staleSeq(o: SeededOrder): ReadonlyMap<string, number> {
  return new Map([[o.orderId, o.seq + 1]]);
}

/** The run events of this app without the run id (checked to be `runId`), in publish order. */
async function shapes(f: Fixture, runId: string): Promise<Record<string, unknown>[]> {
  return (await f.runDone()).map((e) => {
    const { settle_run_id: id, ...rest } = e.payload as Record<string, unknown>;
    expect(id).toBe(runId);
    return rest;
  });
}

function shape(part: number, outcome: 'done' | 'partial') {
  return { bill_id: BILL, part, outcome, batch_count: 2 };
}

/** Seeds the run (A: one order, B: three orders) and builds Y (harness clock) and X (lagging). */
async function setUp(tag: string, lagMs: number) {
  const f = await fixture(p.db);
  const r = rig(f);
  const groups = await f.orderGroups(tag, [1, 3]);
  const { runId, batches } = await f.seedRun(groups);
  return {
    f,
    r,
    y: r.worker(0),
    x: r.worker(lagMs),
    runId,
    a: at(batches, 0),
    b: at(batches, 1),
    aOrders: at(groups, 0),
    bOrders: at(groups, 1),
  };
}

/**
 * A finishes on Y (the run does not rest: B still waits); then B starts on X, credits its first
 * order and is stopped by the switch → part=1 partial, published by X.
 */
async function opening(s: Awaited<ReturnType<typeof setUp>>): Promise<void> {
  const { f, r, x, y, a, b, runId, bOrders } = s;
  await delivered(f, y, a, 'done');
  expect(await f.runDone()).toEqual([]);
  f.clock.advanceMs(1_000);
  r.stopAfter(nth(bOrders, 0));
  await delivered(f, x, b, 'partial');
  expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
}

it(
  '[AC-B2-04zu#1][BR-FUND-04][BR-TEXT-09] 跨 worker 时钟落后不多发（订单 credited_at 单独为最大值）：批次 A 在 worker Y 上 DONE；批次 B 在时钟慢 Y 若干秒的 worker X 上入账一单后因 settle.auto.enabled 停住 → 恰一条 part=1 partial（水位 2 = A 的 1 单 + B 的 1 单）；开关恢复、续跑 B、处理下一单前开关再关、零入账回到 PARTIAL → 不发（A 与已入账的那单不算本次入账：各批计数之和仍为 2、不大于水位），run_done 仍只有 part=1，不出现 part=2；之后续跑到 DONE → 发 part=2 done',
  async () => {
    await watermarkReady(p.db);
    const s = await setUp('skew-zero', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    await opening(s);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    expect(await f.status(a)).toBe('DONE');
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 2 });
    // 本例 credited_at 单独为最大值：B 第 1 单的入账晚于 A 的完成、A 那单的入账与发布方 X 的时钟。
    const publisherAt = x.clock.now().getTime();
    const creditedB = await creditedMs(f, nth(bOrders, 0));
    expect(creditedB).toBeGreaterThan(await finishedMs(f, a));
    expect(creditedB).toBeGreaterThan(await creditedMs(f, nth(aOrders, 0)));
    expect(creditedB).toBeGreaterThan(publisherAt);

    // 续跑 B，处理第 2 单之前开关再次关闭：本次执行一笔都没入账。
    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);
    expect(await published(f, runId)).toEqual({ part: 1, last_outcome: 'partial' });
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 2 });
    await creditedOnce(f, nth(aOrders, 0));
    await creditedOnce(f, nth(bOrders, 0));
    await untouched(f, nth(bOrders, 1));
    await untouched(f, nth(bOrders, 2));

    // 再续跑到 DONE（时钟先走过偏差）：下一条是 part=2 done。
    f.switchBackOn();
    f.clock.advanceMs(2 * SKEW_MS);
    await f.resume(b);
    await delivered(f, x, b, 'done');
    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    await counted(f, runId, { part: 2, last_outcome: 'done', watermark: 4 });
    for (const o of [...aOrders, ...bOrders]) await creditedOnce(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#2][BR-FUND-04][BR-TEXT-09] 正常续跑仍发、只计本次入账：同上布局，part=1 partial（水位 2）之后续跑 B 在 X 上真的入账了第 2 单再停住 → 发 part=2 partial，水位 3；两次水位之差 1 就是本次执行入账的第 2 单，A 的订单、A 的完成与 part=1 已入账的第 1 单都在上一个水位里（A 计数仍 1，B 计数 1 → 2）',
  async () => {
    await watermarkReady(p.db);
    const s = await setUp('skew-more', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    await opening(s);
    const first = await runState(f, runId);
    expect(first).toEqual({ part: 1, last_outcome: 'partial', watermark: 2 });
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 1]);

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'partial', 2),
      f.runEvent(runId, 2, 'partial', 2),
    ]);
    await counted(f, runId, { part: 2, last_outcome: 'partial', watermark: 3 });

    // 本次执行 = 两次水位之间：只含本次入账的第 2 单。
    const second = await runState(f, runId);
    expect(second.watermark - first.watermark).toBe(1);
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 2]);

    await creditedOnce(f, nth(aOrders, 0));
    await creditedOnce(f, nth(bOrders, 0));
    await creditedOnce(f, nth(bOrders, 1));
    await untouched(f, nth(bOrders, 2));
  },
  TIMEOUT,
);

interface Step {
  readonly label: string;
  readonly events: Record<string, unknown>[];
  readonly run: { readonly part: number; readonly last_outcome: string | null };
}

/**
 * The whole flow: A done on Y; B on X credits one order and stops; continue, stopped again before
 * any credit; continue, credits one more order and stops; continue to DONE (the clock first moves
 * past the lag). After every step: the run events (without the run id) and the run row.
 */
async function flow(tag: string, lagMs: number): Promise<Step[]> {
  const s = await setUp(tag, lagMs);
  const { f, r, x, runId, b, aOrders, bOrders } = s;
  const steps: Step[] = [];
  async function record(label: string): Promise<void> {
    steps.push({ label, events: await shapes(f, runId), run: await published(f, runId) });
  }

  await delivered(f, s.y, s.a, 'done');
  await record('A 在 Y 上完成');
  f.clock.advanceMs(1_000);
  r.stopAfter(nth(bOrders, 0));
  await delivered(f, x, b, 'partial');
  await record('B 在 X 上入账一单后停住');

  f.switchBackOn();
  await f.resume(b);
  r.switchOff();
  await delivered(f, x, b, 'partial');
  await record('续跑零入账再停');

  f.switchBackOn();
  await f.resume(b);
  r.stopAfter(nth(bOrders, 1));
  await delivered(f, x, b, 'partial');
  await record('续跑入账一单后停住');

  f.switchBackOn();
  f.clock.advanceMs(2 * SKEW_MS);
  await f.resume(b);
  await delivered(f, x, b, 'done');
  await record('续跑到完成');

  for (const o of [...aOrders, ...bOrders]) await creditedOnce(f, o);
  return steps;
}

it(
  '[AC-B2-04zu#3][BR-FUND-04][BR-TEXT-09] 时钟一致时行为不变：两实例用同一 FixedClock 跑完整流程（A 完成 → B 入账一单停住 → 续跑零入账再停 → 续跑入账一单停住 → 续跑到完成），每步的 run_done 序列与 settle_runs 的 part / last_outcome 依次为 无 / part=1 partial / 不变 / part=2 partial / part=3 done；X 时钟落后时同一流程每步结果与之完全相同',
  async () => {
    const empty: Step['events'] = [];
    const expected: Step[] = [
      { label: 'A 在 Y 上完成', events: empty, run: { part: 0, last_outcome: null } },
      {
        label: 'B 在 X 上入账一单后停住',
        events: [shape(1, 'partial')],
        run: { part: 1, last_outcome: 'partial' },
      },
      {
        label: '续跑零入账再停',
        events: [shape(1, 'partial')],
        run: { part: 1, last_outcome: 'partial' },
      },
      {
        label: '续跑入账一单后停住',
        events: [shape(1, 'partial'), shape(2, 'partial')],
        run: { part: 2, last_outcome: 'partial' },
      },
      {
        label: '续跑到完成',
        events: [shape(1, 'partial'), shape(2, 'partial'), shape(3, 'done')],
        run: { part: 3, last_outcome: 'done' },
      },
    ];

    const same = await flow('skew-same', 0);
    expect(same).toStrictEqual(expected);
    const lagging = await flow('skew-lag', SKEW_MS);
    expect(lagging).toStrictEqual(same);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#4][BR-FUND-04] 水位只来自计数：X 每次发布后直接读 settle_runs 行，published_credited_count 等于本 run 各批 credited_count 之和（A 的 1 单加 B 已入账的单数：2、3、4），A 的计数一直是 1、B 的计数逐次加 1，与发布方 X 的时钟和任何时间戳无关（part=1 partial、part=2 partial、part=3 done 三次都成立）',
  async () => {
    await watermarkReady(p.db);
    const s = await setUp('skew-floor', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    const orders = [...aOrders, ...bOrders];
    async function marked(state: RunState): Promise<void> {
      await counted(f, runId, state);
      expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([
        1,
        state.watermark - 1,
      ]);
    }

    await opening(s);
    await marked({ part: 1, last_outcome: 'partial', watermark: 2 });

    f.switchBackOn();
    await f.resume(b);
    r.stopAfter(nth(bOrders, 1));
    await delivered(f, x, b, 'partial');
    await marked({ part: 2, last_outcome: 'partial', watermark: 3 });

    f.switchBackOn();
    f.clock.advanceMs(2 * SKEW_MS);
    await f.resume(b);
    await delivered(f, x, b, 'done');
    await marked({ part: 3, last_outcome: 'done', watermark: 4 });
    for (const o of orders) await creditedOnce(f, o);
  },
  TIMEOUT,
);

/**
 * One run of A (one order) and B (three orders, the first with a stale settlement seq); Y on the
 * harness clock, X lagMs behind it.
 */
async function staleSetUp(tag: string, lagMs: number) {
  const f = await fixture(p.db);
  const r = rig(f);
  const groups = await f.orderGroups(tag, [1, 3]);
  const aOrders = at(groups, 0);
  const bOrders = at(groups, 1);
  const { runId, batches } = await seedRunWith(f, groups, staleSeq(nth(bOrders, 0)));
  return {
    f,
    r,
    y: r.worker(0),
    x: r.worker(lagMs),
    runId,
    a: at(batches, 0),
    b: at(batches, 1),
    aOrders,
    bOrders,
  };
}

/**
 * A credits its order on Y, the clock moves FINISH_GAP_MS on, A is DONE on Y (the run waits for B);
 * B starts on X, its first item is skipped and the switch goes off → PARTIAL with nothing credited;
 * part=1 partial is published by X for A's credit (watermark 1). A.finished_at is then on its own
 * the greatest instant: after A's credit, after X's clock, and no order of B has credited_at.
 */
async function finishedOpening(s: Awaited<ReturnType<typeof staleSetUp>>) {
  const { f, r, x, y, a, b, runId, aOrders, bOrders } = s;
  r.afterCredit(nth(aOrders, 0), FINISH_GAP_MS);
  await delivered(f, y, a, 'done');
  expect(await f.runDone()).toEqual([]);
  r.stopAfter(nth(bOrders, 0));
  await delivered(f, x, b, 'partial');
  expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
  expect(await f.itemOf(b, nth(bOrders, 0))).toMatchObject({
    result: 'skipped',
    skip_reason: 'settlement_changed',
  });

  const finished = await finishedMs(f, a);
  const publisherAt = x.clock.now().getTime();
  expect(finished).toBeGreaterThan(await creditedMs(f, nth(aOrders, 0)));
  expect(finished).toBeGreaterThan(publisherAt);
  for (const o of bOrders) expect(await creditedAt(f, o)).toBeNull();
  return { finished };
}

it(
  '[AC-B2-04zu#1][AC-B2-04zu#4][BR-FUND-04][BR-TEXT-09] 批次 finished_at 单独为最大值：A 那单在 Y 上入账、稍后 A 才在 Y 上 DONE；B 在时钟慢 Y 若干秒的 X 上首单因结算记录 seq 已变被跳过、随即因开关停住，零入账 → 恰一条 part=1 partial（计入的是 A 那单，水位 1）；开关恢复、续跑 B 零入账再停住 → 不发 part=2（拿 finished_at 与起点比较时会把 A 的完成再算一次），行仍为 part=1 水位 1，A 计数 1、B 计数 0',
  async () => {
    await watermarkReady(p.db);
    const s = await staleSetUp('skew-finished', SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    await finishedOpening(s);
    const partial = f.runEvent(runId, 1, 'partial', 2);
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 1 });

    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 1 });
    expect([await creditedCount(f, a), await creditedCount(f, b)]).toEqual([1, 0]);

    expect(await f.status(a)).toBe('DONE');
    await creditedOnce(f, nth(aOrders, 0));
    for (const o of bOrders) await untouched(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#1][AC-B2-04zu#4][BR-FUND-04][BR-TEXT-09] 受益人补记 closed_at 单独为最大值：A 在 Y 上 DONE；稍后补记批次 C 在 Y 上完成一笔受益人义务（closed_at 取 Y 的时钟）后因开关停住为 PARTIAL；B 在时钟慢 Y 若干秒的 X 上首单被跳过、随即停住，零入账 → 恰一条 part=1 partial（水位 2 = A 的 1 单 + C 的 1 笔补记）；开关恢复、续跑 B 零入账再停住 → 不发 part=2（拿 closed_at 与起点比较时会把 C 的那笔义务再算一次），行仍为 part=1 水位 2，A、C、B 计数为 1、1、0',
  async () => {
    await watermarkReady(p.db);
    const f = await fixture(p.db);
    const r = rig(f);
    const groups = await f.orderGroups('skew-closed', [1, 3, 2]);
    const aOrders = at(groups, 0);
    const bOrders = at(groups, 1);
    const held = at(groups, 2);
    const { runId, batches } = await seedRunWith(
      f,
      [aOrders, [], bOrders],
      staleSeq(nth(bOrders, 0)),
    );
    const a = at(batches, 0);
    const c = at(batches, 1);
    const b = at(batches, 2);
    // C: two open first_credit obligations (direct of two other orders), one beneficiary item each.
    const first = await f.beneficiaryItem(c, nth(held, 0), 'direct');
    const second = await f.beneficiaryItem(c, nth(held, 1), 'direct');
    const y = r.worker(0);
    const x = r.worker(SKEW_MS);
    const partial = f.runEvent(runId, 1, 'partial', 3);

    await delivered(f, y, a, 'done');
    f.clock.advanceMs(CLOSE_GAP_MS);
    r.stopAfterClose(first.beneficiaryCreditId);
    await delivered(f, y, c, 'partial');
    expect(await f.runDone()).toEqual([]);

    f.switchBackOn();
    r.stopAfter(nth(bOrders, 0));
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);

    // closed_at 单独为最大值：晚于 A 的完成、A 那单的入账与发布方 X 的时钟；B 没有入账。
    const closed = await closedMs(f, first.beneficiaryCreditId);
    const publisherAt = x.clock.now().getTime();
    expect(closed).toBeGreaterThan(await finishedMs(f, a));
    expect(closed).toBeGreaterThan(await creditedMs(f, nth(aOrders, 0)));
    expect(closed).toBeGreaterThan(publisherAt);
    for (const o of bOrders) expect(await creditedAt(f, o)).toBeNull();
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 2 });

    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 2 });
    expect([
      await creditedCount(f, a),
      await creditedCount(f, c),
      await creditedCount(f, b),
    ]).toEqual([1, 1, 0]);

    expect(await f.status(c)).toBe('PARTIAL');
    expect(await f.item(c, first.beneficiaryCreditId)).toMatchObject({ result: 'credited' });
    expect(await f.item(c, second.beneficiaryCreditId)).toMatchObject({ result: null });
    expect(await obligation(f, first.beneficiaryCreditId)).toMatchObject({
      status: 'done',
      closed_by: 'R5a',
      closed_ref: first.itemId,
    });
    expect(await obligation(f, second.beneficiaryCreditId)).toMatchObject({
      status: 'open',
      closed_at: null,
    });
    await creditedOnce(f, nth(aOrders, 0));
    for (const o of bOrders) await untouched(f, o);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zu#1][BR-FUND-04][BR-TEXT-09] 边界（供规则测试评审判断）：慢时钟 worker 把最后一批置 DONE、finished_at 早于快 worker 已写下的时刻，仍按批次状态与计数发 done——布局同 finished_at 一例而 X 落后更多；零入账续跑不发 part=2 之后，开关恢复、续跑 B 在 X 上入账余下两单并 DONE（不先让时钟走过偏差，X 此刻仍早于 A.finished_at）→ 恰发 part=2 done，run_done 共两条，水位 1 → 3',
  async () => {
    await watermarkReady(p.db);
    const s = await staleSetUp('skew-boundary', WIDE_SKEW_MS);
    const { f, r, x, runId, a, b, aOrders, bOrders } = s;
    const { finished } = await finishedOpening(s);
    const partial = f.runEvent(runId, 1, 'partial', 2);

    f.switchBackOn();
    await f.resume(b);
    r.switchOff();
    await delivered(f, x, b, 'partial');
    expect(await f.runDone()).toStrictEqual([partial]);
    await counted(f, runId, { part: 1, last_outcome: 'partial', watermark: 1 });

    // 续跑到 DONE：X 完成 B 的时刻仍早于 A 的完成。
    f.switchBackOn();
    await f.resume(b);
    await delivered(f, x, b, 'done');
    expect(x.clock.now().getTime()).toBeLessThan(finished);
    expect(await f.status(a)).toBe('DONE');
    expect(await f.runDone()).toStrictEqual([partial, f.runEvent(runId, 2, 'done', 2)]);
    expect(await published(f, runId)).toEqual({ part: 2, last_outcome: 'done' });
    await counted(f, runId, { part: 2, last_outcome: 'done', watermark: 3 });

    await creditedOnce(f, nth(aOrders, 0));
    await untouched(f, nth(bOrders, 0));
    await creditedOnce(f, nth(bOrders, 1));
    await creditedOnce(f, nth(bOrders, 2));
  },
  TIMEOUT,
);
