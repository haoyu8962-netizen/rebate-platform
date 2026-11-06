// B2-04zt rule tests on a real PostgreSQL (BR-FUND-04 ⑥ ⑦, BR-TEXT-09): the batch's own state move,
// the run's app.settle_runs row and the settle.run_done row of app.event_log are written by one and
// the same transaction, on all three paths that publish the run event:
//   - SB6 (batch DONE), first publish of the run (settle_runs INSERT);
//   - SB7 (batch PARTIAL by a switch), a later part (settle_runs row_version CAS UPDATE);
//   - SB5 c (paused at the execution instant by a switch), first publish of the run.
// Proof: right after the delivery commits and before any further write, the three rows carry the
// same xmin (the id of the transaction that wrote their current version). The executor writes them
// with no SAVEPOINT on that path, and the harness writer inserts event_log on the executor's own
// transaction, so the xmin is the top-level transaction id and can be compared. A control in each
// case shows the comparison tells two transactions apart.
//
// The order credits are not part of that transaction (each item has its own); this file does not
// assert anything about them beyond what the scenarios need.
//
// SB10 (finance starts a paused batch by hand) is not used here; the scenarios follow
// ../run-done/runs.int.test.ts (#24, and the first half of #28).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  RUN_DONE,
  TIMEOUT,
  at,
  databaseFixture,
  fixture,
  nth,
  type Fixture,
  type SeededBatch,
} from '../run-done/kit.ts';

const p = databaseFixture(createTestDatabase);

interface Versions {
  readonly run_xmin: string;
  readonly batch_xmin: string;
  readonly event_xmin: string;
  readonly part: number;
  readonly last_outcome: string | null;
}

/**
 * Committed xmin of the run's settle_runs row, of batch `b`'s settle_batches row and of the
 * settle.run_done row of that run and part in event_log (exactly one such combination expected).
 */
async function versions(
  f: Fixture,
  runId: string,
  b: SeededBatch,
  part: number,
): Promise<Versions> {
  const result = await sql<Versions>`
    SELECT r.xmin::text AS run_xmin,
           b.xmin::text AS batch_xmin,
           e.xmin::text AS event_xmin,
           r.part AS part,
           r.last_outcome AS last_outcome
    FROM app.settle_runs r
    CROSS JOIN app.settle_batches b
    CROSS JOIN app.event_log e
    WHERE r.app_id::text = ${f.appId} AND r.settle_run_id::text = ${runId}
      AND b.app_id::text = ${f.appId} AND b.batch_id::text = ${b.batchId}
      AND e.app_id::text = ${f.appId} AND e.name = ${RUN_DONE}
      AND e.payload->>'settle_run_id' = ${runId}
      AND (e.payload->>'part')::int = ${part}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0);
}

/** Committed xmin of batch `b`'s settle_batches row. */
async function batchXmin(f: Fixture, b: SeededBatch): Promise<string> {
  const result = await sql<{ xmin: string }>`
    SELECT xmin::text AS xmin FROM app.settle_batches
    WHERE app_id::text = ${f.appId} AND batch_id::text = ${b.batchId}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).xmin;
}

