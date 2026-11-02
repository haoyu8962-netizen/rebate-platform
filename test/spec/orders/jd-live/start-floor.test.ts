// B1-04zt ② (specs/union/jd.md: from ≥ 当前时刻 − 90 天): an increment start older than what jd can
// still answer is moved up to the floor, now − 90 days + 1 hour, the same margin as the rescan. A
// start at most 30 minutes behind the floor stays where it is (the rescan's tolerance): the floor
// slides with now, so without it a slow window would be rewound on every tick (the defect B1-04zs
// fixed in the rescan). The cursor row is written before the window is sent, also when there was
// none, so the next tick already starts inside the tolerance. The literals are deliberate: the
// task's constants do not exist before the implementation. The cursor store here keeps one value
// per platform and behaves like infra/sync-cursors.ts: both moves are compare-and-set, and rewind
// with expected null inserts a missing row and leaves an existing one alone.
import { expect, it, vi } from 'vitest';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import type {
  OrderSyncWindow,
  SyncAccount,
  SyncSchedulerDeps,
  SyncStream,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import {
  handleOrderSyncWindow,
  type OrderSyncHandlerDeps,
} from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { capture } from '../attribution/kit.ts';
import { productionPorts, storedDb, workerOf } from '../jd-sync/kit.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, NOW_MS, iso, logged } from '../rescan/kit.ts';
import { ACCOUNT, account, fixture, job } from '../sync/kit.ts';

const FLOOR_MS = NOW_MS - 90 * DAY_MS + HOUR_MS;
const TOLERANCE_MS = 30 * MINUTE_MS;
/** The oldest start left alone. */
const TOLERATED_MS = FLOOR_MS - TOLERANCE_MS;
const CLAMPED = 'order_sync_start_clamped';
const PDD_ACCOUNT = '10000000-0000-4000-8000-000000000002';

const jdAccount: SyncAccount = { ...account, platform: 'jd' };
const pddAccount: SyncAccount = { ...account, union_account_id: PDD_ACCOUNT };
const jdStream: SyncStream = {
  app_id: account.app_id,
  platform: 'jd',
  union_account_id: ACCOUNT,
  query_kind: 'increment',
  scene: '-',
};

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

interface HarnessOptions {
  readonly accounts: readonly SyncAccount[];
  /** The stored cursor of each platform; a platform left out has no row. */
  readonly cursors?: Readonly<Record<string, string>>;
}

function harness(options: HarnessOptions) {
  const f = fixture();
  const stored = new Map(Object.entries(options.cursors ?? {}));
  f.listEnabledAccounts.mockResolvedValue(options.accounts);
  f.read.mockImplementation(async (stream) => stored.get(stream.platform) ?? null);
  f.advance.mockImplementation(async (win) => {
    const current = stored.get(win.platform);
    if (current !== undefined && !sameInstant(current, win.window_start)) return false;
    stored.set(win.platform, win.window_end);
    return true;
  });
  const rewind = vi.fn(
    async (stream: SyncStream, expected: string | null, to: string): Promise<boolean> => {
      const current = stored.get(stream.platform);
      const hit =
        expected === null
          ? current === undefined
          : current !== undefined && sameInstant(current, expected);
      if (!hit) return false;
      stored.set(stream.platform, to);
      return true;
    },
  );
  const cursors = { read: f.read, advance: f.advance, rewind };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const scheduler: SyncSchedulerDeps = { ...f.scheduler, cursors, logger };
  const handler: OrderSyncHandlerDeps = { ...f.handler, cursors, logger };
  return {
    ...f,
    rewind,
    logger,
    scheduler,
    handler,
    cursor: (platform: string) => stored.get(platform) ?? null,
    sent: () => f.send.mock.calls.map(([, , payload]) => payload as OrderSyncWindow),
    /** The jobs the queue holds: a send under a singleton key it already has adds nothing. */
    windows: () => {
      const jobs = new Map<string | undefined, OrderSyncWindow>();
      for (const [, , payload, options] of f.send.mock.calls) {
        const key = options.singletonKey;
        if (!jobs.has(key)) jobs.set(key, payload as OrderSyncWindow);
      }
      return [...jobs.values()];
    },
  };
}

const VIA = ['水位', 'sync_start_at'] as const;

/** One jd account whose start is `startMs`, read from the cursor or from sync_start_at. */
function startingAt(via: (typeof VIA)[number], startMs: number) {
  return via === '水位'
    ? harness({ accounts: [jdAccount], cursors: { jd: iso(startMs) } })
    : harness({ accounts: [{ ...jdAccount, sync_start_at: iso(startMs) }] });
}

/** The rewind's `expected` for such a start: the row it holds, or null for no row. */
const expectedFor = (via: (typeof VIA)[number], startMs: number): string | null =>
  via === '水位' ? iso(startMs) : null;

const floorWindow = expect.objectContaining({
  window_start: iso(FLOOR_MS),
  window_end: iso(FLOOR_MS + HOUR_MS),
});

it('[AC-B1-04zt#9] sync_start_at 早于上限、无水位：先写入水位行 = 上限再发窗，窗口从收到点起、长 60 分钟，真实 jdOrderWindow 放行，warn 一条', async () => {
  const h = startingAt('sync_start_at', FLOOR_MS - 30 * DAY_MS);
  await scheduleOrderSync(h.scheduler);
  expect(h.sent()).toEqual([
    expect.objectContaining({
      platform: 'jd',
      union_account_id: ACCOUNT,
      window_start: iso(FLOOR_MS),
      window_end: iso(FLOOR_MS + HOUR_MS),
    }),
  ]);
  expect(h.rewind).toHaveBeenCalledExactlyOnceWith(jdStream, null, iso(FLOOR_MS));
  expect(h.rewind.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]!);
  expect(h.cursor('jd')).toBe(iso(FLOOR_MS));
  const range = { from: h.sent()[0]!.window_start, to: h.sent()[0]!.window_end };
  expect(() => jdOrderWindow(range, h.clock.now())).not.toThrow();
  // The job runs after it was sent: the one-hour margin covers the wait.
  expect(() => jdOrderWindow(range, new Date(NOW_MS + 59 * MINUTE_MS))).not.toThrow();
  expect(logged(h.logger.warn, CLAMPED)).toEqual([
    expect.objectContaining({ platform: 'jd', account: ACCOUNT }),
  ]);
});

