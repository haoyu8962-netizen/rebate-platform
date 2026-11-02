import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FixedClock, type RootLogger } from '../platform/index.ts';
import {
  LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS,
  LEDGER_ASSET_SNAPSHOT_TICK_MS,
  assetSnapshotTimer,
} from './asset-snapshot.module.ts';

function deps(listApps: () => Promise<readonly string[]>) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  return {
    logger,
    active: {
      db: {} as Kysely<DB>,
      clock: new FixedClock('2032-06-15T16:01:00.000Z'),
      logger: logger as unknown as RootLogger,
      runner: { run: vi.fn() },
      runs: {
        listApps,
        snapshotWindow: vi.fn(),
        timedOutDays: vi.fn(),
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('[AC-B2-04zo#u20] 首次延迟 15 秒，之后每 60 秒', async () => {
  const listApps = vi.fn(() => Promise.resolve<readonly string[]>([]));
  const timer = assetSnapshotTimer(deps(listApps).active);
  timer.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS - 1);
  expect(listApps).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(listApps).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(LEDGER_ASSET_SNAPSHOT_TICK_MS);
  expect(listApps).toHaveBeenCalledTimes(2);
  await timer.onModuleDestroy();
  await vi.advanceTimersByTimeAsync(3 * LEDGER_ASSET_SNAPSHOT_TICK_MS);
  expect(listApps).toHaveBeenCalledTimes(2);
});

it('[AC-B2-04zo#u21] 慢 tick 不重入；销毁等它结束', async () => {
  const slow = Promise.withResolvers<readonly string[]>();
  const listApps = vi.fn(() => slow.promise);
  const timer = assetSnapshotTimer(deps(listApps).active);
  timer.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(
    LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS + 2 * LEDGER_ASSET_SNAPSHOT_TICK_MS,
  );
  expect(listApps).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stopping = timer.onModuleDestroy().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  slow.resolve([]);
  await stopping;
  expect(stopped).toBe(true);
});

it('[AC-B2-04zo#u22] tick 整体失败：记一条 warn，下一次 tick 照常', async () => {
  const listApps = vi
    .fn<() => Promise<readonly string[]>>()
    .mockRejectedValueOnce(new Error('synthetic'))
    .mockResolvedValue([]);
  const { active, logger } = deps(listApps);
  const timer = assetSnapshotTimer(active);
  timer.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(LEDGER_ASSET_SNAPSHOT_FIRST_TICK_MS);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn.mock.calls[0]?.[1]).toBe('ledger_asset_snapshot_tick_failed');
  await vi.advanceTimersByTimeAsync(LEDGER_ASSET_SNAPSHOT_TICK_MS);
  expect(listApps).toHaveBeenCalledTimes(2);
  await timer.onModuleDestroy();
});

it('[AC-B2-04zo#u23] 惰性：没有依赖时 bootstrap 不排定时器，销毁不报错', async () => {
  const timer = assetSnapshotTimer(null);
  timer.onApplicationBootstrap();
  expect(vi.getTimerCount()).toBe(0);
  await expect(timer.onModuleDestroy()).resolves.toBeUndefined();
});