/** Committed xmin of the settle.run_done row of that run and part. */
async function eventXmin(f: Fixture, runId: string, part: number): Promise<string> {
  const result = await sql<{ xmin: string }>`
    SELECT xmin::text AS xmin FROM app.event_log
    WHERE app_id::text = ${f.appId} AND name = ${RUN_DONE}
      AND payload->>'settle_run_id' = ${runId}
      AND (payload->>'part')::int = ${part}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).xmin;
}

/** row_version of the run's settle_runs row (the row must exist). */
async function runVersion(f: Fixture, runId: string): Promise<number> {
  const row = await f.db
    .selectFrom('settle_runs')
    .select('row_version')
    .where('app_id', '=', f.appId)
    .where('settle_run_id', '=', runId)
    .executeTakeFirstOrThrow();
  return row.row_version;
}

/** settle.auto.enabled off (and the clock past the 10-second bound) before the next delivery. */
function switchOff(f: Fixture): void {
  f.switches.set('settle.auto.enabled', false);
  f.clock.advanceMs(11_000);
}

/** One delivery of `b` at its execution instant with a switch off: SB5 c, CONFIRMED + marker. */
async function pausedAtStart(f: Fixture, b: SeededBatch): Promise<void> {
  expect(await f.deliver(b)).toMatchObject({ outcome: 'switched_off' });
  const row = await f.stored(b);
  expect(row.status).toBe('CONFIRMED');
  expect(row.paused_by_switch_at).not.toBeNull();
  expect(row.started_at).toBeNull();
}

it(
  '[AC-B2-04zt#1] [BR-FUND-04][BR-TEXT-09] SB6 首发同一事务：同一 run 两批先后执行完，第二批置 DONE 的提交里 settle_runs 行（INSERT，part=1 done）、该批 settle_batches 行与 part=1 的 settle.run_done 行 xmin 相同；第一批 DONE 行的 xmin 与之不同（比法能区分事务）',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('same-tx-done', [1, 1]));
    const [first, last] = [at(batches, 0), at(batches, 1)];

    await f.finish(first);
    expect(await f.runDone()).toEqual([]);
    await f.finish(last);

    // Before any further write.
    const v = await versions(f, runId, last, 1);
    const firstXmin = await batchXmin(f, first);
    expect({ part: v.part, last_outcome: v.last_outcome }).toEqual({
      part: 1,
      last_outcome: 'done',
    });
    expect(v.run_xmin).toBe(v.batch_xmin);
    expect(v.event_xmin).toBe(v.batch_xmin);
    expect(firstXmin).not.toBe(v.batch_xmin);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'done', 2)]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zt#2] [BR-FUND-04][BR-TEXT-09] SB7 再发同一事务：单批 run 入账 o0 后因开关停在 PARTIAL（part=1 partial），继续执行、入账 o1 后开关再关、停在 PARTIAL → settle_runs 行经 row_version CAS 改为 part=2 partial，与该批 PARTIAL 行、part=2 的 settle.run_done 行 xmin 相同；part=1 事件行的 xmin 与之不同',
  async () => {
    const f = await fixture(p.db);
    const groups = await f.orderGroups('same-tx-partial', [3]);
    const { runId, batches } = await f.seedRun(groups);
    const only = at(batches, 0);
    const orders = at(groups, 0);

    f.stopAfter(nth(orders, 0));
    await f.stop(only);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 1)]);
    const before = await runVersion(f, runId);

    f.switchBackOn();
    await f.resume(only);
    f.stopAfter(nth(orders, 1));
    await f.stop(only);

    // Before any further write.
    const v = await versions(f, runId, only, 2);
    const partOne = await eventXmin(f, runId, 1);
    expect({ part: v.part, last_outcome: v.last_outcome }).toEqual({
      part: 2,
      last_outcome: 'partial',
    });
    expect(v.run_xmin).toBe(v.batch_xmin);
    expect(v.event_xmin).toBe(v.batch_xmin);
    expect(partOne).not.toBe(v.batch_xmin);
    // The row existed before this publish: the UPDATE path, not a second INSERT.
    expect(await runVersion(f, runId)).toBeGreaterThan(before);
    expect(await f.runDone()).toStrictEqual([
      f.runEvent(runId, 1, 'partial', 1),
      f.runEvent(runId, 2, 'partial', 1),
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zt#3] [BR-FUND-04][BR-TEXT-09] SB5 c 停住时发布同一事务：同一 run 两批，第一批执行到 DONE，第二批到执行时刻因 settle.auto.enabled 关闭停在 CONFIRMED（带停住标记）→ settle_runs 行（part=1 partial）、第二批 settle_batches 行与 part=1 的 settle.run_done 行 xmin 相同；第一批 DONE 行的 xmin 与之不同',
  async () => {
    const f = await fixture(p.db);
    const { runId, batches } = await f.seedRun(await f.orderGroups('same-tx-paused', [1, 1]));
    const [first, second] = [at(batches, 0), at(batches, 1)];

    await f.finish(first);
    switchOff(f);
    await pausedAtStart(f, second);

    // Before any further write.
    const v = await versions(f, runId, second, 1);
    const firstXmin = await batchXmin(f, first);
    expect({ part: v.part, last_outcome: v.last_outcome }).toEqual({
      part: 1,
      last_outcome: 'partial',
    });
    expect(v.run_xmin).toBe(v.batch_xmin);
    expect(v.event_xmin).toBe(v.batch_xmin);
    expect(firstXmin).not.toBe(v.batch_xmin);
    expect(await f.runDone()).toStrictEqual([f.runEvent(runId, 1, 'partial', 2)]);
  },
  TIMEOUT,
);
