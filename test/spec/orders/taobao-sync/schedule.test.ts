// 02 §7.1 / CAP-TB-07（D10-588 ③、D10-741 ②④）：淘宝进调度——规则表窗口上限 20 分钟、订单查询回看 90 天、
// 回扫先单档 30 天（rescanDefaults，照 jd 写法；不登记 order_sync.rescan.taobao.* 配置键），scheduledPlatforms /
// manualSyncPlatforms 含淘宝（cap 打开后手动同步随之可用），按单号仍关。京东 / 拼多多的值不变。窗口经真实
// 调度器发出，再交真实淘宝适配器（假传输）确认能取。
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import { scheduleOrderSync } from '../../../../apps/api/src/modules/orders/application/sync-scheduler.ts';
import type { OrderSyncWindow } from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { configItemSpecOf } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  MANUAL_SYNC_ORDER_NO_PLATFORMS,
  manualSyncLimits,
  manualSyncPlatforms,
  manualSyncWindows,
} from '../../../../apps/api/src/modules/orders/domain/manual-sync.ts';
import { PLATFORM_RULES } from '../../../../apps/api/src/modules/orders/domain/platform-rules/index.ts';
import { orderQueryLookbackMs } from '../../../../apps/api/src/modules/orders/domain/platform-rules/query-lookback.ts';
import { rescanDefaults } from '../../../../apps/api/src/modules/orders/domain/platform-rules/rescan.ts';
import {
  INCREMENT_WINDOW_CAP_MS,
  RESCAN_START_MARGIN_MS,
  scheduledPlatforms,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { handleOrderSyncWindow } from '../../../../apps/api/src/modules/orders/jobs/order-sync.ts';
import { ctx, listed, num, onePage, row, setup } from '../../union/taobao-orders/kit.ts';
import { capture } from '../attribution/kit.ts';
import { NOW, job, roundStart } from '../rescan/kit.ts';
import {
  DAY_MS,
  HOUR_MS,
  JD_CAP_MS,
  MINUTE_MS,
  NOW_MS,
  PDD_CAP_MS,
  TAOBAO_CAP_MS,
  TAOBAO_DAYS,
  TAOBAO_ENABLED,
  TAOBAO_LOOKBACK_MS,
  gatedFixture,
  incrementWindow,
  iso,
  taobaoAccount,
  taobaoIncrement,
  taobaoRescanWindow,
} from './taobao-sync-kit.ts';

/** Beijing "YYYY-MM-DD HH:MM:SS" as epoch ms. */
const beijingMs = (text: string | undefined): number =>
  Date.parse(`${String(text).replace(' ', 'T')}+08:00`);

it('[AC-B1-04zzb#11] 规则表淘宝窗口上限 20 分钟（去 TODO），进增量上限与调度；京东 60、拼多多 30 分钟不变', () => {
  expect(PLATFORM_RULES.taobao.syncWindowCapMs).toBe(TAOBAO_CAP_MS);
  expect(INCREMENT_WINDOW_CAP_MS).toEqual({
    jd: JD_CAP_MS,
    pdd: PDD_CAP_MS,
    taobao: TAOBAO_CAP_MS,
  });
  expect(PLATFORM_RULES.jd.syncWindowCapMs).toBe(JD_CAP_MS);
  expect(PLATFORM_RULES.pdd.syncWindowCapMs).toBe(PDD_CAP_MS);
  expect([...scheduledPlatforms()].sort()).toEqual(['jd', 'pdd', 'taobao']);
});

it('[AC-B1-04zzb#12] CAP-TB-07：淘宝订单查询回看 90 天，京东照旧 90 天，拼多多仍无此限', () => {
  expect(orderQueryLookbackMs('taobao')).toBe(TAOBAO_LOOKBACK_MS);
  expect(orderQueryLookbackMs('jd')).toBe(90 * DAY_MS);
  expect(orderQueryLookbackMs('pdd')).toBeNull();
});

it('[AC-B1-04zzb#13] 回扫先单档：淘宝默认开、30 天（rescanDefaults），不登记 order_sync.rescan.taobao.* 配置键；jd / pdd 不变', () => {
  expect(rescanDefaults('taobao')).toEqual({ enabled: true, days: 30 });
  expect(rescanDefaults('jd')).toEqual({ enabled: true, days: 30 });
  expect(rescanDefaults('pdd')).toEqual({ enabled: false, days: 90 });
  expect(configItemSpecOf(TAOBAO_ENABLED)).toBeNull();
  expect(configItemSpecOf(TAOBAO_DAYS)).toBeNull();
});

it('[AC-B1-04zzb#14] 增量调度：淘宝落后 3 小时只发 20 分钟一窗，真实淘宝适配器按这一窗取数', async () => {
  const fromMs = NOW_MS - 3 * HOUR_MS;
  const { f, deps } = gatedFixture(
    { accounts: [taobaoAccount], increment: iso(fromMs) },
    () => true,
  );
  await scheduleOrderSync(deps);
  expect(f.sent()).toEqual([incrementWindow('taobao', fromMs, TAOBAO_CAP_MS)]);
  const win = f.sent()[0] as OrderSyncWindow;
  const s = setup(onePage([]));
  await listed(s.adapter.listOrders({ from: win.window_start, to: win.window_end }, {}, ctx));
  expect(s.requests).toHaveLength(1);
  const [request] = s.requests;
  expect(beijingMs(request?.endTime) - beijingMs(request?.startTime)).toBe(TAOBAO_CAP_MS);
});

it('[AC-B1-04zzb#27] order-sync 处理器收下淘宝 20 分钟增量窗：经真实淘宝适配器取单、交归因流水线、推进水位', async () => {
  const startMs = NOW_MS - 2 * HOUR_MS;
  const win = incrementWindow('taobao', startMs, TAOBAO_CAP_MS);
  const s = setup(onePage([row({ tk_status: num('12'), tk_earning_time: '--' })]));
  const { f } = gatedFixture({ accounts: [taobaoAccount] });
  const deps = {
    ...f.handler,
    cursors: f.ruleTableCaps.cursors,
    registry: { get: () => s.adapter },
  };
  const received = { ...job(win), name: 'window' };
  const result = await capture(() => handleOrderSyncWindow(received, deps));
  expect(result).toMatchObject({ ok: true });
  expect(s.requests).toHaveLength(1);
  expect(f.process).toHaveBeenCalledTimes(1);
  expect(f.process.mock.calls[0]?.[0]).toMatchObject({ platform: 'taobao', raw_status: '12' });
  expect(f.advance).toHaveBeenCalledExactlyOnceWith(win);
});

it('[AC-B1-04zzb#15] 落后 50 分钟逐轮追赶：20 / 20 / 10 分钟首尾相接，追平后不再发', async () => {
  const { f, deps } = gatedFixture(
    { accounts: [taobaoAccount], increment: iso(NOW_MS - 50 * MINUTE_MS) },
    () => true,
  );
  const spans: [number, number][] = [];
  for (let round = 0; round < 6; round += 1) {
    const before = f.sent().length;
    await scheduleOrderSync(deps);
    if (f.sent().length === before) break;
    const win = f.sent().at(-1) as OrderSyncWindow;
    spans.push([Date.parse(win.window_start), Date.parse(win.window_end)]);
    f.setIncrement(win.window_end);
  }
  expect(spans).toEqual([
    [NOW_MS - 50 * MINUTE_MS, NOW_MS - 30 * MINUTE_MS],
    [NOW_MS - 30 * MINUTE_MS, NOW_MS - 10 * MINUTE_MS],
    [NOW_MS - 10 * MINUTE_MS, NOW_MS],
  ]);
});

it('[AC-B1-04zzb#16] 回看 90 天：淘宝游标早于 90 天先挪到 now − 90 天 + 余量，再从那里发窗', async () => {
  const old = '2026-01-01T00:00:00.000Z';
  const { f, deps } = gatedFixture({ accounts: [taobaoAccount], increment: old }, () => true);
  const floor = iso(NOW_MS - TAOBAO_LOOKBACK_MS + RESCAN_START_MARGIN_MS);
  f.rewind.mockResolvedValue(true);
  await scheduleOrderSync(deps);
  expect(f.rewind).toHaveBeenCalledExactlyOnceWith(taobaoIncrement, old, floor);
  expect(f.sent()).toEqual([incrementWindow('taobao', Date.parse(floor), TAOBAO_CAP_MS)]);
});

it('[AC-B1-04zzb#17] 手动同步：limits 列出淘宝（90 天、按单号 0），按单号仍只开拼多多；时间窗按 20 分钟切', () => {
  expect(INCREMENT_WINDOW_CAP_MS.taobao).toBe(TAOBAO_CAP_MS);
  const now = new Date(NOW);
  expect([...manualSyncPlatforms()].sort()).toEqual(['jd', 'pdd', 'taobao']);
  const limits = manualSyncLimits(now);
  expect(limits.find((item) => item.platform === 'taobao')).toEqual({
    platform: 'taobao',
    earliest_from: iso(NOW_MS - 90 * DAY_MS),
    max_order_nos: 0,
  });
  expect(limits.find((item) => item.platform === 'jd')).toEqual({
    platform: 'jd',
    earliest_from: iso(NOW_MS - 30 * DAY_MS),
    max_order_nos: 0,
  });
  expect(limits.find((item) => item.platform === 'pdd')).toEqual({
    platform: 'pdd',
    earliest_from: iso(NOW_MS - 90 * DAY_MS),
    max_order_nos: 50,
  });
  expect([...MANUAL_SYNC_ORDER_NO_PLATFORMS]).toEqual(['pdd']);
  const fromMs = NOW_MS - 50 * MINUTE_MS;
  const windows = manualSyncWindows(fromMs, NOW_MS, TAOBAO_CAP_MS, now);
  expect(windows.map((w) => [w.window_start, w.window_end])).toEqual([
    [iso(fromMs), iso(fromMs + TAOBAO_CAP_MS)],
    [iso(fromMs + TAOBAO_CAP_MS), iso(fromMs + 2 * TAOBAO_CAP_MS)],
    [iso(fromMs + 2 * TAOBAO_CAP_MS), NOW],
  ]);
});

it('[AC-B1-04zzb#18] 回扫：键未设时淘宝开、回扫 30 天，窗长取规则表 20 分钟；开关与天数按淘宝的键读', async () => {
  const { f } = gatedFixture({ accounts: [taobaoAccount] });
  await scheduleOrderRescan(f.ruleTableCaps, ['taobao']);
  expect(f.sent()).toEqual([taobaoRescanWindow(roundStart(30))]);
  expect(f.config.get).toHaveBeenCalledWith(TAOBAO_ENABLED);
  expect(f.config.get).toHaveBeenCalledWith(TAOBAO_DAYS);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzb#19] 回扫：淘宝开关显式关闭后不回扫；天数在 1～90 内按配置', async () => {
  const off = gatedFixture({ accounts: [taobaoAccount], config: { [TAOBAO_ENABLED]: false } });
  await scheduleOrderRescan(off.f.ruleTableCaps, ['taobao']);
  expect(off.f.config.get).toHaveBeenCalledWith(TAOBAO_ENABLED);
  expect(off.f.send).not.toHaveBeenCalled();

  const days = gatedFixture({ accounts: [taobaoAccount], config: { [TAOBAO_DAYS]: 45 } });
  await scheduleOrderRescan(days.f.ruleTableCaps, ['taobao']);
  expect(days.f.sent()).toEqual([taobaoRescanWindow(roundStart(45))]);
});
