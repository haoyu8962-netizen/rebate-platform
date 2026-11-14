import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { acquireRedis, fullWidthPhone, memoryLogger, phone, type TestRedis } from './kit.ts';
import {
  buildApp,
  device,
  outbox,
  responseValidator,
  validateErrorResponse,
  type HttpApp,
} from './http-kit.ts';

let server: TestRedis | undefined;
let database: TestDatabase | undefined;
let db: Kysely<DB> | undefined;
let dir: string | undefined;
let app: HttpApp | undefined;
const clock = new FixedClock('2026-10-06T10:00:00+08:00');
const { logger, lines } = memoryLogger();
beforeAll(async () => {
  server = await acquireRedis();
  if (server === undefined) return;
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'spec-b1-02e-'));
  app = await buildApp(db, dir, server.url, clock, logger);
  await app.init();
}, 180_000);
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await server?.stop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }
});

it.each(['login', 'bind', 'step_up'])(
  '[BR-ID-05] HTTP %s 发码成功，响应过契约，验证码与 captcha_token 不出现在响应或日志',
  async (purpose) => {
    expect(server).toBeDefined();
    expect(app).toBeDefined();
    const send = await device(app!, clock);
    const number = phone();
    let sendStepUp: typeof send | undefined;
    if (purpose === 'step_up') {
      const { randomBytes } = await import('node:crypto');
      const { createSession } =
        await import('../../../../apps/api/src/modules/identity/application/sessions.ts');
      const { TOKEN_SERVICE } =
        await import('../../../../apps/api/src/modules/identity/application/tokens.ts');
      const { FIELD_CRYPTO } = await import('../../../../apps/api/src/modules/platform/index.ts');
      const { seedUser } = await import('../registration/kit.ts');
      const { sign } = await import('../../risk/signature/kit.ts');
      type TokenService =
        import('../../../../apps/api/src/modules/identity/application/access-tokens.ts').TokenService;
      type FieldCrypto = import('../../../../apps/api/src/modules/platform/index.ts').FieldCrypto;
      const headers = {
        'content-type': 'application/json',
        'x-app-id': 'couli',
        'x-platform': 'ios',
        'x-app-version': '1.2.3',
      };
      const created = await app!.inject({
        method: 'POST',
        url: '/v1/devices',
        headers,
        payload: JSON.stringify({
          device_hash: randomBytes(32).toString('hex'),
          id_source: 'idfv',
        }),
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ code: 0 });
      const { data } = created.json<{ data: { device_id: string; install_secret: string } }>();
      const scopedDb = db!.withSchema('app');
      const crypto = app!.get<FieldCrypto>(FIELD_CRYPTO);
      const uid = await seedUser(scopedDb, 'couli');
      await scopedDb
        .updateTable('users')
        .set({
          phone_hmac: crypto.blindIndex(number, 'users.phone'),
          phone_cipher: Buffer.from(crypto.encrypt(number, 'users.phone'), 'utf8'),
        })
        .where('id', '=', uid)
        .execute();
      const tokens = app!.get<TokenService>(TOKEN_SERVICE);
      const session = await scopedDb
        .transaction()
        .execute((trx) =>
          createSession(
            trx,
            { uid, app_id: 'couli', device_id: data.device_id, scp: 'full' },
            { clock, tokens },
          ),
        );
      sendStepUp = (payload) => {
        const path = '/v1/auth/sms-codes';
        const raw = JSON.stringify(payload);
        const timestamp = String(Math.floor(clock.now().getTime() / 1000));
        const nonce = randomBytes(16).toString('hex');
        return app!.inject({
          method: 'POST',
          url: path,
          payload: raw,
          headers: {
            ...headers,
            authorization: `Bearer ${session.access_token}`,
            'x-device-id': data.device_id,
            'x-timestamp': timestamp,
            'x-nonce': nonce,
            'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
          },
        });
      };
    }
    const input = `+86 ${number}`;
    const captcha = `captcha-${randomUUID()}`;
    const start = lines.length;
    const response = sendStepUp
      ? await sendStepUp({ purpose, captcha_token: captcha, action: 'account_deletion' })
      : await send({
          phone: input,
          purpose,
          captcha_token: captcha,
          ...(purpose === 'step_up' ? { action: 'account_deletion' } : {}),
        });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ code: number; data: unknown }>();
    const { validate } = await responseValidator();
    expect(validate(body)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ resend_after_sec: 60, expires_in_sec: 300 });
    const message = outbox(app!).find((m) => m.phone === number && m.purpose === purpose);
    expect(message).toBeDefined();
    expect(message!.code).toMatch(/^\d{6}$/);
    const output = lines.slice(start).join('') + JSON.stringify(body);
    expect(output).not.toContain(number);
    expect(output).not.toContain(input);
    expect(output).not.toContain(captcha);
    expect(output).not.toMatch(new RegExp(`(?<!\\d)${message!.code}(?!\\d)`));
  },
);

it('[AC-S1-78 ②][BR-ID-05] HTTP 规范化别名共享频控，429 带 Retry-After=60', async () => {
  expect(server).toBeDefined();
  expect(app).toBeDefined();
  const send = await device(app!, clock);
  const number = phone();
  expect((await send({ phone: number, purpose: 'login' })).statusCode).toBe(200);
  const response = await send({ phone: fullWidthPhone(number), purpose: 'login' });
  expect(response.statusCode).toBe(429);
  await validateErrorResponse(response);
  expect(response.json<{ code: number }>().code).toBe(42901);
  expect(String(response.headers['retry-after'])).toBe('60');
  expect(outbox(app!).filter((m) => m.phone === number)).toHaveLength(1);
});

it.each(['', '+852 5123 4567', '12345678901', '1380013800'])(
  '[AC-S1-78 ③][BR-ID-05] HTTP 非法手机号 %j 返回 20001 fields/reason',
  async (input) => {
    expect(server).toBeDefined();
    expect(app).toBeDefined();
    const send = await device(app!, clock);
    const response = await send({ phone: input, purpose: 'login' });
    expect(response.statusCode).toBe(400);
    await validateErrorResponse(response);
    expect(response.json()).toMatchObject({
      code: 20001,
      data: { fields: ['phone'], reason: 'phone_invalid' },
    });
  },
);

it('[BR-ID-05] HTTP purpose 越界返回 20001，不能发短信', async () => {
  expect(server).toBeDefined();
  expect(app).toBeDefined();
  const send = await device(app!, clock);
  const number = phone();
  const response = await send({ phone: number, purpose: 'password_reset' });
  expect(response.statusCode).toBe(400);
  await validateErrorResponse(response);
  expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['purpose'] } });
  expect(outbox(app!).some((m) => m.phone === number)).toBe(false);
});

it('[BR-ID-05] HTTP 规范化后的默认号段返回 403/44001，data 不带自由文本', async () => {
  expect(server).toBeDefined();
  expect(app).toBeDefined();
  const send = await device(app!, clock);
  const number = phone('170');
  const response = await send({ phone: `+86 ${number}`, purpose: 'login' });
  expect(response.statusCode).toBe(403);
  await validateErrorResponse(response);
  const body = response.json<{ code: number; data?: Record<string, unknown> | null }>();
  expect(body.code).toBe(44001);
  if (body.data != null) {
    expect(Object.keys(body.data)).toEqual(['risk_msg_code']);
    expect(body.data['risk_msg_code']).toEqual(expect.any(String));
  }
  expect(outbox(app!).some((m) => m.phone === number)).toBe(false);
});
