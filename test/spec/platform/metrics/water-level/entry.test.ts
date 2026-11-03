// B2-09j: with config.metrics set, the worker's served /metrics registry exports
// couli_payout_water_low, read at scrape time over the worker's own database handle through payout's
// read-only port, with the worker's clock; the other four entries do not. If that read fails, the
// whole scrape fails (no 0 is exported in its place). The worker's collection is cached 5 minutes and
// a failure is not. The registry is the real createMetricsRegistry (only the listener is a stand-in),
// so the wiring itself is checked, whichever collector option carries it: a forgotten assembly would
// otherwise leave the alert silent. The stand-ins follow B2-05o's and B1-01zzo's entry tests: the
// platform exports are spied on the platform surface and on platform/metrics, the database compiles
// and logs every query but never connects (B1-01zzi's recordingDb), nothing listens, and the worker
// clock is the system clock of the test config, moved here by fake Date only. Dynamic imports keep
// Nest decorators out of the spec project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { MetricsServerOptions } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import { ROOT, families } from '../kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  NOW_MS,
  TTL_MS,
  WATER_LOW_METRIC,
  W_30000,
  W_31500,
  isForecastRead,
  isWaterLowRead,
  isWatermarkRead,
  mentionsWaterLow,
  waterLowGauge,
  waterRow,
} from './water-harness.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };
const APP = 'water_entry';

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

/** B1-01zzp's auto-payout reads: the cap's config rows and today's auto-reviewed withdrawals. */
function isAutoPayoutRead(query: string): boolean {
  return (
    mentions(query, 'config_items') ||
    (mentions(query, 'withdrawals') && /\breviewed_at\b/.test(query))
  );
}

/**
 * The stand-in's answer during a scrape: one app with W as given and the ¥49,000 of BR-WDR-18's
 * example for the reads behind the gauge; no rows for the auto-payout reads and for anything that
 * reads no fund table; one '0' row for each other fund read, as in B2-05o's entry test.
 */
function scrapeRows(availableFen: bigint) {
  return (query: string): readonly Record<string, unknown>[] => {
    if (isWaterLowRead(query)) return [waterRow(APP, availableFen, EXAMPLE_TOTAL_FEN)];
    if (isAutoPayoutRead(query)) return [];
    const read = FUND_TABLES.filter((table) => mentions(query, table));
    if (read.length === 0) return [];
    if (read[0] === 'order_sync_pending') return [numericRow('0', { reason: 'UNMAPPED_STATUS' })];
    return [numericRow('0')];
  };
}

