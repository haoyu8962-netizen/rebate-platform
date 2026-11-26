import { afterEach, expect, it, vi } from 'vitest';
import * as ledger from '../../../../../apps/api/src/modules/ledger/index.ts';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import type { MetricsServerOptions } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import * as settlement from '../../../../../apps/api/src/modules/settlement/index.ts';
import { FUND_TABLES, mentions, numericRow, recordingDb } from '../../fund-metrics/kit.ts';
import { ROOT } from '../kit.ts';
import {
  BILL_GENERATED,
  BILL_MISMATCH,
  CHANNEL_OPEN,
  TTL_MS,
  appValues,
  movingClock,
} from './kit.ts';

const FIRST = {
  open: { entry_app: 2 },
  bills: { entry_app: { amountMismatch: 5, generatedAtSeconds: 1_767_225_600 } },
};
const NEXT = {
  open: { entry_app: 1 },
  bills: { entry_app: { amountMismatch: 0, generatedAtSeconds: 1_767_225_601 } },
};

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

function expectScrape(text: string, snapshot: typeof FIRST): void {
  expect(appValues(text, CHANNEL_OPEN)).toEqual(snapshot.open);
  expect(appValues(text, BILL_MISMATCH)).toEqual({
    entry_app: snapshot.bills.entry_app.amountMismatch,
  });
  expect(appValues(text, BILL_GENERATED)).toEqual({
    entry_app: snapshot.bills.entry_app.generatedAtSeconds,
  });
}

async function fixture() {
  // Keep the real worker assembly and registry. Replace bootstrap, the database and the listener.
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createWorkerContext(...args: unknown[]): Promise<unknown>;
  };
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: 'worker'): Promise<void>;
  };
  const config = platform.loadConfig({ APP_ENV: 'test' });
  vi.spyOn(platform, 'loadConfig').mockReturnValue({
    ...config,
    metrics: { host: '127.0.0.1', port: 9464 },
  });
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
  const clock = movingClock();
  vi.spyOn(platform, 'clockFromConfig').mockReturnValue(clock);
  const db = recordingDb([], (query) => {
    if (mentions(query, 'order_sync_pending')) {
      return [numericRow('0', { reason: 'UNMAPPED_STATUS' })];
    }
    if (mentions(query, 'withdrawals') && /\breviewed_at\b/.test(query)) return [];
    return FUND_TABLES.some((table) => mentions(query, table)) ? [numericRow('0')] : [];
  });
  vi.spyOn(platform, 'createDbHandles').mockReturnValue({
    db,
    dbRead: null,
    close: async () => undefined,
  });
  const queue = { start: async () => undefined, stop: async () => undefined };
  vi.spyOn(boot, 'createWorkerContext').mockResolvedValue({
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
    close: async () => undefined,
  });
  vi.spyOn(platform, 'startWorkerServices').mockImplementation(async (parts) => {
    await parts.queue.start();
    return { stop: async () => parts.queue.stop() };
  });

  const channel = vi
    .spyOn(ledger, 'readChannelMismatchOpen')
    .mockResolvedValue({ open: FIRST.open });
  const bill = vi
    .spyOn(settlement, 'readSettleBillMismatch')
    .mockResolvedValue({ bills: FIRST.bills });
  const startServer = vi
    .spyOn(platform, 'startMetricsServer')
    .mockImplementation(async ({ port }) => ({
      port,
      close: async () => undefined,
    }));

  const handlers = new Map<string, (...args: unknown[]) => void>();
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, listener);
      return process;
    }
    return originalOn(event, listener);
  });
  // Advance the injected clock separately from timers so wall-clock caching fails the test.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
    ],
  });
  return {
    channel,
    bill,
    clock,
    db,
    async start(): Promise<MetricsServerOptions['registry']> {
      await runEntry('worker');
      expect(process.exitCode, 'worker startup').toBe(originalExitCode);
      expect(startServer).toHaveBeenCalledTimes(1);
      return startServer.mock.calls[0]![0].registry;
    },
    async stop() {
      handlers.get('SIGTERM')?.('SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

it('[AC-B2-09zn#19] worker 抓取时经两个模块的公开读口使用入口数据库句柄，导出三个指标并用注入时钟缓存 30 秒', async () => {
  const f = await fixture();
  try {
    const registry = await f.start();
    expect(f.channel).not.toHaveBeenCalled();
    expect(f.bill).not.toHaveBeenCalled();

    expectScrape(await registry.render(), FIRST);
    expect(f.channel).toHaveBeenCalledTimes(1);
    expect(f.bill).toHaveBeenCalledTimes(1);
    expect(f.channel.mock.calls[0]?.[0]).toBe(f.db);
    expect(f.bill.mock.calls[0]?.[0]).toBe(f.db);

    f.channel.mockResolvedValue({ open: NEXT.open });
    f.bill.mockResolvedValue({ bills: NEXT.bills });
    f.clock.setElapsed(TTL_MS - 1);
    expectScrape(await registry.render(), FIRST);
    expect(f.channel).toHaveBeenCalledTimes(1);
    expect(f.bill).toHaveBeenCalledTimes(1);

    f.clock.setElapsed(TTL_MS);
    expectScrape(await registry.render(), NEXT);
    expect(f.channel).toHaveBeenCalledTimes(2);
    expect(f.bill).toHaveBeenCalledTimes(2);
    expect(f.channel.mock.calls[1]?.[0]).toBe(f.db);
    expect(f.bill.mock.calls[1]?.[0]).toBe(f.db);
  } finally {
    await f.stop();
  }
}, 30_000);

it('[AC-B2-09zn#20] 任一读口失败都使 worker 整次抓取拒绝，恢复后无需推进时钟即可重读', async () => {
  const f = await fixture();
  try {
    const registry = await f.start();
    const channelError = new Error('channel read failed');
    f.channel.mockRejectedValueOnce(channelError);
    await expect(registry.render()).rejects.toBe(channelError);
    expectScrape(await registry.render(), FIRST);
    expect(f.channel).toHaveBeenCalledTimes(2);

    f.clock.setElapsed(TTL_MS);
    const billError = new Error('bill read failed');
    f.bill.mockRejectedValueOnce(billError);
    await expect(registry.render()).rejects.toBe(billError);
    expectScrape(await registry.render(), FIRST);
    expect(f.bill).toHaveBeenCalledTimes(3);
  } finally {
    await f.stop();
  }
}, 30_000);
