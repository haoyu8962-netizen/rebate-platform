// B1-04zzr (D10-798 ①③④⑤⑥⑦, D10-804): one scheduling round over Taobao's three rescan tiers, through
// the real scheduleOrderRescan with the rule table's caps (f.ruleTableCaps, no capsMs). Each tier is
// a stream (taobao, account, kind, '-') with its own cursor; every window carries its timeBasis.
import { expect, it } from 'vitest';
import { scheduleOrderRescan } from '../../../../apps/api/src/modules/orders/application/order-rescan.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import {
  ACCOUNT,
  OTHER_ACCOUNT,
  account as jdAccount,
  daysAgo,
  incrementOf,
  mentioning,
  rescanWindow,
  roundStart,
} from '../rescan/kit.ts';
import {
  ALL_KINDS,
  DAY_MS,
  DEFAULT_WINDOW_MS,
  HOUR_DEPTH_MS,
  HOUR_ENABLED,
  HOUR_MS,
  HOUR_WINDOW_MS,
  MINUTE_MS,
  NOW,
  NOW_MS,
  PROMO_MODE,
  PROMO_WINDOW_MS,
  TAOBAO_ACCOUNT,
  TAOBAO_DAYS,
  TAOBAO_ENABLED,
  TAOBAO_TIER_KEYS,
  WEEK_ENABLED,
  WINDOW_MINUTES,
  dayWindow,
  hourWindow,
  iso,
  taobaoAccount,
  tierFixture,
  tierStream,
  tierWindow,
  weekWindow,
} from './kit.ts';

const TAOBAO: readonly RegisteredPlatform[] = ['taobao'];
/** Promo on and the week tier on: every tier sends one window of 20 minutes. */
const ALL_ON = { [PROMO_MODE]: true, [WEEK_ENABLED]: true };

it('[AC-B1-04zzr#7] 键都未设：天档从 now − 30 天 + 1 小时发 180 分钟窗、带 timeBasis update；小时档从 now − 3 小时（不加余量）发 20 分钟窗、带 timeBasis pay；周档默认关，不读不发；各档开关、天数、窗口与大促键都按淘宝的键读，不告警', async () => {
  const f = tierFixture();
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.sentOf('rescan')).toEqual([dayWindow()]);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow()]);
  expect(f.sentOf('rescan_week')).toEqual([]);
  expect(f.read).not.toHaveBeenCalledWith(tierStream('rescan_week'));
  for (const key of TAOBAO_TIER_KEYS) expect(f.config.get).toHaveBeenCalledWith(key);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzr#8] promo_mode 开：三档都按 20 分钟切（天档 update、小时档与周档 pay），singletonKey 带各自的 query_kind', async () => {
  const f = tierFixture({ config: { ...ALL_ON } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.kindsSent()).toEqual([...ALL_KINDS]);
  expect(f.sentOf('rescan')).toEqual([dayWindow(PROMO_WINDOW_MS)]);
  expect(f.sentOf('rescan_week')).toEqual([weekWindow(PROMO_WINDOW_MS)]);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow(PROMO_WINDOW_MS)]);
  const keys = f.send.mock.calls.map(([, , payload, options]) => [
    payload['query_kind'],
    options.singletonKey,
  ]);
  for (const kind of ALL_KINDS) {
    const win = f.sentOf(kind)[0]!;
    expect(keys).toContainEqual([
      kind,
      `taobao:${TAOBAO_ACCOUNT}:${kind}:-:${String(win['window_start'])}`,
    ]);
  }
  const routes = f.send.mock.calls.map(([queue, name]) => `${queue} ${name}`);
  expect(new Set(routes)).toEqual(new Set(['order-sync rescan.window']));
});

it('[AC-B1-04zzr#9] promo_mode 开且 window_minutes 小于 20：三档都取 window_minutes（小时档也是 10 分钟）', async () => {
  const f = tierFixture({ config: { ...ALL_ON, [WINDOW_MINUTES]: 10 } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.sentOf('rescan')).toEqual([dayWindow(10 * MINUTE_MS)]);
  expect(f.sentOf('rescan_week')).toEqual([weekWindow(10 * MINUTE_MS)]);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow(10 * MINUTE_MS)]);
});

