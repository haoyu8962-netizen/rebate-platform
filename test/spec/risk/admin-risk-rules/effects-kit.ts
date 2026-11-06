// B1-03zg rule-test kit, part 2: what a rule's status does to the deciders (BR-ID-36 细则「规则清单的
// 启停」: a disabled rule takes no part in decisions and writes no risk_hits; hits and appeals already
// written are not affected; it takes effect like a config item change — the readers re-read on the
// 04 §10 cache period — and never reaches back into decisions already made).
//
// The toggles go through the real admin entry (consoleOf: an admin of the decider's app with
// config.risk, a fresh totp step-up per call, expected_version read from the row). The deciders are
// the real ones over the same database, Redis and field keys:
// - DEVICE_REGISTER_LIMIT: the api entry (createHttpApp('api'), publicEntry), driven by signed
//   POST /v1/devices, /v1/auth/sms-codes and /v1/auth/login/sms on a device that already holds
//   DEFAULT_DEVICE_REGISTER_LIMIT registrations of the app (no config item: the default limit);
// - BLACKLIST_HIT: the order pipeline with risk's real order blocklist ports (orders/blacklist/kit).
//
// Cache entry used: the decider's injected FixedClock. After each toggle the tests move it past
// REFRESH_MS (CONTENT_CACHE_TTL_MS, the config_items cache period of content/domain/cache-policy.ts,
// plus one second); a decider that reads the rule without a cache passes as well. Nothing waits on
// real time. Every execution belongs to the isolated container runner.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { CONTENT_CACHE_TTL_MS } from '../../../../apps/api/src/modules/content/domain/cache-policy.ts';
import { DEFAULT_DEVICE_REGISTER_LIMIT } from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import {
  smsSenderToken,
  type FakeSmsSender,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import {
  account,
  fixture,
  signedIn,
  totp,
  type Harness,
  type Response,
} from '../../admin/auth/kit.ts';
import { ok, STEP, type Grant } from '../../admin/step-up/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import { validate as validateLogin } from '../../identity/sms-login/http-kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { sign } from '../signature/kit.ts';
import {
  HOUR,
  LIST,
  PERMISSION,
  accepted,
  at,
  targetOf,
  type Change,
  type RuleRow,
} from './kit.ts';

export const DEVICE_RULE = 'DEVICE_REGISTER_LIMIT';
export const BLACKLIST_RULE = 'BLACKLIST_HIT';
/** How far a decider's clock moves after a toggle: past the config_items cache period. */
export const REFRESH_MS = CONTENT_CACHE_TTL_MS + 1000;
export const REASON = '规则启停对判定的影响';

/**
 * A fresh app id (the deciders accept any well-formed X-App-Id): `rules_` plus 26 hex digits of a
 * UUID, exactly 32 characters, the X-App-Id maxLength.
 */
export const newApp = () => `rules_${randomUUID().replaceAll('-', '').slice(-26)}`;

export function ruleRowOf(h: Harness, appId: string, ruleId: string): Promise<RuleRow> {
  return h.db
    .selectFrom('risk_rules')
    .selectAll()
    .where('app_id', '=', appId)
    .where('rule_id', '=', ruleId)
    .executeTakeFirstOrThrow();
}

/** The rule row as the rule seed registers it: enabled, version 1, conditions without content. */
export async function registerRule(
  h: Harness,
  appId: string,
  rule: { rule_id: string; scene: string; risk_action: 'block' | 'void_commission' },
): Promise<RuleRow> {
  return h.db
    .insertInto('risk_rules')
    .values({
      id: randomUUID(),
      app_id: appId,
      rule_id: rule.rule_id,
      scene: rule.scene,
      conditions: JSON.stringify({}),
      risk_action: rule.risk_action,
      status: 'enabled',
      version: 1,
      created_at: at(-30 * 24 * HOUR),
      updated_at: at(-2 * HOUR),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The console of `appId`: an admin with config.risk who enables / disables rules over HTTP. */
export async function consoleOf(h: Harness, appId: string) {
  const f = await fixture(h);
  const a = await account(h, { app_id: appId, is_super: false });
  await h.db
    .updateTable('admin_users')
    .set({
      totp_secret_cipher: Buffer.from(
        h.fields.encrypt(a.secret, `admin_users.totp_secret:${appId}:${a.id}`),
      ),
    })
    .where('id', '=', a.id)
    .execute();
  await h.db
    .insertInto('admin_permissions')
    .values({
      app_id: appId,
      admin_id: a.id,
      permission_key: PERMISSION,
      granted_by: a.id,
      granted_at: f.clock.now(),
    })
    .execute();
  const session = await signedIn(f, a);
  const auth = { authorization: `Bearer ${session.admin_token}` };
  /** One accepted change of the rule's status (it starts in the other status). */
  const toggle = async (change: Change, ruleId: string) => {
    const before = await ruleRowOf(h, appId, ruleId);
    f.clock.advanceMs(30_000);
    const granted = await ok<Grant>(
      await f.post('/step-up', { tier: 'totp', code: totp(a.secret, f.clock) }, auth),
      STEP,
    );
    const data = await accepted(
      await f.app.inject({
        method: 'POST',
        url: `${LIST}/${encodeURIComponent(ruleId)}/${change}`,
        headers: {
          'content-type': 'application/json',
          ...auth,
          'x-step-up-token': granted.step_up_token,
        },
        payload: JSON.stringify({ expected_version: before.version, reason: REASON }),
      }),
    );
    expect(data, `${change} ${ruleId} of ${appId}`).toMatchObject({
      rule_id: ruleId,
      status: targetOf(change),
      version: before.version + 1,
    });
    return data;
  };
  return { f, a, appId, toggle };
}

/** The app's risk_hits rows (of one rule when given), in insertion order. */
export function hitsOf(h: Harness, appId: string, ruleId?: string) {
  let query = h.db.selectFrom('risk_hits').selectAll().where('app_id', '=', appId);
  if (ruleId !== undefined) query = query.where('rule_id', '=', ruleId);
  return query.orderBy('id').execute();
}
export type HitRow = Awaited<ReturnType<typeof hitsOf>>[number];

export function appealsOf(h: Harness, appId: string) {
  return h.db.selectFrom('appeals').selectAll().where('app_id', '=', appId).orderBy('id').execute();
}

/** A processing appeal of a blocked registration (its risk_hits ref_id is the request number). */
export async function appealBlocked(h: Harness, hit: HitRow, now: Date) {
  expect(hit.related_phone_hmac, 'a register hit carries the phone digest').toEqual(
    expect.any(String),
  );
  await h.db
    .insertInto('appeals')
    .values({
      id: randomUUID(),
      app_id: hit.app_id,
      user_id: null,
      target_type: 'blocked_request',
      request_type: 'register',
      target_id: hit.ref_id,
      related_phone_hmac: String(hit.related_phone_hmac),
      prev_risk_state: null,
      status: 'processing',
      content: '注册被拦，申请放行',
      deadline_at: new Date(now.getTime() + 7 * 24 * HOUR),
      handler_id: null,
      closed_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** A processing appeal of an order (BLACKLIST_HIT disposition). */
export async function appealOrder(
  h: Harness,
  input: { appId: string; userId: string; orderId: string; now: Date },
) {
  await h.db
    .insertInto('appeals')
    .values({
      id: randomUUID(),
      app_id: input.appId,
      user_id: input.userId,
      target_type: 'order',
      request_type: null,
      target_id: input.orderId,
      related_phone_hmac: null,
      prev_risk_state: null,
      status: 'processing',
      content: '订单被判黑名单，申请恢复',
      deadline_at: new Date(input.now.getTime() + 7 * 24 * HOUR),
      handler_id: null,
      closed_at: null,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
}

// ---- the api entry (DEVICE_REGISTER_LIMIT) ----

/** The api entry over the harness's database, Redis and keys, with its own FixedClock. */
export async function publicEntry(h: Harness) {
  const api = await fixture(h, { entry: 'api' });
  const sender = api.app.get<FakeSmsSender>(smsSenderToken());
  let sequence = 0;
  // Each request from its own address: the per-IP send and new-account limits stay out of the way.
  const nextIp = () => `198.51.100.${(sequence++ % 250) + 1}`;

  /**
   * A device of `appId` whose hash already holds DEFAULT_DEVICE_REGISTER_LIMIT registrations of the
   * app (stamped with the entry's clock, well inside the 30-day window).
   */
  async function fullDevice(appId: string) {
    const deviceHash = randomBytes(32).toString('hex');
    const headers = {
      'content-type': 'application/json',
      'x-app-id': appId,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
    };
    const created = await api.app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers,
      payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
      remoteAddress: nextIp(),
    });
    expect(created.statusCode, 'POST /v1/devices').toBe(200);
    const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
    for (let i = 0; i < DEFAULT_DEVICE_REGISTER_LIMIT; i++) {
      const userId = await seedUser(h.db, appId);
      await h.db
        .insertInto('device_registrations')
        .values({
          app_id: appId,
          device_hash: deviceHash,
          user_id: userId,
          register_method: 'sms',
          created_at: api.clock.now(),
        })
        .execute();
    }
    const post = (path: string, body: Record<string, unknown>): Promise<Response> => {
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(api.clock.now().getTime() / 1000));
      const nonce = randomBytes(16).toString('hex');
      return api.app.inject({
        method: 'POST',
        url: path,
        payload: raw,
        remoteAddress: nextIp(),
        headers: {
          ...headers,
          'x-device-id': device.device_id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, device.install_secret),
        },
      });
    };
    /** SMS code to a new number, then SMS login (which registers a new number). */
    const register = async () => {
      const number = phone('139');
      const sent = await post('/v1/auth/sms-codes', { phone: number, purpose: 'login' });
      expect(sent.json(), 'the login code is sent').toMatchObject({ code: 0 });
      const message = sender.outbox().findLast((m) => m.phone === number);
      expect(message, 'the fake sender holds the code').toBeDefined();
      const response = await post('/v1/auth/login/sms', {
        phone: number,
        code: message?.code,
        legal_versions: { privacy: 1, agreement: 1 },
        consent_at: new Date(api.clock.now().getTime() - 5000).toISOString(),
      });
      return { number, response };
    };
    return { appId, deviceHash, register };
  }

  return { api, sender, fullDevice };
}

/** A new account was created: the device limit did not refuse it. */
export async function admitted(response: Response) {
  expect(response.json(), 'registration admitted').toMatchObject({
    code: 0,
    data: { is_new_user: true },
  });
  expect(response.statusCode).toBe(200);
  await validateLogin(response, true);
}

/** 44001: the device limit refused the registration. */
export async function refused(response: Response) {
  expect(response.json(), 'registration refused by the device limit').toMatchObject({
    code: 44001,
  });
  expect(response.statusCode).toBe(403);
  await validateLogin(response, false);
}

/** The DEVICE_REGISTER_LIMIT hit of one refused registration. */
export function expectDeviceHit(hit: HitRow | undefined, appId: string, deviceHash: string) {
  expect(hit).toMatchObject({
    app_id: appId,
    user_id: null,
    rule_id: DEVICE_RULE,
    risk_action: 'block',
    dimension: 'device',
    value_hmac: deviceHash,
    ref_type: 'blocked_request',
    request_type: 'register',
  });
}
