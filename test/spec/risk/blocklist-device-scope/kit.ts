// B1-03zi rule-test kit (BR-ID-31, BR-WDR-03 ③a, BR-WDR-29 ⑨, BR-WDR-30 ⑫; ruling D10-571,
// FU-DEVICE-USER-ID plan B). Members come out of the real chain on the real api entry: POST /v1/devices,
// POST /v1/auth/sms-codes, POST /v1/auth/login/sms. So devices.user_id stays what production leaves it
// (NULL) and every sessions row is written by the login itself; this kit writes neither. What a real
// login cannot produce is seeded as test/spec/payout/risk-rule-toggle/chain-kit.ts seeds it: the verified
// real name, the payout account, the funds and the labor agreement. Logout and the privacy withdrawal
// go through their real endpoints too. All values are synthetic; device hashes are made at run time.
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { expect } from 'vitest';
import {
  smsSenderToken,
  type FakeSmsSender,
} from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  NAME,
  account,
  config,
  type Fixture,
  type Kit,
  type Response,
} from '../../identity/payout-account/kit.ts';
import { phone } from '../../identity/sms-codes/kit.ts';
import { PATH, fund } from '../../payout/apply/kit.ts';
import type { Member as ChainMember, Worker } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { block, type Violation } from '../../payout/risk-rule-toggle/kit.ts';
import { sign } from '../signature/kit.ts';

/** The ⑫ condition of a live BR-WDR-29 ⑨ hit, as the auto decision records it. */
export const BLACKLIST_CONDITION = 'risk_flag:blacklist_hit';

const RULES_PATH = '/v1/withdrawals/rules';
const SMS_PATH = '/v1/auth/sms-codes';
const SMS_LOGIN_PATH = '/v1/auth/login/sms';
const LOGOUT_PATH = '/v1/auth/logout';
const CONSENTS_PATH = '/v1/consents';
const FUNDED_AT = '2026-10-01T02:00:00.000Z';
const LEGAL = { privacy: 7, agreement: 4 };
/** Past the 60 s between two sends of one number (BR-ID-05). */
const RESEND_GAP_MS = 61_000;

