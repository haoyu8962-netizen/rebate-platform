// Shared harness of the B2-04zy rule tests (上线缺口第 26 项, D10-726 / D10-732; BR-FUND-04 ⑦,
// BR-TEXT-09 「0 笔不发」): whether an execution of a settle run credited anything is decided by
// counts, never by comparing timestamps.
//   - app.settle_batches.credited_count: +1 on the item transaction whose item result is
//     'credited' (order items and beneficiary items alike); skipped / deferred items and rolled-back
//     item transactions do not count.
//   - app.settle_runs.published_credited_count: the watermark already published. A run that rests
//     publishes settle.run_done only when the sum of credited_count over its batches is greater than
//     the watermark, and the publish (first INSERT or row_version CAS) writes that sum as the new
//     watermark. A lost CAS or a refused publish leaves the watermark as it was.
//   - D10-732: an execution that credited nothing publishes nothing, also when its batch reaches DONE.
//
// The executors here are built with their own FixedClock (ahead of or behind the harness clock, or
// the harness clock itself), on any pool, with an optional publish wrapper. Seeding, the real
// B2-04m credit (always on the harness clock), the switch map, resume (SB8) and the event reads come
// from ../run-done/kit.ts unchanged. The two new columns are read with raw SQL (the generated DB
// types do not know them before the snapshot); every case calls watermarkReady() first, so a missing
// migration fails on an assertion, not on SQL naming a missing column.
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { getAssetSnapshotStatus } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock, createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createBatchExecutor,
  type BatchExecuteResult,
  type BeneficiaryItemResult,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import type { SeededOrder } from '../credit/kit.ts';
import { at, type Fixture, type Publish, type SeededBatch } from '../run-done/kit.ts';

export {
  BILL,
  RUN_DONE,
  TIMEOUT,
  at,
  creditedOnce,
  databaseFixture,
  fixture,
  nth,
  untouched,
  type Fixture,
  type Publish,
  type SeededBatch,
} from '../run-done/kit.ts';

/** Past the 10-second bound of the switch reads. */
export const SWITCH_STEP_MS = 11_000;

// ---- the two columns ------------------------------------------------------------------------------

export interface CounterColumn {
  readonly relation: string;
  readonly column: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default_expr: string | null;
}

/** credited_count of app.settle_batches and published_credited_count of app.settle_runs, if present. */
export async function counterColumns(db: Kysely<DB>): Promise<CounterColumn[]> {
  return (
    await sql<CounterColumn>`
      SELECT c.relname::text AS relation, a.attname::text AS column, t.typname::text AS type,
        NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'app' AND a.attnum > 0 AND NOT a.attisdropped
        AND ((c.relname = 'settle_batches' AND a.attname = 'credited_count')
          OR (c.relname = 'settle_runs' AND a.attname = 'published_credited_count'))
      ORDER BY c.relname`.execute(db)
  ).rows;
}

/** First step of every case: both columns exist (assertion, not a failing SQL statement). */
export async function watermarkReady(db: Kysely<DB>): Promise<void> {
  const found = (await counterColumns(db)).map((c) => `${c.relation}.${c.column}`);
  expect(found, '两列计数已建').toEqual([
    'settle_batches.credited_count',
    'settle_runs.published_credited_count',
  ]);
}

// ---- reads (committed state, through the fixture's shared pool) -----------------------------------

/** credited_count of batch `b`. */
export async function creditedCount(f: Fixture, b: SeededBatch): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT credited_count AS n FROM app.settle_batches
    WHERE app_id = ${f.appId} AND batch_id = ${b.batchId}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).n;
}

/** Sum of credited_count over the batches of run `runId` in this app. */
export async function runCredited(f: Fixture, runId: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT coalesce(sum(credited_count), 0)::int AS n FROM app.settle_batches
    WHERE app_id = ${f.appId} AND settle_run_id = ${runId}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).n;
}

/** Items of batch `b` whose result is 'credited'. */
export async function creditedItems(f: Fixture, b: SeededBatch): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.settle_batch_items
    WHERE app_id = ${f.appId} AND batch_id = ${b.batchId} AND result = 'credited'`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).n;
}

export interface RunState {
  readonly part: number;
  readonly last_outcome: string | null;
  /** published_credited_count. */
  readonly watermark: number;
}

/** Nothing published for the run yet: no row, or a row still at its defaults. */
export const NOTHING: RunState = { part: 0, last_outcome: null, watermark: 0 };

/** part, last_outcome and the watermark of the run (NOTHING while there is no row). */
export async function runState(f: Fixture, runId: string): Promise<RunState> {
  const result = await sql<RunState>`
    SELECT part, last_outcome, published_credited_count AS watermark FROM app.settle_runs
    WHERE app_id = ${f.appId} AND settle_run_id = ${runId}`.execute(f.db);
  expect(result.rows.length).toBeLessThanOrEqual(1);
  const row = result.rows[0];
  if (row === undefined) return NOTHING;
  return { part: row.part, last_outcome: row.last_outcome, watermark: row.watermark };
}

/** Committed xmin of batch `b`'s settle_batches row. */
export async function batchXmin(f: Fixture, b: SeededBatch): Promise<string> {
  const result = await sql<{ xmin: string }>`
    SELECT xmin::text AS xmin FROM app.settle_batches
    WHERE app_id = ${f.appId} AND batch_id = ${b.batchId}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).xmin;
}

