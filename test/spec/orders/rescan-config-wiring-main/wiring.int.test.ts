// 规则测试（B1-04zzz，FU-RESCAN-CONFIG-WIRING，D10-845；claude-independent，SPEC_REF b79958d）：
// 生产装配下淘宝回扫三档读的配置。回扫配置端口取自真实组合根（AppModule.forEntry 的 worker 入口交给
// OrdersModule.forWorker 的 rescanConfig），按运行体的调用方式用本例的库与时钟建出；库是真 PostgreSQL
// （couli_app），行写进 app.config_items 的 ORDER_SYNC_APP_ID（'couli'）。每例一库。
// 一轮 = 回扫调度器每个档的定时器到点跑的 scheduleOrderRescan；联盟侧（账号、闸门、游标）是
// ../rescan/kit.ts 的替身，不连真实联盟；时间只读注入的 FixedClock。
// 回扫窗口 = promo_mode ? min(window_minutes, 20) : window_minutes（默认 180），小时档另取
// min(·, 20)；周档默认关（B1-04zzr，D10-798 / D10-804）。window_minutes 登记为整数 1～180
// （config-registry，B1-04zzzt），范围外按默认并告警，照 orders 对 days 的处理。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  ENABLED,
  HOUR_ENABLED,
  OTHER_APP_ID,
  PROMO_MODE,
  WEEK_ENABLED,
  WINDOW_MINUTES,
  installCaseDatabase,
  scene,
} from './kit.ts';

installCaseDatabase(createTestDatabase);

it('[AC-B1-04zzzu#1][D10-845] 生产装配、库里没有回扫行：天档 180 分钟（按更新）、小时档 20 分钟（按付款），周档不派，不告警', async () => {
  const s = await scene();
  const round = await s.round();
  expect(round.minutes).toEqual(DEFAULT_WINDOWS);
  expect(round.timeBasis).toEqual({ rescan: 'update', rescan_hour: 'pay' });
  expect(round.warned(WINDOW_MINUTES)).toBe(0);
  expect(round.warned(PROMO_MODE)).toBe(0);
});

it('[AC-B1-04zzzu#2][D10-845] 写 order_sync.promo_mode = true 后下一轮天档、小时档都是 20 分钟，周档打开后也是 20 分钟；改回 false 后回到默认', async () => {
  const s = await scene();
  await s.set(PROMO_MODE, true);
  expect((await s.round()).minutes).toEqual({ rescan: 20, rescan_hour: 20 });

  await s.set(WEEK_ENABLED, true);
  const promoWeek = await s.round();
  expect(promoWeek.minutes).toEqual({ rescan: 20, rescan_hour: 20, rescan_week: 20 });
  expect(promoWeek.timeBasis).toEqual({ rescan: 'update', rescan_hour: 'pay', rescan_week: 'pay' });

  await s.set(PROMO_MODE, false);
  expect((await s.round()).minutes).toEqual({ rescan: 180, rescan_hour: 20, rescan_week: 180 });

  await s.set(WEEK_ENABLED, false);
  expect((await s.round()).minutes).toEqual(DEFAULT_WINDOWS);
});

it('[AC-B1-04zzzu#3][D10-845] promo_mode 与 window_minutes 同时写：窗口取 min(window_minutes, 20)', async () => {
  const s = await scene();
  await s.set(WINDOW_MINUTES, 60);
  await s.set(PROMO_MODE, true);
  expect((await s.round()).minutes).toEqual({ rescan: 20, rescan_hour: 20 });
  await s.set(WINDOW_MINUTES, 10);
  expect((await s.round()).minutes).toEqual({ rescan: 10, rescan_hour: 10 });
});

it('[AC-B1-04zzzu#4][D10-845] 写 window_minutes = 60 后下一轮天档 60 分钟、小时档仍 20 分钟；再改成 90 下一轮就是 90（每轮重读，不留旧值）', async () => {
  const s = await scene();
  expect((await s.round()).minutes).toEqual(DEFAULT_WINDOWS);
  await s.set(WINDOW_MINUTES, 60);
  const sixty = await s.round();
  expect(sixty.minutes).toEqual({ rescan: 60, rescan_hour: 20 });
  expect(sixty.warned(WINDOW_MINUTES)).toBe(0);
  await s.set(WINDOW_MINUTES, 90);
  expect((await s.round()).minutes).toEqual({ rescan: 90, rescan_hour: 20 });
});

it.each([1, 15, 180])(
  '[AC-B1-04zzzu#5][D10-845] window_minutes 取登记范围内的 %s：天档就是它，小时档取 min(它, 20)，不告警',
  async (minutes) => {
    const s = await scene();
    await s.set(WINDOW_MINUTES, minutes);
    const round = await s.round();
    expect(round.minutes).toEqual({ rescan: minutes, rescan_hour: Math.min(minutes, 20) });
    expect(round.warned(WINDOW_MINUTES)).toBe(0);
  },
);

it.each([
  { label: '0', value: 0 },
  { label: '小数 1.5', value: 1.5 },
  { label: '小数 60.5', value: 60.5 },
  { label: '字符串 "60"', value: '60' },
  { label: '负数 -60', value: -60 },
])(
  '[AC-B1-04zzzu#6][D10-845] window_minutes 非法（$label）：下一轮天档按默认 180 分钟、小时档 20 分钟，并只带 key 告警一次',
  async ({ value }) => {
    const s = await scene();
    await s.set(WINDOW_MINUTES, value);
    const round = await s.round();
    expect(round.minutes).toEqual(DEFAULT_WINDOWS);
    expect(round.warned(WINDOW_MINUTES)).toBe(1);
  },
);

it('[AC-B1-04zzzu#7][D10-845] 写 week.enabled = true 后周档开始派窗（180 分钟、按付款）；hour.enabled = false 后小时档停；enabled = false 后天档停', async () => {
  const s = await scene();
  await s.set(WEEK_ENABLED, true);
  const week = await s.round();
  expect(week.minutes).toEqual({ rescan: 180, rescan_hour: 20, rescan_week: 180 });
  expect(week.timeBasis['rescan_week']).toBe('pay');

  await s.set(HOUR_ENABLED, false);
  expect((await s.round()).minutes).toEqual({ rescan: 180, rescan_week: 180 });

  await s.set(ENABLED, false);
  expect((await s.round()).minutes).toEqual({ rescan_week: 180 });

  await s.set(HOUR_ENABLED, true);
  await s.set(ENABLED, true);
  await s.set(WEEK_ENABLED, false);
  expect((await s.round()).minutes).toEqual(DEFAULT_WINDOWS);
});

it('[AC-B1-04zzzu#8][D10-845] 别的 App 的 promo_mode、window_minutes、三档开关都不影响 worker 的淘宝回扫：只读 ORDER_SYNC_APP_ID 的行', async () => {
  const s = await scene();
  await s.set(PROMO_MODE, true, OTHER_APP_ID);
  await s.set(WINDOW_MINUTES, 60, OTHER_APP_ID);
  await s.set(WEEK_ENABLED, true, OTHER_APP_ID);
  await s.set(HOUR_ENABLED, false, OTHER_APP_ID);
  await s.set(ENABLED, false, OTHER_APP_ID);
  expect((await s.round()).minutes).toEqual(DEFAULT_WINDOWS);
});
