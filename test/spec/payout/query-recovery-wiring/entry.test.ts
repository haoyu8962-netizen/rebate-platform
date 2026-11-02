// B2-06i rule tests (规划/08 BR-WDR-14; 生产装配缺口第 5 条): the payout entry starts the query chain's
// recovery once the queue runs, because the rounds enqueue jobs, and stops it before anything it
// needs closes (D10-553). The runtime stays optional: a fake runtime without startRecovery, or no
// runtime at all, starts and stops as before.
import { expect, it, vi } from 'vitest';
import {
  expectServedThenStopped,
  fixture,
  type Fixture,
  type FixtureOptions,
  type RuntimeAnswer,
} from '../entry/entry-kit.ts';
import { liveEnv } from '../entry/mode-kit.ts';
import {
  drain,
  expectNoRecoveryLog,
  expectRecoveryRuns,
  nextRun,
  withMetrics,
  withRecovery,
} from './entry-recovery-kit.ts';
import { gate } from './support.ts';

it('[AC-B2-06i#6] 启动顺序：start(decision)、queue.start 完成之后才调一次 startRecovery，不带参数', async () => {
  const f = await fixture();
  const recovery = withRecovery(f);
  // Recorded only after the start's own awaits: a queue start that is not awaited shows here.
  f.queue.start.mockImplementationOnce(async () => {
    await Promise.resolve();
    await Promise.resolve();
    f.order.push('queue-start');
  });
  await f.run();
  expect(f.order).toEqual(['payout-start', 'queue-start', 'recovery-start']);
  expect(recovery.startRecovery.mock.calls).toEqual([[]]);
  expect(f.start.mock.calls).toStrictEqual([[{ mode: 'dry_run' }]]);
  expect(f.msgs()).toContain('started');
  await expectServedThenStopped(f);
});

it('[AC-B2-06i#7] 停机：最先 worker.stop 并等它完成，之后才关 metrics、queue.stop、context.close', async () => {
  const f = await fixture();
  const metrics = await withMetrics(f);
  const finishing = gate();
  const recovery = withRecovery(f, () => finishing.wait());
  await f.run();
  expect(recovery.startRecovery).toHaveBeenCalledTimes(1);

  f.signal('SIGTERM');
  await drain();
  expect(recovery.stop).toHaveBeenCalledTimes(1);
  expect(metrics.close).not.toHaveBeenCalled();
  expect(f.queue.stop).not.toHaveBeenCalled();
  expect(f.counts.closed).toBe(0);
  expect(f.msgs()).not.toContain('stopped');

  finishing.open();
  await f.settleShutdown();
  expect(f.order).toEqual([
    'payout-start',
    'queue-start',
    'recovery-start',
    'worker-stop-begin',
    'worker-stop-end',
    'metrics-close',
    'queue-stop',
  ]);
  expect(recovery.stop).toHaveBeenCalledTimes(1);
  expect(f.counts.closed).toBe(f.counts.created);
  expect(f.msgs()).toContain('stopped');
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B2-06i#7] 启动失败（metrics 监听失败）：已起的恢复先停并等完，再 queue.stop、context.close，进程以启动失败结束', async () => {
  await expectRecoveryRuns();

  const f = await fixture();
  const recovery = withRecovery(f);
  await withMetrics(f, async () => {
    throw new Error('synthetic listen failure');
  });
  await f.run();
  expect(process.exitCode).toBe(1);
  expect(f.msgs()).toContain('startup_failed');
  // Whether recovery starts before or after the listener is the implementation's choice: whatever
  // started is stopped first.
  const started = recovery.startRecovery.mock.calls.length;
  expect(recovery.stop).toHaveBeenCalledTimes(started);
  expect(f.order.filter((step) => step !== 'payout-start' && step !== 'queue-start')).toEqual(
    started === 0
      ? ['queue-stop']
      : ['recovery-start', 'worker-stop-begin', 'worker-stop-end', 'queue-stop'],
  );
  expect(f.counts.closed).toBe(f.counts.created);
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B2-06i#8] 运行体可选：throw、null、undefined、没有 start、就是队列、没有 startRecovery，照常起停，不崩、不打日志', async () => {
  await expectRecoveryRuns();

  const answers: readonly RuntimeAnswer[] = [
    'throw',
    null,
    undefined,
    'no-start',
    'queue',
    'runtime',
  ];
  for (const answer of answers) {
    const f = await fixture();
    f.state.runtime = answer;
    await f.run();
    await expectServedThenStopped(f);
    expectNoRecoveryLog(f);
    nextRun();
  }

  // startRecovery must follow start(decision): a value without start gets neither.
  const f = await fixture();
  const startRecovery = vi.fn();
  f.state.runtime = { startRecovery } as unknown as RuntimeAnswer;
  await f.run();
  expect(startRecovery).not.toHaveBeenCalled();
  await expectServedThenStopped(f);
});

