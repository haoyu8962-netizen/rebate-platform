// B3-08r fixture: independent finalizations (live settle S5, worker finalize) on a small business
// pool whose daily limits come from the real createQuotaLimitsSource over a real ContentReader on
// that very pool, with the reader's cache expired, so the F0 configuration refresh needs a
// connection of the same pool. Pieces:
// - pools: one fresh PostgreSQL database per test file (the *.int.test.ts passes
//   createTestDatabase: only those may import @couli/db/testing); `db` (max 24) for set-up and the
//   SQL oracles, `small(max)` for the pool under test (closed in afterAll);
// - QuotaReader: the real ContentReader (createContentReader) over the small pool, on its own
//   FixedClock (expire() moves it far past the cache lifetime), behind a pass-through that can
//   make every config_items read fail after it ran on a pool connection (a failed refresh), and
//   that the test unsticks once it gave up waiting, so a pool that deadlocked drains and closes
//   instead of hanging the whole suite;
// - within(works, unstick): starts every work at once and tells whether all of them settled in
//   IN_TIME_MS (far below any connection or lock timeout); on overrun it unsticks, then waits.
// Ports are only built inside tests (never in hooks). Expected values stay in the rule tests.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createContentReader,
  type ContentReader,
} from '../../../../apps/api/src/modules/content/index.ts';
import {
  createPgRunPorts,
  createQuotaLimitsSource,
  type PgRunPorts,
  type QuotaLimitsSource,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import { connect } from '../../db/linking-bindings/kit.ts';
import {
  APP,
  FakeSignals,
  TIMINGS,
  runRow,
  sessionRow,
  settled,
  texts,
  type FixtureDatabase,
  type Row,
} from '../stream-finalize/kit.ts';

/** The bound every concurrent round must meet (no connection or lock timeout is that short). */
export const IN_TIME_MS = 10_000;
/** Far past the content cache lifetime (60 s): the next read of every item reloads. */
const PAST_CACHE_MS = 10 * 60_000;

// ---- pools ---------------------------------------------------------------------------------

export interface Pools {
  /** Set-up and oracle pool (max 24). */
  readonly db: Kysely<DB>;
  /** A pool of `max` connections on the same database (business role couli_app). */
  small(max: number): Kysely<DB>;
}

const readers: QuotaReader[] = [];

export function usePools(createDatabase: () => Promise<FixtureDatabase>): Pools {
  let database: FixtureDatabase | undefined;
  let db: Kysely<DB> | undefined;
  const smalls: Kysely<DB>[] = [];
  beforeAll(async () => {
    database = await createDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 24 });
    connect(db);
  }, 180_000);
  afterAll(async () => {
    // A reader still waiting on a deadlocked pool would keep its connections forever.
    for (const reader of readers.splice(0)) reader.unstick();
    for (const pool of smalls.splice(0)) await destroyDb(pool);
    if (db) await destroyDb(db);
    if (database) await database.drop();
  }, 120_000);
  return {
    get db() {
      if (db === undefined) throw new Error('database not ready');
      return db;
    },
    small(max: number) {
      if (database === undefined) throw new Error('database not ready');
      const pool = createDb({
        connectionString: database.urlFor('couli_app'),
        max,
        applicationName: 'b3-08r-small-pool',
      });
      smalls.push(pool);
      return pool;
    },
  };
}

