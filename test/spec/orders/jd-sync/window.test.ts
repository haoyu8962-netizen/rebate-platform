// B1-04zr (02 §7.1: 京东每 1 分钟、窗口 ≤1 小时): jd's windows off the rule table, through the real
// schedulers and the real adapter check. The rescan fixture's ruleTableCaps injects no cap, as
// production; its increment cursor is what the increment scheduler reads.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type {
  OrderRescanWindow,
  OrderSyncWindow,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import {
  manualSyncLimits,
  manualSyncPlatforms,
  manualSyncWindows,
} from '../../../../apps/api/src/modules/orders/domain/manual-sync.ts';
import { PLATFORM_RULES } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import {
  INCREMENT_WINDOW_CAP_MS,
  scheduledPlatforms,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { handleOrderSyncWindow } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { jdOrderWindow } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { capture } from '../attribution/kit.ts';
import {
  ACCOUNT,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  NOW,
  NOW_MS,
  account,
  fixture,
  iso,
  job,
  rescanWindow,
  roundStart,
} from '../rescan/kit.ts';

/** The adapter's wire time (seconds, GMT+8) as epoch ms. */
const wireMs = (text: string): number => Date.parse(`${text.replace(' ', 'T')}+08:00`);

it('[AC-B1-04zr#1] 规则表 jd 上限 60 分钟，jd 进增量上限、调度与手动同步；淘宝仍不调度', () => {
  expect(PLATFORM_RULES.jd.syncWindowCapMs).toBe(HOUR_MS);
  expect(INCREMENT_WINDOW_CAP_MS).toEqual({ jd: HOUR_MS, pdd: 30 * MINUTE_MS });
  expect([...scheduledPlatforms()].sort()).toEqual(['jd', 'pdd']);
  expect([...manualSyncPlatforms()].sort()).toEqual(['jd', 'pdd']);
  expect(PLATFORM_RULES.taobao.syncWindowCapMs).toBeNull();
});

it.each([
  { label: '落后 3 小时：切满 60 分钟', behindMs: 3 * HOUR_MS, spanMs: HOUR_MS },
  { label: '恰好落后 60 分钟：一窗追平', behindMs: HOUR_MS, spanMs: HOUR_MS },
  { label: '落后 60 分钟零 1 毫秒：仍只发 60 分钟', behindMs: HOUR_MS + 1, spanMs: HOUR_MS },
  { label: '落后 59 分钟：窗口到 now 为止', behindMs: 59 * MINUTE_MS, spanMs: 59 * MINUTE_MS },
  { label: '游标带毫秒：取整后也不越 1 小时', behindMs: 3 * HOUR_MS + 500, spanMs: HOUR_MS },
])(
  '[AC-B1-04zr#2] $label，真实 jdOrderWindow 放行，上游时间窗不超 1 小时',
  async ({ behindMs, spanMs }) => {
    const from = iso(NOW_MS - behindMs);
    const f = fixture({ increment: from });
    await scheduleOrderSync(f.ruleTableCaps);
    expect(f.sent()).toHaveLength(1);
    const win = f.sent()[0] as OrderSyncWindow;
    expect(win).toMatchObject({
      platform: 'jd',
      union_account_id: ACCOUNT,
      query_kind: 'increment',
      scene: '-',
      window_start: from,
      window_end: iso(Date.parse(from) + spanMs),
    });
    const upstream = jdOrderWindow({ from: win.window_start, to: win.window_end }, f.clock.now());
    const upstreamMs = wireMs(upstream.endTime) - wireMs(upstream.startTime);
    expect(upstreamMs).toBeGreaterThan(0);
    expect(upstreamMs).toBeLessThanOrEqual(HOUR_MS);
  },
);

it('[AC-B1-04zr#3] 调度发出的窗恰好压在适配器的校验线上：60 分钟放行，同一窗多 1 毫秒就拒', async () => {
  const f = fixture({ increment: iso(NOW_MS - 3 * HOUR_MS) });
  await scheduleOrderSync(f.ruleTableCaps);
  expect(f.sent()).toHaveLength(1);
  const win = f.sent()[0] as OrderSyncWindow;
  const endMs = Date.parse(win.window_end);
  expect(endMs - Date.parse(win.window_start)).toBe(HOUR_MS);
  const now = f.clock.now();
  expect(() => jdOrderWindow({ from: win.window_start, to: iso(endMs) }, now)).not.toThrow();
  expect(() => jdOrderWindow({ from: win.window_start, to: iso(endMs + 1) }, now)).toThrow(
    /exceeds 1 hour/,
  );
});

it('[AC-B1-04zr#4] 落后 150 分钟逐轮追赶：窗口首尾相接，每窗都过适配器校验，追平后不再发', async () => {
  const f = fixture({ increment: iso(NOW_MS - 150 * MINUTE_MS) });
  const spans: [number, number][] = [];
  for (let round = 0; round < 6; round += 1) {
    const before = f.sent().length;
    await scheduleOrderSync(f.ruleTableCaps);
    if (f.sent().length === before) break;
    const win = f.sent().at(-1) as OrderSyncWindow;
    spans.push([Date.parse(win.window_start), Date.parse(win.window_end)]);
    const range = { from: win.window_start, to: win.window_end };
    expect(() => jdOrderWindow(range, f.clock.now())).not.toThrow();
    f.setIncrement(win.window_end);
  }
  expect(spans).toEqual([
    [NOW_MS - 150 * MINUTE_MS, NOW_MS - 90 * MINUTE_MS],
    [NOW_MS - 90 * MINUTE_MS, NOW_MS - 30 * MINUTE_MS],
    [NOW_MS - 30 * MINUTE_MS, NOW_MS],
  ]);
});

it('[AC-B1-04zr#5] 手动同步：limits 列出 jd（30 天、不支持按单号报 0），时间窗按 60 分钟切，每窗都过适配器校验', () => {
  const now = new Date(NOW);
  const limit = manualSyncLimits(now).find((item) => item.platform === 'jd');
  expect(limit).toEqual({
    platform: 'jd',
    earliest_from: iso(NOW_MS - 30 * DAY_MS),
    max_order_nos: 0,
  });
  const fromMs = NOW_MS - 150 * MINUTE_MS;
  const windows = manualSyncWindows(fromMs, NOW_MS, INCREMENT_WINDOW_CAP_MS.jd!, now);
  expect(windows.map((win) => [win.window_start, win.window_end])).toEqual([
    [iso(fromMs), iso(fromMs + HOUR_MS)],
    [iso(fromMs + HOUR_MS), iso(fromMs + 2 * HOUR_MS)],
    [iso(fromMs + 2 * HOUR_MS), NOW],
  ]);
  for (const win of windows) {
    expect(() => jdOrderWindow({ from: win.window_start, to: win.window_end }, now)).not.toThrow();
  }
});

it('[AC-B1-04zr#6] order-sync 处理器收下 jd 增量窗：经真实 jdOrderWindow 取单后推进水位', async () => {
  const f = fixture();
  f.listOrders.mockImplementation(async (range) => {
    jdOrderWindow(range, f.clock.now());
    return { items: [], nextCursor: null };
  });
  const startMs = NOW_MS - 2 * HOUR_MS;
  const win: OrderSyncWindow = {
    app_id: account.app_id,
    platform: 'jd',
    union_account_id: ACCOUNT,
    query_kind: 'increment',
    scene: '-',
    window_start: iso(startMs),
    window_end: iso(startMs + HOUR_MS),
  };
  const deps = { ...f.handler, cursors: f.ruleTableCaps.cursors };
  const result = await capture(() => handleOrderSyncWindow({ ...job(win), name: 'window' }, deps));
  expect(result).toMatchObject({ ok: true });
  expect(f.listOrders).toHaveBeenCalledTimes(1);
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zr#7] 回扫不注入 capsMs：jd 窗长取规则表的 60 分钟，真实 jdOrderWindow 放行', async () => {
  const f = fixture();
  await scheduleOrderRescan(f.ruleTableCaps, ['jd']);
  expect(f.sent()).toEqual([rescanWindow(roundStart(30))]);
  const win = f.sent()[0] as OrderRescanWindow;
  const range = { from: win.window_start, to: win.window_end };
  expect(() => jdOrderWindow(range, f.clock.now())).not.toThrow();
});
