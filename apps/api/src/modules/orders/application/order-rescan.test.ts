import { expect, it, vi } from 'vitest';
import { FixedClock, type JobQueue } from '../../platform/index.ts';
import { scheduleOrderRescan, type OrderRescanSchedulerDeps } from './order-rescan.ts';
import type { OrderRescanWindow, RescanCursorStore } from './sync-ports.ts';

const NOW = '2026-10-17T02:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const iso = (ms: number): string => new Date(ms).toISOString();

function harness(
  rescanCursor: string,
  incrementCursor: string,
  orderSources?: OrderRescanSchedulerDeps['orderSources'],
) {
  let cursor = rescanCursor;
  const clock = new FixedClock(NOW);
  const send = vi.fn<JobQueue['send']>().mockResolvedValue('queued');
  const read = vi.fn<RescanCursorStore['read']>(async (stream) =>
    stream.query_kind === 'increment' ? incrementCursor : cursor,
  );
  const advance = vi.fn<RescanCursorStore['advance']>(async () => true);
  const rewind = vi.fn<RescanCursorStore['rewind']>(async (_stream, _expected, to) => {
    cursor = to;
    return true;
  });
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const get = vi.fn(async () => undefined);
  const deps: OrderRescanSchedulerDeps = {
    clock,
    logger: { info, warn, error } as never,
    ...(orderSources === undefined ? {} : { orderSources }),
    queue: { send },
    cursors: { read, advance, rewind },
    config: { get },
    capsMs: { jd: HOUR_MS },
    access: {
      listEnabledAccounts: async () => [
        {
          app_id: 'rescan-unit',
          platform: 'jd',
          union_account_id: ACCOUNT,
          sync_start_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      siteAuthAvailable: async () => true,
      offlineCircuitOpen: async () => false,
    },
  };
  return { clock, deps, send, read, advance, rewind, info, warn, error, get };
}

it('[AC-B1-04zm] 回到轮首后首窗放不进 increment 游标之前：游标非空时也不发', async () => {
  const roundStartMs = NOW_MS - 30 * DAY_MS + HOUR_MS;
  // The rescan cursor is set and past the ceiling; the ceiling leaves 30 minutes of the round.
  const ceiling = iso(roundStartMs + HOUR_MS / 2);
  const f = harness(iso(NOW_MS - 2 * DAY_MS), ceiling);
  await scheduleOrderRescan(f.deps, ['jd']);
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.rewind.mock.calls[0]?.[2]).toBe(iso(roundStartMs));
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-04zm] 回到轮首后的下一窗终点在 min(now, increment 游标) 之内', async () => {
  const ceilingMs = NOW_MS - 3 * HOUR_MS;
  const f = harness(iso(ceilingMs + 1), iso(ceilingMs));
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.send).not.toHaveBeenCalled();
  await scheduleOrderRescan(f.deps, ['jd']);
  const win = f.send.mock.calls[0]?.[2] as OrderRescanWindow;
  expect(Date.parse(win.window_end)).toBeLessThanOrEqual(ceilingMs);
});

it('[AC-B1-04zm] 调度只移动 rescan 流的游标', async () => {
  const f = harness(iso(NOW_MS - 45 * DAY_MS), NOW);
  await scheduleOrderRescan(f.deps, ['jd']);
  expect(f.rewind.mock.calls.map(([stream]) => stream.query_kind)).toEqual(['rescan']);
  expect(f.advance).not.toHaveBeenCalled();
});

it('[AC-B1-04zzb#r1] 回扫调度门：平台无订单源时本轮不投窗、不读不动游标、不报错，只一条 info', async () => {
  const gate = vi.fn(() => false);
  const f = harness(iso(NOW_MS - 45 * DAY_MS), NOW, gate);
  await expect(scheduleOrderRescan(f.deps, ['jd'])).resolves.toBeUndefined();
  expect(gate).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.warn).not.toHaveBeenCalled();
  expect(f.error).not.toHaveBeenCalled();
  expect(f.info.mock.calls).toEqual([
    [{ platform: 'jd' }, 'order_sync_rescan_skipped_no_order_source'],
  ]);
});

it('[AC-B1-04zzb#r2] 回扫调度门：有订单源时与不设门时一样移动游标、投同一窗', async () => {
  const gated = harness(iso(NOW_MS - 2 * DAY_MS), NOW, () => true);
  const plain = harness(iso(NOW_MS - 2 * DAY_MS), NOW);
  await scheduleOrderRescan(gated.deps, ['jd']);
  await scheduleOrderRescan(plain.deps, ['jd']);
  expect(gated.send).toHaveBeenCalledTimes(1);
  expect(gated.send.mock.calls).toEqual(plain.send.mock.calls);
  expect(gated.rewind.mock.calls).toEqual(plain.rewind.mock.calls);
  expect(gated.info.mock.calls).toEqual(plain.info.mock.calls);
});
