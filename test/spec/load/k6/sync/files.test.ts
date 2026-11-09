import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { diskConfig, subject, text } from './kit.ts';

it('[AC-QA-06c#16] 独立配置仅含 sync，余量 5 QPS 乘三；P95 与错误率写在配置', () => {
  const config = diskConfig();
  expect(subject.syncConfigProblems(config)).toEqual([]);
  expect(Object.keys(config.scenarios)).toEqual(['sync']);
  expect(config.multiplier).toBe(3);
  expect(config.scenarios.sync).toMatchObject({
    service: 'admin',
    method: 'POST',
    path: '/admin/v1/order-syncs',
    executor: 'ramping-arrival-rate',
    peak: 5,
    ramp_up: '30s',
    hold: '2m',
    latency_metric: 'http_req_duration',
    p95_ms: 1500,
    error_rate: 0.01,
  });
  expect(subject.buildSyncOptions(config).scenarios['sync']?.stages[1]?.target).toBe(15);
  expect(config.requests.sync).toHaveProperty('platform');
  expect(JSON.stringify(config)).not.toMatch(/access_token|admin_token|Authorization|Bearer /i);
});

it('[AC-QA-06c#17] sync 入口使用独立配置及生产纯构造器，共用 options.ts 不复制 QA-06a 三场景入口', () => {
  const entry = text('infra/load/k6/sync.ts');
  expect(entry).toMatch(/open\(\s*['"]\.\/sync\.config\.json['"]\s*\)/);
  expect(entry).toMatch(/from\s+['"]\.\/sync-options\.ts['"]/);
  expect(entry).toMatch(/\bbuildSyncOptions\(/);
  expect(entry).toMatch(/\bbuildSyncRequest\(/);
  const helpers = text('infra/load/k6/sync-options.ts');
  expect(helpers).toMatch(/import\s*\{[^}]+\}\s*from\s*['"]\.\/options\.ts['"]/);
  expect(helpers).not.toMatch(/from\s+['"]node:/);
  expect(entry).not.toMatch(/open\(\s*['"]\.\/config\.json['"]|from\s+['"]\.\/script\.ts['"]/);
  expect(entry).not.toMatch(/\.env|console\.|http\.batch/);
});

it('[AC-QA-06c#18] 增加 sync 后 QA-06a 三场景配置与入口逐字保持原样', () => {
  // 新场景存在 + 旧入口不变是同一条兼容性验收；骨架阶段在新配置缺失处先红。
  expect(Object.keys(diskConfig().scenarios)).toEqual(['sync']);
  const expected = {
    'config.json': '3c8a6aa302ff08045f1c606d08362419ed5f9b852b763316e393b99aa2151915',
    'script.ts': '26772774e9d129bfe71c0bd461e9c6d00da0379760ee2949d6f47b6ccece75cb',
  };
  for (const [file, digest] of Object.entries(expected)) {
    expect(
      createHash('sha256')
        .update(text(`infra/load/k6/${file}`))
        .digest('hex'),
      file,
    ).toBe(digest);
  }
});

it('[AC-QA-06c#19] README 只追加同步节，含运行命令、阈值依据、环境变量和 WireMock 隔离说明', () => {
  const readme = Buffer.from(text('infra/load/k6/README.md'));
  const addition = readme.subarray(7711).toString('utf8');
  expect(addition).toMatch(/^\s*## .*sync|^\s*## .*同步/m);
  expect(createHash('sha256').update(readme.subarray(0, 7711)).digest('hex')).toBe(
    'd641499fa3c3ab28dbee8ec7340553a5745e0818b7adf0fcebb87f19b8881b72',
  );
  for (const term of [
    'sync.ts',
    'sync.config.json',
    'LOAD_ADMIN_BASE_URL',
    'LOAD_ADMIN_TOKEN',
    'LOAD_ENV',
    'order.view',
    'infra/fault',
    'WireMock',
    'prod',
    '01 §7.3',
    '01 §7.1',
    '50',
    '30',
    '15',
    '5',
    '1500',
    '1%',
  ])
    expect(addition, term).toContain(term);
  expect(addition).toMatch(/本地.*初值|初值.*本地/);
  expect(addition).toMatch(/无.*专条|没有.*专.*指标/);
  expect(addition).toMatch(/不压真实联盟|禁止.*真实联盟/);
  expect(addition).toMatch(/docker compose[^\n]+run[^\n]+sync\.ts/);
});
