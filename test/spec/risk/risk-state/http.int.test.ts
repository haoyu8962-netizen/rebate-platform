import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { WHITELIST } from './policy-kit.ts';
import { SEARCH, allowed, banned, client, openHttp, type Fixture } from './http-kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

for (const state of ['banned', 'appealing'] as const) {
  for (const route of WHITELIST) {
    it(`[AC-B1-03h#16][BR-ID-31/36] 真 AppModule ${state} 白名单 ${route.method} ${route.path}`, async () => {
      const c = await client(f, state);
      if (state === 'appealing') await c.appeal('banned');
      await banned(await c.send('GET', SEARCH));
      const body =
        route.method === 'GET'
          ? undefined
          : route.path === '/v1/auth/refresh'
            ? { refresh_token: c.session.refresh_token }
            : 'body' in route
              ? route.body
              : {};
      const response = await c.send(
        route.method,
        route.path.replace(':withdrawal_id', randomUUID()),
        body,
      );
      allowed(response);
      expect(JSON.stringify(response.json())).not.toContain('private rule details');
    });
  }
}

for (const route of [
  { method: 'GET', path: SEARCH, body: undefined },
  {
    method: 'POST',
    path: '/v1/consents',
    body: {
      type: 'privacy',
      accepted: false,
      version: 1,
      channel: 'privacy_center',
      client_at: '2026-10-08T04:00:00.000Z',
    },
  },
  { method: 'POST', path: `/v1/links/${randomUUID()}/open`, body: {} },
  {
    method: 'POST',
    path: '/v1/auth/oauth-attempts',
    body: { provider: 'wechat', purpose: 'login' },
  },
  {
    method: 'POST',
    path: '/v1/auth/oauth-attempts',
    body: { provider: 'wechat', purpose: 'payout_bind' },
  },
  { method: 'POST', path: '/v1/auth/step-up', body: { action: 'phone_change', code: '123456' } },
]) {
  it(`[AC-B1-03h#17][BR-ID-31] 真签名白名单外 ${route.method} ${route.path} ${JSON.stringify(route.body)} 返回契约 10006`, async () => {
    const c = await client(f);
    await banned(await c.send(route.method, route.path, route.body));
    expect(
      await f.db.selectFrom('consent_records').selectAll().where('app_id', '=', c.appId).execute(),
    ).toEqual([]);
    expect(
      await f.db.selectFrom('idempotency_keys').selectAll().where('app_id', '=', c.appId).execute(),
    ).toEqual([]);
  });
}

for (const state of ['normal', 'frozen', 'appealing'] as const) {
  it(`[AC-B1-03h#18][BR-ID-36] ${state}（appealing 的处理中申诉前 frozen）不受 10006 拦截`, async () => {
    const c = await client(f, state);
    if (state === 'appealing') {
      await c.appeal('banned', 'upheld'); // historical ban appeal must not override the active one
      await c.appeal('frozen');
      const other = await seedUser(f.db, c.appId);
      await c.appeal('banned', 'processing', other); // nor may another user's current ban appeal
    }
    allowed(
      await c.send('POST', '/v1/auth/oauth-attempts', { purpose: 'login', provider: 'wechat' }),
    );
    expect(
      (await c.risk.readRiskState({ app_id: c.appId, user_id: c.uid }, { fresh: true })).state,
    ).toBe(state);
  });
}

it('[AC-B1-03h#19][BR-ID-01] 真实 ④a 在 ⑤ 前：低版本 banned 得到 10405；支持版本得到 10006', async () => {
  const c = await client(f);
  await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
    VALUES (${randomUUID()}, ${c.appId}, 'ios', 'appstore', '9.0.0', '8.0.0', 'fixture', 'fixture', 'https://example.test/store', 'appstore', '[]'::jsonb)`.execute(
    f.db,
  );
  const body = { action: 'phone_change', code: '123456' };
  const response = await c.send('POST', '/v1/auth/step-up', body);
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 10405, data: { min_supported_version: '8.0.0' } });
  await banned(await c.send('POST', '/v1/auth/step-up', body, { 'x-app-version': '9.0.0' }));
});

it('[AC-B1-03h#20][BR-ID-01] 真 AppModule 缓存预热后本进程变更立即生效，解封也不等待 60 秒', async () => {
  const c = await client(f, 'normal');
  const body = { provider: 'wechat', purpose: 'login' };
  allowed(await c.send('POST', '/v1/auth/oauth-attempts', body));
  await c.set('banned');
  await banned(await c.send('POST', '/v1/auth/oauth-attempts', body));
  await c.set('normal');
  allowed(await c.send('POST', '/v1/auth/oauth-attempts', body));
  const events = await f.db
    .selectFrom('event_log')
    .selectAll()
    .where('app_id', '=', c.appId)
    .where('name', '=', 'risk.state_changed')
    .execute();
  expect(events.map((e) => (e.payload as { data: { to: string } }).data.to)).toContain('banned');
});

it('[AC-B1-03h#21][BR-ID-01] 真幂等接线：已完成 link open 原样回放；新键才判断 ⑤ 且不落幂等记录', async () => {
  const c = await client(f);
  const path = `/v1/links/${randomUUID()}/open`;
  const key = randomUUID();
  const body = { installed: 'unknown', no_rebate: false };
  const trace = randomUUID();
  // Seed through platform's real idempotency service outside an HTTP request scope.
  const original = await f.idem.execute(
    {
      appId: c.appId,
      actor: { userId: c.uid, deviceId: null, phoneHmac: null },
      method: 'POST',
      path,
      key,
      body,
      traceId: trace,
    },
    async () => ({ status: 422, envelope: { code: 30141, msg: '商品已下架', trace_id: trace } }),
  );
  const replay = await c.send('POST', path, body, { 'idempotency-key': key, 'x-trace-id': trace });
  expect(replay.statusCode).toBe(original.status);
  expect(replay.json()).toEqual(JSON.parse(original.body));
  const missing = randomUUID();
  await banned(await c.send('POST', path, body, { 'idempotency-key': missing }));
  expect(
    await f.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', c.appId)
      .where('key', '=', missing)
      .execute(),
  ).toEqual([]);
});

for (const path of [
  '/v1/auth/login/sms',
  '/v1/auth/login/wechat',
  '/v1/auth/login/apple',
  '/v1/auth/login/huawei',
]) {
  it(`[AC-B1-03h#22][BR-ID-31] 四个登录接口 ${path} 不执行封禁拦截（即使带 banned 用户 Authorization）`, async () => {
    const c = await client(f);
    const credentials = path.endsWith('/sms')
      ? { phone: '13812345678', code: '123456' }
      : path.endsWith('/wechat')
        ? { attempt_id: randomUUID(), code: 'fixture-code' }
        : path.endsWith('/apple')
          ? {
              attempt_id: randomUUID(),
              identity_token: 'fixture-token',
              authorization_code: 'fixture-code',
            }
          : { attempt_id: randomUUID(), authorization_code: 'fixture-code' };
    const response = await c.send('POST', path, {
      ...credentials,
      legal_versions: { privacy: 1, agreement: 1 },
      consent_at: f.clock.now().toISOString(),
    });
    allowed(response);
    expect(response.json<{ code: number }>().code).not.toBe(0); // no invented external credentials
  });
}
