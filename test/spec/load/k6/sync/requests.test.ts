import { expect, it } from 'vitest';
import { env, fixture, limits, rejected, subject, windowFixture } from './kit.ts';

it('[AC-QA-06c#7] 订单号形态按契约 POST admin，身份仅用管理员令牌，不加 step-up 或幂等键', () => {
  for (const count of [1, 50]) {
    const config = fixture();
    config.requests.sync.order_nos = Array.from({ length: count }, (_, i) => `local-${i}`);
    const request = subject.buildSyncRequest(config, env);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://127.0.0.1:3002/admin/v1/order-syncs');
    expect(JSON.parse(request.body)).toEqual(config.requests.sync);
    expect(request.params).toMatchObject({
      headers: {
        Authorization: `Bearer ${env.LOAD_ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      redirects: 0,
      tags: { scenario: 'sync' },
      timeout: '10s',
    });
    const headers = Object.keys(request.params.headers).map((key) => key.toLowerCase());
    expect(headers).not.toContain('idempotency-key');
    expect(headers.some((key) => /step.?up/.test(key))).toBe(false);
    expect(request.body).not.toContain(env.LOAD_ADMIN_TOKEN);
    expect(request.params.tags).not.toHaveProperty('token');
  }
});

it('[AC-QA-06c#8] 时间窗保留带时区的 from/to，接受 earliest_from 边界和等价时刻', () => {
  for (const from of ['2026-11-08T00:00:00+08:00', '2026-11-07T16:00:00Z']) {
    const config = windowFixture();
    config.requests.sync.from = from;
    const request = subject.buildSyncRequest(config, env, limits);
    expect(JSON.parse(request.body)).toEqual(config.requests.sync);
    expect(request.url).toBe('http://127.0.0.1:3002/admin/v1/order-syncs');
  }
});

it('[AC-QA-06c#9] 请求体拒绝混合形态、越界订单号、未知平台和客户端身份', () => {
  const invalid = [
    {},
    { platform: 'pdd' },
    { platform: 'unknown', order_nos: ['x'] },
    { platform: 'pdd', order_nos: [] },
    { platform: 'pdd', order_nos: Array.from({ length: 51 }, (_, i) => String(i)) },
    { platform: 'pdd', order_nos: [''] },
    { platform: 'pdd', order_nos: [123] },
    { platform: 'pdd', order_nos: ['x'.repeat(65)] },
    { ...windowFixture().requests.sync, order_nos: ['x'] },
    { ...fixture().requests.sync, status_filter: 'anything' },
    { ...fixture().requests.sync, app_id: 'injected' },
    { ...fixture().requests.sync, admin_id: 'injected' },
    { platform: 'pdd', from: '2026-11-08T00:00:00+08:00' },
  ];
  for (const body of invalid) {
    const config = fixture();
    Object.assign(config.requests, { sync: body });
    expect(subject.syncConfigProblems(config), JSON.stringify(body)).not.toEqual([]);
    rejected(() => subject.buildSyncRequest(config, env, limits));
  }
});

it('[AC-QA-06c#10] 时间窗不早于对应平台 limits，起止合法且严格递增', () => {
  rejected(() => subject.buildSyncRequest(windowFixture(), env));
  rejected(() => subject.buildSyncRequest(windowFixture(), env, { items: [] }));
  rejected(() =>
    subject.buildSyncRequest(windowFixture(), env, {
      items: [{ ...limits.items[0]!, platform: 'jd' }],
    }),
  );
  for (const patch of [
    { from: '2026-11-07T23:59:59+08:00' },
    { from: '2026-11-09T00:00:00+08:00' },
    { from: '2026-11-10T00:00:00+08:00' },
    { from: 'not-a-date' },
    { to: 'not-a-date' },
    { from: '2026-11-08T00:00:00' },
    { to: '2026-11-09' },
  ]) {
    const config = windowFixture();
    Object.assign(config.requests.sync, patch);
    rejected(() => subject.buildSyncRequest(config, env, limits));
  }
});

it('[AC-QA-06c#11] 令牌来自环境变量，缺失或换行拒绝；URL 覆盖不能绕过安全校验', () => {
  for (const token of [undefined, '', ' ', 'bad\r\nAuthorization: injected']) {
    rejected(() => subject.buildSyncRequest(fixture(), { LOAD_ADMIN_TOKEN: token }));
  }
  rejected(() =>
    subject.buildSyncRequest(fixture(), { ...env, LOAD_ADMIN_BASE_URL: 'https://prod.example' }),
  );
  rejected(() => subject.buildSyncRequest(fixture(), { ...env, LOAD_ENV: 'prod' }));
  const request = subject.buildSyncRequest(fixture(), {
    ...env,
    LOAD_ADMIN_BASE_URL: 'http://wiremock:8080/',
    LOAD_ADMIN_TOKEN: 'another-local-token',
  });
  expect(request.url).toBe('http://wiremock:8080/admin/v1/order-syncs');
  expect(request.params.headers['Authorization']).toBe('Bearer another-local-token');
});
