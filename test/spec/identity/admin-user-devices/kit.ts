// B1-02zz rule-test kit: GET /admin/v1/users/{user_id}/devices on the real admin entry and a real
// database (contract adminListUserDevices, CT-26j, CT-26m; task §2b, §9). No port is replaced and
// no skeleton is imported. Before the implementation the route is not mounted, so setup() fails on
// its assertion and every integration case is red there, negative cases included.
//
// The admin login, the sessions seed, the account seeds and POST .../reverified-devices come from
// reverify-admin-device/kit.ts: a device of a user is one a session of that user was bound to,
// revoked sessions included (D10-585), and only a real sessions row decides it. The device seed is
// this kit's, because the list needs the columns that seed fixes: platform, app_version, created_at,
// last_seen_at, last_login_sid, an install secret to look for, and devices.user_id, which no
// production code writes and which only #13 ever fills.
//
// Not pinned on purpose, because §2b does not say: which answer wins when a request has no
// permission and also a bad page parameter; whether a deleting or deleted account is listed (it is
// not unknown, so it is not 20001 by the contract, and 08 does not speak of this read); the order of
// devices with the same last_seen_at, beyond one stable partition into pages; the zone a time is
// written in (instants are compared).
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type { Harness, HttpApp, Response } from '../../admin/auth/kit.ts';
import {
  NOT_UUIDS,
  PERMISSION,
  REVOKED,
  TRACE,
  account,
  body,
  flag,
  member,
  noHash,
  ok as saved,
  record,
  recorded,
  revoke,
  sessionOn,
  setup as recordingSetup,
  snapshot,
  user,
  type Device,
  type Member,
  type SessionOptions,
  type Setup,
  type Target,
} from '../reverify-admin-device/kit.ts';
import { PATH, validate } from './schema.ts';

export {
  NOT_UUIDS,
  PERMISSION,
  REVOKED,
  account,
  body,
  flag,
  member,
  noHash,
  record,
  recorded,
  revoke,
  saved,
  sessionOn,
  user,
};
export type { Device, Member, Setup, Target };

const ROUTE = PATH.replace('{user_id}', ':user_id');

export type Item = Schema<'AdminUserDevice'>;
export type Page = Schema<'AdminUserDevicePage'>;

export function mounted(app: HttpApp): boolean {
  return app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url: ROUTE });
}

/** The admin entry with a signed-in super admin of a fresh app. */
export async function setup(h: Harness): Promise<Setup> {
  const s = await recordingSetup(h, `b1-02zz-${randomUUID()}`);
  // Every integration case is red before the route exists, negative cases included.
  expect(mounted(s.app), 'admin 入口必须挂载 GET /admin/v1/users/{user_id}/devices').toBe(true);
  return s;
}

export interface ListOptions {
  /** The admin doing it (default: the super admin of setup). */
  as?: Member;
  /** null: no admin_token at all. */
  token?: string | null;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

/** GET /admin/v1/users/{user_id}/devices; never sends an X-Step-Up-Token unless `headers` does. */
export function list(s: Setup, userId: string, options: ListOptions = {}) {
  const token = options.token === undefined ? (options.as?.token ?? s.token) : options.token;
  const search = new URLSearchParams(options.query ?? {}).toString();
  const path = PATH.replace('{user_id}', encodeURIComponent(userId));
  return s.app.inject({
    method: 'GET',
    url: search === '' ? path : `${path}?${search}`,
    headers: {
      'x-trace-id': TRACE,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    remoteAddress: '127.0.0.1',
  });
}

/** A 200: the contract envelope and its 200 schema; returns data. */
export async function listed(response: Response): Promise<Page> {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, msg: '', trace_id: TRACE });
  await validate(response);
  return response.json<{ data: Page }>().data;
}

export async function pageOf(
  s: Setup,
  target: Pick<Target, 'id'>,
  options: ListOptions = {},
): Promise<Page> {
  return listed(await list(s, target.id, options));
}

/** contracts/error-codes.yaml statuses of the codes this operation answers. */
const STATUS: Readonly<Record<number, number>> = { 10001: 401, 10403: 403, 20001: 400 };

/** A refusal: code, HTTP status and, when given, the exact data. */
export async function rejected(response: Response, code: number, data?: object) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(STATUS[code]);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  if (data !== undefined) expect(response.json().data).toEqual(data);
  await validate(response);
}

// ---------------------------------------------------------------- seeds

export const minutesAgo = (s: Setup, minutes: number) =>
  new Date(s.clock.now().getTime() - minutes * 60_000);

export interface DeviceSeed {
  platform?: 'ios' | 'android' | 'harmony';
  appVersion?: string;
  createdAt?: Date;
  lastSeenAt?: Date;
  lastLoginSid?: string;
  /** devices.user_id: never written by production code, filled only to show it is not read. */
  userColumn?: Pick<Target, 'id'>;
}

