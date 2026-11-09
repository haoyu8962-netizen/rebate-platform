// B1-03zn rule-test kit: console registration of order appeals counts like the app's submission
// (BR-ID-36 细则「维持后再申诉」: the same order at most 3 times, the first included, revoked ones
// too, never restarted; 编排 21:27 after B1-03zl: the console registration and the user submission
// take one and the same transaction-level advisory lock, key `risk.appeals.order:<app_id>:<order_id>`).
//
// One admin harness drives both sides over the same database, Redis and field keys:
// - the admin entry (B1-03ze kit: POST /admin/v1/appeals, an account with risk.appeal);
// - the api entry (createHttpApp('api')), where the order's owner is signed in with a real device
//   (signed POST /v1/devices, a persisted session) and calls POST / GET /v1/me/appeals.
// The app id is at most 32 characters (the X-App-Id maxLength), so the read kit's setup (40
// characters) is not used; the scenario object has the same shape as the B1-03ze one.
//
// Orders are the B1-03ze seeds (rebate_status VOID, reason BLACKLIST, the void_commission hit).
// Appeals are closed by a fixture write (as the B1-03zl kit does): the order stays voided, as with a
// revoked appeal whose 申诉恢复差错单 is not processed yet. Both entry clocks move together (tick), so
// created_at orders the appeals of both sides. Every execution belongs to the isolated container
// runner.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { fixture, signedIn, type Harness } from '../../admin/auth/kit.ts';
import { BLOCKED, admin, grant } from '../admin-appeals-read/kit.ts';
import {
  DAY,
  HOUR,
  LIST,
  PERMISSION,
  REASON,
  at,
  mountedWrites,
  orderAppeal,
  writers,
  type Member,
  type Order,
} from '../admin-appeals-write/kit.ts';
import { PATH } from '../appeals/http-kit.ts';
import { sign } from '../signature/kit.ts';

export type Outcome = 'upheld' | 'revoked';
export type Contender = 'admin' | 'user';

/** The user submission's lock key, letter for letter (appeals.ts submitOrder, B1-03zl). */
export const orderLockKey = (appId: string, orderId: string) =>
  `risk.appeals.order:${appId}:${orderId}`;

/**
 * An app of its own (`aoa_` plus 28 hex digits: exactly 32 characters), its console account with
 * risk.appeal signed in on the admin entry, and the api entry over the same harness.
 */
