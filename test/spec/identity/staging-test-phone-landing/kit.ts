// B1-02zzc rule-test helpers: the real api AppModule (landing-sms kit: real routes, real stores,
// the fake SMS provider whose outbox the tests read), with the staging test phones switched on
// for the SMS code service that identity.module assembles.
//
// Why a spy and not APP_ENV=staging for the whole entry: a staging entry needs the live keyring,
// JWT keys and the live SMS channel (its fallback sender refuses every message), none of which a
// test may hold. So the entry runs as `test` and only the options identity.module hands to
// createSmsCodeService are changed: appEnv 'staging' and the test phones that the real
// readStagingTestPhoneConfig('staging', STAGING_TEST_PHONES / STAGING_TEST_SMS_CODE_FILE) plus the
// real openStagingTestPhones (code file under the repository's .tmp/) produce. Everything that
// identity.module builds around that service — in particular what it hands to the landing page
// registration — is left exactly as assembled; that wiring is what these tests pin.
//
// The numbers are synthetic 199 numbers and the fixed code is synthetic (no node value here).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { ROOT, TRACE, api, openKit as openLandingKit, type Response } from '../landing-sms/kit.ts';
import type { Fixture } from '../../growth/landing-register/kit.ts';
import { CODE_FILE_ENV, FIXED, PHONES_ENV, distinctPhones } from '../staging-test-phone/kit.ts';

type SmsModule =
  typeof import('../../../../apps/api/src/modules/identity/application/sms-codes.ts');
type ConfigModule = typeof import('../../../../apps/api/src/modules/platform/config/index.ts');

export { FIXED };
export const LOGIN_PATH = '/v1/auth/login/sms';
export const APP_SMS_PATH = '/v1/auth/sms-codes';
/** Sending IP of the landing kit's f.sms() (growth landing-register kit). */
export const LANDING_SEND_IP = '198.51.100.19';
/** Number of listed phones; each test takes its own. */
const LISTED = 4;

/**
 * Opens the real api entry with staging test phones `phones` and the fixed code FIXED.
 * Fails (never runs green unconfigured) when identity.module did not build its SMS code service
 * through createSmsCodeService while the spy was in place.
 */
export async function openKit(db: Kysely<DB>, databaseUrl: string, redisUrl: string) {
  const sms = await api<SmsModule>('modules/identity/application/sms-codes.ts');
  const { readStagingTestPhoneConfig, openStagingTestPhones } = await api<ConfigModule>(
    'modules/platform/config/index.ts',
  );
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-02zzc-'));
  const phones = distinctPhones(LISTED);
  try {
    const codeFile = join(dir, 'test-sms-code');
    writeFileSync(codeFile, `${FIXED}\n`, { mode: 0o600 });
    const read = readStagingTestPhoneConfig('staging', {
      [PHONES_ENV]: phones.join(','),
      [CODE_FILE_ENV]: codeFile,
    });
    expect(read.problems).toEqual([]);
    expect(read.stagingTestPhones).not.toBeNull();
    const stagingTestPhones = await openStagingTestPhones(read.stagingTestPhones!);
    expect(stagingTestPhones).toEqual({ phones, code: FIXED });
    const factory = sms.createSmsCodeService;
    const staged = vi
      .spyOn(sms, 'createSmsCodeService')
      .mockImplementation((options) =>
        factory({ ...options, appEnv: 'staging', stagingTestPhones }),
      );
    let calls = 0;
    const kit = await openLandingKit(db, databaseUrl, redisUrl).finally(() => {
      // Read before restoring: mockRestore also clears the recorded calls.
      calls = staged.mock.calls.length;
      staged.mockRestore();
    });
    try {
      // The assembled service really went through the staging options above.
      expect(calls).toBeGreaterThan(0);
    } catch (error) {
      await kit.close();
      throw error;
    }
    return {
      ...kit,
      phones,
      async close() {
        try {
          await kit.close();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Kit = Awaited<ReturnType<typeof openKit>>;

/**
 * Sends a landing code to `number` (the real landing route, the fake provider) and returns the
 * request body of a landing registration with the code that was really delivered. A delivered
 * code equal to FIXED (one in a million) is not usable to tell the two apart: wait out the
 * 60-second window and send again.
 */
export async function landingBody(kit: Kit, f: Fixture, number: string) {
  for (let round = 0; round < 3; round++) {
    const before = kit.sender.outbox().length;
    const body = await f.sms(number);
    // The landing page's code of a listed number goes to the provider (never skipped).
    expect(kit.sender.outbox()).toHaveLength(before + 1);
    expect(kit.sender.outbox().at(-1)).toEqual(
      expect.objectContaining({ app_id: f.appId, phone: number, purpose: 'login' }),
    );
    expect(body.sms_code).toMatch(/^\d{6}$/);
    if (body.sms_code !== FIXED) return body;
    kit.clock.advanceMs(60_000);
  }
  throw new Error('three delivered codes equal to the fixed code');
}

/** An App installation of `f`'s app: device registration, then signed requests. */
export async function appClient(kit: Kit, f: Fixture) {
  const headers = {
    'content-type': 'application/json',
    'x-app-id': f.appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-trace-id': TRACE,
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    remoteAddress: LANDING_SEND_IP,
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const { device_id, install_secret } = created.json<{
    data: { device_id: string; install_secret: string };
  }>().data;
  const post = (path: string, body: Record<string, unknown>): Promise<Response> => {
    const payload = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const text = [
      'POST',
      path,
      timestamp,
      nonce,
      createHash('sha256').update(payload).digest('hex'),
    ].join('\n');
    return kit.app.inject({
      method: 'POST',
      url: path,
      remoteAddress: LANDING_SEND_IP,
      payload,
      headers: {
        ...headers,
        'x-device-id': device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', install_secret).update(text).digest('hex'),
      },
    });
  };
  return {
    deviceId: device_id,
    send: (number: string) => post(APP_SMS_PATH, { phone: number, purpose: 'login' }),
    login: (number: string, code: string) =>
      post(LOGIN_PATH, {
        phone: number,
        code,
        legal_versions: { privacy: 11, agreement: 7 },
        consent_at: kit.clock.now().toISOString(),
      }),
  };
}

/** The response matches the contract envelope of `path` (200 or 4XX). */
export function contractBody(kit: Kit, path: string, response: Response): Record<string, unknown> {
  const key = response.statusCode === 200 ? '200' : '4XX';
  const schema = kit.document.paths[path]!.post.responses[key]!.content['application/json']!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  const body = response.json();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(body['trace_id']).toBe(TRACE);
  return body;
}

/** Sessions of `appId` (tokens are only issued with a session). */
export function sessions(kit: Kit, appId: string) {
  return kit.db.selectFrom('sessions').selectAll().where('app_id', '=', appId).execute();
}
