// B1-04zzr (D10-798 ②③⑤, D10-804): the pace of each Taobao tier's loop, max(60, floor(P ÷ (D ÷ cap)))
// seconds, through the real createOrderRescanScheduler on fake timers. Start dispatches nothing;
// switches, window_minutes and promo_mode are read again every round, so no restart is needed.
// Windows are counted per tier kind. The hour tier's window is min(effective cap, 20 minutes), so its
// pace is 400 s at the defaults, with promo_mode and with window_minutes = 60 (author-notes.md).
import { afterEach, expect, it, vi } from 'vitest';
import { createOrderRescanScheduler } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import {
  HOUR_WINDOW_MS,
  MINUTE_MS,
  PROMO_MODE,
  PROMO_WINDOW_MS,
  WEEK_ENABLED,
  WINDOW_MINUTES,
  tierFixture,
} from './kit.ts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const TAOBAO: readonly RegisteredPlatform[] = ['taobao'];

type Fixture = ReturnType<typeof tierFixture>;

function started(f: Fixture) {
  vi.useFakeTimers();
  return createOrderRescanScheduler(f.ruleTableCaps, TAOBAO).start();
}

/** Advances fake time to `atMs` since start (calls must be in increasing order). */
function clockTo() {
  let at = 0;
  return async (atMs: number) => {
    await vi.advanceTimersByTimeAsync(atMs - at);
    at = atMs;
  };
}

const spanOf = (win: Record<string, unknown> | undefined): number =>
  Date.parse(String(win?.['window_end'])) - Date.parse(String(win?.['window_start']));

