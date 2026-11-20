import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { installSecretContext } from '../../../../apps/api/src/modules/identity/domain/device.ts';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import { sign } from '../../risk/signature/kit.ts';
import { PATH, type Fixture, type Kit } from '../bind-phone/http-kit.ts';
import { outbox, type HttpApp, type Response } from '../sms-codes/http-kit.ts';

export const SMS = '/v1/auth/sms-codes';
export const STEP_UP = '/v1/auth/step-up';
export const H5 = '/v1/auth/h5-token';
export const REFRESH = '/v1/auth/refresh';
export const ME = '/v1/me';
export const SMS_LOGIN = '/v1/auth/login/sms';
export const DAY_MS = 86_400_000;
export const PHONE_CHANGE = { action: 'phone_change' } as const;
export const CHANGE_SMS = { purpose: 'step_up', ...PHONE_CHANGE } as const;

export function readResponse(
  kit: Kit,
  path: string,
  response: Response,
  code: number,
  method: 'get' | 'post' = 'post',
) {
  const status = new Map([
    [0, 200],
    [10002, 401],
    [10003, 403],
    [10401, 401],
    [10402, 401],
    [10404, 401],
    [10405, 403],
    [30411, 422],
    [30414, 422],
    [44001, 403],
  ]);
  expect(response.statusCode).toBe(status.get(code) ?? 400);
  const body = response.json<{ code: number; msg: string; trace_id: string; data?: unknown }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const schema =
    kit.document.paths[path]![method]!.responses[code === 0 ? '200' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}

type Session = Fixture['session'];
type GetApp = HttpApp & {
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<Response>;
};

function headersFor(appId: string) {
  return {
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
}

// Use the same device and session that the shared binding fixture used. Its randomly generated
// test install secret is only needed to sign the additional routes.
export async function primary(f: Fixture) {
  const device = await f.db
    .selectFrom('devices')
    .select('install_secret_cipher')
    .where('app_id', '=', f.appId)
    .where('id', '=', f.deviceId)
    .executeTakeFirstOrThrow();
  const secret = f.kit.crypto.decrypt(
    device.install_secret_cipher.toString('utf8'),
    installSecretContext(f.deviceId),
  );
  return deviceClient(f, f.deviceId, secret).authenticated(f.session);
}

export async function newDevice(f: Fixture) {
  const response = await f.kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headersFor(f.appId), 'content-type': 'application/json' },
    payload: JSON.stringify({ id_source: 'idfv', device_hash: randomBytes(32).toString('hex') }),
  });
  readResponse(f.kit, '/v1/devices', response, 0);
  const { device_id, install_secret } = response.json<{ data: Schema<'RegisterDeviceData'> }>()
    .data;
  return deviceClient(f, device_id, install_secret);
}

function deviceClient(f: Fixture, id: string, secret: string) {
  const kit = f.kit;
  const headers = { ...headersFor(f.appId), 'x-device-id': id };

  function post(path: string, body: object, extra: Record<string, string> = {}) {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: path,
      payload: raw,
      headers: {
        ...headers,
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, secret),
        ...extra,
      },
    });
  }

  async function issue(uid = f.uid, scope: 'full' | 'deletion_only' = 'full') {
    const session = await f.db
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid, app_id: f.appId, device_id: id, scp: scope },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
    return authenticated(session);
  }

  function authenticated(session: Session) {
    const authorization = `Bearer ${session.access_token}`;
    const authedPost = (path: string, body: object, extra?: Record<string, string>) =>
      post(path, body, { authorization, ...extra });
    return {
      deviceId: id,
      session,
      post: authedPost,
      bind(phone: string, code: string, token?: string, key = randomUUID()) {
        return authedPost(
          PATH,
          { phone, code },
          {
            'idempotency-key': key,
            ...(token === undefined ? {} : { 'x-step-up-token': token }),
          },
        );
      },
      me(h5Token?: string) {
        return (kit.app as GetApp).inject({
          method: 'GET',
          url: ME,
          headers: {
            ...headers,
            ...(h5Token === undefined
              ? { authorization }
              : {
                  'x-platform': 'h5',
                  'x-channel': 'official',
                  authorization: `Bearer ${h5Token}`,
                }),
          },
        });
      },
      refresh: () => post(REFRESH, { refresh_token: session.refresh_token }),
    };
  }

  return { post, issue, authenticated };
}

