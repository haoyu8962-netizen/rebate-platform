// B1-02zzzb rule-test fixture (规划/08 BR-ID-08 细则「绑定业务摘要」; FU-STEPUP-TOKEN-BIND-DIGEST;
// contract POST /v1/auth/step-up `summary`, CT-26c). The real AppModule over PG + Redis, opened as
// test/spec/identity/payout-bank-card/kit.ts opens it (only the card BIN and verification vendor
// factories are spied on). No route, guard or business handler is replaced:
// - step_up_tokens come from the real POST /v1/auth/step-up with a fresh SMS code read from the fake
//   sender's outbox (the fixture user has a bound phone, so the SMS way applies), or — for a token
//   whose claims carry no summary — are signed exactly as that route signs them (signScopedToken with
//   the application's TOKEN_KEYS, aud=step_up, claims uid, app_id, sid, device_id, action, jti);
// - payout account saves go through the real PUT /v1/me/payout-account (payout-bank-card kit's
//   submit).
// The digest claim is found by its value, not by its name (the contract fixes one string claim
// `p:<payout_method>:<HMAC>` / `p:wechat:<attempt_id>`; its name is only the contract line's
// suggestion). Only the orchestrator runs these fixtures, inside
// the isolated integration-test container.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { SmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import type { FakeSmsSender } from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { sign } from '../../risk/signature/kit.ts';
import { ALIPAY_CONTEXT, ROOT, state, type Response } from '../payout-account/kit.ts';
import { envelope, fixture as cardFixture, type Kit } from '../payout-bank-card/kit.ts';

export { open, close, reset, card, bankBody, NAME } from '../payout-bank-card/kit.ts';
export { BANK_CONTEXT } from '../payout-bank-card/kit.ts';
export { ALIPAY_CONTEXT, LOGIN, state, privateDataAbsent } from '../payout-account/kit.ts';
export type { Kit };

type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
type FakeSms = typeof import('../../../../apps/api/src/modules/identity/infra/fake-sms.ts');

export const STEP_UP = '/v1/auth/step-up';
/**
 * BR-ID-05 counts the SMS send quota per phone over every app (60 s interval, daily cap), so
 * every member gets its own bound phone: the prefix 139 (not an 08 default blocked prefix), a
 * random block of 4 digits drawn once per file, and a 4-digit serial of the member in this file.
 */
const PHONE_BLOCK = String(randomInt(0, 10_000)).padStart(4, '0');
let phoneSerial = 0;
function nextPhone(): string {
  phoneSerial += 1;
  return `139${PHONE_BLOCK}${String(phoneSerial).padStart(4, '0')}`;
}
export const TIMEOUT = 60_000;
/** BR-ID-08: a step_up_token lives 5 minutes. */
const TTL_SECONDS = 300;
/** BR-ID-05: one SMS per 60 s for (app, phone, purpose); the fixture clock moves past it. */
const RESEND_MS = 61_000;
export type StepUpAction =
  'withdraw' | 'payout_account_change' | 'phone_change' | 'account_deletion';
export type Summary = Readonly<Record<string, unknown>>;
export interface Envelope {
  code: number;
  msg: string;
  trace_id: string;
  data?: Record<string, unknown>;
}

/** The claims of a JWT (payload segment), without verifying it. */
export function claimsOf(token: string): Record<string, unknown> {
  const segments = token.split('.');
  expect(segments).toHaveLength(3);
  const json = Buffer.from(segments[1]!, 'base64url').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[wp]:/.test(value);
}

/** The business digest claim values of a step_up_token (`w:…` / `p:…`), whatever the claim name. */
export function digestsOf(token: string): string[] {
  return Object.values(claimsOf(token)).filter(isDigest);
}

const STATUSES: Readonly<Record<number, number>> = Object.freeze({
  0: 200,
  10003: 403,
  20001: 400,
});