it('[AC-B1-04zzr#27] 键都未设：启动零投递，天档第 360 秒发第一窗、720 秒第二窗；小时档第 400 秒、800 秒各发一个 20 分钟窗；周档关着不发；停止后不留定时器', async () => {
  const f = tierFixture();
  const loop = started(f);
  const to = clockTo();
  try {
    await to(0);
    expect(f.send).not.toHaveBeenCalled();
    await to(359_999);
    expect(f.sentOf('rescan')).toHaveLength(0);
    await to(360_000);
    expect(f.sentOf('rescan')).toHaveLength(1);
    await to(399_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(0);
    await to(400_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    await to(719_999);
    expect(f.sentOf('rescan')).toHaveLength(1);
    await to(720_000);
    expect(f.sentOf('rescan')).toHaveLength(2);
    await to(799_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    await to(800_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(2);
    expect(f.sentOf('rescan_hour').map(spanOf)).toEqual([HOUR_WINDOW_MS, HOUR_WINDOW_MS]);
    await to(7_200_000);
    expect(f.sentOf('rescan_week')).toHaveLength(0);
  } finally {
    await loop.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
  const sent = f.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(7 * 86_400_000);
  expect(f.send).toHaveBeenCalledTimes(sent);
});

it('[AC-B1-04zzr#28] 周档打开：第 840 秒发第一窗（7 天 ÷ (90 天 ÷ 180 分钟)）', async () => {
  const f = tierFixture({ config: { [WEEK_ENABLED]: true } });
  const loop = started(f);
  const to = clockTo();
  try {
    await to(839_999);
    expect(f.sentOf('rescan_week')).toHaveLength(0);
    await to(840_000);
    expect(f.sentOf('rescan_week')).toHaveLength(1);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zzr#29] promo_mode 开（窗口 20 分钟）：天档 60 秒（下限）、周档 93 秒、小时档 400 秒各发第一窗', async () => {
  const f = tierFixture({ config: { [PROMO_MODE]: true, [WEEK_ENABLED]: true } });
  const loop = started(f);
  const to = clockTo();
  try {
    await to(59_999);
    expect(f.sentOf('rescan')).toHaveLength(0);
    await to(60_000);
    expect(f.sentOf('rescan')).toHaveLength(1);
    await to(92_999);
    expect(f.sentOf('rescan_week')).toHaveLength(0);
    await to(93_000);
    expect(f.sentOf('rescan_week')).toHaveLength(1);
    await to(399_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(0);
    await to(400_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    expect(f.sent().every((win) => spanOf(win) === PROMO_WINDOW_MS)).toBe(true);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zzr#30] window_minutes=60：天档 120 秒、周档 280 秒各发第一窗；小时档窗口封顶 20 分钟，仍第 400 秒发第一窗', async () => {
  const f = tierFixture({ config: { [WINDOW_MINUTES]: 60, [WEEK_ENABLED]: true } });
  const loop = started(f);
  const to = clockTo();
  try {
    await to(119_999);
    expect(f.sentOf('rescan')).toHaveLength(0);
    await to(120_000);
    expect(f.sentOf('rescan')).toHaveLength(1);
    await to(279_999);
    expect(f.sentOf('rescan_week')).toHaveLength(0);
    await to(280_000);
    expect(f.sentOf('rescan_week')).toHaveLength(1);
    await to(399_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(0);
    await to(400_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    expect(spanOf(f.sentOf('rescan_hour')[0])).toBe(HOUR_WINDOW_MS);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zzr#42] window_minutes=10（低于 20 分钟）：小时档按 10 分钟切，第 200 秒发第一窗、400 秒第二窗', async () => {
  const f = tierFixture({ config: { [WINDOW_MINUTES]: 10 } });
  const loop = started(f);
  const to = clockTo();
  try {
    await to(199_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(0);
    await to(200_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    await to(399_999);
    expect(f.sentOf('rescan_hour')).toHaveLength(1);
    await to(400_000);
    expect(f.sentOf('rescan_hour')).toHaveLength(2);
    expect(f.sentOf('rescan_hour').map(spanOf)).toEqual([10 * MINUTE_MS, 10 * MINUTE_MS]);
  } finally {
    await loop.stop();
  }
});

it.each([0, 1.5, '60', 'abc'])(
  '[AC-B1-04zzr#31] window_minutes=%j 不合法：按默认 180 分钟定节奏，天档仍在第 360 秒发第一窗',
  async (minutes) => {
    const f = tierFixture({ config: { [WINDOW_MINUTES]: minutes } });
    const loop = started(f);
    const to = clockTo();
    try {
      await to(359_999);
      expect(f.sentOf('rescan')).toHaveLength(0);
      await to(360_000);
      expect(f.sentOf('rescan')).toHaveLength(1);
    } finally {
      await loop.stop();
    }
  },
);

it('[AC-B1-04zzr#32] 周档开关每轮重读：关着不发，打开后不用重启就开始', async () => {
  const f = tierFixture();
  const loop = started(f);
  const to = clockTo();
  try {
    await to(840_000);
    expect(f.sentOf('rescan_week')).toHaveLength(0);
    f.values[WEEK_ENABLED] = true;
    await to(1_680_000);
    expect(f.sentOf('rescan_week')).toHaveLength(1);
  } finally {
    await loop.stop();
  }
});

it('[AC-B1-04zzr#33] promo_mode 每轮重读：打开后下一轮起按 20 分钟切，节奏随之改为 60 秒', async () => {
  const f = tierFixture();
  const loop = started(f);
  const to = clockTo();
  try {
    await to(360_000);
    expect(f.sentOf('rescan')).toHaveLength(1);
    f.values[PROMO_MODE] = true;
    // The timer armed after the first round keeps its 360 s; the round it fires reads promo_mode.
    await to(719_999);
    expect(f.sentOf('rescan')).toHaveLength(1);
    await to(720_000);
    expect(f.sentOf('rescan')).toHaveLength(2);
    await to(780_000);
    expect(f.sentOf('rescan')).toHaveLength(3);
    expect(f.sentOf('rescan').slice(1).map(spanOf)).toEqual([PROMO_WINDOW_MS, PROMO_WINDOW_MS]);
  } finally {
    await loop.stop();
  }
});
