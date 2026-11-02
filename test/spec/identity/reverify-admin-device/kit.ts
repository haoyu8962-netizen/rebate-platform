// B1-02zx rule-test kit: POST /admin/v1/users/{user_id}/reverified-devices on the real admin entry
// and a real database (contract adminAddUserReverifiedDevice, CT-26j; 08 BR-WDR-01 细则「清除标记只走
// 人工」; task §9). No port is replaced and no skeleton is imported. Before the implementation the
// route is not mounted, so setup() fails on its first assertion and every integration case is red
// there, negative cases included.
//
// Admin-only cases run on useHarness() (admin/auth/kit.ts). The cases that need a withdrawal as well
// run the api entry of reverify/kit.ts and the admin entry over one database: adminHarness() gives
// fixture() a Harness over the kit's database and Redis, with an admin keyring of its own. The two
// entries have separate FixedClocks; nothing here compares across them.
//
// Who owns a device (D10-571 ⑨, D10-585): a device of a user is one a session of that user was bound
// to, revoked sessions included, and the device itself is not revoked. Devices are shared per
// install: no production code writes devices.user_id, and no seed here does either. sessionOn() is
// the one place that decides it, with a real sessions row; effect.int.test.ts #46 gets the same row
// from a real SMS login.
//
// Not pinned on purpose (listed in the task's output): which field answers when a user_id that is
// not a UUID comes with an invalid body (both are 20001 without an audit record).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { seed } from '../../admin/accounts/kit.ts';
import {
  ORIGIN,
  fixture,
  signedIn,
  type Harness,
  type HttpApp,
  type Response,
} from '../../admin/auth/kit.ts';
import {
  added,
  auditText,
  member,
  stepUp,
  user,
  type AuditRow,
  type Member,
  type User,
} from '../admin-profile/kit.ts';
import { deletion } from '../admin-realname/kit.ts';
import type { Kit, Trusted } from '../reverify/kit.ts';
import { PATH, validate } from './schema.ts';

export { added, auditText, deletion, member, stepUp, user };
export type { AuditRow, Member, User };

