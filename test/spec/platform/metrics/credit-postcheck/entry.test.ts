// B2-02v: with config.metrics set, the worker's served /metrics registry exports
// couli_credit_postcheck_mismatch_open, read at scrape time through ledger's read-only port
// readCreditPostcheckOpen over the worker's own database handle; the other four entries do not. If
// that read fails, the whole scrape fails (no 0 is exported in its place). The worker's collection
// is cached 30 seconds and a failure is not. The registry is the real createMetricsRegistry (only the
// listener is a stand-in), so the wiring itself is checked. The port is spied on ledger's index.ts
// (the only surface the worker may import it from), so its answer is the test's; the port itself is
// checked in port.int.test.ts. The other stand-ins follow B2-09ze's entry test: the database compiles
// and logs every query but never connects, nothing listens, and the worker clock is the system clock
// of the test config, moved here by fake Date only. Dynamic imports keep Nest decorators out of the
// spec project's TypeScript compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as ledgerIndex from '../../../../../apps/api/src/modules/ledger/index.ts';
import type { CreditPostcheckOpen } from '../../../../../apps/api/src/modules/ledger/index.ts';
import * as payoutIndex from '../../../../../apps/api/src/modules/payout/index.ts';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import * as metrics from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import type { MetricsServerOptions } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { FUND_TABLES, mentions, numericRow, recordingDb } from '../../fund-metrics/kit.ts';
import { ROOT, families } from '../kit.ts';
import {
  EXAMPLE_TOTAL_FEN,
  NOW_MS,
  W_30000,
  isWaterLowRead,
  waterRow,
} from '../water-level/water-harness.ts';
import {
  CREDIT_POSTCHECK_METRIC,
  TTL_MS,
  creditPostcheckGauge,
  mentionsCreditPostcheck,
} from './postcheck-harness.ts';

type Entry = 'api' | 'stream' | 'admin' | 'worker' | 'payout';
const ENTRIES: readonly Entry[] = ['api', 'stream', 'admin', 'worker', 'payout'];
const METRICS_CONFIG = { host: '10.0.3.7', port: 9464 };
const APP = 'postcheck_entry';
const APP_OTHER = 'postcheck_entry_other';

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