it('[AC-B2-06i#8] COULI_EXIT_AFTER_INIT=1：不调用 startRecovery', async () => {
  await expectRecoveryRuns();

  const f = await fixture({ exitAfterInit: true });
  const recovery = withRecovery(f);
  await f.run();
  expect(recovery.startRecovery).not.toHaveBeenCalled();
  expect(f.queue.start).not.toHaveBeenCalled();
  expect(f.msgs()).toContain('started');
  expect(f.counts.closed).toBe(f.counts.created);
  expect(process.exitCode).not.toBe(1);
});

it('[AC-B2-06i#8] 启动过程中已请求停止（建上下文、start、queue.start 期间）：不调用 startRecovery，干净停止', async () => {
  await expectRecoveryRuns();

  const during: readonly ((f: Fixture) => void)[] = [
    (f) => {
      f.onCreate(() => f.signal('SIGTERM'));
    },
    (f) => {
      f.start.mockImplementationOnce((decision) => {
        f.signal('SIGTERM');
        return { mode: decision.mode, channels: {} };
      });
    },
    (f) => {
      f.queue.start.mockImplementationOnce(async () => {
        f.signal('SIGTERM');
      });
    },
  ];
  for (const requestStop of during) {
    const f = await fixture();
    const recovery = withRecovery(f);
    requestStop(f);
    await f.run();
    await f.settleShutdown();
    expect(recovery.startRecovery).not.toHaveBeenCalled();
    expect(recovery.stop).not.toHaveBeenCalled();
    expect(f.msgs()).toContain('stopped');
    expect(f.msgs()).not.toContain('started');
    expect(f.counts.closed).toBe(f.counts.created);
    expect(process.exitCode).not.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    nextRun();
  }
});

it('[AC-B2-06i#8] metrics 监听期间请求停止：起过的恢复照样先停，不留定时器', async () => {
  await expectRecoveryRuns();

  const f = await fixture();
  const recovery = withRecovery(f);
  await withMetrics(f, async () => {
    f.signal('SIGTERM');
  });
  await f.run();
  await f.settleShutdown();
  const started = recovery.startRecovery.mock.calls.length;
  expect(recovery.stop).toHaveBeenCalledTimes(started);
  expect(f.order.filter((step) => step !== 'payout-start' && step !== 'queue-start')).toEqual(
    started === 0
      ? ['metrics-close', 'queue-stop']
      : ['recovery-start', 'worker-stop-begin', 'worker-stop-end', 'metrics-close', 'queue-stop'],
  );
  expect(f.counts.closed).toBe(f.counts.created);
  expect(vi.getTimerCount()).toBe(0);
});

it('[AC-B2-06i#10] dry_run 和 live 都启动恢复：入口不看模式', async () => {
  const runs: readonly { readonly options: FixtureOptions; readonly mode: string }[] = [
    { options: {}, mode: 'dry_run' },
    { options: { appEnv: 'prod', env: liveEnv() }, mode: 'live' },
  ];
  for (const { options, mode } of runs) {
    const f = await fixture(options);
    const recovery = withRecovery(f);
    await f.run();
    expect(f.start.mock.calls[0]?.[0].mode).toBe(mode);
    expect(recovery.startRecovery).toHaveBeenCalledTimes(1);
    await expectServedThenStopped(f);
    expect(recovery.stop).toHaveBeenCalledTimes(1);
    nextRun();
  }
});