it('[AC-B1-04zzr#10] window_minutes=60、promo_mode 显式关：天档与周档按 60 分钟切，小时档封顶 20 分钟，不告警', async () => {
  const f = tierFixture({
    config: { [WINDOW_MINUTES]: 60, [PROMO_MODE]: false, [WEEK_ENABLED]: true },
  });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.sentOf('rescan')).toEqual([dayWindow(60 * MINUTE_MS)]);
  expect(f.sentOf('rescan_week')).toEqual([weekWindow(60 * MINUTE_MS)]);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow(HOUR_WINDOW_MS)]);
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, '180', 'abc', true])(
  '[AC-B1-04zzr#11] window_minutes=%j 不合法：按默认 180 分钟切，一轮只 warn 一次且只含键名',
  async (minutes) => {
    const f = tierFixture({ config: { [WINDOW_MINUTES]: minutes, [WEEK_ENABLED]: true } });
    await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
    expect(f.sentOf('rescan')).toEqual([dayWindow()]);
    expect(f.sentOf('rescan_week')).toEqual([weekWindow()]);
    expect(f.sentOf('rescan_hour')).toEqual([hourWindow()]);
    const warned = mentioning(f.logger.warn, WINDOW_MINUTES);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[0]).toEqual({ key: WINDOW_MINUTES });
  },
);

it('[AC-B1-04zzr#12] 周档打开：读 (taobao, 账号, rescan_week, -) 游标，从 now − 90 天 + 1 小时发 180 分钟窗、带 timeBasis pay', async () => {
  const f = tierFixture({ config: { [WEEK_ENABLED]: true } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.read).toHaveBeenCalledWith(tierStream('rescan_week'));
  expect(f.sentOf('rescan_week')).toEqual([weekWindow()]);
  expect(f.sentOf('rescan')).toEqual([dayWindow()]);
});

it('[AC-B1-04zzr#13] 天档 days 只管天档：days=45 时天档从 now − 45 天 + 1 小时起，周档仍从 now − 90 天 + 1 小时起', async () => {
  const f = tierFixture({ config: { [TAOBAO_DAYS]: 45, [WEEK_ENABLED]: true } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.sentOf('rescan')).toEqual([dayWindow(DEFAULT_WINDOW_MS, 45)]);
  expect(f.sentOf('rescan_week')).toEqual([weekWindow()]);
});

it('[AC-B1-04zzr#14] 各档游标各自独立：天档从自己的游标起、周档从自己的游标起，小时档读自己的流', async () => {
  const dayCursor = daysAgo(5);
  const weekCursor = daysAgo(40);
  const f = tierFixture({
    cursors: { rescan: dayCursor, rescan_week: weekCursor },
    config: { ...ALL_ON },
  });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  for (const kind of ALL_KINDS) expect(f.read).toHaveBeenCalledWith(tierStream(kind));
  expect(f.read).toHaveBeenCalledWith(incrementOf(tierStream('rescan')));
  expect(f.sentOf('rescan')).toEqual([
    tierWindow('rescan', Date.parse(dayCursor), PROMO_WINDOW_MS, 'update'),
  ]);
  expect(f.sentOf('rescan_week')).toEqual([
    tierWindow('rescan_week', Date.parse(weekCursor), PROMO_WINDOW_MS, 'pay'),
  ]);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow(PROMO_WINDOW_MS)]);
  expect(f.rewind).not.toHaveBeenCalled();
  expect(f.advance).not.toHaveBeenCalled();
  expect([f.cursorOf('rescan'), f.cursorOf('rescan_week')]).toEqual([dayCursor, weekCursor]);
});

