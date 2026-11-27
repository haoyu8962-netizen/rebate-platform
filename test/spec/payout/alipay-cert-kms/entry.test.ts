import { expect, it } from 'vitest';
import { secretsRead, text } from '../../platform/kms/kit.ts';
import { SDK_MARKER, sdk } from '../../platform/kms/sdk-stub.ts';
import { expectServedThenStopped } from '../entry/entry-kit.ts';
import { nextRun } from '../query-recovery-wiring/entry-recovery-kit.ts';
import {
  EXPECTED_CREDENTIALS,
  LEGACY_ENV,
  SECRET_NAMES,
  expectKmsRefused,
  expectNoCredentialInLogs,
  kmsFixture,
} from './entry-kit.ts';

function expectLive(f: Awaited<ReturnType<typeof kmsFixture>>): void {
  expect(f.start).toHaveBeenCalledTimes(1);
  const decision = f.start.mock.calls[0]?.[0];
  expect(decision?.mode).toBe('live');
  if (decision?.mode === 'live') {
    const { privateKey, alipayPublicKey, ...credentials } = decision.credentials;
    const { privateKey: appKey, alipayPublicKey: alipayKey, ...expected } = EXPECTED_CREDENTIALS;
    expect(credentials).toStrictEqual(expected);
    expect(privateKey === appKey).toBe(true);
    expect(alipayPublicKey === alipayKey).toBe(true);
  }
  expect(secretsRead().toSorted()).toEqual(SECRET_NAMES.toSorted());
}

it('[AC-B2-06j#5] prod 的 dry_run 不读密钥，live 只读打款的四个 KMS 条目并注入证书凭据', async () => {
  const dry = await kmsFixture({ env: { PAYOUT_MODE: 'dry_run' } });
  await dry.run();
  expect(dry.start.mock.calls).toStrictEqual([[{ mode: 'dry_run' }]]);
  await expectServedThenStopped(dry);
  expect(secretsRead()).toEqual([]);
  expectNoCredentialInLogs(dry.lines);
  nextRun();

  const live = await kmsFixture();
  await live.run();
  expectLive(live);
  await expectServedThenStopped(live);
  expectNoCredentialInLogs(live.lines);
});

it('[AC-B2-06j#6] prod + live 没配置 KMS，即使保留旧变量也拒绝启动', async () => {
  const f = await kmsFixture({ withKms: false, env: LEGACY_ENV });
  await f.run();
  expectKmsRefused(f);
  expect(secretsRead()).toEqual([]);
});

it.each(SECRET_NAMES)('[AC-B2-06j#7] prod + live 缺 KMS 条目 %s 时拒绝启动', async (name) => {
  const f = await kmsFixture({ env: LEGACY_ENV });
  sdk.secrets.delete(name);
  await f.run();
  expectKmsRefused(f);
  expect(secretsRead()).toContain(name);
});

it('[AC-B2-06j#8] prod + live 的 KMS 条目齐备但读取失败时拒绝启动，日志不带 SDK 原文', async () => {
  const f = await kmsFixture({ env: LEGACY_ENV });
  sdk.getSecretValue.mockRejectedValue(new Error(SDK_MARKER));
  await f.run();
  expectKmsRefused(f);
  expect(sdk.getSecretValue).toHaveBeenCalled();
  expect(f.lines.join('\n')).not.toContain(SDK_MARKER);
});

it.each(SECRET_NAMES)(
  '[AC-B2-06j#9] prod + live 的 %s 无法解析时拒绝启动，日志不带原文',
  async (name) => {
    const f = await kmsFixture({ env: LEGACY_ENV });
    const malformed = 'test-payout-credential-malformed';
    sdk.secrets.set(name, text(malformed));
    await f.run();
    expectKmsRefused(f);
    expect(secretsRead()).toContain(name);
    expect(f.lines.join('\n')).not.toContain(malformed);
  },
);

it('[AC-B2-06j#10] prod + live 忽略旧环境变量的凭据，恰有一条告警列出两个变量名', async () => {
  const f = await kmsFixture({ env: LEGACY_ENV });
  await f.run();
  expectLive(f);
  await expectServedThenStopped(f);
  expectNoCredentialInLogs(f.lines);

  const names = Object.keys(LEGACY_ENV);
  const warnings = f.lines.filter((line) => {
    const record = JSON.parse(line) as { level: number };
    return record.level === 40 && names.some((name) => line.includes(name));
  });
  expect(warnings).toHaveLength(1);
  for (const name of names) expect(warnings[0]).toContain(name);
});