it('[AC-B1-04zt#10] 水位早于上限：先 rewind 恰一次再发窗，任务完成时 CAS 命中，水位前进一窗', async () => {
  const old = iso(FLOOR_MS - 7 * DAY_MS);
  const h = harness({ accounts: [jdAccount], cursors: { jd: old } });
  await scheduleOrderSync(h.scheduler);
  expect(h.rewind).toHaveBeenCalledExactlyOnceWith(jdStream, old, iso(FLOOR_MS));
  expect(h.rewind.mock.invocationCallOrder[0]).toBeLessThan(h.send.mock.invocationCallOrder[0]!);
  expect(h.sent()).toEqual([floorWindow]);
  const win = h.sent()[0]!;
  h.listOrders.mockImplementation(async (range) => {
    jdOrderWindow(range, h.clock.now());
    return { items: [], nextCursor: null };
  });
  const result = await capture(() => handleOrderSyncWindow(job(win), h.handler));
  expect(result).toMatchObject({ ok: true });
  await expect(h.advance.mock.results[0]?.value).resolves.toBe(true);
  expect(h.cursor('jd')).toBe(win.window_end);
});

it('[AC-B1-04zt#10] 生产装配给增量调度的水位存储能 rewind：对 sync_cursors 做 UPDATE', async () => {
  const ports = await productionPorts();
  const { db, queries } = storedDb();
  const { runtime } = workerOf(ports, db);
  // Optional on the port, so a fake without it still compiles: this reads what the worker holds.
  const cursors = runtime.cursors as unknown as {
    rewind?: (stream: SyncStream, expected: string | null, to: string) => Promise<boolean>;
  };
  expect(cursors.rewind).toBeTypeOf('function');
  await cursors.rewind?.(jdStream, iso(FLOOR_MS - DAY_MS), iso(FLOOR_MS));
  expect(queries.some((sql) => /^update\b.*sync_cursors/i.test(sql))).toBe(true);
});

it.each(VIA)('[AC-B1-04zt#11] %s过旧、rewind 的 CAS 失败：本轮不发窗，水位不动', async (via) => {
  const h = startingAt(via, FLOOR_MS - DAY_MS);
  const before = h.cursor('jd');
  h.rewind.mockResolvedValue(false);
  await scheduleOrderSync(h.scheduler);
  expect(h.rewind).toHaveBeenCalledTimes(1);
  expect(h.send).not.toHaveBeenCalled();
  expect(h.cursor('jd')).toBe(before);
});

it.each(VIA)(
  '[AC-B1-04zt#12] %s恰早于上限 30 分钟及更晚：不动不 warn；早 30 分钟零 1 毫秒才收到上限',
  async (via) => {
    for (const startMs of [TOLERATED_MS, TOLERATED_MS + 1, FLOOR_MS, FLOOR_MS + 1]) {
      const kept = startingAt(via, startMs);
      await scheduleOrderSync(kept.scheduler);
      expect(kept.sent(), `起点 ${iso(startMs)}`).toEqual([
        expect.objectContaining({
          window_start: iso(startMs),
          window_end: iso(startMs + HOUR_MS),
        }),
      ]);
      expect(kept.rewind).not.toHaveBeenCalled();
      expect(logged(kept.logger.warn, CLAMPED)).toEqual([]);
    }
    const movedMs = TOLERATED_MS - 1;
    const moved = startingAt(via, movedMs);
    await scheduleOrderSync(moved.scheduler);
    expect(moved.sent()).toEqual([floorWindow]);
    expect(moved.rewind).toHaveBeenCalledExactlyOnceWith(
      jdStream,
      expectedFor(via, movedMs),
      iso(FLOOR_MS),
    );
    expect(logged(moved.logger.warn, CLAMPED)).toHaveLength(1);
  },
);