function headersOf(appId: string) {
  return {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
}

/** A fresh app: its version row and the withdrawal configuration, before its first request. */
export async function newApp(kit: Kit): Promise<string> {
  const appId = `bd_${randomBytes(10).toString('hex')}`;
  await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture', 'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(
    kit.db,
  );
  const owner = { appId } as Fixture;
  for (const [name, value] of Object.entries({
    'legal.labor_agreement.version': 1,
    'legal.labor_agreement.text_url': 'https://example.test/labor',
    'legal.labor_agreement.text_sha256': 'a'.repeat(64),
    'legal.labor_agreement.resign_from_version': 1,
    'withdraw.daily_count_per_user': 0,
    'withdraw.monthly_count_per_user': 0,
    'withdraw.payee_daily_count': 0,
    'withdraw.payee_daily_distinct_users': 0,
    'withdraw.auto_payout.enabled': true,
  })) {
    await config(kit, owner, name, value);
  }
  return appId;
}

export interface Device {
  readonly appId: string;
  readonly deviceId: string;
  readonly deviceHash: string;
  readonly installSecret: string;
}

/** A device of the real registration; `deviceHash` lets two apps share one hash. */
export async function registerDevice(
  kit: Kit,
  appId: string,
  deviceHash: string = randomBytes(32).toString('hex'),
): Promise<Device> {
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: headersOf(appId),
    payload: JSON.stringify({ device_hash: deviceHash, id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const { device_id, install_secret } = created.json<{
    data: { device_id: string; install_secret: string };
  }>().data;
  return { appId, deviceId: device_id, deviceHash, installSecret: install_secret };
}

function signedPost(kit: Kit, device: Device, path: string, body: object): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return kit.app.inject({
    method: 'POST',
    url: path,
    payload: raw,
    headers: {
      ...headersOf(device.appId),
      'x-device-id': device.deviceId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, device.installSecret),
    },
  });
}

export interface Session {
  readonly device: Device;
  readonly userId: string;
  readonly sid: string;
  readonly accessToken: string;
  readonly isNewUser: boolean;
}

/** Code request and SMS login of the number on the device: a new account or a further session. */
export async function smsLogin(kit: Kit, device: Device, number: string): Promise<Session> {
  kit.clock.advanceMs(RESEND_GAP_MS);
  const sent = await signedPost(kit, device, SMS_PATH, { phone: number, purpose: 'login' });
  expect(sent.statusCode).toBe(200);
  const message = kit.app
    .get<FakeSmsSender>(smsSenderToken())
    .outbox()
    .findLast((m) => m.app_id === device.appId && m.phone === number && m.purpose === 'login');
  expect(message?.code).toMatch(/^\d{6}$/);
  const answer = await signedPost(kit, device, SMS_LOGIN_PATH, {
    phone: number,
    code: message!.code,
    legal_versions: LEGAL,
    consent_at: kit.clock.now().toISOString(),
  });
  expect(answer.statusCode).toBe(200);
  const { user_id, is_new_user, tokens } = answer.json<{
    data: { user_id: string; is_new_user: boolean; tokens: { access_token: string } };
  }>().data;
  const principal = await kit.tokens.verifyAccess(tokens.access_token);
  return {
    device,
    userId: user_id,
    sid: principal.sid,
    accessToken: tokens.access_token,
    isNewUser: is_new_user,
  };
}

export interface Member {
  readonly appId: string;
  readonly userId: string;
  /** The session of the login that registered the account. */
  readonly first: Session;
  /** The plaintext number, for the checks that it never leaves. */
  readonly number: string;
  readonly payeeDigest: string;
  /** A further real login of this account. */
  login(device: Device): Promise<Session>;
}

/**
 * A member registered by a real SMS login on `device`, ready to withdraw: verified real name,
 * current alipay account of their own, 10000 fen credited earlier, current labor agreement.
 */
export async function member(kit: Kit, appId: string, device: Device): Promise<Member> {
  const number = phone();
  const first = await smsLogin(kit, device, number);
  const userId = first.userId;
  await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
    VALUES (${randomUUID()}, ${appId}, ${userId}, 'verified', ${Buffer.from(kit.crypto.encrypt(NAME, 'realname.name'))}, ${Buffer.from(kit.crypto.encrypt(userId, 'realname.id_no'))}, ${kit.crypto.blindIndex(userId, 'realname.id_no')}, ${Buffer.from(kit.crypto.encrypt('1990-01-01', 'realname.birth_date'))}, 'fixture', ${kit.clock.now()})`.execute(
    kit.db,
  );
  const payee = await account(
    kit,
    { appId, uid: userId } as Fixture,
    `member-${randomBytes(4).toString('hex')}@example.test`,
  );
  await fund(kit.db, createLedger({ clock: new FixedClock(FUNDED_AT) }), { appId, userId }, 10000n);
  await sql`INSERT INTO app.consent_records
    (app_id, subject_type, user_id, device_id, type, version, accepted, channel, text_sha256,
     signer_snapshot, client_at, server_at)
    VALUES (${appId}, 'user', ${userId}, ${device.deviceId}, 'labor_agreement', 1, true, 'withdraw_flow',
      ${'a'.repeat(64)}, '{}'::jsonb, ${kit.clock.now()}, ${kit.clock.now()})`.execute(kit.db);
  return {
    appId,
    userId,
    first,
    number,
    payeeDigest: payee.alipay_hmac!,
    login: (next) => smsLogin(kit, next, number),
  };
}

function authHeaders(session: Session) {
  return {
    ...headersOf(session.device.appId),
    'x-device-id': session.device.deviceId,
    authorization: `Bearer ${session.accessToken}`,
  };
}

/** POST /v1/withdrawals for 1000 fen from the session's device: new key, new step-up each time. */
export async function post(kit: Kit, session: Session): Promise<Response> {
  const { device, userId, sid } = session;
  const body = JSON.stringify({ amount_fen: 1000 });
  const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const stepUp = await kit.signScopedToken(kit.keys, {
    audience: 'step_up',
    claims: {
      uid: userId,
      app_id: device.appId,
      sid,
      device_id: device.deviceId,
      action: 'withdraw',
      jti: randomUUID(),
    },
    issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
    ttlSeconds: 300,
  });
  return kit.app.inject({
    method: 'POST',
    url: PATH,
    payload: body,
    headers: {
      ...authHeaders(session),
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-sign': sign('POST', PATH, Buffer.from(body), timestamp, nonce, device.installSecret),
      'idempotency-key': randomUUID(),
      'x-step-up-token': stepUp,
    },
  });
}

/** A POST that must create the withdrawal: its id. */
export async function apply(kit: Kit, session: Session): Promise<string> {
  const answer = await post(kit, session);
  expect(answer.json()).toMatchObject({ code: 0 });
  return answer.json<{ data: { withdrawal_id: string } }>().data.withdrawal_id;
}

/** GET /v1/withdrawals/rules from the session's device. */
export function rules(kit: Kit, session: Session): Promise<Response> {
  return kit.app.inject({ method: 'GET', url: RULES_PATH, headers: authHeaders(session) });
}

/** The block_code of the rules answer, which is a success envelope even when blocked. */
export async function blockCode(kit: Kit, session: Session): Promise<unknown> {
  const answer = await rules(kit, session);
  expect(answer.statusCode).toBe(200);
  return answer.json<{ data: { block_code: unknown } }>().data.block_code;
}

/** The refusal of a blocklist hit on POST /v1/withdrawals. */
export function refused(violation: Violation) {
  return { code: 44001, data: { risk_msg_code: `blocklist.${violation}` } };
}

/** The real sign-out of the session (BR-ID-07). */
export async function logout(kit: Kit, session: Session): Promise<void> {
  const answer = await kit.app.inject({
    method: 'POST',
    url: LOGOUT_PATH,
    payload: '{}',
    headers: authHeaders(session),
  });
  expect(answer.statusCode).toBe(200);
}

/** The real withdrawal of the privacy consent on the session's device (BR-ID-13). */
export async function withdrawPrivacy(kit: Kit, session: Session): Promise<void> {
  const answer = await kit.app.inject({
    method: 'POST',
    url: CONSENTS_PATH,
    payload: JSON.stringify({
      type: 'privacy',
      version: LEGAL.privacy,
      accepted: false,
      channel: 'privacy_center',
      client_at: kit.clock.now().toISOString(),
    }),
    headers: authHeaders(session),
  });
  expect(answer.statusCode).toBe(200);
}

/** What production left on the device's row. */
export async function deviceRow(kit: Kit, device: Device) {
  const { rows } = await sql<{
    user_id: string | null;
    device_hash: string;
    last_login_sid: string | null;
    revoked_at: Date | null;
  }>`SELECT user_id, device_hash, last_login_sid, revoked_at FROM app.devices
    WHERE app_id = ${device.appId} AND id = ${device.deviceId}`.execute(kit.db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** What production left on the session's row. */
export async function sessionRow(kit: Kit, session: Session) {
  const { rows } = await sql<{
    created_at: Date;
    revoked_at: Date | null;
    device_id: string;
    user_id: string;
  }>`SELECT created_at, revoked_at, device_id, user_id FROM app.sessions
    WHERE app_id = ${session.device.appId} AND sid = ${session.sid}`.execute(kit.db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** The device's stored hash on the blocklist of the device's own app. */
export async function blockDevice(
  kit: Kit,
  device: Device,
  violation: Violation = 'other',
): Promise<void> {
  const { device_hash } = await deviceRow(kit, device);
  await block(kit.db, device.appId, 'device', device_hash, violation);
}

/** The member's own value of a dimension on the blocklist of their app. */
export async function blockMember(
  kit: Kit,
  m: Member,
  dimension: 'phone' | 'id_no' | 'alipay',
  violation: Violation = 'other',
): Promise<void> {
  let digest = m.payeeDigest;
  if (dimension === 'phone') {
    const { rows } = await sql<{ digest: string }>`SELECT phone_hmac AS digest FROM app.users
      WHERE app_id = ${m.appId} AND id = ${m.userId}`.execute(kit.db);
    digest = rows[0]!.digest;
  }
  if (dimension === 'id_no') {
    const { rows } = await sql<{ digest: string }>`SELECT id_no_hmac AS digest FROM app.realname
      WHERE app_id = ${m.appId} AND user_id = ${m.userId}`.execute(kit.db);
    digest = rows[0]!.digest;
  }
  await block(kit.db, m.appId, dimension, digest, violation);
}

export async function withdrawalRow(kit: Kit, appId: string, id: string) {
  const { rows } = await sql<{
    status: string;
    review_mode: string | null;
    auto_decision: unknown;
    risk_flags: unknown;
  }>`SELECT status, review_mode, auto_decision, risk_flags FROM app.withdrawals
    WHERE app_id = ${appId} AND id = ${id}`.execute(kit.db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** One delivery of the withdrawal.created job on the real worker entry; the stored decision. */
export function decide(kit: Kit, worker: Worker, m: Member, id: string): Promise<unknown> {
  const subject: Pick<ChainMember, 'appId' | 'userId' | 'withdrawal'> = {
    appId: m.appId,
    userId: m.userId as ChainMember['userId'],
    withdrawal: (withdrawalId) => withdrawalRow(kit, m.appId, withdrawalId),
  };
  return worker.decide(subject as ChainMember, id);
}

/** The ⑨ hit: manual, with the blacklist condition among the failed ones. */
export function expectHit(decision: unknown): void {
  expect(decision).toMatchObject({
    result: 'manual',
    failed_conditions: expect.arrayContaining([BLACKLIST_CONDITION]),
  });
}

/** No ⑨ hit; other conditions of the decision are not this rule's concern. */
export function expectNoHit(decision: unknown): void {
  expect(decision).toMatchObject({ failed_conditions: expect.any(Array) });
  const { failed_conditions } = decision as { failed_conditions: string[] };
  expect(failed_conditions).not.toContain(BLACKLIST_CONDITION);
}
