import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { FIELD_CRYPTO, type FieldCrypto } from '../../../../apps/api/src/modules/platform/index.ts';
import { PHONE_BLIND_INDEX_CONTEXT } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { seedUser } from '../registration/kit.ts';
import { acquireRedis, memoryLogger, phone, wrong, type TestRedis } from '../sms-codes/kit.ts';
import { buildApp, outbox, type HttpApp } from '../sms-codes/http-kit.ts';
import { openKit, closeKit, rows, type Kit } from './kit.ts';
import { client, validate } from './http-kit.ts';

let kit: Kit;
let redis: TestRedis | undefined;
let app: HttpApp;
let dir: string | undefined;
const clock = new FixedClock('2026-10-08T04:00:00.000Z');
const { logger, lines } = memoryLogger();
const restrictedHeaders = { 'x-channel': 'appstore', 'x-app-version': '1.0.3' };
beforeAll(async () => {
  kit = await openKit();
  // Seed before app construction so the content reader cannot cache a missing minimum.
  await kit.db
    .withSchema('app')
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: 'couli',
      platform: 'ios',
      channel: restrictedHeaders['x-channel'],
      latest_version: '3.0.0',
      min_supported_version: '3.0.0',
      update_title: '测试版本',
      update_notes: '短信登录作用域测试',
      store_url: 'https://example.invalid/app',
      default_store: 'app_store',
      store_listings: sql`'[]'::jsonb`,
    })
    .execute();
  redis = await acquireRedis();
  if (redis === undefined) return;
  const base = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'spec-b1-02j-'));
  app = await buildApp(kit.db, dir, redis.url, clock, logger);
  await app.init();
}, 180_000);
afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      await closeKit(kit);
    } finally {
      await redis?.stop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function prepared() {
  expect(redis).toBeDefined();
  expect(app).toBeDefined();
  const c = await client(app, clock);
  const number = phone();
  expect((await c.send(number)).statusCode).toBe(200);
  const code = outbox(app).findLast(
    (message) => message.phone === number && message.purpose === 'login',
  )!.code;
  expect(code).toMatch(/^\d{6}$/);
  const body = {
    phone: number,
    code,
    legal_versions: { privacy: 7, agreement: 4 },
    consent_at: '2026-10-08T03:59:55.000Z',
  };
  return { c, body };
}

it('[AC-S1-83#16][BR-ID-01] 真签名 HTTP 受限新号返回 403/10405 完整外壳，不建号且核销验证码', async () => {
  const { c, body } = await prepared();
  const before = await rows(kit, 'couli');
  const response = await c.login({ ...body, invite_code: 'K7Q2MZ' }, restrictedHeaders);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    code: 10405,
    trace_id: expect.any(String),
    msg: expect.any(String),
  });
  expect(response.json<{ data: unknown }>().data).toEqual({
    reason: 'no_account',
    min_supported_version: '3.0.0',
  });
  await validate(response, false);
  expect(await rows(kit, 'couli')).toEqual(before);
  const consumed = await c.login(body, restrictedHeaders);
  expect(consumed.statusCode).toBe(400);
  expect(consumed.json()).toMatchObject({ code: 20003 });
  await validate(consumed, false);
  expect(await rows(kit, 'couli')).toEqual(before);
});

it.each([
  { version: '1.0.3', scope: 'deletion_only' },
  { version: '3.0.0', scope: 'full' },
])(
  '[AC-B1-02j#38][BR-ID-01/INV-06] 真签名 HTTP 已有账号按渠道与版本 $version 签发 $scope',
  async ({ version, scope }) => {
    const { c, body } = await prepared();
    // buildApp owns a separate keyring; seed with the running app's phone blind index.
    const uid = await seedUser(kit.db, 'couli', {
      phoneHmac: app
        .get<FieldCrypto>(FIELD_CRYPTO)
        .blindIndex(body.phone, PHONE_BLIND_INDEX_CONTEXT),
    });
    const before = await rows(kit, 'couli');
    const response = await c.login(
      { ...body, invite_code: 'BAD' },
      {
        ...restrictedHeaders,
        'x-app-version': version,
      },
    );
    expect(response.statusCode).toBe(200);
    await validate(response, true);
    const { data } = response.json<{
      data: { tokens: { access_token: string; session_scope: string } };
    }>();
    expect(data).toMatchObject({
      user_id: uid,
      is_new_user: false,
      tokens: { session_scope: scope },
      invite_bind: { result: 'ignored_existing_user' },
    });
    expect(
      await app.get<TokenService>(TOKEN_SERVICE).verifyAccess(data.tokens.access_token),
    ).toMatchObject({
      uid,
      app_id: 'couli',
      device_id: c.deviceId,
      scp: scope,
    });
    const after = await rows(kit, 'couli');
    const { expectOnlyLoginActivity } = await import('../reverify/login-activity.ts');
    expectOnlyLoginActivity(before.users, after.users, {
      uid,
      at: clock.now(),
      hash: c.deviceHash,
    });
    expect(after.registrations).toEqual(before.registrations);
    expect(
      after.consents.filter((row) => row.user_id === uid && row.channel === 'login_page'),
    ).toHaveLength(2);
    expect(after.logs.filter((row) => row.user_id === uid)).toHaveLength(1);
    expect(after.sessions.filter((row) => row.user_id === uid)).toHaveLength(1);
  },
);

