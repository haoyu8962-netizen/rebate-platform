// Kit of B1-20c: POST /v1/auth/merge, the merge of a third-party account without phone into the
// account that owns the phone number (规划/08 BR-ID-06 正文与细则「并号」; 04 §6.1 mergeAccount;
// 02 §18「并号」; 10 AC-S1-59 ②③⑥, AC-S1-130 ③; orchestrator D10-1099 Q-3–Q-6, T-7; D10-1103:
// a flagged target on a device not re-verified → 10010, nothing merged).
// Built on B1-20a's HTTP kit (real AppModule over PG and Redis: openKit / closeKit, the merge_ticket
// fault switch, storedTicket). A ticket is only ever obtained through the real POST /v1/me/phone;
// conditions are then changed straight in app.* within their constraints, and the merge is sent
// signed, with the source account's session. Static imports of apps/api are types only.
// hold() / lockWaiters() / queued() order a merge against another transaction on a users row (the
// target's or the source's): the merge stops at its first lock on that row (or the key check of a
// row that references it), after everything it read before; queued() fails the test when the merge
// never waited there. failTicketScripts() makes only the ticket's compare-and-delete fail.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { apiRequire, sign } from '../../risk/signature/kit.ts';
import {
  INSTANT,
  PHONE_CONTEXT,
  TICKET_NAMESPACE,
  mergeable,
  storedTicket,
  ticketKey,
  type Kit,
} from '../bind-phone/http-kit.ts';
import { seedUser } from '../registration/kit.ts';
import { outbox, type Response } from '../sms-codes/http-kit.ts';
import { phone } from '../sms-codes/kit.ts';

export { INSTANT };
export const MERGE_PATH = '/v1/auth/merge';
export const BIND_PATH = '/v1/me/phone';
export const ME_PATH = '/v1/me';
/** Clears the SMS resend interval before a second code to the same number. */
export const RESEND_GAP_MS = 120_000;
const DAY_MS = 86_400_000;

export type Provider = 'wechat' | 'apple' | 'huawei';
type BindingPatch = Partial<Insertable<DB['union_bindings']>>;

type Method = 'GET' | 'POST';
interface WireRequest {
  method: Method;
  url: string;
  headers: Record<string, string>;
  payload?: string;
}
type Inject = (request: WireRequest) => Promise<Response>;

export interface Envelope {
  code: number;
  msg: string;
  trace_id: string;
  data?: Record<string, unknown>;
}

export interface Tokens {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  session_scope: string;
}

export interface SendOptions {
  /** Bearer token; the source's session token when absent, no Authorization header when null. */
  token?: string | null;
  /** Idempotency-Key; a fresh one when absent. */
  key?: string;
  headers?: Record<string, string>;
}

export interface SceneOptions {
  /** The source account's register_method and its one user_oauth provider (default wechat). */
  provider?: Provider;
  /** An existing app (several sources in one app); a fresh app when absent. */
  appId?: string;
  /** The number to bind; a fresh number owned by a fresh sms target when absent. */
  number?: string;
  /** The target that owns `number` (with `number`); a fresh one when absent. */
  target?: string;
  /** Seeds app_versions (ios / appstore) with this minimum before the device registers. */
  minVersion?: string;
}

function statusOf(code: number): number {
  if (code === 0) return 200;
  if (code === 50001) return 500;
  if (code === 30411) return 422;
  if ([10001, 10002].includes(code)) return 401;
  if ([10006, 10007, 10010, 10405].includes(code)) return 403;
  return 400;
}

