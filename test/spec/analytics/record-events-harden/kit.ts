import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type QueryId } from 'kysely';
import { expect } from 'vitest';
import {
  recordEvents,
  type AnalyticsEvent,
  type RecordEventsInput,
  type RecordEventsResult,
} from '../../../../apps/api/src/modules/analytics/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const TIMEOUT = 120_000;
export const SERVER_AT = '2032-06-15T16:00:00.123Z';
export const CLIENT_AT = '2026-11-14T08:00:00.456+08:00';

// Only the *.int.test.ts callers import @couli/db/testing.
interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<Database>) {
  const database = await create();
  const connectionString = database.urlFor('couli_app');
  return {
    database,
    left: createDb({ connectionString, max: 1 }),
    right: createDb({ connectionString, max: 1 }),
    observer: createDb({ connectionString, max: 1 }),
  };
}

export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([destroyDb(h.left), destroyDb(h.right), destroyDb(h.observer)]);
  await h.database.drop();
}

export function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    eventId: randomUUID(),
    eventType: 'page_view',
    props: {},
    clientAt: CLIENT_AT,
    ...overrides,
  };
}

export function batch(events: readonly AnalyticsEvent[]): RecordEventsInput {
  return {
    appId: `ct13i-${randomUUID()}`,
    userId: null,
    deviceId: null,
    clock: new FixedClock(SERVER_AT),
    events,
  };
}

export function rows(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('events')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('event_type')
    .orderBy('event_id')
    .execute();
}

export function keys(db: Kysely<DB>, appId: string) {
  return db
    .withSchema('app')
    .selectFrom('event_dedup')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('event_type')
    .orderBy('event_id')
    .execute();
}

/** Pause AFTER PostgreSQL executed the first dedup INSERT, before the transaction can commit. */
function pauseFirstInsert(db: Kysely<DB>) {
  let reached = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queries = new WeakSet<QueryId>();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'InsertQueryNode' && node.into?.table.identifier.name === 'event_dedup') {
        queries.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (!reached && queries.has(queryId)) {
        reached = true;
        await released;
      }
      return result;
    },
  };
  return { db: db.withPlugin(plugin), reached: () => reached, release: () => release() };
}

function track<T>(promise: Promise<T>) {
  let settled = false;
  const outcome: Promise<PromiseSettledResult<T>> = promise.then(
    (value) => {
      settled = true;
      return { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      settled = true;
      return { status: 'rejected', reason };
    },
  );
  return { outcome, settled: () => settled };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
}

/**
 * A first INSERT is held open. B must either finish its own first INSERT (opposing keys),
 * or demonstrably wait on A's PostgreSQL lock (same first key after sorting).
 * Releasing both in the first case deterministically exposes the old [A,B]/[B,A] deadlock;
 * the second case lets a sorted implementation proceed, without a barrier-induced deadlock.
 * No fake DB, trigger, retry, privileged connection, or sleep-based overlap assumption.
 */
export async function overlap(h: Harness, left: RecordEventsInput, right: RecordEventsInput) {
  // Pin each backend for the entire experiment, including the PID/timeout setup.
  return h.left.connection().execute(async (leftDb) =>
    h.right.connection().execute(async (rightDb) => {
      const configure = async (db: Kysely<DB>) => {
        const result = await sql<{ pid: number }>`select pg_backend_pid() as pid,
        set_config('lock_timeout', '10s', false),
        set_config('statement_timeout', '15s', false)`.execute(db);
        return result.rows[0]!.pid;
      };
      const leftPid = await configure(leftDb);
      const rightPid = await configure(rightDb);
      const a = pauseFirstInsert(leftDb);
      const b = pauseFirstInsert(rightDb);
      const first = track(recordEvents(a.db, left));
      let second: ReturnType<typeof track<RecordEventsResult>> | undefined;
      let blocked = false;
      try {
        await until(() => a.reached() || first.settled());
        expect(a.reached(), 'first transaction must pause after a real dedup INSERT').toBe(true);
        expect(first.settled()).toBe(false);
        second = track(recordEvents(b.db, right));
        await until(async () => {
          if (b.reached() || second!.settled()) return true;
          const result = await sql<{ blocked: boolean }>`select
          ${leftPid}::integer = any(pg_blocking_pids(${rightPid}::integer)) as blocked
        `.execute(h.observer);
          blocked = result.rows[0]!.blocked;
          return blocked;
        });
        expect(
          b.reached() || blocked,
          'second transaction must insert or wait on the first backend',
        ).toBe(true);
        expect(second.settled()).toBe(false);
        // Real uncommitted work, not two serial calls or a result hook after COMMIT.
        expect(await keys(h.observer, left.appId)).toEqual([]);
        expect(await rows(h.observer, left.appId)).toEqual([]);
      } finally {
        a.release();
        b.release();
        // Always drain both promises, even if a barrier assertion fails.
        await Promise.all([first.outcome, second?.outcome]);
      }
      expect(second).toBeDefined();
      return {
        results: await Promise.all([first.outcome, second!.outcome]),
        blocked,
      };
    }),
  );
}