export const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';
export const REASON = '企业微信核对注册时间、最近一笔订单号与实名信息，旧号未换，登记用户当前手机';
export const ACTION = 'user_reverified_device_add';
export const PERMISSION = 'user.phone_change';
/** users.status deleting reads processing (BR-ID-28; the values of 10007's data.stage). */
export const DELETING = { reason: 'account_deleting', stage: 'processing' };
/** Each fits the Id schema (1–64 characters), so only the UUID check can answer. */
export const NOT_UUIDS = ['not-a-uuid', 'a'.repeat(64), 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'];
const ROUTE = PATH.replace('{user_id}', ':user_id');

export type Body = Record<string, unknown>;
export type Recorded = Schema<'AdminReverifiedDevice'>;
export type Target = Pick<User, 'id' | 'appId'>;
export interface Device {
  id: string;
  appId: string;
  hash: string;
}

interface RouteTable {
  getHttpAdapter(): {
    getInstance(): { hasRoute(options: { method: string; url: string }): boolean };
  };
}

export function mounted(app: HttpApp): boolean {
  return (app as unknown as RouteTable)
    .getHttpAdapter()
    .getInstance()
    .hasRoute({ method: 'POST', url: ROUTE });
}

/** A Harness over the database and Redis of reverify/kit.ts: the admin entry beside its api entry. */
export async function adminHarness(kit: Kit): Promise<Harness> {
  const dir = join(kit.dir, 'admin');
  mkdirSync(dir, { recursive: true });
  const master = randomBytes(32);
  const provider = new LocalKeyProvider(master);
  const wrapped = await createWrappedKeyring(provider);
  const masterFile = join(dir, 'master.hex');
  const keyringFile = join(dir, 'keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
  const appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const password = randomBytes(24).toString('base64url');
  return {
    db: kit.suite.db.withSchema('app'),
    redis: kit.suite.server,
    fields: await openFieldCrypto(wrapped, provider),
    env: {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1,192.0.2.0/24,2001:db8::/32',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'b1-02zx-app',
      JWT_PRIVATE_KEY_PEM: appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    password,
    passwordHash: await hashAdminPassword(password),
    appKey,
    apps: [],
  };
}

/** The admin entry with a signed-in super admin of `appId`. */
export async function setup(h: Harness, appId = `b1-02zx-${randomUUID()}`) {
  const f = await fixture(h);
  // Every integration case is red before the route exists, negative cases included.
  expect(
    mounted(f.app),
    'admin 入口必须挂载 POST /admin/v1/users/{user_id}/reverified-devices',
  ).toBe(true);
  const actor = await seed(h, appId, { isSuper: true });
  const session = await signedIn(f, actor);
  f.overrides.logger.info({ event: 'reverified_device_test_capture_ready' }, 'capture ready');
  return { ...f, h, appId, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export interface RecordOptions {
  /** The admin doing it (default: the super admin of setup). */
  as?: Member;
  /** null: no admin_token at all. */
  token?: string | null;
  /** undefined: a fresh valid totp token of the admin; null: no X-Step-Up-Token. */
  stepUp?: string | null;
  headers?: Record<string, string>;
}

/** POST /admin/v1/users/{user_id}/reverified-devices; never sends an Idempotency-Key. */
export async function record(s: Setup, userId: string, payload: Body, options: RecordOptions = {}) {
  const who = options.as?.who ?? s.actor;
  const token = options.token === undefined ? (options.as?.token ?? s.token) : options.token;
  const step =
    options.stepUp === undefined
      ? token === null
        ? null
        : await stepUp(s, who, token)
      : options.stepUp;
  return s.app.inject({
    method: 'POST',
    url: PATH.replace('{user_id}', encodeURIComponent(userId)),
    headers: {
      'content-type': 'application/json',
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(step === null ? {} : { 'x-step-up-token': step }),
      ...options.headers,
    },
    payload: JSON.stringify(payload),
    remoteAddress: '127.0.0.1',
  });
}

export const body = (device: Pick<Device, 'id'>, reason = REASON): Body => ({
  device_id: device.id,
  reason,
});

/** A 200: the contract envelope and its 200 schema; returns data. */
export async function ok(response: Response): Promise<Recorded> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response);
  return response.json<{ data: Recorded }>().data;
}

/** contracts/error-codes.yaml statuses of the codes this operation answers. */
const STATUS: Readonly<Record<number, number>> = {
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  30419: 422,
};

/** A refusal: code, HTTP status and, when given, the exact data. */
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}

// ---------------------------------------------------------------- seeds

async function insertDevice(s: Setup, appId: string): Promise<Device> {
  const id = randomUUID();
  const hash = randomBytes(32).toString('hex');
  await s.h.db
    .insertInto('devices')
    .values({
      id,
      app_id: appId,
      device_hash: hash,
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('fixture'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: s.clock.now(),
    })
    .execute();
  return { id, appId, hash };
}

export interface SessionOptions {
  /** The session was revoked before the request (default: live). */
  revoked?: boolean;
}
export const REVOKED: SessionOptions = { revoked: true };

/** One sessions row of `target` bound to `device`: what makes it a device of that user. */
export async function sessionOn(
  s: Setup,
  target: Target,
  device: Pick<Device, 'id'>,
  options: SessionOptions = {},
) {
  const now = s.clock.now();
  const revoked = options.revoked === true;
  await s.h.db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      sid: randomBytes(16).toString('base64url'),
      login_method: null,
      user_id: target.id,
      device_id: device.id,
      revoked_at: revoked ? now : null,
      revoke_reason: revoked ? 'logout' : null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** A device of `target`: registered, one session of that user bound to it. */
export async function deviceOf(s: Setup, target: Target, options: SessionOptions = {}) {
  const device = await insertDevice(s, target.appId);
  await sessionOn(s, target, device, options);
  return device;
}

/** A live device nobody has signed in on: no session of anyone. */
export const unowned = (s: Setup, appId = s.appId) => insertDevice(s, appId);

export const revoke = (s: Setup, device: Device) =>
  sql`UPDATE app.devices SET revoked_at = ${s.clock.now()}
    WHERE app_id = ${device.appId} AND id = ${device.id}`.execute(s.h.db);

export const TRUSTED: Trusted = { realname: true, providers: [] };

export const flag = (s: Setup, target: Target, trusted: Trusted = TRUSTED, at = s.clock.now()) =>
  sql`UPDATE app.users SET reverify_flagged_at = ${at},
      reverify_trusted = ${JSON.stringify(trusted)}::jsonb
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);

export const unflag = (s: Setup, target: Target) =>
  sql`UPDATE app.users SET reverify_flagged_at = NULL, reverify_trusted = NULL
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);

/** An account that carries the flag, with a live device of its own. */
export async function account(s: Setup, appId = s.appId) {
  const target = await user(s.h, appId);
  await flag(s, target);
  return { target, device: await deviceOf(s, target) };
}

/**
 * A tombstone: deletion complete, nothing left of the re-verification data (BR-ID-28). Its session
 * rows stay, revoked, so its devices are created with REVOKED.
 */
export async function deleted(s: Setup) {
  const target = await user(s.h, s.appId, { phone: null, status: 'deleted' });
  await deletion(s.h, target, 'done');
  return target;
}

/**
 * An account in deletion. As the expiry job leaves it (deletion-expiry.ts ⑥): users.status deleting,
 * the request processing, the flag and the live session still there. With `flagged: false`, as the
 * cleanup of deletion-processing.ts leaves it: the flag gone, the session revoked.
 */
export async function deleting(s: Setup, options: { flagged?: boolean } = {}) {
  const flagged = options.flagged !== false;
  const target = await user(s.h, s.appId, { status: 'deleting' });
  await deletion(s.h, target, 'processing');
  if (flagged) await flag(s, target);
  return { target, device: await deviceOf(s, target, flagged ? {} : REVOKED) };
}

/** One row of reverified_devices, written before the request under test. */
export async function recorded(
  s: Setup,
  target: Target,
  device: Pick<Device, 'hash'>,
  source: 'self' | 'admin',
  at: Date,
) {
  await s.h.db
    .insertInto('reverified_devices')
    .values({
      id: randomUUID(),
      app_id: target.appId,
      user_id: target.id,
      device_hash: device.hash,
      source,
      created_at: at,
    })
    .execute();
}

/**
 * Everything the record must leave alone on a lived-in flagged account: a run of failures and three
 * bound identities (one outside the trusted snapshot, what a phone change would unbind). The live
 * session a phone change would revoke is the one deviceOf() seeded.
 */
export async function livedIn(s: Setup, target: Target, device: Device) {
  const now = s.clock.now();
  await sql`UPDATE app.users SET reverify_fail_count = 3, reverify_fail_day = '2026-10-09'::date,
      reverify_fail_epoch = 7, last_active_at = ${now}, last_login_device_hash = ${device.hash}
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);
  for (const provider of ['wechat', 'apple', 'huawei']) {
    await s.h.db
      .insertInto('user_oauth')
      .values({
        id: randomUUID(),
        app_id: target.appId,
        user_id: target.id,
        provider,
        union_id: `union-${randomUUID()}`,
      })
      .execute();
  }
}

// ---------------------------------------------------------------- reads

async function accounts(h: Harness, appId: string) {
  const { rows } = await sql<{ id: string } & Record<string, unknown>>`SELECT id,
      reverify_flagged_at, reverify_trusted, reverify_fail_count,
      reverify_fail_day::text AS reverify_fail_day, reverify_fail_epoch, last_active_at,
      last_login_device_hash
    FROM app.users WHERE app_id = ${appId} ORDER BY id`.execute(h.db);
  return rows;
}

/** The account's flag, its time, the trusted snapshot, the failure run and the two inputs. */
export async function stateOf(h: Harness, target: Target) {
  const row = (await accounts(h, target.appId)).find((entry) => entry.id === target.id);
  expect(row).toBeDefined();
  return row!;
}

export const records = (h: Harness, target: Target) =>
  h.db
    .selectFrom('reverified_devices')
    .selectAll()
    .where('app_id', '=', target.appId)
    .where('user_id', '=', target.id)
    .orderBy('id')
    .execute();

/** Everything a refusal must leave alone in the app, audits aside. */
export async function snapshot(h: Harness, appId: string) {
  return {
    accounts: await accounts(h, appId),
    records: await h.db
      .selectFrom('reverified_devices')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    devices: await h.db
      .selectFrom('devices')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    identities: await h.db
      .selectFrom('user_oauth')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    sessions: await h.db
      .selectFrom('sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('sid')
      .execute(),
  };
}

export const audits = (h: Harness, appId: string) =>
  h.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('action', '=', ACTION)
    .orderBy('id')
    .execute();

/** Call the answer once the request is over: no data changed and no audit record was added. */
export async function watch(s: Setup) {
  const before = { data: await snapshot(s.h, s.appId), audits: await audits(s.h, s.appId) };
  return async () => {
    expect(await snapshot(s.h, s.appId)).toEqual(before.data);
    expect(await audits(s.h, s.appId)).toEqual(before.audits);
  };
}

/**
 * The values under any key naming a code or a result in the record's JSON columns, as text. The
 * record's layout is the implementation's, and a bare `0` cannot be looked for in the row's text.
 */
export function resultCodes(entry: AuditRow): string[] {
  const found: string[] = [];
  const walk = (node: unknown, named: boolean): void => {
    if (typeof node === 'number' || typeof node === 'string') {
      if (named) found.push(String(node));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      walk(child, named || /code|result/i.test(key));
    }
  };
  walk(entry.before, false);
  walk(entry.after, false);
  return found;
}

/** No device_hash in any log line of the test or in the responses. */
export function noHash(
  s: Setup,
  devices: readonly Pick<Device, 'hash'>[],
  responses: readonly Response[],
) {
  expect(s.lines.length, '日志捕获器必须启用').toBeGreaterThan(0);
  const text = [...s.lines, ...responses.map((response) => JSON.stringify(response.json()))].join(
    '\n',
  );
  for (const device of devices) expect(text).not.toContain(device.hash);
}

/**
 * The request has parked on a row lock, or has ended without waiting for one. A request doing
 * neither within the bound fails here, so nothing passes on a request still on its way.
 */
async function parkedOrEnded(h: Harness, request: Promise<unknown>, ms = 5000): Promise<void> {
  const progress = { ended: false };
  const end = () => {
    progress.ended = true;
  };
  void request.then(end, end);
  for (let left = ms; left > 0 && !progress.ended; left -= 10) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(h.db);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(progress.ended, 'the request neither waited on the users row nor ended').toBe(true);
}

/**
 * A deletion overtaking the request (08 BR-ID-28 细则「待加验记录」; the mode of
 * identity/ports/lock-users.ts). The flagged account starts in the cooling period, which does not
 * refuse (#29). Another connection holds the users row, so a plain read of the request still sees a
 * normal account; `start` runs until it waits on that row or ends; then what the expiry job writes
 * commits (users.status deleting, the request processing) and, with `cleaned`, what the cleanup
 * writes as well (the flag gone). Only a request that judges the account while it holds the row, or
 * on the write itself, sees it.
 */
export async function deletionOvertakes(
  h: Harness,
  target: Target,
  cleaned: boolean,
  start: () => Promise<Response>,
): Promise<Response> {
  await deletion(h, target, 'cooling');
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = h.db.transaction().execute(async (trx) => {
    const { rows } = await sql`SELECT 1 FROM app.users
      WHERE app_id = ${target.appId} AND id = ${target.id} FOR NO KEY UPDATE`.execute(trx);
    expect(rows).toHaveLength(1);
    locked();
    await released;
    await sql`UPDATE app.users SET status = 'deleting'
      WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(trx);
    await sql`UPDATE app.deletion_requests SET status = 'processing'
      WHERE app_id = ${target.appId} AND user_id = ${target.id}`.execute(trx);
    if (cleaned) {
      await sql`UPDATE app.users SET reverify_flagged_at = NULL, reverify_trusted = NULL
        WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(trx);
    }
  });
  await Promise.race([isLocked, holder]);
  const request = start();
  try {
    await parkedOrEnded(h, request);
  } finally {
    release();
    await holder;
  }
  return request;
}
