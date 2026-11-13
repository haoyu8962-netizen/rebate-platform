import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  MetricsRegistryOptions,
  MetricsServerOptions,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { compileOnlyDb } from '../metrics/kit.ts';
import { assertCounter, loadCounterToken, METRIC, ROOT } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

// Real runEntry and registry; only infrastructure is replaced. No socket, Redis or PG connection.
async function fixture(token: symbol) {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue({
    ...base,
    metrics: { host: '127.0.0.1', port: 9464 },
  });
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(
    platform.createRootLogger(
      { level: 'silent', entry: 'stream', appEnv: 'test' },
      { write: () => undefined },
    ),
  );
  const db = compileOnlyDb([]);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: async () => undefined,
  });
  const counter = {
    value: 0,
    total() {
      return this.value;
    },
  };
  const state: { missing: 'null' | 'undefined' | 'throw' | false } = { missing: false };
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const get = vi.fn((wanted: unknown, _options?: unknown): unknown => {
    void _options;
    if (wanted === platform.JOB_QUEUE) return queue;
    if (wanted !== token) return null;
    if (state.missing === 'throw') throw new Error('synthetic: provider not registered');
    if (state.missing === 'null') return null;
    if (state.missing === 'undefined') return undefined;
    return counter;
  });
  const app = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get,
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  vi.spyOn(platform, 'startWorkerServices').mockResolvedValue({ stop: async () => undefined });
  const realRegistry = metrics.createMetricsRegistry;
  const registries: MetricsRegistryOptions[] = [];
  const createRegistry = (options: MetricsRegistryOptions) => {
    registries.push(options);
    return realRegistry(options);
  };
  vi.spyOn(platform, 'createMetricsRegistry').mockImplementation(createRegistry);
  vi.spyOn(metrics, 'createMetricsRegistry').mockImplementation(createRegistry);
  const servers: MetricsServerOptions[] = [];
  const startServer = async (options: MetricsServerOptions) => {
    servers.push(options);
    return { port: options.port, close: async () => undefined };
  };
  vi.spyOn(platform, 'startMetricsServer').mockImplementation(startServer);
  vi.spyOn(metrics, 'startMetricsServer').mockImplementation(startServer);
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  });
  vi.useFakeTimers();
  return {
    counter,
    state,
    get,
    registries,
    servers,
    async start(entry: Entry) {
      const before = servers.length;
      await runEntry(entry);
      expect(process.exitCode, `${entry} startup`).toBe(originalExitCode);
      expect(servers).toHaveLength(before + 1);
      return servers.at(-1)!.registry;
    },
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
    async close() {
      await this.stop();
      await db.destroy();
    },
  };
}

it('[AC-B1-01zzv#3] stream 启动按公开 Nest 令牌接入 /metrics，抓取看见增量；其余四入口不取计数器', async () => {
  const token = await loadCounterToken();
  const f = await fixture(token);
  try {
    const registry = await f.start('stream');
    assertCounter(await registry.render(), 0);
    expect(f.get).toHaveBeenCalledWith(token, { strict: false });
    f.counter.value += 1;
    assertCounter(await registry.render(), 1);
    assertCounter(await registry.render(), 1);
    await f.stop();
    for (const entry of ['api', 'admin', 'worker', 'payout'] as const) {
      f.get.mockClear();
      await f.start(entry);
      expect(f.registries.at(-1)!.collectAgentReplyEmpty, entry).toBeUndefined();
      expect(
        f.get.mock.calls.filter(([wanted]) => wanted === token),
        entry,
      ).toEqual([]);
      await f.stop();
    }
  } finally {
    await f.close();
  }
}, 30_000);

it('[AC-B1-01zzv#4] stream 能拿到计数器才输出；未注册、null、undefined 都不输出且启动和抓取仍成功', async () => {
  const f = await fixture(await loadCounterToken());
  try {
    f.counter.value = 8;
    assertCounter(await (await f.start('stream')).render(), 8);
    await f.stop();
    for (const missing of ['null', 'undefined', 'throw'] as const) {
      f.state.missing = missing;
      const registry = await f.start('stream');
      expect(await registry.render(), missing).not.toContain(METRIC);
      expect(await registry.render(), missing).not.toContain(METRIC);
      await f.stop();
    }
  } finally {
    await f.close();
  }
}, 30_000);