export type Client = Awaited<ReturnType<typeof primary>>;

export function messages(f: Fixture) {
  return outbox(f.kit.app).filter((sms) => sms.app_id === f.appId);
}

export async function sendStepUp(
  f: Fixture,
  client: Client,
  oldPhone: string,
  action: Schema<'StepUpAction'> = PHONE_CHANGE.action,
) {
  const before = messages(f).length;
  const response = await client.post(SMS, { purpose: 'step_up', action });
  expect(readResponse(f.kit, SMS, response, 0).data).toEqual({
    resend_after_sec: 60,
    expires_in_sec: 300,
  });
  const sent = messages(f).slice(before);
  expect(sent).toEqual([expect.objectContaining({ phone: oldPhone, purpose: 'step_up' })]);
  expect(sent[0]!.code).toMatch(/^\d{6}$/);
  return sent[0]!.code;
}

export async function verifyStepUp(
  f: Fixture,
  client: Client,
  code: string,
  action: Schema<'StepUpAction'> = PHONE_CHANGE.action,
) {
  const response = await client.post(STEP_UP, {
    action,
    code,
    ...(action === 'payout_account_change'
      ? { summary: { payout_method: 'alipay', alipay_logon_id: '13800138000' } }
      : {}),
  });
  readResponse(f.kit, STEP_UP, response, 0);
  return response.json<{ data: Schema<'StepUpData'> }>().data.step_up_token;
}

export function oldPhones(f: Fixture) {
  return f.db
    .selectFrom('deleted_identities')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

export function audits(f: Fixture) {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

export function pushTokens(f: Fixture) {
  return f.db
    .selectFrom('push_tokens')
    .select(['device_id', 'user_id', 'bound_sid'])
    .where('app_id', '=', f.appId)
    .orderBy('device_id')
    .execute();
}

export async function accountState(f: Fixture) {
  return {
    ...(await f.snapshot()),
    oldPhones: await oldPhones(f),
    audits: await audits(f),
    pushTokens: await pushTokens(f),
  };
}

export async function setPhoneChange(f: Fixture, value: boolean | 'false') {
  await f.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: 'account.phone_change_enabled',
      value: JSON.stringify(value),
      version: 1,
      updated_by: 'fixture',
    })
    .onConflict((conflict) =>
      conflict.columns(['app_id', 'key']).doUpdateSet((eb) => ({
        value: eb.ref('excluded.value'),
        version: eb('config_items.version', '+', 1),
      })),
    )
    .execute();
}

export async function holdLock(f: Fixture, lock: (trx: Transaction<DB>) => Promise<unknown>) {
  const locked = Promise.withResolvers<number>();
  const unlocked = Promise.withResolvers<void>();
  const transaction = f.db.transaction().execute(async (trx) => {
    await lock(trx);
    const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    locked.resolve(result.rows[0]!.pid);
    await unlocked.promise;
  });
  const pid = await Promise.race([locked.promise, transaction.then(() => locked.promise)]);
  return {
    pid,
    async release() {
      unlocked.resolve();
      await transaction;
    },
  };
}

// Stop on a database condition or a completed HTTP response. In the unimplemented case the
// response completes immediately, so the test reports an assertion instead of a timeout.
export async function waitForBlockedRequest(
  f: Fixture,
  blocker: number,
  request: Promise<Response>,
) {
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let attempt = 0; attempt < 500 && !settled; attempt += 1) {
    const result = await sql<{ waiting: number }>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND ${blocker}::int = ANY(pg_blocking_pids(pid))
    `.execute(f.db);
    if (result.rows[0]!.waiting > 0) return true;
    await delay(10);
  }
  return false;
}
