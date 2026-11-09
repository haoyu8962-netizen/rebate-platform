import { expect, it } from 'vitest';
import { boot, env, fixture, rejected, success, windowFixture } from './kit.ts';

it('[AC-QA-06c#12] 真实入口读同目录配置、导出 sync options，并以本场景参数发一次 POST', () => {
  const config = fixture();
  config.scenarios.sync.peak = 7;
  config.scenarios.sync.p95_ms = 900;
  const run = boot(config, { ...env, LOAD_ADMIN_BASE_URL: 'http://wiremock:8080' }, success());
  expect(run.opened).toEqual(['./sync.config.json']);
  expect(Object.keys(run.exported.options?.scenarios ?? {})).toEqual(['sync']);
  expect(run.exported.options?.scenarios['sync']?.stages[1]?.target).toBe(21);
  expect(run.exported.options?.thresholds['http_req_duration{scenario:sync}']).toEqual([
    'p(95)<900',
  ]);
  expect(run.exported.options?.thresholds['checks']).toEqual(['rate==1']);
  expect(run.exported.options?.thresholds['dropped_iterations']).toEqual(['count==0']);
  expect(run.exported.options?.maxRedirects).toBe(0);
  expect(run.exported.sync).toBeTypeOf('function');
  const data = run.exported.setup?.();
  run.exported.sync!(data);
  expect(run.calls).toHaveLength(1);
  expect(run.calls[0]).toMatchObject({
    method: 'POST',
    url: 'http://wiremock:8080/admin/v1/order-syncs',
    params: {
      redirects: 0,
      tags: { scenario: 'sync' },
      headers: { Authorization: `Bearer ${env.LOAD_ADMIN_TOKEN}` },
    },
  });
  expect(JSON.parse(String(run.calls[0]?.body))).toEqual(config.requests.sync);
  expect(run.checks.length).toBeGreaterThan(0);
  expect(run.checks.every(Boolean)).toBe(true);
});

it('[AC-QA-06c#13] 时间窗入口先读 limits，之后才 POST，两个请求均禁止重定向', () => {
  const run = boot(windowFixture(), env, success());
  expect(run.exported.setup).toBeTypeOf('function');
  expect(run.exported.sync).toBeTypeOf('function');
  const data = run.exported.setup!();
  run.exported.sync!(data);
  expect(run.calls.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: 'GET', url: 'http://127.0.0.1:3002/admin/v1/order-syncs/limits' },
    { method: 'POST', url: 'http://127.0.0.1:3002/admin/v1/order-syncs' },
  ]);
  for (const call of run.calls) {
    expect(call.params['redirects']).toBe(0);
    expect(call.params['headers']).toMatchObject({
      Authorization: `Bearer ${env.LOAD_ADMIN_TOKEN}`,
    });
  }
});

it('[AC-QA-06c#14] 初始化拒绝生产目标、未给令牌和非法配置，负载前即失败', () => {
  for (const environment of [
    {},
    { ...env, LOAD_ENV: 'prod' },
    { ...env, LOAD_ADMIN_BASE_URL: 'https://prod.example' },
  ]) {
    rejected(() => boot(fixture(), environment, success()));
  }
  const config = fixture();
  config.scenarios.sync.peak = 0;
  rejected(() => boot(config, env, success()));
});

it('[AC-QA-06c#15] HTTP 错误、业务错误、非 JSON 和重定向计为失败，不重试或跟随跳转', () => {
  for (const reply of [
    { ...success(), status: 401 },
    { ...success(), status: 429 },
    { ...success(), status: 500 },
    { ...success(), error_code: 1050 },
    {
      ...success(),
      body: JSON.stringify({ code: 30156, msg: 'paused', data: { platform: 'pdd' } }),
    },
    { ...success(), body: '<html>not json</html>' },
    { ...success(), body: null },
    { ...success(), status: 302, headers: { Location: 'https://prod.example' } },
  ]) {
    const run = boot(fixture(), env, reply);
    expect(run.exported.sync).toBeTypeOf('function');
    run.exported.sync!(run.exported.setup?.());
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.params['redirects']).toBe(0);
    expect(run.checks).toContain(false);
  }
});