it('[AC-B1-04zt#12] 容差内的起点离真实 90 天界还有 30 分钟：等到 29 分钟后执行，真实 jdOrderWindow 仍放行', async () => {
  const h = startingAt('水位', TOLERATED_MS);
  await scheduleOrderSync(h.scheduler);
  expect(h.rewind).not.toHaveBeenCalled();
  expect(logged(h.logger.warn, CLAMPED)).toEqual([]);
  const range = { from: h.sent()[0]!.window_start, to: h.sent()[0]!.window_end };
  expect(() => jdOrderWindow(range, new Date(NOW_MS + 29 * MINUTE_MS))).not.toThrow();
  const moved = startingAt('水位', TOLERATED_MS - 1);
  await scheduleOrderSync(moved.scheduler);
  expect(moved.rewind).toHaveBeenCalledTimes(1);
});

it.each(VIA)(
  '[AC-B1-04zt#13] 同一轮里 pdd 的%s早于 90 天不收，窗口照旧、不 rewind、不 warn；jd 照收',
  async (via) => {
    const old = iso(FLOOR_MS - 30 * DAY_MS);
    const h = harness({
      accounts: [jdAccount, via === '水位' ? pddAccount : { ...pddAccount, sync_start_at: old }],
      cursors: via === '水位' ? { jd: old, pdd: old } : { jd: old },
    });
    await scheduleOrderSync(h.scheduler);
    const oldMs = Date.parse(old);
    expect(h.sent().map((win) => [win.platform, win.window_start, win.window_end])).toEqual([
      ['jd', iso(FLOOR_MS), iso(FLOOR_MS + HOUR_MS)],
      ['pdd', iso(oldMs), iso(oldMs + 30 * MINUTE_MS)],
    ]);
    expect(h.rewind).toHaveBeenCalledExactlyOnceWith(jdStream, old, iso(FLOOR_MS));
    expect(logged(h.logger.warn, CLAMPED)).toEqual([
      expect.objectContaining({ platform: 'jd', account: ACCOUNT }),
    ]);
  },
);

it('[AC-B1-04zt#14] sync_start_at 过旧、无水位，连续 3 拍任务未完成：只有一窗、只写一次水位、一条 warn；任务完成时 CAS 命中', async () => {
  const h = startingAt('sync_start_at', FLOOR_MS - 30 * DAY_MS);
  for (let tick = 0; tick < 3; tick += 1) {
    await scheduleOrderSync(h.scheduler);
    h.clock.advanceMs(MINUTE_MS);
  }
  expect(h.windows()).toEqual([floorWindow]);
  expect(h.rewind).toHaveBeenCalledExactlyOnceWith(jdStream, null, iso(FLOOR_MS));
  expect(logged(h.logger.warn, CLAMPED)).toHaveLength(1);
  const win = h.windows()[0]!;
  h.listOrders.mockImplementation(async (range) => {
    jdOrderWindow(range, h.clock.now());
    return { items: [], nextCursor: null };
  });
  const result = await capture(() => handleOrderSyncWindow(job(win), h.handler));
  expect(result).toMatchObject({ ok: true });
  await expect(h.advance.mock.results[0]?.value).resolves.toBe(true);
  expect(h.cursor('jd')).toBe(win.window_end);
});

it('[AC-B1-04zt#15] 慢窗：水位早于上限，收到上限发窗后任务跑 2 拍未完成，直到上限滑过恰 30 分钟：不再 rewind、无新窗、无新 warn', async () => {
  const old = iso(FLOOR_MS - 7 * DAY_MS);
  const h = harness({ accounts: [jdAccount], cursors: { jd: old } });
  await scheduleOrderSync(h.scheduler);
  h.clock.advanceMs(MINUTE_MS);
  await scheduleOrderSync(h.scheduler);
  h.clock.advanceMs(TOLERANCE_MS - MINUTE_MS);
  await scheduleOrderSync(h.scheduler);
  expect(h.rewind).toHaveBeenCalledExactlyOnceWith(jdStream, old, iso(FLOOR_MS));
  expect(h.windows()).toEqual([floorWindow]);
  expect(logged(h.logger.warn, CLAMPED)).toHaveLength(1);
  expect(h.cursor('jd')).toBe(iso(FLOOR_MS));
});