/** An envelope with this code, its HTTP status, and the contract response schema of the path. */
export function answered(
  kit: Kit,
  path: string,
  method: 'post' | 'put',
  response: Response,
  code: number,
): Envelope {
  expect(response.statusCode, response.body).toBe(STATUSES[code] ?? 422);
  const body = response.json<Envelope>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[path]![method]!;
  const content = operation.responses[code === 0 ? '200' : '4XX']!.content;
  const validate = kit.compile({ schema: content['application/json']!.schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

/** BR-ID-08: a step-up failure is 10003 (HTTP 403) without data — no reason told apart. */
export function stepUpRequired(
  kit: Kit,
  path: string,
  method: 'post' | 'put',
  response: Response,
): void {
  const body = answered(kit, path, method, response, 10003);
  expect(body).not.toHaveProperty('data');
}

/** PUT /v1/me/payout-account refused with 10003 (payout-bank-card kit's contract check). */
export function saveRefused(kit: Kit, response: Response): void {
  const body = envelope(kit, response, 10003);
  expect(body).not.toHaveProperty('data');
}

/** PUT /v1/me/payout-account accepted (code 0). */
export function saved(kit: Kit, response: Response) {
  return envelope(kit, response, 0);
}

/**
 * One realname-verified member with a bound phone and a registered device (payout-bank-card kit's
 * fixture).
 */
export async function member(kit: Kit) {
  const f = await cardFixture(kit);
  // This member's own bound phone (users.phone_hmac / phone_cipher, written as
  // test/spec/identity/sms-codes/http.int.test.ts writes them): the step-up SMS goes to the
  // account's own number.
  const phone = nextPhone();
  await kit.db
    .updateTable('users')
    .set({
      phone_hmac: kit.crypto.blindIndex(phone, 'users.phone'),
      phone_cipher: Buffer.from(kit.crypto.encrypt(phone, 'users.phone'), 'utf8'),
    })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
  const tokensModule = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const fakeSms = (await import(
    new URL('apps/api/src/modules/identity/infra/fake-sms.ts', ROOT).href
  )) as FakeSms;
  const sms = kit.app.get<SmsCodeService>(tokensModule.SMS_CODES);
  const sender = kit.app.get<FakeSmsSender>(fakeSms.smsSenderToken());
  const deviceId = f.device.device_id;
  const session = await kit.db
    .transaction()
    .execute((trx) =>
      kit.createSession(
        trx,
        { uid: f.uid, app_id: f.appId, device_id: deviceId, scp: 'full' },
        { clock: kit.clock, tokens: kit.tokens },
      ),
    );
  /** Every response body this member received, for the privacy checks. */
  const bodies: string[] = [];
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };

  async function post(path: string, body: unknown, extra: Record<string, string>) {
    // A fresh access token for the current Clock; the session stays the same.
    const accessToken = await kit.tokens.issueAccess({
      uid: f.uid,
      app_id: f.appId,
      device_id: deviceId,
      sid: session.sid,
      scp: 'full',
    });
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const response = await kit.app.inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...headers,
        authorization: `Bearer ${accessToken}`,
        'x-device-id': deviceId,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, f.device.install_secret),
        'x-trace-id': randomUUID(),
        ...extra,
      },
    });
    bodies.push(response.body);
    return response;
  }

  let sent = 0;
  /** A fresh step_up SMS code of the member's own phone (the fake sender's outbox). */
  async function smsCode(action: StepUpAction): Promise<string> {
    if (sent > 0) kit.clock.advanceMs(RESEND_MS);
    sent += 1;
    const result = await sms.send({
      app_id: f.appId,
      phone,
      purpose: 'step_up',
      action,
      device_id: deviceId,
    });
    expect(result).toMatchObject({ code: 0 });
    const message = sender
      .outbox()
      .filter((entry) => entry.app_id === f.appId && entry.purpose === 'step_up')
      .at(-1);
    expect(message).toBeDefined();
    return message!.code;
  }

  /** POST /v1/auth/step-up by SMS; `summary` omitted when undefined. */
  async function stepUp(action: StepUpAction, summary?: Summary): Promise<Response> {
    const code = await smsCode(action);
    return post(STEP_UP, { action, code, ...(summary === undefined ? {} : { summary }) }, {});
  }

  /** A step_up_token issued by POST /v1/auth/step-up (asserts code 0 and the contract). */
  async function token(action: StepUpAction, summary?: Summary): Promise<string> {
    const body = answered(kit, STEP_UP, 'post', await stepUp(action, summary), 0);
    const issued = body.data?.['step_up_token'];
    expect(issued).toEqual(expect.any(String));
    return issued as string;
  }

  /** A token signed as POST /v1/auth/step-up signs it, with no summary in its claims. */
  function mint(action: StepUpAction): Promise<string> {
    return kit.signScopedToken(kit.keys, {
      audience: 'step_up',
      claims: {
        uid: f.uid,
        app_id: f.appId,
        sid: session.sid,
        device_id: deviceId,
        action,
        jti: randomUUID(),
      },
      issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
      ttlSeconds: TTL_SECONDS,
    });
  }

  /** PUT /v1/me/payout-account with this step_up_token. */
  async function save(
    body: unknown,
    stepUpToken: string,
    key: ReturnType<typeof randomUUID> = randomUUID(),
  ) {
    const response = await f.submit(body, key, stepUpToken);
    bodies.push(response.body);
    return response;
  }

  return {
    f,
    uid: f.uid,
    appId: f.appId,
    deviceId,
    /** This member's bound phone (users.phone_cipher), for the privacy checks. */
    phone,
    bodies,
    stepUp,
    token,
    mint,
    save,
    accounts: () => state(kit, f),
    alipayHmac: (logon: string) => kit.crypto.blindIndex(logon, ALIPAY_CONTEXT),
  };
}
export type Member = Awaited<ReturnType<typeof member>>;