it('[AC-B1-04zzr#15] 天档开关关：不读天档游标、不发天档窗，小时档照发', async () => {
  const f = tierFixture({ config: { [TAOBAO_ENABLED]: false, [PROMO_MODE]: true } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.read).not.toHaveBeenCalledWith(tierStream('rescan'));
  expect(f.kindsSent()).toEqual(['rescan_hour']);
  expect(f.sentOf('rescan_hour')).toEqual([hourWindow(PROMO_WINDOW_MS)]);
});

it('[AC-B1-04zzr#16] 小时档开关关：不读小时档游标、不发小时档窗，天档与周档照发', async () => {
  const f = tierFixture({ config: { ...ALL_ON, [HOUR_ENABLED]: false } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.read).not.toHaveBeenCalledWith(tierStream('rescan_hour'));
  expect(f.kindsSent()).toEqual(['rescan', 'rescan_week']);
});

it('[AC-B1-04zzr#17] 一个档的游标 CAS 没命中（被别处挪过）只跳过这一档，另两档照发', async () => {
  const stale = daysAgo(45);
  const f = tierFixture({ cursors: { rescan: stale }, config: { ...ALL_ON } });
  f.rewind.mockResolvedValue(false);
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.rewind).toHaveBeenCalledWith(tierStream('rescan'), stale, roundStart(30));
  expect(f.kindsSent()).toEqual(['rescan_hour', 'rescan_week']);
  expect(f.cursorOf('rescan')).toBe(stale);
});

type Fixture = ReturnType<typeof tierFixture>;

const GATES: readonly {
  readonly label: string;
  readonly shut: (f: Fixture) => void;
  readonly open: (f: Fixture) => void;
}[] = [
  {
    label: '账号不是可查询账号',
    shut: (f) => f.queryableAccount.mockResolvedValue(OTHER_ACCOUNT),
    open: (f) => f.queryableAccount.mockResolvedValue(TAOBAO_ACCOUNT),
  },
  {
    label: '平台没有可查询账号',
    shut: (f) => f.queryableAccount.mockResolvedValue(null),
    open: (f) => f.queryableAccount.mockResolvedValue(TAOBAO_ACCOUNT),
  },
  {
    label: '离线熔断打开',
    shut: (f) => f.offlineCircuitOpen.mockResolvedValue(true),
    open: (f) => f.offlineCircuitOpen.mockResolvedValue(false),
  },
  {
    label: '站长授权不可用',
    shut: (f) => f.siteAuthAvailable.mockResolvedValue(false),
    open: (f) => f.siteAuthAvailable.mockResolvedValue(true),
  },
  {
    label: 'sync_start_at 为空',
    shut: (f) =>
      f.listEnabledAccounts.mockResolvedValue([{ ...taobaoAccount, sync_start_at: null }]),
    open: (f) => f.listEnabledAccounts.mockResolvedValue([taobaoAccount]),
  },
  {
    label: 'increment 游标为空',
    shut: (f) => f.setIncrement(null),
    open: (f) => f.setIncrement(NOW),
  },
];

it.each(GATES)(
  '[AC-B1-04zzr#18] $label：三档都不发、不动游标；恢复后三档都发',
  async ({ shut, open }) => {
    const stale = daysAgo(45);
    const f = tierFixture({ cursors: { rescan: stale }, config: { ...ALL_ON } });
    shut(f);
    await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rewind).not.toHaveBeenCalled();
    expect(f.cursorOf('rescan')).toBe(stale);
    open(f);
    await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
    expect(f.kindsSent()).toEqual([...ALL_KINDS]);
    expect(f.sentOf('rescan')).toEqual([dayWindow(PROMO_WINDOW_MS)]);
  },
);

it('[AC-B1-04zzr#19] 订单源门（orderSources）为否：本轮三档都不读配置、不发；恢复后三档都发', async () => {
  const f = tierFixture({ config: { ...ALL_ON } });
  let sources = false;
  const deps = { ...f.ruleTableCaps, orderSources: () => sources };
  await scheduleOrderRescan(deps, TAOBAO);
  expect(f.config.get).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  sources = true;
  await scheduleOrderRescan(deps, TAOBAO);
  expect(f.kindsSent()).toEqual([...ALL_KINDS]);
});

it('[AC-B1-04zzr#20] 每档的终点是 min(now, increment 游标)：increment 游标落后时天档与周档的窗都不越过它', async () => {
  const behindMs = NOW_MS - 10 * DAY_MS;
  const f = tierFixture({
    increment: iso(behindMs),
    cursors: { rescan: iso(behindMs - PROMO_WINDOW_MS + 1) },
    config: { ...ALL_ON },
  });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  // The day tier is one millisecond short of a window before the increment cursor: its round ends.
  expect(f.rewind).toHaveBeenCalledWith(
    tierStream('rescan'),
    iso(behindMs - PROMO_WINDOW_MS + 1),
    roundStart(30),
  );
  expect(f.sentOf('rescan').every((win) => win['window_start'] === roundStart(30))).toBe(true);
  // The week tier starts far before it and sends its first window; the hour tier has nothing
  // before the increment cursor.
  expect(f.sentOf('rescan_week')).toEqual([weekWindow(PROMO_WINDOW_MS)]);
  expect(f.sentOf('rescan_hour')).toEqual([]);
  for (const win of f.sent()) {
    expect(Date.parse(String(win['window_end']))).toBeLessThanOrEqual(behindMs);
  }
});

