// B3-08l 同步的入口接线（照 test/spec/agent/stream-recovery/entry.test.ts：stub bootstrap.createWorkerContext 与
// startWorkerServices，不起真进程、不发真信号）。worker 在 startWorkerServices 解决之后、`started` 之前取
// context.get(agentRuleSyncToken(), {strict: false}) 的运行体并 start() 一次（不带测试缝）；停机先等它 stop
// 完成再 services.stop（stop 拒绝时 services.stop 仍调用）；上下文里没有可用的运行体（get 抛错、null、undefined、
// 没有 start）时照常 started 与停机、不起、不崩；COULI_EXIT_AFTER_INIT=1、启动期间已收到信号、api / stream /
// admin / payout 入口都不起。
import { afterEach, expect, it, vi } from 'vitest';

import {
  agentRuleSyncToken,
  agentSweeperToken,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';

// Loaded by URL (as the B3-03h entry test does): the entry, bootstrap and platform pull in the
// Nest controllers, which the `test` project does not compile.
interface Platform {
  JOB_QUEUE: symbol;
  loadConfig(env: object): object;
  loadConnectionConfig(...args: unknown[]): object;
  loadMaintConnectionConfig(...args: unknown[]): unknown;
  createRootLogger(...args: unknown[]): unknown;
  createDbHandles(...args: unknown[]): unknown;
  startWorkerServices(parts: { queue: { start(): Promise<void> } }): Promise<{
    stop(): Promise<void>;
  }>;
}
interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}
const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;
async function modules() {
  return {
    platform: (await import(src('modules/platform/index.ts'))) as Platform,
    boot: (await import(src('bootstrap.ts'))) as Boot,
    entryModule: (await import(src('entry.ts'))) as { runEntry(entry: Entry): Promise<void> },
    risk: (await import(src('modules/risk/index.ts'))) as { riskScanToken(): symbol },
  };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

type SyncAnswer = 'runtime' | 'throw' | null | undefined | 'no-start';

async function fixture(env: Record<string, string> = {}) {
  // The token the worker resolves (NotImplemented on the skeleton reddens each test here).
  const syncToken = agentRuleSyncToken();
  expect(typeof syncToken).toBe('symbol');
  const sweeperToken = agentSweeperToken();
  const { platform, boot, entryModule, risk } = await modules();
  const p = await ports();
  const config = platform.loadConfig({ APP_ENV: 'test', ...env });
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue({ redisUrl: null });
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(p.logger);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: null,
    dbRead: null,
    close: async () => undefined,
  });
  const order: string[] = [];
  const msgs = (): string[] => p.lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  // loop.stop() resolves at once unless the test holds it: then it settles only when the test
  // says so, as a loop waiting for its round in flight does.
  let stopGate: Promise<void> | null = null;
  const loopStop = vi.fn(async () => {
    order.push('rule-sync-stop-called');
    if (stopGate !== null) await stopGate;
    order.push('rule-sync-stopped');
  });
  const start = vi.fn((...args: unknown[]) => {
    void args;
    order.push(msgs().includes('started') ? 'rule-sync-start-after-started' : 'rule-sync-start');
    return { stop: loopStop };
  });
  const state: { sync: SyncAnswer } = { sync: 'runtime' };
  const queue = {
    start: vi.fn(async () => {
      order.push('queue-start');
    }),
    stop: vi.fn(async () => undefined),
  };
  const context = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown): unknown => {
      if (token === platform.JOB_QUEUE) return queue;
      if (token === risk.riskScanToken()) return null;
      if (token === sweeperToken) return null;
      if (token === syncToken) {
        switch (state.sync) {
          case 'runtime':
            return { start, syncOnce: async () => ({ synced: [], failed: [] }) };
          case 'throw':
            throw new Error('Nest could not find the agent rule sync token');
          case 'no-start':
            return { syncOnce: async () => ({ synced: [], failed: [] }) };
          default:
            return state.sync;
        }
      }
      throw new Error(`unexpected token ${String(token)}`);
    },
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(context);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(context);
  const servicesStop = vi.fn(async () => {
    order.push('services-stop');
  });
  let duringStart: (() => void) | null = null;
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    duringStart?.();
    return { stop: servicesStop };
  });
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((
    event: string,
    listener: (...a: unknown[]) => void,
  ) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event as never, listener as never);
  }) as never);
  vi.useFakeTimers();
  return {
    order,
    msgs,
    start,
    loopStop,
    servicesStop,
    state,
    run: (entry: Entry) => entryModule.runEntry(entry),
    signal(signal: 'SIGTERM' | 'SIGINT') {
      expect(handlers.has(signal)).toBe(true);
      handlers.get(signal)!(signal);
    },
    onStart(fn: () => void) {
      duringStart = fn;
    },
    holdStop(): { release(): void; fail(error: Error): void } {
      let release!: () => void;
      let fail!: (error: Error) => void;
      stopGate = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      return { release: () => release(), fail: (error) => fail(error) };
    },
    /** Drains pending continuations without advancing time (fake timers). */
    async drain() {
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(0);
    },
    async settleShutdown() {
      await vi.advanceTimersByTimeAsync(0);
      expect(msgs().some((m) => m === 'stopped' || m === 'shutdown_failed')).toBe(true);
    },
  };
}

