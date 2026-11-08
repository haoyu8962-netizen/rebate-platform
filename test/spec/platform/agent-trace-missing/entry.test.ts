// B3-08z (编排 03:19 (a)): with config.metrics set, the worker's served /metrics registry exports
// couli_agent_trace_missing_runs, read at scrape time over the worker's own database handle through
// agent's read-only port (wired by entry.ts into createAgentTraceMissingCollector); the other four
// entries do not have it and never make that read. If the read fails the whole scrape fails (no 0
// in its place, the frozen registry semantics of B3-08za); once it works again the gauge is back.
// The registry is the real createMetricsRegistry (only the listener is a stand-in), so the wiring
// itself is checked. The stand-ins follow B2-09j's entry test: the platform exports are spied on the
// platform surface and on platform/metrics, the database compiles and logs every query but never
// connects (B1-01zzi's recordingDb), nothing listens, and the worker clock is the system clock of
// the test config, moved by fake Date only. Dynamic imports keep Nest decorators out of the spec
// project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { MetricsServerOptions } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../fund-metrics/kit.ts';
import { ROOT, expectProcessMetrics, families } from '../metrics/kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  W_30000,
  isWaterLowRead,
  waterRow,
} from '../metrics/water-level/water-harness.ts';
import { METRIC, NOW_MS, ROW_LOCK, mentionsMetric, missingGauge } from './kit.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };
const APP = 'trace_entry';
/** What the stand-in answers for the count column of the port's read. */
const MISSING = 2;

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

/** A read behind the gauge: agent_runs or agent_cards. */
function isTraceMissingRead(query: string): boolean {
  return mentions(query, 'agent_runs') || mentions(query, 'agent_cards');
}

/** B1-01zzp's auto-payout reads: the cap's config rows and today's auto-reviewed withdrawals. */
function isAutoPayoutRead(query: string): boolean {
  return (
    mentions(query, 'config_items') ||
    (mentions(query, 'withdrawals') && /\breviewed_at\b/.test(query))
  );
}

/**
 * The stand-in's answer during a scrape: for the port's read one row of app_id APP whose every
 * other column reads as MISSING (PostgreSQL's text of a count); the other worker gauges are
 * answered as in B2-09j's entry test.
 */
function scrapeRows(query: string): readonly Record<string, unknown>[] {
  if (isTraceMissingRead(query)) return [numericRow(String(MISSING), { app_id: APP })];
  if (isWaterLowRead(query)) return [waterRow('water_entry', W_30000, EXAMPLE_TOTAL_FEN)];
  if (isAutoPayoutRead(query)) return [];
  const read = FUND_TABLES.filter((table) => mentions(query, table));
  if (read.length === 0) return [];
  if (read[0] === 'order_sync_pending') return [numericRow('0', { reason: 'UNMAPPED_STATUS' })];
  return [numericRow('0')];
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
  // No rows during startup (as in B1-01zzh's and B2-09j's tests); `scrape` while scraping.
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

it('[AC-B3-08z#10] worker 的 /metrics 在 scrape 时经本入口库、经 agent 只读端口读 agent_runs / agent_cards，正常渲染 couli_agent_trace_missing_runs（gauge、只带 app_id、值为端口结果），其余指标照常、不写、不加行锁、不读库时钟；其余四个入口没有该指标、不做该读', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const registry = f.servers.at(-1)!.options.registry;

      f.queries.length = 0;
      f.answer.scrape = scrapeRows;
      const text = await registry.render();
      f.answer.scrape = null;

      if (entry === 'worker') {
        expect(families(text).get(METRIC), `worker: # TYPE of ${METRIC}`).toBe('gauge');
        expect(missingGauge(text), 'worker: the port result').toEqual({ [APP]: MISSING });
        const reads = f.queries.filter(isTraceMissingRead);
        expect(
          reads.some((q) => mentions(q, 'agent_runs')),
          'the scrape reads agent_runs',
        ).toBe(true);
        expect(
          reads.some((q) => mentions(q, 'agent_cards')),
          'the scrape reads agent_cards',
        ).toBe(true);
        expect(
          reads.filter((q) => ROW_LOCK.test(q)),
          'no row locks',
        ).toEqual([]);
        expect(
          f.queries.filter((q) => WRITE_SQL.test(q)),
          'no writes',
        ).toEqual([]);
        expect(
          f.queries.filter((q) => SQL_CLOCK.test(q)),
          'no database clock',
        ).toEqual([]);
        expectProcessMetrics(text);
      } else {
        expect(mentionsMetric(text), entry).toBe(false);
        expect(f.queries.filter(isTraceMissingRead), entry).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B3-08z#11] worker 上该端口读失败时整次 scrape 失败（render 拒绝），不以 0 代替、不只是少这一项；读恢复后下一次 scrape 导出端口结果', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.servers, 'worker: metrics servers started').toHaveLength(1);
    const registry = f.servers.at(-1)!.options.registry;

    // The failure first: a failed read is never served from a cache afterwards.
    const message = 'stand-in: agent trace read unavailable';
    f.queries.length = 0;
    f.answer.scrape = (query) => {
      if (isTraceMissingRead(query)) throw new Error(message);
      return scrapeRows(query);
    };
    await expect(registry.render(), 'the scrape fails').rejects.toThrow(message);
    expect(f.queries.some(isTraceMissingRead), 'the failing scrape tried the read').toBe(true);

    f.answer.scrape = scrapeRows;
    const text = await registry.render();
    f.answer.scrape = null;
    expect(missingGauge(text), 'after recovery').toEqual({ [APP]: MISSING });
    expectProcessMetrics(text);
  } finally {
    f.answer.scrape = null;
    await f.stop();
  }
}, 30_000);
