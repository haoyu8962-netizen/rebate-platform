// B2-06f rule tests: the payout entry starts by PAYOUT_MODE (规划/08 BR-WDR-13: 默认 dry_run；live 只能
// 经生产发布；非 prod 只能沙箱或 dry-run；只有 payout 进程读通道密钥) and resolves its runtime through an
// optional token, as the worker's order sync does. Startup logs carry no key.
import { expect, it } from 'vitest';
import { expectRefused, expectServedThenStopped, fixture } from './entry-kit.ts';
import { CREDENTIAL_NAMES, LIVE_CREDENTIALS, NON_PROD, liveEnv } from './mode-kit.ts';

it('[AC-B2-06f#9] 未设 PAYOUT_MODE：以 dry_run 启动运行体一次，先注册 payout 队列再启动队列', async () => {
  const f = await fixture();
  await f.run();
  expect(f.start.mock.calls).toStrictEqual([[{ mode: 'dry_run' }]]);
  expect(f.order).toEqual(['payout-start', 'queue-start']);
  await expectServedThenStopped(f);
});

it('[AC-B2-06f#10] prod 设了凭证但 PAYOUT_MODE=dry_run：仍是 dry_run，运行体拿不到凭证，日志不含私钥', async () => {
  const f = await fixture({ appEnv: 'prod', env: { ...liveEnv(), PAYOUT_MODE: 'dry_run' } });
  await f.run();
  expect(f.start.mock.calls).toStrictEqual([[{ mode: 'dry_run' }]]);
  expect(f.lines.join('\n')).not.toContain(LIVE_CREDENTIALS.privateKey);
  await expectServedThenStopped(f);
});

it.each(NON_PROD)(
  '[AC-B2-06f#11] APP_ENV=%s、PAYOUT_MODE=live（凭证齐全）：启动失败，不注册不启动队列',
  async (appEnv) => {
    const f = await fixture({ appEnv, env: liveEnv() });
    await f.run();
    expectRefused(f);
  },
);

it.each(
  CREDENTIAL_NAMES.filter(
    (name) => name === 'ALIPAY_APP_ID' || name === 'ALIPAY_GATEWAY_URL',
  ).flatMap((name) => [undefined, '  '].map((value) => ({ name, value }))),
)(
  '[AC-B2-06f#12] APP_ENV=prod、PAYOUT_MODE=live、$name=$value：缺凭证即启动失败',
  async ({ name, value }) => {
    const f = await fixture({ appEnv: 'prod', env: { ...liveEnv(), [name]: value } });
    await f.run();
    expectRefused(f);
  },
);

it('[AC-B2-06f#13] APP_ENV=prod、PAYOUT_MODE=live、凭证齐全：以 live 与注入的凭证启动，先注册后启动队列，日志不含私钥', async () => {
  const { EXPECTED_CREDENTIALS, kmsFixture } = await import('../alipay-cert-kms/entry-kit.ts');
  const f = await kmsFixture();
  await f.run();
  expect(f.start.mock.calls).toStrictEqual([[{ mode: 'live', credentials: EXPECTED_CREDENTIALS }]]);
  expect(f.order).toEqual(['payout-start', 'queue-start']);
  await expectServedThenStopped(f);
  expect(f.lines.join('\n')).not.toContain(EXPECTED_CREDENTIALS.privateKey);
});

it.each(['LIVE', 'sandbox', 'production'])(
  '[AC-B2-06f#14] PAYOUT_MODE=%j（prod、凭证齐全）：未知取值即启动失败',
  async (mode) => {
    const f = await fixture({ appEnv: 'prod', env: { ...liveEnv(), PAYOUT_MODE: mode } });
    await f.run();
    expectRefused(f);
  },
);

it('[AC-B2-06f#15] COULI_EXIT_AFTER_INIT=1、dry_run：初始化后记 started 并关闭，不启动队列', async () => {
  const f = await fixture({ exitAfterInit: true });
  await f.run();
  expect(process.exitCode).not.toBe(1);
  expect(f.msgs()).toContain('started');
  expect(f.queue.start).not.toHaveBeenCalled();
  expect(f.counts.closed).toBe(f.counts.created);
});

it('[AC-B2-06f#15] COULI_EXIT_AFTER_INIT=1、staging 的 live：守卫照样生效，启动失败', async () => {
  const f = await fixture({ appEnv: 'staging', env: liveEnv(), exitAfterInit: true });
  await f.run();
  expectRefused(f);
});

it.each(['throw', null, undefined, 'no-start', 'queue'] as const)(
  '[AC-B2-06f#16] 可选运行体 %s：dry_run 不导致启动失败，队列照常启动一次',
  async (answer) => {
    const f = await fixture();
    f.state.runtime = answer;
    await f.run();
    expect(f.state.runtimeGets).toBe(1);
    expect(f.start).not.toHaveBeenCalled();
    await expectServedThenStopped(f);
  },
);

it('[AC-B2-06f#17] 建上下文期间收到 SIGTERM：不启动运行体与队列，干净停止', async () => {
  const f = await fixture();
  f.onCreate(() => f.signal('SIGTERM'));
  await f.run();
  await f.settleShutdown();
  expect(f.msgs()).toContain('stopped');
  expect(f.msgs()).not.toContain('started');
  expect(f.start).not.toHaveBeenCalled();
  expect(f.queue.start).not.toHaveBeenCalled();
  expect(f.counts.closed).toBe(f.counts.created);
  expect(process.exitCode).not.toBe(1);
});