/** The response envelope of POST /v1/auth/merge, checked against the contract first. */
export function answer(kit: Kit, response: Response, code: number): Envelope {
  expect(response.statusCode).toBe(statusOf(code));
  const body = response.json<Envelope>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const status = code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX';
  const responses = kit.document.paths[MERGE_PATH]!['post']!.responses;
  const schema = responses[status]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

/** 30411 without the merge offer (BR-ID-06: 任一条件不满足时只返回 30411). */
export function refused(kit: Kit, response: Response): void {
  const body = answer(kit, response, 30411);
  expect(body.data?.['reason']).toBeUndefined();
  expect(body.data?.['merge_ticket']).toBeUndefined();
}

/** A successful merge into `target`: LoginResponse, is_new_user false, a full-scope pair. */
export function merged(kit: Kit, response: Response, target: string): Tokens {
  const body = answer(kit, response, 0);
  expect(body.data).toEqual({
    user_id: target,
    is_new_user: false,
    tokens: {
      access_token: expect.any(String),
      access_expires_at: expect.any(String),
      refresh_token: expect.any(String),
      refresh_expires_at: expect.any(String),
      session_scope: 'full',
    },
  });
  return body.data!['tokens'] as Tokens;
}

async function registerDevice(inject: Inject, headers: Record<string, string>) {
  const hash = randomBytes(32).toString('hex');
  const created = await inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: hash, id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const data = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  return { id: data.device_id, secret: data.install_secret, hash };
}
export type Device = Awaited<ReturnType<typeof registerDevice>>;

export async function scene(kit: Kit, options: SceneOptions = {}) {
  if (options.appId === undefined) {
    // A fresh app starts a fresh story; a shared app keeps the clock its first scene moved.
    kit.clock.set(INSTANT);
    kit.faults.ticketStore = false;
    kit.faults.claims = false;
    kit.faults.ledger = false;
  }
  const appId = options.appId ?? `mg_${randomBytes(10).toString('hex')}`;
  const db = kit.suite.db.withSchema('app');
  const inject = kit.app.inject.bind(kit.app) as unknown as Inject;
  const provider = options.provider ?? 'wechat';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  if (options.minVersion !== undefined) {
    await db
      .insertInto('app_versions')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform: 'ios',
        channel: 'appstore',
        latest_version: options.minVersion,
        min_supported_version: options.minVersion,
        update_title: 'test',
        update_notes: 'test',
        store_url: 'https://example.test/app',
        default_store: 'appstore',
        store_listings: JSON.stringify([]),
      })
      .execute();
  }
  const device = await registerDevice(inject, headers);
  // The source: registered with `provider` on this device (one registration record), no phone.
  const source = await seedUser(db, appId, { method: provider, hash: device.hash });
  const sourceOauth = await oauth(db, appId, source, provider);
  const hmac = (value: string) => kit.crypto.blindIndex(value, PHONE_CONTEXT);
  const number = options.number ?? phone('139');
  const phoneHmac = hmac(number);
  const target =
    options.target ?? (await seedUser(db, appId, { method: 'sms', status: 'normal', phoneHmac }));

  const login = (user: string, on: Device = device) =>
    db
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid: user, app_id: appId, device_id: on.id, scp: 'full' },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
  const session = await login(source);

  /** A signed POST of this scene's device (or `on`). */
  const post = (path: string, body: unknown, opts: SendOptions = {}, on: Device = device) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const token = opts.token === undefined ? session.access_token : opts.token;
    return inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...headers,
        'x-device-id': on.id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, on.secret),
        'x-trace-id': randomUUID(),
        'idempotency-key': opts.key ?? randomUUID(),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...opts.headers,
      },
    });
  };

  /** GET with `token` on this scene's device (or `on`). */
  const get = (path: string, token: string, on: Device = device) =>
    inject({
      method: 'GET',
      url: path,
      headers: {
        ...headers,
        'x-device-id': on.id,
        'x-trace-id': randomUUID(),
        authorization: `Bearer ${token}`,
      },
    });

  /** Sends a bind code (from `on`) through the real SMS service; returns it from the fake sender. */
  const send = async (to = number, on: Device = device) => {
    expect(
      await kit.sms.send({ app_id: appId, phone: to, purpose: 'bind', device_id: on.id }),
    ).toMatchObject({ code: 0 });
    const sent = outbox(kit.app)
      .filter((m) => m.app_id === appId && m.phone === to && m.purpose === 'bind')
      .at(-1);
    expect(sent).toBeDefined();
    return sent!.code;
  };

  /** The real offer: bind the target's number → 30411 mergeable; returns the merge_ticket. */
  const offer = async () => {
    const code = await send();
    return mergeable(kit, await post(BIND_PATH, { phone: number, code }));
  };

  const merge = (ticket: string, opts: SendOptions = {}) =>
    post(MERGE_PATH, { merge_ticket: ticket }, opts);

  const user = (id: string) =>
    db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const rows = {
    oauth: (owner: string) =>
      db
        .selectFrom('user_oauth')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .orderBy('id')
        .execute(),
    sessions: (owner: string) =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    loginLogs: (owner: string) =>
      db
        .selectFrom('login_logs')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .orderBy('id')
        .execute(),
    registrations: (owner: string) =>
      db
        .selectFrom('device_registrations')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .execute(),
    bindings: (owner: string) =>
      db
        .selectFrom('union_bindings')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .orderBy('id')
        .execute(),
    pushTokens: () =>
      db.selectFrom('push_tokens').selectAll().where('app_id', '=', appId).orderBy('id').execute(),
    /** The user-level consent records of `owner`. */
    consents: (owner: string) =>
      db
        .selectFrom('consent_records')
        .selectAll()
        .where('app_id', '=', appId)
        .where('user_id', '=', owner)
        .orderBy('id')
        .execute(),
    device: (id = device.id) =>
      db
        .selectFrom('devices')
        .selectAll()
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
  };

  /** Every row a merge writes, of this app; for "nothing moved" assertions. */
  const snapshot = async () => ({
    users: await db
      .selectFrom('users')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    oauth: await db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sessions: await db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    bindings: await db
      .selectFrom('union_bindings')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    registrations: await db
      .selectFrom('device_registrations')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('user_id')
      .execute(),
    loginLogs: await db
      .selectFrom('login_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    pushTokens: await rows.pushTokens(),
    deletions: await db
      .selectFrom('deletion_requests')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    deletedIdentities: await db
      .selectFrom('deleted_identities')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    consents: await db
      .selectFrom('consent_records')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    reverifiedDevices: await db
      .selectFrom('reverified_devices')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  });

  // ---- fixtures that change a merge condition (straight into app.*) ----

  /** Another account of the app (sms, its own fresh number). */
  const bystander = () =>
    seedUser(db, appId, { method: 'sms', status: 'normal', phoneHmac: hmac(phone('135')) });

  const setParent = (child: string, parent: string) =>
    sql`UPDATE app.users SET parent_id = ${parent} WHERE app_id = ${appId}
      AND id = ${child}`.execute(db);

  const setStatus = (id: string, status: 'normal' | 'deleting' | 'deleted') =>
    sql`UPDATE app.users SET status = ${status} WHERE app_id = ${appId} AND id = ${id}`.execute(db);

  const setPhone = (id: string, value: string) =>
    sql`UPDATE app.users SET phone_hmac = ${hmac(value)} WHERE app_id = ${appId}
      AND id = ${id}`.execute(db);

  const setRisk = (id: string, state: 'banned' | 'appealing' | 'frozen' | 'normal') =>
    db.transaction().execute((trx) =>
      kit.risk.setRiskState(trx, {
        app_id: appId,
        user_id: id,
        state,
        reason: 'fixture reason',
        reason_category: state === 'normal' ? null : 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );

  const appeal = (id: string, previous: 'banned' | 'frozen') =>
    sql`INSERT INTO app.appeals (id, app_id, user_id, target_type, target_id, prev_risk_state,
        status, content, deadline_at, handler_id, closed_at)
      VALUES (${randomUUID()}, ${appId}, ${id}, 'account', ${id}, ${previous}, 'processing',
        'fixture appeal', ${new Date(kit.clock.now().getTime() + DAY_MS)}, null, null)`.execute(db);

  const order = async (owner: string) => {
    const orderId = randomUUID();
    const sub = `sub-${randomUUID()}`;
    const attrAt = kit.clock.now();
    await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
      VALUES ('taobao', ${sub}, ${orderId}, ${appId}, ${attrAt})`.execute(db);
    await sql`INSERT INTO app.orders
      (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, platform_status, attr_at)
      VALUES (${orderId}, ${appId}, 'taobao', ${sub}, 'item-fixture', ${owner}, 'PAID',
        ${attrAt})`.execute(db);
    return orderId;
  };

  /** One claim (找回申请) of `owner` as the applicant, submitted. */
  const claim = async (owner: string) => {
    const now = kit.clock.now();
    await sql`INSERT INTO app.claims
        (id, app_id, user_id, platform, order_no, order_no_type, paid_date, evidence_level, status,
         created_at, updated_at)
      VALUES (${randomUUID()}, ${appId}, ${owner}, 'taobao', ${`claim-${randomUUID()}`}, 'sub',
        '2026-10-10', null, 'submitted', ${now}, ${now})`.execute(db);
  };

  /**
   * One admin_adjustments row of `owner` (D10-1099 Q-3: any row makes the account non-empty).
   * The system's ACCOUNT_CLOSED kind needs no operator, amount or voucher.
   */
  const adjustment = async (owner: string, status: 'PENDING' | 'CANCELLED' | 'REJECTED') => {
    await sql`INSERT INTO app.admin_adjustments
        (adjust_id, app_id, user_id, direction, amount_fen, reason_code, refs, contra_subject,
         contra_platform, note, status, reject_note)
      VALUES (${randomUUID()}, ${appId}, ${owner}, 'decrease', null, 'ACCOUNT_CLOSED',
        ${JSON.stringify(['fixture-ref'])}::jsonb, 'COMMISSION_REVENUE', null, null, ${status},
        ${status === 'REJECTED' ? 'fixture rejection' : null})`.execute(db);
  };

  /** One union_bindings row of `owner` with its own union_accounts row (active taobao default). */
  const binding = async (owner: string, patch: BindingPatch = {}) => {
    const platform = patch.platform ?? 'taobao';
    const status = patch.status ?? 'active';
    const accountId = randomUUID();
    const now = kit.clock.now();
    await db
      .insertInto('union_accounts')
      .values({
        id: accountId,
        app_id: appId,
        platform,
        account_name: 'synthetic-account',
        status: 'active',
        auth_status: 'active',
      })
      .execute();
    const released = status === 'released';
    return db
      .insertInto('union_bindings')
      .values({
        id: randomUUID(),
        app_id: appId,
        user_id: owner,
        platform,
        union_account_id: accountId,
        relation_id: randomBytes(6).toString('hex'),
        status,
        blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        reason: null,
        row_version: 3,
        bound_at: status === 'unbound' ? null : new Date(now.getTime() - 30 * DAY_MS),
        released_at: released ? new Date(now.getTime() - 40 * DAY_MS) : null,
        cooldown_until: released ? new Date(now.getTime() - 10 * DAY_MS) : null,
        created_at: new Date(now.getTime() - 30 * DAY_MS),
        updated_at: new Date(now.getTime() - 30 * DAY_MS),
        ...patch,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  };

  /** A deletion request of `owner` (users.status left as it is). */
  const deletion = async (owner: string, status: 'cooling' | 'processing') => {
    const now = kit.clock.now().getTime();
    const applyAt = new Date(status === 'processing' ? now - 16 * DAY_MS : now - 2 * DAY_MS);
    await sql`INSERT INTO app.deletion_requests
        (id, app_id, user_id, status, apply_at, cooling_until, cancelled_at, cancel_reason,
         processed_at, balance_snapshot_fen)
      VALUES (${randomUUID()}, ${appId}, ${owner}, ${status}, ${applyAt},
        ${new Date(applyAt.getTime() + 15 * DAY_MS)}, null, null, null, 0)`.execute(db);
  };

  /** A push token of `on` bound to `sid` of `owner` (notification's row, written directly). */
  const pushToken = async (owner: string, sid: string, on: Device = device) => {
    const id = randomUUID();
    await db
      .insertInto('push_tokens')
      .values({
        id,
        app_id: appId,
        user_id: owner,
        bound_sid: sid,
        device_id: on.id,
        provider: 'mobpush',
        token: `fixture-push-${id}`,
        token_set_at: kit.clock.now(),
        frozen_until: null,
        revoked_at: null,
      })
      .execute();
    return id;
  };

  /** An earlier login record of `owner` on this device. */
  const loginLog = (owner: string, method: string) =>
    sql`INSERT INTO app.login_logs (app_id, user_id, device_id_hash, ip, method, device_hash,
        created_at)
      VALUES (${appId}, ${owner}, ${`fixture-${device.hash.slice(0, 16)}`}, '192.0.2.10',
        ${method}, ${device.hash}, ${new Date(kit.clock.now().getTime() - DAY_MS)})`.execute(db);

  /** The withdraw.dormant_reverify_days switch of this app (BR-WDR-01 细则「判定」). */
  const dormantDays = (days: number) =>
    db
      .insertInto('config_items')
      .values({
        app_id: appId,
        key: 'withdraw.dormant_reverify_days',
        value: JSON.stringify(days),
        updated_by: 'fixture',
      })
      .execute();

  /** One consent record: device-level of `on` (this device by default), user-level with `user`. */
  const consent = (input: {
    user?: string;
    on?: Device;
    type: string;
    version: number;
    agoMs: number;
    accepted?: boolean;
  }) => {
    const at = new Date(kit.clock.now().getTime() - input.agoMs);
    return db
      .insertInto('consent_records')
      .values({
        app_id: appId,
        subject_type: input.user === undefined ? 'device' : 'user',
        user_id: input.user ?? null,
        device_id: input.user === undefined ? (input.on ?? device).id : null,
        type: input.type,
        version: input.version,
        accepted: input.accepted ?? true,
        channel: 'privacy_center',
        client_at: at,
        server_at: at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  };

  /** The re-verification flag of `user` (BR-WDR-01 细则), set at `at`. */
  const flag = (
    user: string,
    trusted: { realname: boolean; providers: Provider[] },
    at: Date = kit.clock.now(),
  ) =>
    sql`UPDATE app.users SET reverify_flagged_at = ${at},
        reverify_trusted = ${JSON.stringify(trusted)}::jsonb
      WHERE app_id = ${appId} AND id = ${user}`.execute(db);

  /** `on` (this device by default) is a re-verified device of `user`. */
  const reverified = (user: string, on: Device = device) =>
    sql`INSERT INTO app.reverified_devices (id, app_id, user_id, device_hash, source)
      VALUES (${randomUUID()}, ${appId}, ${user}, ${on.hash}, 'self')`.execute(db);

  /**
   * Another connection holds the users row of `user` (FOR UPDATE) until release(); `work` then runs
   * in that transaction before it commits. FOR UPDATE also stops the key check of a row that
   * references the user (FOR KEY SHARE), so a merge waits here even if it never locks the row.
   */
  const hold = async (user: string) => {
    type Work = (trx: Transaction<DB>) => Promise<unknown>;
    let open!: (work: Work | null) => void;
    const released = new Promise<Work | null>((resolve) => {
      open = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction().execute(async (trx) => {
      const rows = await sql`SELECT 1 FROM app.users WHERE app_id = ${appId} AND id = ${user}
        FOR UPDATE`.execute(trx);
      expect(rows.rows).toHaveLength(1);
      locked();
      const work = await released;
      if (work !== null) await work(trx);
    });
    await Promise.race([ready, holder]);
    return {
      release: async (work: Work | null = null) => {
        open(work);
        await holder;
      },
    };
  };

  /**
   * Polls until `count` sessions of the test database wait on a heavyweight lock (row locks
   * included) or every one of `requests` has ended, at most `ms`; the number last seen. The tests
   * of a file run one at a time on the kit's own database, so these are its requests.
   */
  const lockWaiters = async (
    count: number,
    requests: readonly Promise<unknown>[],
    ms = 5000,
  ): Promise<number> => {
    let running = requests.length;
    const ended = () => {
      running -= 1;
    };
    for (const request of requests) void request.then(ended, ended);
    const deadline = Date.now() + ms;
    for (;;) {
      const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
      const seen = result.rows[0]!.n;
      if (seen >= count || running === 0 || Date.now() >= deadline) return seen;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /**
   * Waits until one of `requests` waits on a lock behind `gate`. When none does (the request ended
   * or never reached the held row), opens the gate, lets the requests end and fails the test: a
   * merge that never queued behind the held row proves nothing about reading after the lock.
   */
  const queued = async (
    gate: Awaited<ReturnType<typeof hold>>,
    requests: readonly Promise<unknown>[],
  ): Promise<void> => {
    const seen = await lockWaiters(1, requests);
    if (seen < 1) {
      await gate.release();
      await Promise.allSettled(requests);
    }
    expect(seen, 'the merge never waited on the held users row').toBeGreaterThanOrEqual(1);
  };

  /** The ticket is still stored, unchanged (not consumed). */
  const ticketKept = async (ticket: string) => {
    const stored = await storedTicket(kit, ticket);
    expect(stored.value).not.toBeNull();
    expect(JSON.parse(stored.value!)).toEqual({
      app_id: appId,
      uid: source,
      phone_hmac: hmac(number),
    });
  };

  return {
    kit,
    db,
    appId,
    provider,
    device,
    source,
    sourceOauth,
    target,
    number,
    session,
    headers,
    hmac,
    login,
    newDevice: () => registerDevice(inject, headers),
    post,
    get,
    send,
    offer,
    merge,
    user,
    rows,
    snapshot,
    bystander,
    setParent,
    setStatus,
    setPhone,
    setRisk,
    appeal,
    order,
    claim,
    adjustment,
    binding,
    deletion,
    pushToken,
    loginLog,
    dormantDays,
    consent,
    flag,
    reverified,
    hold,
    lockWaiters,
    queued,
    ticketKept,
    oauth: (owner: string, p: Provider) => oauth(db, appId, owner, p),
  };
}
export type Scene = Awaited<ReturnType<typeof scene>>;
export type Snapshot = Awaited<ReturnType<Scene['snapshot']>>;

/** Columns a login of `user` may overwrite (activity values, BR-WDR-01 细则「判定」 flag). */
const ACTIVITY: readonly string[] = [
  'last_active_at',
  'last_login_device_hash',
  'updated_at',
  'row_version',
  'reverify_flagged_at',
  'reverify_trusted',
];

/** The snapshot with the activity columns of `user`'s users row left out. */
export function apartFromActivity(snapshot: Snapshot, user: string) {
  return {
    ...snapshot,
    users: snapshot.users.map((row) =>
      row.id !== user
        ? row
        : Object.fromEntries(Object.entries(row).filter(([key]) => !ACTIVITY.includes(key))),
    ),
  };
}

async function oauth(
  db: Kysely<DB>,
  appId: string,
  owner: string,
  provider: Provider,
): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('user_oauth')
    .values({
      id,
      app_id: appId,
      user_id: owner,
      provider,
      union_id: `union-${randomUUID()}`,
      open_id: `open-${randomUUID()}`,
    })
    .execute();
  return id;
}

/** The token opens GET /v1/me (on the scene's device unless `on`). */
export async function usable(s: Scene, token: string, on?: Device): Promise<void> {
  const response = await s.get(ME_PATH, token, on);
  expect(response.statusCode).toBe(200);
  expect(response.json<Envelope>().code).toBe(0);
}

/** The token's session is over: GET /v1/me answers 10002 (BR-ID-07). */
export async function revoked(s: Scene, token: string, on?: Device): Promise<void> {
  const response = await s.get(ME_PATH, token, on);
  expect(response.statusCode).toBe(401);
  expect(response.json<Envelope>().code).toBe(10002);
}

/** Puts a raw ticket value into the merge_ticket namespace (as the offer stores it). */
export async function plantTicket(kit: Kit, value: Record<string, unknown>): Promise<string> {
  const ticket = randomBytes(32).toString('hex');
  await kit.redis.namespace(TICKET_NAMESPACE).set(ticketKey(ticket), JSON.stringify(value), 300);
  return ticket;
}

/** Lets a stored ticket expire (Redis time, not the injected Clock). */
export async function expire(kit: Kit, ticket: string): Promise<void> {
  await kit.redis.namespace(TICKET_NAMESPACE).eval("return redis.call('PEXPIRE', KEYS[1], 1)", {
    keys: [ticketKey(ticket)],
    args: [],
    ttlSeconds: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await storedTicket(kit, ticket)).value).toBeNull();
}

type DriverCall = (this: unknown, command: string, ...args: unknown[]) => Promise<unknown>;
/** Redis commands that run a script; the merge_ticket namespace offers only get / set / eval. */
const SCRIPT_COMMANDS: ReadonlySet<string> = new Set([
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL',
  'FCALL_RO',
]);

/**
 * From now until disarm(): every script command (the compare-and-delete that consumes a ticket)
 * on a `merge_ticket:` key fails in the app's ioredis client before it reaches Redis, as a Redis
 * error reply (NOPERM) would; GET and SET of the namespace, and every other namespace, keep
 * working. kit.faults.ticketStore cannot tell get from eval, so this sits one layer lower, on the
 * driver. Proven on a scratch key of the app's own handle before it returns (a fault that does not
 * reach the app's client fails the test instead of passing silently).
 */
export async function failTicketScripts(kit: Kit): Promise<{ disarm(): void }> {
  const { Redis } = apiRequire('ioredis') as { Redis: { prototype: object } };
  const proto = Redis.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, 'call');
  const original = Reflect.get(proto, 'call') as DriverCall;
  const prefix = `${TICKET_NAMESPACE}:`;
  const faulty: DriverCall = function (this: unknown, command, ...args) {
    const script = SCRIPT_COMMANDS.has(command.toUpperCase());
    if (script && args.some((arg) => typeof arg === 'string' && arg.startsWith(prefix))) {
      const error = new Error('NOPERM fixture: merge_ticket script refused');
      error.name = 'ReplyError';
      return Promise.reject(error);
    }
    return original.call(this, command, ...args);
  };
  Object.defineProperty(proto, 'call', { configurable: true, writable: true, value: faulty });
  const disarm = () => {
    if (own === undefined) Reflect.deleteProperty(proto, 'call');
    else Object.defineProperty(proto, 'call', own);
  };
  try {
    const namespace = kit.redis.namespace(TICKET_NAMESPACE);
    const scratch = `fixture-${randomBytes(8).toString('hex')}`;
    await namespace.set(scratch, 'kept', 30);
    await expect(
      namespace.eval("return redis.call('DEL', KEYS[1])", {
        keys: [scratch],
        args: [],
        ttlSeconds: 1,
      }),
    ).rejects.toThrow();
    expect(await namespace.get(scratch)).toBe('kept');
  } catch (error) {
    disarm();
    throw error;
  }
  return { disarm };
}

/** Every app.idempotency_keys row of `appId`. */
export function idempotencyRows(db: Kysely<DB>, appId: string) {
  return db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** Rows of app.idempotency_keys (any app) whose whole row as text contains `needle`. */
export async function idempotencyRowsContaining(db: Kysely<DB>, needle: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.idempotency_keys AS t WHERE strpos(t::text, ${needle}) > 0
  `.execute(db);
  return Number(result.rows[0]?.n ?? '-1');
}

/** No phone number or ticket appears in any log line. */
export function quiet(kit: Kit, ...secrets: string[]): void {
  const text = kit.lines.join('\n');
  for (const secret of secrets) expect(text).not.toContain(secret);
}
