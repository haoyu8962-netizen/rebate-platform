// B1-02zr rule-test kit (08 BR-ID-28 细则「待加验记录」, BR-WDR-01 细则「删除」). The runner is the
// worker's deletion token, built from the options app.module really passes (no fake port, nothing
// of this task imported), over the business role couli_app of a cloned test database:
//   - `worker`: AGENT_USER_HASH_KEY set, every owner port real, a request can reach done;
//   - `blockedWorker`: the key unset, so the agent slot is the real unavailable marker and the
//     cleanup reruns every round with cleaned_at NULL;
//   - Apple is the real unconfigured revoker: an account with an Apple token stops after ①.
// A cleanup failure is a real one too: another connection holds a row of the user in an open
// transaction, the round waits on it (seen in pg_locks) and pg_cancel_backend cancels that
// statement. Holding is a DELETE, rolled back afterwards: couli_app has no UPDATE on these tables,
// so SELECT … FOR UPDATE would be refused.
//
// users.reverify_fail_epoch is read by nothing here: it is a generation counter, not personal data
// (orchestrator §9), so these tests leave it free.
// The test database is the integration file's createTestDatabase (depcruise allows
// @couli/db/testing in *.int.test.ts only); this kit only sees a structural type.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDb, type DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  DAY_MS,
  NOW,
  ROOT,
  at,
  capturedWorkerOptions,
  fieldCrypto,
  gate,
  identity,
  ports,
  request,
  sessionsOf,
  settledOrWaiting,
  userRow,
  type Member,
  type Ports,
  type Runner,
  type WorkerModule,
} from '../deletion-processing/kit.ts';

interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

interface WorkerContext {
  get(token: unknown): unknown;
  close(): Promise<void>;
}

export interface ReverifyState {
  last_active_at: Date | null;
  last_login_device_hash: string | null;
  reverify_flagged_at: Date | null;
  reverify_trusted: { realname: boolean; providers: string[] } | null;
  reverify_fail_count: number;
  reverify_fail_day: string | null;
}

/** Synthetic test-only value: only its presence matters (agent's purge keys its hash on it). */
const AGENT_KEY = 'test-only-agent-user-hash-key-b1-02zr';
const FAIL_DAY = '2026-10-22';

/** The six columns after the deletion: reverify_fail_count is NOT NULL, its empty value is 0. */
export const CLEARED: ReverifyState = {
  last_active_at: null,
  last_login_device_hash: null,
  reverify_flagged_at: null,
  reverify_trusted: null,
  reverify_fail_count: 0,
  reverify_fail_day: null,
};

/** A flagged account in the middle of its failures. */
export function seededState(deviceHash: string): ReverifyState {
  return {
    last_active_at: at(-200 * DAY_MS),
    last_login_device_hash: deviceHash,
    reverify_flagged_at: at(-DAY_MS),
    reverify_trusted: { realname: true, providers: ['wechat'] },
    reverify_fail_count: 3,
    reverify_fail_day: FAIL_DAY,
  };
}

/** Like workerHarness of the deletion-processing kit, with the agent key in APP_CONFIG. */
async function workerContext(
  p: Ports,
  module: WorkerModule,
  db: Kysely<DB>,
  crypto: FieldCrypto,
  agentUserHashKey: string | null,
): Promise<WorkerContext> {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<WorkerContext>;
    };
  };
  class Dependencies {}
  class Harness {}
  const providers = [
    { provide: p.platform.CLOCK, useValue: p.clock },
    { provide: p.platform.ROOT_LOGGER, useValue: p.logger },
    { provide: p.platform.APP_CONFIG, useValue: { appEnv: 'test', agentUserHashKey } },
    { provide: p.platform.DB, useValue: db },
    { provide: p.platform.FIELD_CRYPTO, useValue: crypto },
  ];
  return NestFactory.createApplicationContext(
    {
      module: Harness,
      imports: [
        {
          module: Dependencies,
          global: true,
          providers,
          exports: providers.map((value) => value.provide),
        },
        module,
      ],
    },
    { logger: false, abortOnError: false },
  );
}

export async function open(database: TestDatabaseUrls) {
  const p = await ports();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 10 });
  const crypto = await fieldCrypto();
  const api = await identity();
  const options = await capturedWorkerOptions(api, p);
  const module = () => api.IdentityDeletionExpiryModule.forWorker(options as never);
  const full = await workerContext(p, module(), db, crypto, AGENT_KEY);
  const blocked = await workerContext(p, module(), db, crypto, null);
  const token = api.deletionExpiryToken();
  return {
    ...p,
    db,
    crypto,
    worker: full.get(token) as Runner,
    blockedWorker: blocked.get(token) as Runner,
    async closeWorkers() {
      try {
        await full.close();
      } finally {
        await blocked.close();
      }
    },
  };
}
export type Kit = Awaited<ReturnType<typeof open>>;

/** Between tests: a round is across apps, so every open request of earlier tests reaches done. */
export async function reset(kit: Kit): Promise<void> {
  await sql`UPDATE app.deletion_requests SET status = 'done', processed_at = cooling_until,
    row_version = row_version + 1 WHERE status IN ('cooling', 'processing')`.execute(kit.db);
  kit.clock.set(NOW);
  kit.lines.length = 0;
}

export async function close(kit: Kit | undefined): Promise<void> {
  if (kit === undefined) return;
  try {
    await kit.closeWorkers();
  } finally {
    await kit.db.destroy();
  }
}

// ---- seeding ---------------------------------------------------------------------------------

