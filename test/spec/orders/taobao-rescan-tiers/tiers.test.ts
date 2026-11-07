// B1-04zzr (D10-798 ①②③, D10-804): the pure rules of Taobao's rescan tiers — the tier table, the
// pace of a tier and the window cap. Tables hold plain values only: no code under test runs at
// collection.
import { expect, it } from 'vitest';
import {
  rescanDefaults,
  rescanTiers,
} from '../../../../apps/api/src/modules/orders/domain/platform-rules/rescan.ts';
import {
  isRescanWindowMinutes,
  rescanIntervalSeconds,
  rescanTierIntervalSeconds,
  rescanWindowCapMs,
} from '../../../../apps/api/src/modules/orders/domain/sync-window.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './kit.ts';

/** [period P, depth D] of each tier (D10-798 ①). */
const TIER = {
  day: [DAY_MS, 30 * DAY_MS],
  hour: [HOUR_MS, 3 * HOUR_MS],
  week: [7 * DAY_MS, 90 * DAY_MS],
} as const;

it('[AC-B1-04zzr#1] 淘宝三档：天档 rescan 30 天 / 1 天 / update / 默认开，小时档 rescan_hour 3 小时 / 1 小时 / pay / 默认开，周档 rescan_week 90 天 / 7 天 / pay / 默认关；天档仍是 rescanDefaults 的单档', () => {
  const tiers = rescanTiers('taobao');
  expect(tiers).not.toBeNull();
  expect([...tiers!].sort((a, b) => a.queryKind.localeCompare(b.queryKind))).toEqual([
    {
      queryKind: 'rescan',
      depthMs: 30 * DAY_MS,
      periodMs: DAY_MS,
      timeBasis: 'update',
      enabled: true,
    },
    {
      queryKind: 'rescan_hour',
      depthMs: 3 * HOUR_MS,
      periodMs: HOUR_MS,
      timeBasis: 'pay',
      enabled: true,
    },
    {
      queryKind: 'rescan_week',
      depthMs: 90 * DAY_MS,
      periodMs: 7 * DAY_MS,
      timeBasis: 'pay',
      enabled: false,
    },
  ]);
  expect(rescanDefaults('taobao')).toEqual({ enabled: true, days: 30 });
});

it.each(['jd', 'pdd', 'synthetic-unlisted', 'hasOwnProperty'])(
  '[AC-B1-04zzr#2] %s 不分档：rescanTiers 为 null（京东、拼多多单档不变）',
  (platform) => {
    expect(rescanTiers(platform)).toBeNull();
  },
);

it.each([
  { tier: 'day', minutes: 180, seconds: 360 },
  { tier: 'hour', minutes: 180, seconds: 3600 },
  { tier: 'week', minutes: 180, seconds: 840 },
  { tier: 'day', minutes: 60, seconds: 120 },
  { tier: 'hour', minutes: 60, seconds: 1200 },
  { tier: 'week', minutes: 60, seconds: 280 },
  // Promo caps: the day tier's 40 s is raised to the floor, the week tier's 93.3 s rounded down.
  { tier: 'day', minutes: 20, seconds: 60 },
  { tier: 'hour', minutes: 20, seconds: 400 },
  { tier: 'week', minutes: 20, seconds: 93 },
] as const)(
  '[AC-B1-04zzr#3] 节奏 max(60, floor(P ÷ (D ÷ cap)))：$tier 档、窗口 $minutes 分钟 → $seconds 秒',
  ({ tier, minutes, seconds }) => {
    const [periodMs, depthMs] = TIER[tier];
    expect(rescanTierIntervalSeconds(periodMs, depthMs, minutes * MINUTE_MS)).toBe(seconds);
  },
);

it.each([1, 7, 30, 45, 90])(
  '[AC-B1-04zzr#4] 周期 1 天、深度 %d 天：与单档 rescanIntervalSeconds 同值（模型只是推广到周期 P）',
  (days) => {
    for (const minutes of [20, 30, 60, 180]) {
      expect(
        rescanTierIntervalSeconds(DAY_MS, days * DAY_MS, minutes * MINUTE_MS),
        `${minutes} minutes`,
      ).toBe(rescanIntervalSeconds(days, minutes * MINUTE_MS));
    }
  },
);

it('[AC-B1-04zzr#5] window_minutes 只认正整数分钟；0、负数、小数、字符串、布尔、空值、NaN、无穷都不合法', () => {
  for (const valid of [1, 20, 60, 180]) {
    expect(isRescanWindowMinutes(valid), String(valid)).toBe(true);
  }
  for (const invalid of [0, -1, 1.5, '180', 'abc', true, null, undefined, Number.NaN, Infinity]) {
    expect(isRescanWindowMinutes(invalid), String(invalid)).toBe(false);
  }
});

it.each([
  { minutes: 180, promo: false, capMinutes: 180 },
  { minutes: 60, promo: false, capMinutes: 60 },
  { minutes: 10, promo: false, capMinutes: 10 },
  { minutes: 180, promo: true, capMinutes: 20 },
  { minutes: 60, promo: true, capMinutes: 20 },
  { minutes: 20, promo: true, capMinutes: 20 },
  { minutes: 10, promo: true, capMinutes: 10 },
])(
  '[AC-B1-04zzr#6] window_minutes=$minutes、promo_mode=$promo：回扫窗口 $capMinutes 分钟（大促取 min(window_minutes, 20)）',
  ({ minutes, promo, capMinutes }) => {
    expect(rescanWindowCapMs(minutes, promo)).toBe(capMinutes * MINUTE_MS);
  },
);