/** The three BR-AI-15 daily limits as config_items rows of app couli (inserted once per file). */
export async function seedQuota(
  db: Kysely<DB>,
  values: { member: number; guest: number; guestIp: number },
): Promise<void> {
  const items: [string, number][] = [
    ['agent.member_daily_quota', values.member],
    ['agent.guest_daily_quota', values.guest],
    ['agent.guest_ip_daily_quota', values.guestIp],
  ];
  for (const [item, value] of items) {
    await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
      VALUES (${APP}, ${item}, ${JSON.stringify(value)}::jsonb, 'b3-08r-rule-test')
      ON CONFLICT (app_id, key) DO NOTHING`.execute(db);
  }
}

// ---- the limits source ---------------------------------------------------------------------

type Config = Awaited<ReturnType<ContentReader['configValue']>>;

/**
 * The real ContentReader over `db` (the pool under test). `failing`: every config_items read runs
 * on a pool connection and then rejects (the refresh failed; the cache keeps nothing).
 */
export class QuotaReader implements Pick<ContentReader, 'configValue'> {
  readonly clock: FixedClock;
  failing = false;
  /** config_items reads that ran on the pool and were then failed by `failing`. */
  failedReads = 0;
  readonly #inner: Pick<ContentReader, 'configValue'>;
  readonly #stuck: Promise<'unstuck'>;
  #unstick: () => void = () => undefined;

  constructor(db: Kysely<DB>, atMs: number) {
    this.clock = new FixedClock(new Date(atMs));
    const plugin: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: (args) => {
        if (!this.failing) return Promise.resolve(args.result);
        this.failedReads += 1;
        return Promise.reject(new Error('fixture: config_items read failed'));
      },
    };
    this.#inner = createContentReader({ db: db.withPlugin(plugin), clock: this.clock });
    this.#stuck = new Promise<'unstuck'>((resolve) => {
      this.#unstick = () => resolve('unstuck');
    });
  }

  /** Moves the reader's clock past the cache lifetime: every cached item is stale. */
  expire(): void {
    this.clock.advanceMs(PAST_CACHE_MS);
  }

  /** The test gave up waiting: every pending and later read rejects at once. */
  unstick(): void {
    this.#unstick();
  }

  async configValue(appId: string, item: string): Promise<Config> {
    const answer = await Promise.race([this.#inner.configValue(appId, item), this.#stuck]);
    if (answer === 'unstuck') throw new Error('fixture: the test gave up waiting');
    return answer;
  }
}

export interface PoolInst {
  readonly clock: FixedClock;
  readonly reader: QuotaReader;
  readonly limits: QuotaLimitsSource;
  readonly ports: PgRunPorts;
}

/** One service instance on `db` at `atMs`: real ports, real limits source over the same pool. */
export function poolInstance(db: Kysely<DB>, atMs: number): PoolInst {
  const clock = new FixedClock(new Date(atMs));
  const reader = new QuotaReader(db, atMs);
  readers.push(reader);
  const limits = createQuotaLimitsSource({ reader });
  const ports = createPgRunPorts({
    db,
    clock,
    timings: TIMINGS,
    limits,
    texts,
    signals: new FakeSignals(),
  });
  return { clock, reader, limits, ports };
}

// ---- concurrency ---------------------------------------------------------------------------

export interface Within<T> {
  /** Every work settled within the bound. */
  readonly inTime: boolean;
  /** What each work returned, or its error (after the bound: once unstuck). */
  readonly results: (T | Error)[];
}

/** Starts every work in the same turn; on overrun calls `unstick` and still waits for all. */
export async function within<T>(
  works: readonly (() => Promise<T>)[],
  unstick: () => void,
  ms: number = IN_TIME_MS,
): Promise<Within<T>> {
  const all = Promise.all(works.map((work) => settled(work())));
  let timer: NodeJS.Timeout | undefined;
  const first = await Promise.race([
    all.then(() => 'done' as const),
    new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), ms);
    }),
  ]);
  clearTimeout(timer);
  if (first === 'late') unstick();
  return { inTime: first === 'done', results: await all };
}

// ---- oracles -------------------------------------------------------------------------------

/** What a finalization leaves on its run row and on its session's run lock. */
export async function settledView(db: Kysely<DB>, runId: string): Promise<Row> {
  const run = await runRow(db, runId);
  expect(run['session_id'], `session of ${runId}`).toBeTypeOf('string');
  const session = await sessionRow(db, run['session_id'] as string);
  return {
    end_reason: run['end_reason'],
    card_delivered: run['card_delivered'],
    settle_result: run['settle_result'],
    final_event: run['final_event'],
    settled_at: run['settled_at'],
    ended_at: run['ended_at'],
    finish_reason: run['finish_reason'],
    finalize_hold: run['finalize_hold'],
    run_lock_run_id: session['run_lock_run_id'],
    run_lock_expires_at: session['run_lock_expires_at'],
  };
}
