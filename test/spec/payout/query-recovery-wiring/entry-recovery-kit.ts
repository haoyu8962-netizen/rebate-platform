// What the B2-06i entry tests add to test/spec/payout/entry/entry-kit.ts (not changed): a fake
// runtime with startRecovery, handed in through the kit's state.runtime, and a /metrics listener
// that never listens. Every step is recorded on the kit's `order`.
import { expect, vi } from 'vitest';
import {
  expectServedThenStopped,
  fixture,
  type Fixture,
  type RuntimeAnswer,
} from '../entry/entry-kit.ts';

const originalExitCode = process.exitCode;

const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

interface MetricsPorts {
  createMetricsRegistry(...args: unknown[]): unknown;
  startMetricsServer(...args: unknown[]): Promise<unknown>;
}
interface ConfigPort {
  loadConfig(env: object): object;
}

/** A real wait of a few promise turns: a stop that is not awaited shows in the order. */
async function turns(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Gives `f` a runtime that has startRecovery; `onStop` runs inside the worker's stop. */
export function withRecovery(f: Fixture, onStop: () => Promise<void> = turns) {
  const stop = vi.fn(async () => {
    f.order.push('worker-stop-begin');
    await onStop();
    f.order.push('worker-stop-end');
  });
  const startRecovery = vi.fn(() => {
    f.order.push('recovery-start');
    return { stop };
  });
  f.state.runtime = { start: f.start, startRecovery } as unknown as RuntimeAnswer;
  return { stop, startRecovery };
}

/** METRICS_PORT set: nothing listens; `onListen` runs inside the listener's start. */
export async function withMetrics(f: Fixture, onListen: () => Promise<void> = turns) {
  const platform = (await import(src('modules/platform/index.ts'))) as ConfigPort;
  // The kit's spy answers here; the same spy then answers with metrics on.
  const config = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue({
    ...config,
    metrics: { host: '127.0.0.1', port: 9464 },
  });
  const close = vi.fn(async () => {
    f.order.push('metrics-close');
  });
  for (const path of ['modules/platform/index.ts', 'modules/platform/metrics/index.ts']) {
    const ports = (await import(src(path))) as MetricsPorts;
    vi.spyOn(ports, 'createMetricsRegistry').mockReturnValue({
      contentType: 'text/plain',
      render: async () => '',
    });
    vi.spyOn(ports, 'startMetricsServer').mockImplementation(async () => {
      await onListen();
      return { port: 9464, close };
    });
  }
  return { close };
}

/** Everything one fixture set up is undone, so a test can run the entry a second time. */
export function nextRun(): void {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = originalExitCode;
}

/** Lets a shutdown go as far as it can without the test opening anything. */
export async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/**
 * The positive half of the tests that pin when recovery does not start: the plain entry starts it
 * once and stops it once. A negative half alone would already hold today.
 */
export async function expectRecoveryRuns(): Promise<void> {
  const f = await fixture();
  const recovery = withRecovery(f);
  await f.run();
  expect(recovery.startRecovery).toHaveBeenCalledTimes(1);
  await expectServedThenStopped(f);
  expect(recovery.stop).toHaveBeenCalledTimes(1);
  nextRun();
}

/** No log line of the entry is about recovery. */
export function expectNoRecoveryLog(f: Fixture): void {
  expect(f.msgs().filter((msg) => msg.includes('recovery'))).toEqual([]);
}
