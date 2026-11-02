// B1-02zy rule-test kit (08 BR-ID-28 细则「待加验记录」, BR-WDR-01 细则「删除」; orchestrator §9,
// FU-REVERIFY-WRITE-AFTER-DELETE). Requests in flight must not write the old-number re-verification
// data back once the account has entered processing or is deleted: users.status deleting or deleted
// (口径 of §9). Other accounts behave as before; a ban lives in user_risk_state, not users.status,
// and an account in its cooling period is still status normal.
//
// Two real things over one cloned test database, as couli_app:
//   - the HTTP app of reverify/kit.ts (`http`): only the provider exchange is a test double;
//   - the worker's deletion round of reverify-deletion/kit.ts (`workers`): `worker` reaches done
//     (status deleted), `blockedWorker` commits the cleanup and stays deleting.
// The two have separate FixedClocks: updated_at tells a write of the cleanup from a late request.
//
// The barrier (heldRound). A cleanup transaction takes the users row first and goes to the catalog
// port last, so another connection holding the user's favorites row parks the real cleanup with
// everything done and nothing committed. A request sent then sees the session live and the data
// there, and stops on the users row behind the cleanup. Letting the favorites row go commits the
// cleanup, and only then does the request's write run, on the row's latest version. The waits are
// seen in pg_stat_activity and pg_locks, never timed. Without any status condition the request
// waits; a conditional UPDATE that already reads deleting has nothing to wait for and ends, which
// is why reachedBarrier takes either.
//
// The status moves to deleting in a fixture statement (what deletion-expiry.ts does at ⑥). The
// cooling-period expiry is not what is under test, and refresh is the only one of these that passes
// the deletion guard once the status has moved: reverify requests start while the account is normal.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { recordRefreshActivity } from '../../../../apps/api/src/modules/identity/application/reverify-activity.ts';
import {
  reserveFailure,
  settlePassed,
  type ReverifySubject,
} from '../../../../apps/api/src/modules/identity/infra/reverify-store.ts';
import {
  gate,
  lockWaiters,
  seedRequest,
  userRow,
  type Member,
} from '../deletion-processing/kit.ts';
import {
  CLEARED,
  close as closeWorkers,
  favorite,
  holdFavorites,
  open as openWorkers,
  reset as resetWorkers,
  reverifiedDevices,
  reverifyState,
  type Kit as Workers,
  type ReverifyState,
} from '../reverify-deletion/kit.ts';
import {
  TODAY,
  closeKit,
  openKit,
  type Device,
  type Fixture,
  type Kit as Http,
} from '../reverify/kit.ts';

export interface Suite {
  readonly http: Http;
  readonly workers: Workers;
}

export async function openSuite(): Promise<Suite> {
  const http = await openKit();
  try {
    return { http, workers: await openWorkers(http.suite.database) };
  } catch (error) {
    await closeKit(http);
    throw error;
  }
}

/** The worker's pool goes first: the HTTP kit drops the database. */
export async function closeSuite(suite: Suite | undefined): Promise<void> {
  if (suite === undefined) return;
  try {
    await closeWorkers(suite.workers);
  } finally {
    await closeKit(suite.http);
  }
}

/** A round is across apps: every open request of earlier tests reaches done. */
export function resetSuite(suite: Suite): Promise<void> {
  return resetWorkers(suite.workers);
}

export const ROUNDS = [
  { round: 'worker', status: 'deleted' },
  { round: 'blockedWorker', status: 'deleting' },
] as const;
export type Round = (typeof ROUNDS)[number]['round'];

export const WRITE_NAMES = ['recordRefreshActivity', 'settlePassed', 'reserveFailure'] as const;
export type WriteName = (typeof WRITE_NAMES)[number];

/** Each of the three writes against an account in each of the two statuses. */
export const WRITES_BY_STATUS = WRITE_NAMES.flatMap((write) =>
  ROUNDS.map((round) => ({ write, ...round })),
);

/** An account of the fixture's app and a device, for a direct call of one of the three writes. */
export interface Target {
  readonly uid: string;
  readonly m: Member;
  readonly device: Device;
  readonly now: Date;
}

export function memberOf(f: Fixture, uid: string): Member {
  return { appId: f.appId, uid, phoneHmac: null };
}

export function subjectOf(m: Member): ReverifySubject {
  return { app_id: m.appId, user_id: m.uid };
}

/** The handle the three writes run on: their statements name no schema. */
export function direct(suite: Suite): Kysely<DB> {
  return suite.workers.db.withSchema('app');
}

export async function account(suite: Suite, f: Fixture): Promise<Target> {
  const { uid } = await f.user();
  return {
    uid,
    m: memberOf(f, uid),
    device: await f.device(),
    now: suite.http.clock.now(),
  };
}

/** The real implementation of one of the three writes. What it answers is not judged here. */
export function write(suite: Suite, name: WriteName, target: Target): Promise<unknown> {
  const { m, device, now } = target;
  const db = direct(suite);
  if (name === 'recordRefreshActivity') {
    return db.transaction().execute((trx) =>
      recordRefreshActivity(trx, {
        app_id: m.appId,
        user_id: m.uid,
        device_id: device.id,
        now,
      }),
    );
  }
  if (name === 'settlePassed') {
    return settlePassed(db, subjectOf(m), { deviceHash: device.hash, now });
  }
  return reserveFailure(db, subjectOf(m), TODAY, now);
}

