// B1-10w yesterday and status rule tests (claude-independent, SPEC_REF 00959234): yesterday is
// admin's readDashboardYesterday for the app at the injected clock (B1-34q; null when there is no
// row not later than yesterday, CT-24zzk / D10-1403 ③), its fields date, links, orders,
// est_rebate_fen, new_users, as_of as that read returns them; status only with fund.view:
// payout_queue_paused (payout.queue_paused), payout_channel_paused (the channels whose
// payout.channel_paused.<channel> is on), settle_auto_enabled (settle.auto.enabled), read from the
// existing config (registry defaults when unset; a changed value is read once the switch cache has
// aged out), balance_w_expired null (W not shipped). Task brief §9 items 6–7. Real admin entry and
// PostgreSQL (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CHANNELS,
  CHANNEL_PAUSED,
  FUND_VIEW,
  QUEUE_PAUSED,
  SETTLE_AUTO,
  TIMEOUT,
  VIEW,
  dashboard,
  desk,
  newApp,
  normalizeYesterday,
  seedDay,
  setConfig,
  sources,
  useHarness,
  yesterdayView,
} from './kit.ts';

const h = useHarness();

/** Longer than every config / switch cache of the content reader (60 s, switches ≤ 10 s). */
const CACHE_AGED_MS = 61_000;