it('[AC-B1-02j#39][BR-ID-05] 真签名 HTTP 同设备注册上限返回 403/44001 契约外壳，不建号', async () => {
  const { c, body } = await prepared();
  for (let i = 0; i < 3; i++) {
    const uid = await seedUser(kit.db, 'couli');
    await kit.db
      .withSchema('app')
      .insertInto('device_registrations')
      .values({
        app_id: 'couli',
        device_hash: c.deviceHash,
        user_id: uid,
        register_method: 'sms',
        created_at: new Date(clock.now().getTime() - 1000),
      })
      .execute();
  }
  const before = await rows(kit, 'couli');
  const response = await c.login(body);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({
    code: 44001,
    trace_id: expect.any(String),
    msg: expect.any(String),
  });
  await validate(response, false);
  const { data } = response.json<{ data?: { risk_msg_code?: unknown } | null }>();
  if (data && 'risk_msg_code' in data) {
    expect(data.risk_msg_code).toEqual(expect.any(String));
  }
  expect(await rows(kit, 'couli')).toEqual(before);
});

it.each(['legal_versions', 'consent_at'])(
  '[AC-B1-02j#29][BR-ID-04] 真签名 HTTP 缺少 %s 返回契约 20001，验证码未被消耗',
  async (missing) => {
    const { c, body } = await prepared();
    const payload: Record<string, unknown> = { ...body };
    delete payload[missing];
    const before = await rows(kit, 'couli');
    const response = await c.login(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 20001,
      data: { fields: expect.arrayContaining([missing]) },
    });
    await validate(response, false);
    expect(await rows(kit, 'couli')).toEqual(before);
    expect((await c.login(body)).json()).toMatchObject({ code: 0, data: { is_new_user: true } });
  },
);

it('[AC-B1-02j#30][BR-ID-04/05] HTTP 新号成功响应符合 LoginResponse，重复码错误外壳符合契约', async () => {
  const { c, body } = await prepared();
  const start = lines.length;
  const response = await c.login(body, { authorization: 'Bearer expired-token-is-irrelevant' });
  expect(response.statusCode).toBe(200);
  await validate(response, true);
  const answer = response.json<{
    data: {
      user_id: string;
      is_new_user: boolean;
      tokens: { session_scope: string; access_token: string; refresh_token: string };
    };
  }>();
  expect(answer.data).toMatchObject({ is_new_user: true, tokens: { session_scope: 'full' } });
  expect(answer.data).not.toHaveProperty('invite_bind');
  const state = await rows(kit, 'couli');
  expect(
    state.consents.filter(
      (row) => row.user_id === answer.data.user_id && row.channel === 'login_page',
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'privacy',
        version: 7,
        client_at: new Date(body.consent_at),
        server_at: clock.now(),
        accepted: true,
      }),
      expect.objectContaining({
        type: 'agreement',
        version: 4,
        client_at: new Date(body.consent_at),
        server_at: clock.now(),
        accepted: true,
      }),
    ]),
  );
  const duplicate = await c.login(body);
  expect(duplicate.statusCode).toBe(400);
  expect(duplicate.json()).toMatchObject({
    code: 20003,
    trace_id: expect.any(String),
    msg: expect.any(String),
  });
  await validate(duplicate, false);
  expect(await rows(kit, 'couli')).toEqual(state);
  const logged = lines.slice(start).join('');
  expect(logged).not.toContain(body.phone);
  expect(logged).not.toContain(answer.data.tokens.access_token);
  expect(logged).not.toContain(answer.data.tokens.refresh_token);
});

it('[AC-B1-02j#31][BR-ID-05] HTTP 错码 20002 不写记录，非法手机号带 phone_invalid', async () => {
  const { c, body } = await prepared();
  const before = await rows(kit, 'couli');
  const wrongCode = await c.login({ ...body, code: wrong(body.code) });
  expect(wrongCode.statusCode).toBe(400);
  expect(wrongCode.json()).toMatchObject({ code: 20002 });
  await validate(wrongCode, false);
  const invalid = await c.login({ ...body, phone: '+852 5123 4567' });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toMatchObject({
    code: 20001,
    data: { fields: ['phone'], reason: 'phone_invalid' },
  });
  await validate(invalid, false);
  expect(await rows(kit, 'couli')).toEqual(before);
});

it('[AC-B1-02j#32][04 §6.1] 已注册登录路由执行签名与设备来源检查，客户端不能替换 app 身份', async () => {
  const { c, body } = await prepared();
  // Establish the real route first: existing middleware alone must not make this test green.
  const good = await c.login(body);
  expect(good.statusCode).toBe(200);
  const before = await rows(kit, 'couli');
  const signature = await c.login(body, { 'x-sign': '0'.repeat(64) });
  expect(signature.json()).toMatchObject({ code: 10401 });
  await validate(signature, false);
  const source = await c.login(body, { 'x-app-id': 'different-app' });
  expect(source.statusCode).toBe(403);
  expect(source.json()).toMatchObject({ code: 10403 });
  await validate(source, false);
  expect(await rows(kit, 'couli')).toEqual(before);
});