export async function setup(h: Harness) {
  const appId = `aoa_${randomUUID().replaceAll('-', '').slice(0, 28)}`;
  const f = await fixture(h);
  expect(
    mountedWrites(f),
    'POST /admin/v1/appeals, /admin/v1/appeals/{appeal_id}/claim and /resolve on the admin entry',
  ).toEqual([true, true, true]);
  const a = await admin(h, appId);
  await grant(h, f, appId, a, [PERMISSION]);
  const session = await signedIn(f, a);
  const get = (path: string, query: Record<string, string>, headers: Record<string, string>) => {
    const search = new URLSearchParams(query).toString();
    return f.read(session.admin_token, search === '' ? path : `${path}?${search}`, headers);
  };
  const api = await fixture(h, { entry: 'api' });
  return {
    h,
    f,
    a,
    appId,
    token: session.admin_token,
    list: (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      get(LIST, query, headers),
    detail: (id: string, headers: Record<string, string> = {}) =>
      get(`${LIST}/${encodeURIComponent(id)}`, {}, headers),
    lookup: (query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
      get(BLOCKED, query, headers),
    ...writers(f, a, session.admin_token),
    api,
  };
}
export type Context = Awaited<ReturnType<typeof setup>>;

/** Both entry clocks one step on (default one second). */
export function tick(c: Context, ms = 1000) {
  c.f.clock.advanceMs(ms);
  c.api.clock.advanceMs(ms);
}

/** The body of a console registration (POST /admin/v1/appeals). */
export const registerBody = (
  targetType: 'account' | 'order' | 'blocked_request',
  targetId: string,
  content = '订单返利被作废，本人经企业微信联系客服申诉。',
) => ({ target_type: targetType, target_id: targetId, content, reason: REASON });

/**
 * The order's owner signed in on the api entry: a device registered through signed POST
 * /v1/devices and a persisted session of the user (identity's own createSession).
 */
export async function appUser(c: Context, user: Member) {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': c.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await c.api.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode, 'POST /v1/devices').toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  const tokens = c.api.app.get<TokenService>(TOKEN_SERVICE);
  const session = await c.h.db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid: user.id, app_id: c.appId, device_id: device.device_id, scp: 'full' },
        { clock: c.api.clock, tokens },
      ),
    );
  const send = (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const timestamp = String(Math.floor(c.api.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const path = url.split('?')[0]!;
    return c.api.app.inject({
      method,
      url,
      ...(raw === '' ? {} : { payload: raw }),
      headers: {
        ...headers,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign(method, path, Buffer.from(raw), timestamp, nonce, device.install_secret),
        'x-trace-id': randomUUID(),
        'idempotency-key': randomUUID(),
        authorization: `Bearer ${session.access_token}`,
      },
    });
  };
  return {
    /** POST /v1/me/appeals on the order (a fresh idempotency key each time). */
    submit: (orderId: string, content = '订单返利被作废，请核查。') =>
      send('POST', PATH, { target_type: 'order', target_id: orderId, content }),
    /** GET /v1/me/appeals (first page). */
    list: () => send('GET', PATH),
  };
}
export type AppUser = Awaited<ReturnType<typeof appUser>>;

/** attempt_no / can_resubmit of each listed appeal, by appeal id. */
export function attemptsOf(
  items: readonly { appeal_id: string; attempt_no: number; can_resubmit: boolean }[],
): Record<string, { attempt_no: number; can_resubmit: boolean }> {
  return Object.fromEntries(
    items.map((item) => [
      item.appeal_id,
      { attempt_no: item.attempt_no, can_resubmit: item.can_resubmit },
    ]),
  );
}

/** Closed appeals on the order, oldest first, all closed well before now (15, 12, 9 … days ago). */
export async function seedHistory(
  c: Context,
  user: Member,
  o: Order,
  outcomes: readonly Outcome[],
) {
  const ids: string[] = [];
  for (const [n, status] of outcomes.entries()) {
    const row = await orderAppeal(c, user, o, { status, created_at: at(-(15 - 3 * n) * DAY) });
    ids.push(row.id);
  }
  return ids;
}

/** One closed order appeal written on `db` (a fixture transaction), as the read kit seeds them. */
export async function insertClosedAppeal(
  db: Kysely<DB> | Transaction<DB>,
  c: Context,
  user: Member,
  o: Order,
  status: Outcome,
  created: Date,
) {
  const id = randomUUID();
  await db
    .insertInto('appeals')
    .values({
      id,
      app_id: c.appId,
      user_id: user.id,
      target_type: 'order',
      request_type: null,
      target_id: o.order_id,
      related_phone_hmac: null,
      prev_risk_state: null,
      status,
      content: `申诉陈述-${id}`,
      deadline_at: new Date(created.getTime() + 3 * DAY),
      handler_id: c.a.id,
      closed_at: new Date(created.getTime() + HOUR),
      row_version: 1,
      created_at: created,
      updated_at: created,
    })
    .execute();
  return id;
}

/**
 * One processing order appeal written on `db` (a fixture transaction) at the entry clock's now, as
 * the app's submission (`app`) or a console registration (`admin`, registered by the context's
 * account) writes it.
 */
export async function insertProcessingAppeal(
  db: Kysely<DB> | Transaction<DB>,
  c: Context,
  user: Member,
  o: Order,
  source: 'app' | 'admin',
) {
  const id = randomUUID();
  const now = c.f.clock.now();
  await db
    .insertInto('appeals')
    .values({
      id,
      app_id: c.appId,
      user_id: user.id,
      target_type: 'order',
      request_type: null,
      target_id: o.order_id,
      related_phone_hmac: null,
      prev_risk_state: null,
      status: 'processing',
      content: `处理中的订单申诉-${id}`,
      deadline_at: new Date(now.getTime() + 3 * DAY),
      handler_id: null,
      closed_at: null,
      row_version: 0,
      created_at: now,
      updated_at: now,
      source,
      registered_by: source === 'admin' ? c.a.id : null,
    })
    .execute();
  return id;
}

/**
 * Closes a processing appeal as `status` one step after the last one (a fixture write; the order
 * stays as it is: voided, its recovery ticket not processed).
 */
export async function closeAppeal(c: Context, appealId: string, status: Outcome) {
  tick(c);
  const now = c.f.clock.now();
  const closed = await sql`
    UPDATE app.appeals
       SET status = ${status}, closed_at = ${now}, handler_id = ${c.a.id},
           updated_at = ${now}, row_version = row_version + 1
     WHERE app_id = ${c.appId} AND id = ${appealId} AND status = 'processing'
  `.execute(c.h.db);
  expect(closed.numAffectedRows, `close ${appealId}`).toBe(1n);
}

/** Every appeal of the app on the order, oldest first. */
export const orderRows = (c: Context, orderId: string) =>
  c.h.db
    .selectFrom('appeals')
    .selectAll()
    .where('app_id', '=', c.appId)
    .where('target_type', '=', 'order')
    .where('target_id', '=', orderId)
    .orderBy('created_at')
    .execute();

/** The order's rebate status and reason (still VOID + BLACKLIST: still appealable). */
export const orderState = (c: Context, orderId: string) =>
  c.h.db
    .selectFrom('orders')
    .select(['rebate_status', 'reason'])
    .where('app_id', '=', c.appId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();

export const VOIDED = { rebate_status: 'VOID', reason: 'BLACKLIST' };

// ---- the order lock ----

/** Takes the order's transaction-level advisory lock on `trx` (the user submission's key). */
export async function holdOrderLock(trx: Transaction<DB>, appId: string, orderId: string) {
  const key = orderLockKey(appId, orderId);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

/** Whether the order lock is free now (tried and released in a transaction of its own). */
export function orderLockFree(c: Context, orderId: string): Promise<boolean> {
  return c.h.db.transaction().execute(async (trx) => {
    const result = await sql<{ acquired: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${orderLockKey(c.appId, orderId)}, 0))
        AS acquired`.execute(trx);
    return result.rows[0]!.acquired;
  });
}

export function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open: () => release(), wait: () => opened };
}

/**
 * Waits until PostgreSQL shows `count` backends waiting on a lock that backend `pid` holds; fails
 * as soon as one of the requests has finished (it went past the lock instead of waiting).
 */
export async function waitersOf(
  db: Kysely<DB>,
  pid: number,
  count: number,
  finished: () => boolean,
) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    expect(finished(), 'every request must wait for the transaction holding the order lock').toBe(
      false,
    );
    const rows = await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity
       WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.execute(db);
    if (rows.rows.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect.fail('PostgreSQL did not show the requests waiting on the order lock');
}

/**
 * As waitersOf, but each waiter must be waiting on the order's advisory lock itself (the bigint key
 * hashtextextended(`risk.appeals.order:<app_id>:<order_id>`, 0): classid the high 32 bits, objid the
 * low 32 bits, objsubid 1), not on anything else the holder has (such as the row it inserted under
 * the processing unique index).
 */
export async function orderLockWaitersOf(
  c: Context,
  orderId: string,
  pid: number,
  count: number,
  finished: () => boolean,
) {
  const key = orderLockKey(c.appId, orderId);
  for (let attempt = 0; attempt < 250; attempt += 1) {
    expect(finished(), 'every request must wait for the transaction holding the order lock').toBe(
      false,
    );
    const rows = await sql<{ pid: number }>`
      SELECT DISTINCT l.pid FROM pg_locks l
       WHERE NOT l.granted
         AND l.locktype = 'advisory'
         AND l.objsubid = 1
         AND l.classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
         AND l.objid::bigint = (hashtextextended(${key}, 0) & 4294967295)
         AND ${pid} = ANY(pg_blocking_pids(l.pid))`.execute(c.h.db);
    if (rows.rows.length >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect.fail('PostgreSQL did not show the requests waiting on the order advisory lock');
}