export interface Written {
  readonly state: Partial<ReverifyState>;
  readonly devices: readonly { device_hash: string; source: string }[];
}

/**
 * What a write leaves on an account that had two failures today (fixture `failures(uid, 2)`):
 * the columns it moves and the reverified_devices rows.
 */
export function written(name: WriteName, target: Target): Written {
  if (name === 'recordRefreshActivity') {
    return {
      state: {
        last_active_at: target.now,
        last_login_device_hash: target.device.hash,
        reverify_fail_count: 2,
        reverify_fail_day: TODAY,
      },
      devices: [],
    };
  }
  if (name === 'settlePassed') {
    return {
      state: { reverify_fail_count: 0, reverify_fail_day: null },
      devices: [{ device_hash: target.device.hash, source: 'self' }],
    };
  }
  return { state: { reverify_fail_count: 3, reverify_fail_day: TODAY }, devices: [] };
}

/** What the cooling-period expiry leaves: users.status deleting and a processing request. */
export async function enterProcessing(suite: Suite, m: Member) {
  const { db } = suite.workers;
  await sql`UPDATE app.users SET status = 'deleting', row_version = row_version + 1
    WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(db);
  return seedRequest(db, m);
}

/** An account that went through a real round and is in `round`'s final status, data removed. */
export async function throughRound(suite: Suite, m: Member, round: Round): Promise<void> {
  await enterProcessing(suite, m);
  await suite.workers[round].runOnce();
}

class HoldReleased extends Error {}

/**
 * One real round of `round`, parked in its cleanup transaction while `whileHeld` runs (see the
 * header). The cleanup is seen waiting before `whileHeld` starts; it commits once `whileHeld` is
 * over, and the round has ended when this returns.
 */
export async function heldRound(
  suite: Suite,
  round: Round,
  m: Member,
  whileHeld: () => Promise<void>,
): Promise<void> {
  const { workers } = suite;
  await favorite(workers.db, m);
  const holding = gate();
  const release = gate();
  const holder = workers.db
    .transaction()
    .execute(async (trx): Promise<void> => {
      expect(await holdFavorites(m)(trx)).toBeGreaterThan(0n);
      holding.open();
      await release.promise;
      throw new HoldReleased();
    })
    .catch((error: unknown) => {
      if (!(error instanceof HoldReleased)) throw error;
    });
  await Promise.race([holding.promise, holder]);
  const running = workers[round].runOnce();
  try {
    await lockWaiters(workers.db, 1);
    await whileHeld();
  } finally {
    release.open();
    await Promise.allSettled([running, holder]);
  }
}

/**
 * `request` is at the barrier: `count` sessions wait on a lock (the parked cleanup and the request
 * behind it), or the request has ended without writing to wait for (see the header). A request
 * doing neither within the bound fails here, so a pass never comes from a request still on its way.
 */
export async function reachedBarrier(
  f: Fixture,
  count: number,
  request: Promise<unknown>,
): Promise<void> {
  const progress = { ended: false };
  const end = () => {
    progress.ended = true;
  };
  void request.then(end, end);
  const seen = await f.lockWaiters(count, [request]);
  expect(
    progress.ended || seen >= count,
    'the request neither waited on the users row nor ended',
  ).toBe(true);
}

/**
 * The status moving under a write that has already read it. Another connection holds the users row
 * while the status is still normal, so any plain read of the write sees normal; `start` runs until
 * it waits on that row, then the status moves to deleting in the holder and commits. Only a
 * condition on the write itself, or a read that locks the row, sees it. Nothing but the status moves.
 */
export async function statusMovesUnderWrite(
  suite: Suite,
  f: Fixture,
  m: Member,
  start: () => Promise<unknown>,
): Promise<void> {
  const locked = gate();
  const release = gate();
  const holder = suite.workers.db.transaction().execute(async (trx): Promise<void> => {
    const { rows } = await sql`SELECT 1 FROM app.users
      WHERE app_id = ${m.appId} AND id = ${m.uid} FOR NO KEY UPDATE`.execute(trx);
    expect(rows).toHaveLength(1);
    locked.open();
    await release.promise;
    await sql`UPDATE app.users SET status = 'deleting'
      WHERE app_id = ${m.appId} AND id = ${m.uid}`.execute(trx);
  });
  await Promise.race([locked.promise, holder]);
  const call = start();
  try {
    expect(await f.lockWaiters(1, [call])).toBe(1);
  } finally {
    release.open();
    await holder;
  }
  await call;
}

/**
 * Nothing was written back after the cleanup committed: the six columns empty, no
 * reverified_devices row, and updated_at is still the worker clock's (a late request's is the HTTP
 * clock's). The account really reached `status`.
 */
export async function expectNoWriteBack(suite: Suite, m: Member, status: string): Promise<void> {
  const { workers } = suite;
  expect(await reverifyState(workers.db, m)).toEqual(CLEARED);
  expect(await reverifiedDevices(workers.db, m)).toEqual([]);
  expect(await userRow(workers.db, m)).toMatchObject({ status, updated_at: workers.clock.now() });
}

/** The users row is exactly `before`, and the account has no reverified_devices row. */
export async function expectUntouched(
  suite: Suite,
  m: Member,
  before: Awaited<ReturnType<typeof userRow>>,
): Promise<void> {
  const { workers } = suite;
  expect(await userRow(workers.db, m)).toEqual(before);
  expect(await reverifiedDevices(workers.db, m)).toEqual([]);
}
