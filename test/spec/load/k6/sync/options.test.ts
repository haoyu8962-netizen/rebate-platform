import { expect, it } from 'vitest';
import { fixture, rejected, subject } from './kit.ts';

it('[AC-QA-06c#1] 同步配置合法，独立场景以三倍峰值升压、保持、降至零', () => {
  const config = fixture();
  expect(subject.syncConfigProblems(config)).toEqual([]);
  const options = subject.buildSyncOptions(config);
  expect(Object.keys(options.scenarios)).toEqual(['sync']);
  expect(options.scenarios['sync']).toEqual({
    executor: 'ramping-arrival-rate',
    exec: 'sync',
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs: 30,
    maxVUs: 150,
    gracefulStop: '10s',
    stages: [
      { duration: '30s', target: 15 },
      { duration: '2m', target: 15 },
      { duration: '30s', target: 0 },
    ],
  });
  expect(options.thresholds).toEqual({
    'http_req_duration{scenario:sync}': ['p(95)<1500'],
    'http_req_failed{scenario:sync}': ['rate<0.01'],
    checks: ['rate==1'],
    dropped_iterations: ['count==0'],
  });
  expect(options.maxRedirects).toBe(0);
});

it('[AC-QA-06c#2] 峰值、阶段、阈值从配置读取，不在实现中钉死本地初值', () => {
  const config = fixture();
  Object.assign(config.scenarios.sync, {
    peak: 7,
    ramp_up: '10s',
    hold: '1m',
    p95_ms: 800,
    error_rate: 0.005,
    pre_allocated_vus: 42,
    max_vus: 210,
    request_timeout: '8s',
  });
  const options = subject.buildSyncOptions(config);
  expect(options.scenarios['sync']).toEqual({
    executor: 'ramping-arrival-rate',
    exec: 'sync',
    startRate: 0,
    timeUnit: '1s',
    preAllocatedVUs: 42,
    maxVUs: 210,
    gracefulStop: '8s',
    stages: [
      { duration: '10s', target: 21 },
      { duration: '1m', target: 21 },
      { duration: '10s', target: 0 },
    ],
  });
  expect(options.thresholds['http_req_duration{scenario:sync}']).toEqual(['p(95)<800']);
  expect(options.thresholds['http_req_failed{scenario:sync}']).toEqual(['rate<0.005']);
});

it('[AC-QA-06c#3] 只有 sync，一个都不能缺，也不能混入 QA-06a 场景', () => {
  for (const scenarios of [
    {},
    { search: fixture().scenarios.sync },
    {
      ...fixture().scenarios,
      convert: fixture().scenarios.sync,
    },
  ]) {
    expect(subject.syncConfigProblems({ ...fixture(), scenarios }).length).toBeGreaterThan(0);
  }
  for (const value of [
    null,
    [],
    {},
    { ...fixture(), base_urls: null },
    { ...fixture(), scenarios: null },
  ]) {
    expect(subject.syncConfigProblems(value).length).toBeGreaterThan(0);
  }
});

it('[AC-QA-06c#4] 缺失或非法阈值、负载、阶段、接口参数阻止运行', () => {
  const patches = [
    { peak: 0 },
    { peak: -1 },
    { peak: 1.5 },
    { peak: Number.MAX_SAFE_INTEGER },
    { executor: 'ramping-vus' },
    { ramp_up: '0s' },
    { hold: '' },
    { p95_ms: undefined },
    { p95_ms: 0 },
    { p95_ms: -1 },
    { p95_ms: NaN },
    { p95_ms: 1.5 },
    { p95_ms: Infinity },
    { error_rate: undefined },
    { error_rate: 0 },
    { error_rate: 1 },
    { error_rate: -0.01 },
    { error_rate: NaN },
    { latency_metric: 'http_req_waiting' },
    { service: 'api' },
    { method: 'GET' },
    { path: '/admin/v1/order-syncs/limits' },
    { path: '//wiremock/admin/v1/order-syncs' },
    { request_timeout: '0s' },
    { pre_allocated_vus: 0 },
    { max_vus: 1 },
  ];
  for (const patch of patches) {
    const config = fixture();
    Object.assign(config.scenarios.sync, patch);
    expect(subject.syncConfigProblems(config), JSON.stringify(patch)).not.toEqual([]);
    rejected(() => subject.buildSyncOptions(config));
  }
  for (const multiplier of [0, 1, 2, 4, 3.5]) {
    const config = { ...fixture(), multiplier };
    expect(subject.syncConfigProblems(config)).not.toEqual([]);
    rejected(() => subject.buildSyncOptions(config));
  }
});

it('[AC-QA-06c#5] 目标根地址只接受回环和 WireMock，环境覆盖也受同一校验', () => {
  for (const base of [
    'http://127.0.0.1:3002',
    'http://localhost:3002/',
    'http://[::1]:3002',
    'http://wiremock:8080',
    'https://localhost',
  ]) {
    const config = fixture();
    config.base_urls.admin = base;
    expect(subject.resolveSyncBaseUrl(config, {})).toBe(base.replace(/\/$/, ''));
    expect(subject.resolveSyncBaseUrl(fixture(), { LOAD_ADMIN_BASE_URL: base })).toBe(
      base.replace(/\/$/, ''),
    );
    for (const LOAD_ENV of ['local', 'wiremock']) {
      expect(subject.resolveSyncBaseUrl(config, { LOAD_ENV })).toBe(base.replace(/\/$/, ''));
    }
  }
});

it('[AC-QA-06c#6] 拒绝生产、未登记 staging、伪装主机、认证信息和非根地址', () => {
  for (const base of [
    'https://prod.example',
    'https://staging.example',
    'https://api.jd.com',
    'http://127.0.0.1.evil.test',
    'http://wiremock.evil.test',
    'http://localhost@evil.test',
    'http://user:pass@localhost',
    'http://localhost/path',
    'http://localhost?target=prod',
    'http://localhost#prod',
    'http://localhost:0',
    'http://localhost:65536',
    'file:///etc/hosts',
    '//localhost',
    'http://2130706433',
    'http://127.1',
    'http://localhost\\@evil.test',
    'http://%6cocalhost',
    '',
  ]) {
    const config = fixture();
    config.base_urls.admin = base;
    expect(subject.syncConfigProblems(config), base).not.toEqual([]);
    rejected(() => subject.resolveSyncBaseUrl(config, {}));
    rejected(() => subject.resolveSyncBaseUrl(fixture(), { LOAD_ADMIN_BASE_URL: base }));
  }
  for (const LOAD_ENV of ['prod', 'production', 'staging', 'unknown']) {
    rejected(() => subject.resolveSyncBaseUrl(fixture(), { LOAD_ENV }));
  }
});