/** Committed xmin of the item of order `o` in batch `b`. */
export async function itemXmin(f: Fixture, b: SeededBatch, o: SeededOrder): Promise<string> {
  const id = b.items.get(o.orderId);
  if (id === undefined) throw new Error('no item of this order in the batch');
  const result = await sql<{ xmin: string }>`
    SELECT xmin::text AS xmin FROM app.settle_batch_items
    WHERE app_id = ${f.appId} AND batch_id = ${b.batchId} AND id = ${id}`.execute(f.db);
  expect(result.rows).toHaveLength(1);
  return at(result.rows, 0).xmin;
}

// ---- executors with their own clocks ---------------------------------------------------------------

export interface WorkerOptions {
  /** How far this executor's clock is ahead of (> 0) or behind (< 0) the harness clock. */
  readonly offsetMs?: number;
  /** Pool of this executor "process" (default: the fixture's shared pool). */
  readonly via?: Kysely<DB>;
  /** Replaces the plain pass-through to the harness writer. */
  readonly publish?: Publish;
}

export interface Worker {
  /** The FixedClock injected into this executor (the harness clock itself for offset 0). */
  readonly clock: FixedClock;
  /** One batch_execute delivery; the offset is re-applied at its start, the clock stays put in it. */
  deliver(b: SeededBatch): Promise<BatchExecuteResult>;
}

/** Executors over one fixture, sharing the order hooks and the beneficiary answers below. */
export function rig(f: Fixture) {
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
  /** Fake answers of the B2-04q port, by beneficiary_credit_id. */
  const answers = new Map<string, BeneficiaryItemResult>();

  function worker(options: WorkerOptions = {}): Worker {
    const offset = options.offsetMs ?? 0;
    const clock = offset === 0 ? f.clock : new FixedClock(f.clock.now());
    const executor = createBatchExecutor({
      db: options.via ?? f.db,
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
          return f.h.boot().credit(trx, input);
        },
      },
      creditBeneficiary: {
        execute: async (_trx, input) => {
          const answer = answers.get(input.beneficiaryCreditId);
          if (answer === undefined) throw new Error('no fake answer for this obligation');
          return answer;
        },
      },
      events: { publish: options.publish ?? f.write },
    });
    return {
      clock,
      deliver(b) {
        if (clock !== f.clock) clock.set(new Date(f.clock.now().getTime() + offset));
        return executor.run({ appId: f.appId, batchId: b.batchId });
      },
    };
  }

  function onCredit(o: SeededOrder, hook: (trx: Transaction<DB>) => Promise<void>): void {
    hooks.set(o.orderId, hook);
  }

  /** Inside the credit of `o`, settle.auto.enabled goes off: `o` is credited, the run stops next. */
  function stopAfter(o: SeededOrder): void {
    onCredit(o, async () => {
      f.switches.set('settle.auto.enabled', false);
      f.clock.advanceMs(SWITCH_STEP_MS);
    });
  }

  /** settle.auto.enabled off before the next delivery. */
  function switchOff(): void {
    f.switches.set('settle.auto.enabled', false);
    f.clock.advanceMs(SWITCH_STEP_MS);
  }

  /** The credit of `o` fails with an ordinary error: its item transaction rolls back, run() rejects. */
  function failAt(o: SeededOrder): void {
    onCredit(o, async () => {
      throw new Error('ordinary failure injected by the watermark test');
    });
  }

  return { worker, onCredit, stopAfter, switchOff, failAt, answers };
}

/** One delivery of `b` by `w`, with the outcome and the batch status it must leave. */
export async function delivered(
  f: Fixture,
  w: Worker,
  b: SeededBatch,
  outcome: 'done' | 'partial',
): Promise<void> {
  expect(await w.deliver(b)).toMatchObject({ outcome });
  expect(await f.status(b)).toBe(outcome === 'done' ? 'DONE' : 'PARTIAL');
}

/** A writer that refuses settle.run_done (the publishing transaction rolls back). */
export function refuseRunDone(f: Fixture): Publish {
  return async (trx, event) => {
    if (event.name === 'settle.run_done') throw new Error('refused by the watermark test');
    return f.write(trx, event);
  };
}

// ---- statement-level faults on an executor's pool --------------------------------------------------

const UPDATE_RUNS = /^\s*update\s+(?:"?app"?\s*\.\s*)?"?settle_runs"?\s/i;
const UPDATE_BATCH_COUNT =
  /\bupdate\s+(?:"?app"?\s*\.\s*)?"?settle_batches"?\s+(?:as\s+\w+\s+)?set\b[^;]*\bcredited_count\b/i;

/** Every UPDATE of app.settle_runs through the returned executor matches no row: a lost CAS. */
export function runCasMisses(db: Kysely<DB>) {
  let misses = 0;
  const lost = db.withPlugin({
    transformQuery(args) {
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (!UPDATE_RUNS.test(compiled.sql)) return args.node;
      misses += 1;
      if (args.node.kind === 'UpdateQueryNode') {
        return {
          ...args.node,
          where: { kind: 'WhereNode', where: sql<boolean>`false`.toOperationNode() },
        };
      }
      return sql`UPDATE app.settle_runs SET part = part WHERE false`.toOperationNode();
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: lost, misses: () => misses };
}

/**
 * The UPDATE of app.settle_batches that moves credited_count fails after PostgreSQL ran it, so the
 * item transaction really held the increment when it rolls back.
 */
export function countFailsAfter(db: Kysely<DB>) {
  let injected = 0;
  const pending = new Set<unknown>();
  const faulty = db.withPlugin({
    transformQuery(args) {
      const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (UPDATE_BATCH_COUNT.test(compiled.sql)) pending.add(args.queryId);
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        injected += 1;
        throw new Error('injected failure after the credited_count update ran');
      }
      return args.result;
    },
  });
  return { db: faulty, injected: () => injected };
}