it('[AC-B1-04zzr#21] 大促与窗口键只管淘宝回扫：同一轮京东仍是单档 rescan、60 分钟窗、载荷不带 timeBasis', async () => {
  const f = tierFixture({
    accounts: [jdAccount, taobaoAccount],
    config: { ...ALL_ON, [WINDOW_MINUTES]: 180 },
  });
  await scheduleOrderRescan(f.ruleTableCaps, ['jd', 'taobao']);
  const jd = f.sent().filter((win) => win['platform'] === 'jd');
  expect(jd).toEqual([rescanWindow(roundStart(30))]);
  expect(jd[0]).not.toHaveProperty('timeBasis');
  expect(jd[0]?.['union_account_id']).toBe(ACCOUNT);
  expect(f.kindsSent()).toEqual([...ALL_KINDS]);
  expect(f.sentOf('rescan')).toEqual([dayWindow(PROMO_WINDOW_MS)]);
});

it('[AC-B1-04zzr#22] 周档起点在近 90 天内：即使时钟在派发后又走了半小时，窗起点仍晚于 now − 90 天', async () => {
  const f = tierFixture({ config: { [WEEK_ENABLED]: true } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  const [week] = f.sentOf('rescan_week');
  expect(week).toBeDefined();
  const startMs = Date.parse(String(week?.['window_start']));
  expect(startMs).toBeGreaterThan(NOW_MS + 30 * MINUTE_MS - 90 * DAY_MS);
});

it('[AC-B1-04zzr#39] 小时档沿自己的游标走：游标在 now − 2 小时，从游标发 20 分钟窗、带 pay，不挪游标', async () => {
  const hourCursor = iso(NOW_MS - 2 * HOUR_MS);
  const f = tierFixture({ cursors: { rescan_hour: hourCursor } });
  await scheduleOrderRescan(f.ruleTableCaps, TAOBAO);
  expect(f.read).toHaveBeenCalledWith(tierStream('rescan_hour'));
  expect(f.sentOf('rescan_hour')).toEqual([
    tierWindow('rescan_hour', NOW_MS - 2 * HOUR_MS, HOUR_WINDOW_MS, 'pay'),
  ]);
  expect(f.rewind).not.toHaveBeenCalledWith(
    tierStream('rescan_hour'),
    expect.anything(),
    expect.anything(),
  );
  expect(f.cursorOf('rescan_hour')).toBe(hourCursor);
});

it('[AC-B1-04zzr#40] 小时档只发整窗：游标在 now − 20 分钟恰好发 [now − 20 分钟, now]；再晚 1 毫秒则本轮结束、游标回到 now − 3 小时，不补短窗', async () => {
  const fits = tierFixture({ cursors: { rescan_hour: iso(NOW_MS - HOUR_WINDOW_MS) } });
  await scheduleOrderRescan(fits.ruleTableCaps, TAOBAO);
  expect(fits.sentOf('rescan_hour')).toEqual([
    tierWindow('rescan_hour', NOW_MS - HOUR_WINDOW_MS, HOUR_WINDOW_MS, 'pay'),
  ]);

  const short = iso(NOW_MS - HOUR_WINDOW_MS + 1);
  const ends = tierFixture({ cursors: { rescan_hour: short } });
  await scheduleOrderRescan(ends.ruleTableCaps, TAOBAO);
  expect(ends.sentOf('rescan_hour')).toEqual([]);
  expect(ends.rewind).toHaveBeenCalledWith(
    tierStream('rescan_hour'),
    short,
    iso(NOW_MS - HOUR_DEPTH_MS),
  );
  expect(ends.cursorOf('rescan_hour')).toBe(iso(NOW_MS - HOUR_DEPTH_MS));
  // The day tier is not held back by the hour tier's round end.
  expect(ends.sentOf('rescan')).toEqual([dayWindow()]);
});

it('[AC-B1-04zzr#41] 小时档终点是 min(now, increment 游标)：increment 在 now − 1 小时照发首窗；在 now − 3 小时 + 19 分钟放不下一整窗则不发', async () => {
  const behind = tierFixture({ increment: iso(NOW_MS - HOUR_MS) });
  await scheduleOrderRescan(behind.ruleTableCaps, TAOBAO);
  expect(behind.sentOf('rescan_hour')).toEqual([hourWindow()]);

  const tight = tierFixture({ increment: iso(NOW_MS - HOUR_DEPTH_MS + 19 * MINUTE_MS) });
  await scheduleOrderRescan(tight.ruleTableCaps, TAOBAO);
  expect(tight.sentOf('rescan_hour')).toEqual([]);
  for (const win of tight.sent()) {
    expect(Date.parse(String(win['window_end']))).toBeLessThanOrEqual(
      NOW_MS - HOUR_DEPTH_MS + 19 * MINUTE_MS,
    );
  }
});