async function fixture() {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  const base = platform.loadConfig({ APP_ENV: 'test' });
  // No CLOCK_NOW: the worker clock is the system clock, which reads the faked Date below.
  const config = { ...base, metrics: METRICS_CONFIG, clockNow: undefined } as ReturnType<
    typeof platform.loadConfig
  >;
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
  const queries: string[] = [];
  // No rows during startup (as in B1-01zzh's and B1-01zzi's tests); `scrape` while scraping.
  const answer: { scrape: ((query: string) => readonly Record<string, unknown>[]) | null } = {
    scrape: null,
  };
  const db = recordingDb(queries, (query) => (answer.scrape === null ? [] : answer.scrape(query)));
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: async () => undefined,
  });
  const queue = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
  const app = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
  };
  vi.spyOn(boot, 'createHttpApp').mockResolvedValue(app);
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue(app);
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => parts.queue.stop() };
  });

  // Only the listener is replaced; the registry handed to it is the real one.
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
  // Date is faked too: the worker's system clock reads it, and only this test moves it.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'Date',
    ],
  });
  vi.setSystemTime(NOW_MS);
  return {
    runEntry,
    servers,
    queries,
    answer,
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B2-09j#19] worker 的 /metrics 在 scrape 时经本入口库读 W 与 P、导出 couli_payout_water_low（gauge、app_id 标签、值为端口结论）、不写、不读数据库时钟；其余四个入口没有该指标、不做该读', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const registry = f.servers.at(-1)!.options.registry;

      f.queries.length = 0;
      f.answer.scrape = scrapeRows(W_30000);
      const text = await registry.render();
      f.answer.scrape = null;

      if (entry === 'worker') {
        expect(families(text).get(WATER_LOW_METRIC), `worker: # TYPE of ${WATER_LOW_METRIC}`).toBe(
          'gauge',
        );
        expect(waterLowGauge(text), 'worker: the port conclusion').toEqual({ [APP]: 1 });
        expect(f.queries.some(isWatermarkRead), 'the scrape reads W').toBe(true);
        expect(f.queries.some(isForecastRead), 'the scrape reads P').toBe(true);
        expect(f.queries.filter((q) => WRITE_SQL.test(q))).toEqual([]);
        expect(f.queries.filter((q) => SQL_CLOCK.test(q))).toEqual([]);
      } else {
        expect(mentionsWaterLow(text), entry).toBe(false);
        expect(f.queries.filter(isWaterLowRead), entry).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B2-09j#20] worker 的水位读失败时整次 scrape 失败（render 拒绝），不以 0 代替；读恢复后下一次 scrape 导出端口结论', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.servers, 'worker: metrics servers started').toHaveLength(1);
    const registry = f.servers.at(-1)!.options.registry;

    // The failure first: a failed read is never served from a cache afterwards.
    const message = 'stand-in: water level read unavailable';
    const healthy = scrapeRows(W_31500);
    f.queries.length = 0;
    f.answer.scrape = (query) => {
      if (isWaterLowRead(query)) throw new Error(message);
      return healthy(query);
    };
    await expect(registry.render(), 'the scrape fails').rejects.toThrow(message);
    expect(f.queries.some(isWaterLowRead), 'the failing scrape tried the read').toBe(true);

    f.answer.scrape = healthy;
    const text = await registry.render();
    f.answer.scrape = null;
    expect(waterLowGauge(text), 'after recovery').toEqual({ [APP]: 0 });
  } finally {
    f.answer.scrape = null;
    await f.stop();
  }
}, 30_000);

it('[AC-B2-09j#21] worker 装配走 5 分钟缓存：5 分钟内不再读、值不变，满 5 分钟重读并跟随新结论；过期后读失败整次 scrape 失败，旧值不回来', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    const registry = f.servers.at(-1)!.options.registry;

    f.answer.scrape = scrapeRows(W_30000);
    expect(waterLowGauge(await registry.render()), 'first scrape').toEqual({ [APP]: 1 });

    // W was entered again and is no longer low; within 5 minutes the scrape does not read it.
    f.answer.scrape = scrapeRows(W_31500);
    vi.setSystemTime(NOW_MS + TTL_MS - 1);
    f.queries.length = 0;
    expect(waterLowGauge(await registry.render()), 'within 5 minutes').toEqual({ [APP]: 1 });
    expect(f.queries.filter(isWaterLowRead), 'no read within 5 minutes').toEqual([]);

    vi.setSystemTime(NOW_MS + TTL_MS);
    f.queries.length = 0;
    expect(waterLowGauge(await registry.render()), 'after 5 minutes').toEqual({ [APP]: 0 });
    expect(f.queries.some(isWaterLowRead), 'read again after 5 minutes').toBe(true);

    const message = 'stand-in: water level read unavailable';
    const healthy = scrapeRows(W_30000);
    f.answer.scrape = (query) => {
      if (isWaterLowRead(query)) throw new Error(message);
      return healthy(query);
    };
    vi.setSystemTime(NOW_MS + 2 * TTL_MS);
    await expect(registry.render(), 'expired and the read fails').rejects.toThrow(message);

    f.answer.scrape = healthy;
    expect(waterLowGauge(await registry.render()), 'read again at once').toEqual({ [APP]: 1 });
  } finally {
    f.answer.scrape = null;
    await f.stop();
  }
}, 30_000);
