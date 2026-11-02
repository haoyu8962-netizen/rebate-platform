import { expect, it } from 'vitest';
import {
  manualSyncFilterDigest,
  manualSyncLimits,
  type ManualSyncFilter,
} from '../../../../apps/api/src/modules/orders/domain/manual-sync.ts';

const DAY = 86_400_000;
// 02 §7.1 table: the farthest look-back of each platform (taobao weekly 90 days, jd daily 30 days,
// pdd daily 90 days); 01 F-ORD-10: at most 50 order numbers.
const LOOK_BACK_DAYS = { taobao: 90, jd: 30, pdd: 90 } as const;
const window = (patch: Partial<Extract<ManualSyncFilter, { mode: 'window' }>> = {}) =>
  ({
    platform: 'pdd',
    mode: 'window',
    from: '2026-10-21T00:00:00+08:00',
    to: '2026-10-22T00:00:00+08:00',
    status_filter: null,
    ...patch,
  }) satisfies ManualSyncFilter;
const orderNos = (orderNumbers: readonly string[] = ['231006-1234567891']) =>
  ({ platform: 'pdd', mode: 'order_nos', order_nos: orderNumbers }) satisfies ManualSyncFilter;

it('[AC-B1-09i#2] 筛选摘要是 64 位小写十六进制；同一时刻不同偏移写法摘要相同', () => {
  const digest = manualSyncFilterDigest(window());
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(manualSyncFilterDigest(window())).toBe(digest);
  expect(
    manualSyncFilterDigest(
      window({ from: '2026-10-20T16:00:00Z', to: '2026-10-21T16:00:00.000Z' }),
    ),
  ).toBe(digest);
  expect(manualSyncFilterDigest(orderNos())).toMatch(/^[0-9a-f]{64}$/);
  expect(manualSyncFilterDigest(orderNos())).toBe(manualSyncFilterDigest(orderNos()));
});

it('[AC-B1-09i#3] 平台、时间窗、状态筛选、单号任一不同摘要就不同；时间窗与单号两种形式互不相同', () => {
  const digests = [
    window(),
    window({ platform: 'jd' }),
    window({ platform: 'taobao' }),
    window({ from: '2026-10-21T00:30:00+08:00' }),
    window({ to: '2026-10-21T23:30:00+08:00' }),
    window({ status_filter: 'paid' }),
    window({ status_filter: 'settled' }),
    orderNos(),
    orderNos(['231006-1234567892']),
    orderNos(['231006-1234567891', '231006-1234567892']),
    { platform: 'jd', mode: 'order_nos', order_nos: ['231006-1234567891'] } as const,
  ].map((filter) => manualSyncFilterDigest(filter));
  expect(new Set(digests).size).toBe(digests.length);
});

it('[AC-B1-09i#4] limits 按 02 §7.1 的最远回扫范围随时钟给出 earliest_from，单号上限 pdd 50、jd 0', () => {
  const now = new Date('2026-10-22T02:00:00.000Z');
  const items = manualSyncLimits(now);
  const platforms = items.map((item) => item.platform);
  expect(platforms).toContain('pdd');
  expect(new Set(platforms).size).toBe(platforms.length);
  for (const item of items) {
    expect(Object.keys(LOOK_BACK_DAYS)).toContain(item.platform);
    expect(item.max_order_nos).toBe(item.platform === 'pdd' ? 50 : 0);
    const earliest = Date.parse(item.earliest_from);
    const range = LOOK_BACK_DAYS[item.platform] * DAY;
    // The range may be counted from the start of the day; never longer than one extra day.
    expect(earliest).toBeLessThanOrEqual(now.getTime() - range);
    expect(earliest).toBeGreaterThan(now.getTime() - range - DAY);
  }
});

it('[AC-B1-09i#5] earliest_from 随时钟移动：两天后的 earliest_from 更晚，且不早于当时的范围', () => {
  const now = new Date('2026-10-22T02:00:00.000Z');
  const later = new Date(now.getTime() + 2 * DAY);
  const first = new Map(manualSyncLimits(now).map((item) => [item.platform, item.earliest_from]));
  const second = manualSyncLimits(later);
  expect(second.map((item) => item.platform).sort()).toEqual([...first.keys()].sort());
  for (const item of second) {
    expect(Date.parse(item.earliest_from)).toBeGreaterThan(Date.parse(first.get(item.platform)!));
    const range = LOOK_BACK_DAYS[item.platform] * DAY;
    expect(Date.parse(item.earliest_from)).toBeGreaterThan(later.getTime() - range - DAY);
  }
});

it('[AC-B1-04zu#1] max_order_nos 与 MANUAL_SYNC_ORDER_NO_PLATFORMS 对上：名单内恰 50，名单外恰 0（pdd 50、jd 0）', async () => {
  // Imported here: a changed import at the top of the file would judge all its tests in the red
  // check, and the ones this task leaves alone stay green.
  const { MANUAL_SYNC_ORDER_NO_PLATFORMS } =
    await import('../../../../apps/api/src/modules/orders/domain/manual-sync.ts');
  const items = manualSyncLimits(new Date('2026-10-22T02:00:00.000Z'));
  const maxOf = (platform: string) =>
    items.find((item) => item.platform === platform)?.max_order_nos;
  expect(maxOf('jd')).toBe(0);
  expect(maxOf('pdd')).toBe(50);
  expect(MANUAL_SYNC_ORDER_NO_PLATFORMS).toContain('pdd');
  expect(MANUAL_SYNC_ORDER_NO_PLATFORMS).not.toContain('jd');
  for (const item of items) {
    expect(item.max_order_nos).toBe(
      MANUAL_SYNC_ORDER_NO_PLATFORMS.includes(item.platform) ? 50 : 0,
    );
  }
});