/** The stand-in's answer during a scrape for the other collectors, as in B2-09ze's entry test. */
function scrapeRows(query: string): readonly Record<string, unknown>[] {
  if (isWaterLowRead(query)) return [waterRow(APP, W_30000, EXAMPLE_TOTAL_FEN)];
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
  // No rows during startup; scrapeRows while scraping.
  const answer = { scraping: false };
  const db = recordingDb(queries, (query) => (answer.scraping ? scrapeRows(query) : []));
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

  // payout's stale W port is not this test's: it answers nothing.
  vi.spyOn(payoutIndex, 'readPayoutWaterStale').mockResolvedValue({ waterStale: {} });

  // ledger's port: records who called it, and answers what the test sets.
  const calls: unknown[] = [];
  const port: { answer: () => Promise<CreditPostcheckOpen> } = {
    answer: async () => ({ open: { [APP]: 2, [APP_OTHER]: 1 } }),
  };
  vi.spyOn(ledgerIndex, 'readCreditPostcheckOpen').mockImplementation(async (handle) => {
    calls.push(handle);
    return port.answer();
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
    db,
    calls,
    port,
    /** One scrape of `registry` with the stand-in rows. */
    async scrape(registry: MetricsServerOptions['registry']): Promise<string> {
      answer.scraping = true;
      try {
        return await registry.render();
      } finally {
        answer.scraping = false;
      }
    },
    /** Delivers SIGTERM to the last started entry and lets its shutdown run. */
    async stop() {
      const handler = handlers.get('SIGTERM');
      handlers.clear();
      handler?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B2-02v#7] worker 的 /metrics 在 scrape 时经 ledger/index.ts 的 readCreditPostcheckOpen（本入口的库句柄）导出 couli_credit_postcheck_mismatch_open（gauge、app_id 标签、值为端口结论）；启动时不读；其余四个入口没有该指标、不调该端口', async () => {
  const f = await fixture();
  try {
    for (const entry of ENTRIES) {
      const before = f.servers.length;
      await f.runEntry(entry);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.servers.length - before, `${entry}: metrics servers started`).toBe(1);
      const registry = f.servers.at(-1)!.options.registry;
      expect(f.calls, `${entry}: not read at startup`).toEqual([]);

      const text = await f.scrape(registry);

      if (entry === 'worker') {
        expect(
          families(text).get(CREDIT_POSTCHECK_METRIC),
          `worker: # TYPE of ${CREDIT_POSTCHECK_METRIC}`,
        ).toBe('gauge');
        expect(creditPostcheckGauge(text), 'worker: the port conclusion').toEqual({
          [APP]: 2,
          [APP_OTHER]: 1,
        });
        expect(f.calls, 'worker: one port call per scrape').toHaveLength(1);
        expect(f.calls[0], "worker: the entry's own database handle").toBe(f.db);
        f.calls.length = 0;
      } else {
        expect(mentionsCreditPostcheck(text), entry).toBe(false);
        expect(f.calls, entry).toEqual([]);
      }
      await f.stop();
    }
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B2-02v#8] worker 的未结差错单读失败时整次 scrape 失败（render 拒绝），不以 0 代替；读恢复后下一次 scrape 导出端口结论（失败不进缓存）', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    expect(f.servers, 'worker: metrics servers started').toHaveLength(1);
    const registry = f.servers.at(-1)!.options.registry;

    const failure = new Error('stand-in: open diffs read unavailable');
    f.port.answer = async () => {
      throw failure;
    };
    await expect(f.scrape(registry), 'the scrape fails').rejects.toThrow(failure.message);
    expect(f.calls.length, 'the failing scrape called the port').toBeGreaterThan(0);

    f.port.answer = async () => ({ open: { [APP]: 1 } });
    expect(creditPostcheckGauge(await f.scrape(registry)), 'after recovery').toEqual({ [APP]: 1 });
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B2-02v#9] worker 装配走 30 秒缓存（注入的时钟）：30 秒内不再读、值不变，满 30 秒重读并跟随新结论；过期后读失败整次 scrape 失败，旧值不回来', async () => {
  const f = await fixture();
  try {
    await f.runEntry('worker');
    expect(process.exitCode, 'worker failed to start').toBe(originalExitCode);
    const registry = f.servers.at(-1)!.options.registry;

    f.port.answer = async () => ({ open: { [APP]: 1 } });
    expect(creditPostcheckGauge(await f.scrape(registry)), 'first scrape').toEqual({ [APP]: 1 });
    expect(f.calls, 'first scrape reads').toHaveLength(1);

    // Another mismatch was registered; within 30 seconds the scrape does not read it.
    f.port.answer = async () => ({ open: { [APP]: 2 } });
    vi.setSystemTime(NOW_MS + TTL_MS - 1);
    expect(creditPostcheckGauge(await f.scrape(registry)), 'within 30 seconds').toEqual({
      [APP]: 1,
    });
    expect(f.calls, 'no read within 30 seconds').toHaveLength(1);

    vi.setSystemTime(NOW_MS + TTL_MS);
    expect(creditPostcheckGauge(await f.scrape(registry)), 'after 30 seconds').toEqual({
      [APP]: 2,
    });
    expect(f.calls, 'read again after 30 seconds').toHaveLength(2);

    const failure = new Error('stand-in: open diffs read unavailable');
    f.port.answer = async () => {
      throw failure;
    };
    vi.setSystemTime(NOW_MS + 2 * TTL_MS);
    await expect(f.scrape(registry), 'expired and the read fails').rejects.toThrow(failure.message);

    f.port.answer = async () => ({ open: { [APP]: 1 } });
    expect(creditPostcheckGauge(await f.scrape(registry)), 'read again at once').toEqual({
      [APP]: 1,
    });
  } finally {
    await f.stop();
  }
}, 30_000);