export interface SeededDevice extends Device {
  platform: string;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  secret: Buffer;
  lastLoginSid: string | null;
  userColumn: string | null;
}

function fresh(s: Setup, appId: string, seed: DeviceSeed): SeededDevice {
  const now = s.clock.now();
  return {
    id: randomUUID(),
    appId,
    hash: randomBytes(32).toString('hex'),
    platform: seed.platform ?? 'ios',
    appVersion: seed.appVersion ?? '2.0.0',
    createdAt: seed.createdAt ?? now,
    lastSeenAt: seed.lastSeenAt ?? now,
    secret: randomBytes(32),
    lastLoginSid: seed.lastLoginSid ?? null,
    userColumn: seed.userColumn?.id ?? null,
  };
}

const columns = (device: SeededDevice) => ({
  id: device.id,
  app_id: device.appId,
  user_id: device.userColumn,
  device_hash: device.hash,
  id_source: 'idfv',
  install_secret_cipher: device.secret,
  platform: device.platform,
  app_version: device.appVersion,
  last_login_sid: device.lastLoginSid,
  last_seen_at: device.lastSeenAt,
  created_at: device.createdAt,
  updated_at: device.createdAt,
});

/** A registered device, on no session of anyone. */
export async function device(s: Setup, appId: string, seed: DeviceSeed = {}) {
  const seeded = fresh(s, appId, seed);
  await s.h.db.insertInto('devices').values(columns(seeded)).execute();
  return seeded;
}

/** A device of `target`: registered, one session of that user bound to it. */
export async function owned(
  s: Setup,
  target: Target,
  seed: DeviceSeed = {},
  session: SessionOptions = {},
) {
  const seeded = await device(s, target.appId, seed);
  await sessionOn(s, target, seeded, session);
  return seeded;
}

/** `count` devices of `target` seen at one instant, in one statement each table. */
export async function fleet(s: Setup, target: Target, count: number) {
  const seeded = Array.from({ length: count }, () => fresh(s, target.appId, {}));
  const now = s.clock.now();
  await s.h.db.insertInto('devices').values(seeded.map(columns)).execute();
  await s.h.db
    .insertInto('sessions')
    .values(
      seeded.map((entry) => ({
        id: randomUUID(),
        app_id: target.appId,
        sid: randomBytes(16).toString('base64url'),
        login_method: null,
        user_id: target.id,
        device_id: entry.id,
        revoked_at: null,
        revoke_reason: null,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  return seeded;
}

// ---------------------------------------------------------------- reads

export const instant = (value: string) => new Date(value).getTime();

/** A listed row with its times as instants: the zone a time is written in is not pinned. */
export const normal = (item: Item) => ({
  ...item,
  created_at: instant(item.created_at),
  last_seen_at: instant(item.last_seen_at),
  reverified:
    item.reverified === null
      ? null
      : { ...item.reverified, created_at: instant(item.reverified.created_at) },
});

/** The exact row of `seeded`, to compare with normal(item). */
export const row = (
  seeded: SeededDevice,
  reverified: { source: 'self' | 'admin'; at: Date } | null = null,
) => ({
  device_id: seeded.id,
  platform: seeded.platform,
  app_version: seeded.appVersion,
  created_at: seeded.createdAt.getTime(),
  last_seen_at: seeded.lastSeenAt.getTime(),
  reverified:
    reverified === null ? null : { source: reverified.source, created_at: reverified.at.getTime() },
});

export const ids = (page: Page) => page.items.map((item) => item.device_id);

const allAudits = (h: Harness) => h.db.selectFrom('audit_logs').selectAll().orderBy('id').execute();

/**
 * Call the answer once the requests are over: no data of the app changed, device and session rows
 * included, and audit_logs has no new row. watch() of reverify-admin-device/kit.ts looks at the one
 * action of POST only; a read must not add a row under any name, of any app.
 */
export async function readOnly(s: Setup) {
  const before = { data: await snapshot(s.h, s.appId), audits: await allAudits(s.h) };
  return async () => {
    expect(await snapshot(s.h, s.appId)).toEqual(before.data);
    expect(await allAudits(s.h)).toEqual(before.audits);
  };
}

/** Nothing the contract forbids in the response, by name or by value. */
export function noSecrets(response: Response, devices: readonly SeededDevice[]) {
  const text = JSON.stringify(response.json());
  for (const name of ['device_hash', 'install_secret', 'last_login_sid']) {
    expect(text).not.toContain(name);
  }
  for (const seeded of devices) {
    expect(text).not.toContain(seeded.hash);
    expect(text).not.toContain(seeded.secret.toString('hex'));
    expect(text).not.toContain(seeded.secret.toString('base64'));
    expect(text).not.toContain(seeded.secret.toString('base64url'));
    if (seeded.lastLoginSid !== null) expect(text).not.toContain(seeded.lastLoginSid);
  }
}
