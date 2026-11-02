import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type {
  MetricsRegistryOptions,
  MetricsServerOptions,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  createTaobaoSearchCounter,
  taobaoSearchCounterToken,
} from '../../../../apps/api/src/modules/union/infra/taobao/search-counter.ts';
import { compileOnlyDb, families, ROOT, samples } from '../../platform/metrics/kit.ts';

// 第 12 条的入口接线：runEntry 在 api 入口取到 UnionModule 提供的计数器（taobaoSearchCounterToken，
// strict: false 解析），把快照交给 createMetricsRegistry，/metrics 就有这个计数器；worker 不交。注册表是真的，
// 只有监听、应用上下文、队列是替身，照 B1-01zzh 的入口测试；不连库、不监听。动态导入把 Nest 装饰器挡在
// 规则测试的类型检查之外。

type Entry = 'api' | 'worker';

const METRIC = 'couli_taobao_search_total';
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };

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

async function fixture(token: symbol, counter: unknown) {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  const config = { ...base, metrics: METRICS_CONFIG } as ReturnType<typeof platform.loadConfig>;
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db: compileOnlyDb([]),
    dbRead: null,
    close: async () => undefined,
  });
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const app = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (wanted: unknown) => {
      if (wanted === platform.JOB_QUEUE) return queue;
      return wanted === token ? counter : null;
    },
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => parts.queue.stop() };
  });

  // The registry stays the real one; what each entry hands it is recorded.
  const real = metrics.createMetricsRegistry;
  const registries: MetricsRegistryOptions[] = [];
  const createRegistry = (options: MetricsRegistryOptions) => {
    registries.push(options);
    return real(options);
  };
  vi.spyOn(platform, 'createMetricsRegistry').mockImplementation(createRegistry);
  vi.spyOn(metrics, 'createMetricsRegistry').mockImplementation(createRegistry);
  const servers: { options: MetricsServerOptions }[] = [];
  const startServer = async (serverOptions: MetricsServerOptions) => {
    servers.push({ options: serverOptions });
    return { port: serverOptions.port, close: vi.fn(async () => undefined) };
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
    runEntry,
    registries,
    servers,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B1-04zy#59] api 入口的 /metrics 输出 UnionModule 计数器的当前值；worker 入口不交这个计数器', async () => {
  const counter = createTaobaoSearchCounter();
  counter.record('official', 'fallback');
  counter.record('dataoke', 'ok');
  const f = await fixture(taobaoSearchCounterToken(), counter);
  try {
    await f.runEntry('api');
    expect(process.exitCode, 'api failed to start').toBe(originalExitCode);
    expect(f.servers).toHaveLength(1);
    const registry = f.servers[0]!.options.registry;
    const first = await registry.render();
    expect(families(first).get(METRIC)).toBe('counter');
    const series = (text: string) =>
      samples(text)
        .filter((sample) => sample.name === METRIC)
        .map(({ labels, value }) => ({ ...labels, value }));
    expect(series(first)).toEqual(
      expect.arrayContaining([
        { source: 'official', outcome: 'fallback', value: 1 },
        { source: 'dataoke', outcome: 'ok', value: 1 },
      ]),
    );

    // 每次 scrape 读当前值，不是启动时的快照。
    counter.record('official', 'fallback');
    expect(series(await registry.render())).toEqual(
      expect.arrayContaining([{ source: 'official', outcome: 'fallback', value: 2 }]),
    );
    await f.stop();

    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.registries.at(-1)!.entry).toBe('worker');
    expect(f.registries.at(-1)!.collectTaobaoSearch).toBeUndefined();
  } finally {
    await f.stop();
  }
}, 30_000);