it('[AC-B3-08l#4] worker 入口：startWorkerServices 解决之后、started 之前起一次规则块同步（start 不带参数）；SIGTERM 时先等它 stop 完成（之前 services.stop 不被调用），之后才 services.stop，不留定时器', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  const options = f.start.mock.calls[0]?.[0] as { schedule?: unknown } | undefined;
  expect(options?.schedule, 'production passes no schedule seam').toBeUndefined();
  expect(f.order).toEqual(['queue-start', 'rule-sync-start']);
  expect(f.msgs()).toContain('started');
  const held = f.holdStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop, 'services.stop waits for the rule sync stop').not.toHaveBeenCalled();
  expect(f.msgs()).not.toContain('stopped');
  held.release();
  await f.settleShutdown();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(f.order).toEqual([
    'queue-start',
    'rule-sync-start',
    'rule-sync-stop-called',
    'rule-sync-stopped',
    'services-stop',
  ]);
  expect(f.msgs()).toContain('stopped');
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-08l#4] 规则块同步 stop 拒绝时 services.stop 仍被调用（在拒绝之后），不留定时器', async () => {
  const f = await fixture();
  await f.run('worker');
  expect(f.start).toHaveBeenCalledTimes(1);
  const held = f.holdStop();
  f.signal('SIGTERM');
  await f.drain();
  expect(f.loopStop).toHaveBeenCalledTimes(1);
  expect(f.servicesStop).not.toHaveBeenCalled();
  held.fail(new Error('fixture-rule-sync-stop-failed'));
  await f.settleShutdown();
  expect(f.servicesStop).toHaveBeenCalledTimes(1);
  expect(f.order).toEqual([
    'queue-start',
    'rule-sync-start',
    'rule-sync-stop-called',
    'services-stop',
  ]);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);

it('[AC-B3-08l#4] 上下文里没有可用的同步运行体（get 抛错、null、undefined、没有 start；隔离 worker 上下文）：worker 照常 started 与停机，不起、不崩、不记 startup_failed', async () => {
  for (const answer of ['throw', null, undefined, 'no-start'] as const) {
    const f = await fixture();
    f.state.sync = answer;
    await f.run('worker');
    expect(f.msgs(), String(answer)).toContain('started');
    expect(f.msgs(), String(answer)).not.toContain('startup_failed');
    expect(f.start, String(answer)).not.toHaveBeenCalled();
    f.signal('SIGTERM');
    await f.settleShutdown();
    expect(f.servicesStop, String(answer)).toHaveBeenCalledTimes(1);
    expect(f.msgs(), String(answer)).toContain('stopped');
    expect(vi.getTimerCount(), String(answer)).toBe(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
}, 30_000);

it('[AC-B3-08l#4] api / stream / admin / payout 入口与 COULI_EXIT_AFTER_INIT=1 的 worker 都不起同步；启动期间已收到停止信号的 worker 也不起', async () => {
  const f = await fixture();
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    await f.run(entry);
    f.signal('SIGINT');
    await f.settleShutdown();
    expect(f.start, entry).not.toHaveBeenCalled();
    expect(vi.getTimerCount(), entry).toBe(0);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();

  const exitAfterInit = await fixture({ COULI_EXIT_AFTER_INIT: '1' });
  await exitAfterInit.run('worker');
  expect(exitAfterInit.msgs()).toContain('started');
  expect(exitAfterInit.start).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();

  const early = await fixture();
  early.onStart(() => early.signal('SIGTERM'));
  await early.run('worker');
  await early.settleShutdown();
  expect(early.start).not.toHaveBeenCalled();
  expect(early.servicesStop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}, 30_000);