/** All six columns, as a flagged account has them (seededState). */
export async function flag(db: Kysely<DB>, m: Member, deviceHash: string): Promise<void> {
  const state = seededState(deviceHash);
  await sql`UPDATE app.users SET last_active_at = ${state.last_active_at},
      last_login_device_hash = ${state.last_login_device_hash},
      reverify_flagged_at = ${state.reverify_flagged_at},
      reverify_trusted = ${JSON.stringify(state.reverify_trusted)}::jsonb,
      reverify_fail_count = ${state.reverify_fail_count},
      reverify_fail_day = ${state.reverify_fail_day}::date
    WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(db);
}

/** No flag, but the activity columns and a day's failures (what a cleared flag leaves behind). */
export async function activity(db: Kysely<DB>, m: Member, deviceHash: string): Promise<void> {
  await sql`UPDATE app.users SET last_active_at = ${at(-DAY_MS)},
      last_login_device_hash = ${deviceHash}, reverify_fail_count = 2,
      reverify_fail_day = ${FAIL_DAY}::date
    WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(db);
}

export async function reverifiedDevice(
  db: Kysely<DB>,
  m: Member,
  deviceHash: string,
  source: 'self' | 'admin' = 'self',
): Promise<void> {
  await sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
    VALUES (${randomUUID()}, ${m.appId}, ${m.uid}, ${deviceHash}, ${source})`.execute(db);
}

export async function favorite(db: Kysely<DB>, m: Member): Promise<void> {
  await sql`INSERT INTO app.favorites (id, app_id, user_id, platform, product_key)
    VALUES (${randomUUID()}, ${m.appId}, ${m.uid}, 'jd', 'b1-02zr-fixture')`.execute(db);
}

// ---- reading ---------------------------------------------------------------------------------

/** The six columns; the date is read as text (no timezone parsing). */
export async function reverifyState(db: Kysely<DB>, m: Member): Promise<ReverifyState> {
  const { rows } = await sql<ReverifyState>`SELECT last_active_at, last_login_device_hash,
      reverify_flagged_at, reverify_trusted, reverify_fail_count,
      reverify_fail_day::text AS reverify_fail_day
    FROM app.users WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

export async function reverifiedDevices(db: Kysely<DB>, m: Member) {
  const { rows } = await sql<{ device_hash: string; source: string }>`SELECT device_hash, source
    FROM app.reverified_devices WHERE app_id = ${m.appId} AND user_id = ${m.uid}
    ORDER BY device_hash, source`.execute(db);
  return rows;
}

/** Everything a rolled-back cleanup must leave as it was. */
export async function footprint(db: Kysely<DB>, m: Member, requestId: string) {
  return {
    request: await request(db, requestId),
    user: await userRow(db, m),
    state: await reverifyState(db, m),
    devices: await reverifiedDevices(db, m),
    sessions: await sessionsOf(db, m.appId),
  };
}

/** The reverify columns found on deleted_identities. */
export async function reverifyColumnsOfTombstone(db: Kysely<DB>): Promise<string[]> {
  const names = Object.keys(CLEARED);
  const { rows } = await sql<{ name: string }>`SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'deleted_identities'
      AND column_name = ANY(${names}::text[])`.execute(db);
  return rows.map((row) => row.name);
}

// ---- a real failure inside the cleanup ---------------------------------------------------------

/** Takes the row locks on the holder's transaction; the number of rows held. */
export type Hold = (trx: Transaction<DB>) => Promise<bigint>;

export function holdReverifiedDevices(m: Member): Hold {
  return async (trx) => {
    const result = await trx
      .withSchema('app')
      .deleteFrom('reverified_devices')
      .where('app_id', '=', m.appId)
      .where('user_id', '=', m.uid)
      .executeTakeFirstOrThrow();
    return result.numDeletedRows;
  };
}

/** favorites go through catalog's port, the last of the cleanup's ports. */
export function holdFavorites(m: Member): Hold {
  return async (trx) => {
    const result = await trx
      .withSchema('app')
      .deleteFrom('favorites')
      .where('app_id', '=', m.appId)
      .where('user_id', '=', m.uid)
      .executeTakeFirstOrThrow();
    return result.numDeletedRows;
  };
}

class HoldReleased extends Error {}

async function waitingPids(db: Kysely<DB>): Promise<number[]> {
  const { rows } = await sql<{ pid: number }>`SELECT DISTINCT l.pid
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND a.datname = current_database()`.execute(db);
  return rows.map((row) => row.pid);
}

/**
 * One worker round whose cleanup waits on the held rows and is cancelled there. `whileWaiting` runs
 * while the cleanup transaction is open. The held rows are released (rolled back) before returning.
 * Fails its assertion when the round never waited on them.
 */
export async function cancelledRound(
  kit: Kit,
  hold: Hold,
  whileWaiting: () => Promise<void>,
): Promise<void> {
  const holding = gate();
  const release = gate();
  const holder = kit.db
    .transaction()
    .execute(async (trx): Promise<void> => {
      expect(await hold(trx)).toBeGreaterThan(0n);
      holding.open();
      await release.promise;
      throw new HoldReleased();
    })
    .catch((error: unknown) => {
      if (!(error instanceof HoldReleased)) throw error;
    });
  await Promise.race([holding.promise, holder]);
  const round = kit.worker.runOnce();
  try {
    await settledOrWaiting(kit.db, round);
    const pids = await waitingPids(kit.db);
    expect(pids, 'the cleanup did not wait on the held rows').toHaveLength(1);
    await whileWaiting();
    const { rows } = await sql<{ cancelled: boolean }>`
      SELECT pg_cancel_backend(${pids[0]!}) AS cancelled`.execute(kit.db);
    expect(rows).toEqual([{ cancelled: true }]);
    await round;
  } finally {
    release.open();
    await Promise.allSettled([round, holder]);
  }
}