it(
  '[AC-B1-10w#8] yesterday：没有任何聚合行 → null（键仍在）；有行时各字段等于 readDashboardYesterday 的结果（昨天那行；今天的行不取）；只取本 app 的行',
  async () => {
    const d = await desk(h);
    const appId = newApp('yday');
    const other = newApp('yday_other');
    const viewer = await d.caller(appId, [VIEW]);
    const none = await dashboard(await d.get(viewer));
    expect(none.keys).toEqual(['todo', 'yesterday']);
    expect(none.yesterday).toBeNull();

    // Another app's rows never show here.
    await seedDay(h, other, '2026-10-08', {
      links: 77,
      orders: 66,
      est: 5555,
      users: 44,
      asOf: new Date('2026-10-08T16:30:00.000Z'),
    });
    expect((await dashboard(await d.get(viewer))).yesterday).toBeNull();

    // An older row, yesterday's row (2026-10-08 +08:00, the clock being 2026-10-09 10:00 +08:00)
    // and today's row: the read picks yesterday's.
    await seedDay(h, appId, '2026-10-06', {
      links: 1,
      orders: 1,
      est: 1,
      users: 1,
      asOf: new Date('2026-10-06T16:30:00.000Z'),
    });
    await seedDay(h, appId, '2026-10-08', {
      links: 1284,
      orders: 312,
      est: 158_600,
      users: 46,
      asOf: new Date('2026-10-08T16:30:00.000Z'),
    });
    await seedDay(h, appId, '2026-10-09', {
      links: 3,
      orders: 3,
      est: 3,
      users: 3,
      asOf: new Date('2026-10-09T01:00:00.000Z'),
    });
    const src = await sources();
    const read = await src.readDashboardYesterday(h.db, { appId, now: d.f.clock.now() });
    expect(read).not.toBeNull();
    expect(read!.date).toBe('2026-10-08');
    const got = await dashboard(await d.get(viewer));
    expect(got.yesterday).not.toBeNull();
    expect(Object.keys(got.yesterday!).sort()).toEqual([
      'as_of',
      'date',
      'est_rebate_fen',
      'links',
      'new_users',
      'orders',
    ]);
    expect(normalizeYesterday(got.yesterday!)).toEqual(yesterdayView(read!));
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#9] yesterday：昨天没有行时取不晚于昨天的最新一行，date 与 as_of 如实（与 readDashboardYesterday 一致）',
  async () => {
    const d = await desk(h);
    const appId = newApp('yday_stale');
    const viewer = await d.caller(appId, [VIEW]);
    expect((await dashboard(await d.get(viewer))).yesterday).toBeNull();
    await seedDay(h, appId, '2026-10-05', {
      links: 10,
      orders: 2,
      est: 300,
      users: 1,
      asOf: new Date('2026-10-05T17:10:00.000Z'),
    });
    const src = await sources();
    const read = await src.readDashboardYesterday(h.db, { appId, now: d.f.clock.now() });
    expect(read).not.toBeNull();
    expect(read!.date).toBe('2026-10-05');
    const got = await dashboard(await d.get(viewer));
    expect(got.yesterday).not.toBeNull();
    expect(normalizeYesterday(got.yesterday!)).toEqual(yesterdayView(read!));
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#10] status 只给 fund.view：没有 fund.view 无 status 键；有 fund.view 时未配置取默认（队列未暂停、无通道暂停、自动结算开），balance_w_expired 为 null',
  async () => {
    const d = await desk(h);
    const appId = newApp('status');
    const plain = await dashboard(await d.get(await d.caller(appId, [VIEW, 'withdraw.review'])));
    expect(plain.status).toBeUndefined();
    expect(plain.keys).toEqual(['todo', 'yesterday']);
    const fund = await dashboard(await d.get(await d.caller(appId, [VIEW, FUND_VIEW])));
    expect(fund.status).toEqual({
      payout_queue_paused: false,
      payout_channel_paused: [],
      settle_auto_enabled: true,
      balance_w_expired: null,
    });
    const root = await d.caller(appId, [], { superAdmin: true });
    const superAdmin = await dashboard(await d.get(root));
    expect(superAdmin.status).toEqual(fund.status);
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#11] status 三个开关按配置取值：队列暂停、bank_card 与 wechat 暂停、自动结算关 → 读到这些值；改回后（缓存过期）读到新值；另一 app 的配置不影响；W 始终为 null',
  async () => {
    const d = await desk(h);
    const appId = newApp('switches');
    const other = newApp('switches_other');
    const viewer = await d.caller(appId, [VIEW, FUND_VIEW]);
    const before = await dashboard(await d.get(viewer));
    expect(before.status).toEqual({
      payout_queue_paused: false,
      payout_channel_paused: [],
      settle_auto_enabled: true,
      balance_w_expired: null,
    });

    // Another app pauses everything: this app is unchanged.
    await setConfig(h, other, QUEUE_PAUSED, true);
    for (const channel of CHANNELS) await setConfig(h, other, CHANNEL_PAUSED(channel), true);
    await setConfig(h, other, SETTLE_AUTO, false);
    d.f.clock.advanceMs(CACHE_AGED_MS);
    expect((await dashboard(await d.get(viewer))).status).toEqual(before.status);

    await setConfig(h, appId, QUEUE_PAUSED, true);
    await setConfig(h, appId, CHANNEL_PAUSED('alipay'), false);
    await setConfig(h, appId, CHANNEL_PAUSED('bank_card'), true);
    await setConfig(h, appId, CHANNEL_PAUSED('wechat'), true);
    await setConfig(h, appId, SETTLE_AUTO, false);
    d.f.clock.advanceMs(CACHE_AGED_MS);
    const paused = await dashboard(await d.get(viewer));
    expect(paused.status).toBeDefined();
    expect({
      ...paused.status,
      payout_channel_paused: [...(paused.status!['payout_channel_paused'] as string[])].sort(),
    }).toEqual({
      payout_queue_paused: true,
      payout_channel_paused: ['bank_card', 'wechat'],
      settle_auto_enabled: false,
      balance_w_expired: null,
    });

    await setConfig(h, appId, QUEUE_PAUSED, false);
    await setConfig(h, appId, CHANNEL_PAUSED('wechat'), false);
    await setConfig(h, appId, SETTLE_AUTO, true);
    d.f.clock.advanceMs(CACHE_AGED_MS);
    expect((await dashboard(await d.get(viewer))).status).toEqual({
      payout_queue_paused: false,
      payout_channel_paused: ['bank_card'],
      settle_auto_enabled: true,
      balance_w_expired: null,
    });
  },
  TIMEOUT,
);
