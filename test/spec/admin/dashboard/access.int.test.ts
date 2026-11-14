// B1-10w access and trimming rule tests (claude-independent, SPEC_REF 00959234): adminGetDashboard
// is guarded by dashboard.view alone (10403 data.reason=admin_permission_denied without it, 10001
// without a token); the server trims todo[] to the card points the account holds, in enum order,
// beneficiary_held_overdue never (D10-1402, even with risk.freeze); yesterday is always there with
// dashboard.view; status only with fund.view. Task brief §9 items 1–2. Real admin entry and
// PostgreSQL (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CARDS,
  CARD_KEYS,
  CARD_POINTS,
  FUND_VIEW,
  HELD_KEY,
  HELD_POINT,
  TIMEOUT,
  VIEW,
  answer,
  dashboard,
  denied,
  desk,
  keysOf,
  newApp,
  normalizeYesterday,
  seedDay,
  sources,
  useHarness,
  yesterdayView,
} from './kit.ts';

const h = useHarness();

it(
  '[AC-B1-10w#1] 只认 dashboard.view：持有时 200（不持任何卡点：todo 为空数组、yesterday 照返回、没有 status 键）；不持 dashboard.view（什么都不持、持全部卡点与 fund.view、持 risk.freeze）→ 10403 data.reason=admin_permission_denied；不带令牌 → 10001',
  async () => {
    const d = await desk(h);
    const appId = newApp('access');
    const asOf = new Date('2026-10-08T17:00:00.000Z');
    await seedDay(h, appId, '2026-10-08', { links: 9, orders: 4, est: 1234, users: 2, asOf });

    const viewer = await d.caller(appId, [VIEW]);
    const plain = await dashboard(await d.get(viewer));
    expect(plain.cards).toEqual([]);
    expect(plain.keys).toEqual(['todo', 'yesterday']);
    expect(plain.status).toBeUndefined();
    const src = await sources();
    const read = await src.readDashboardYesterday(h.db, {
      appId,
      now: d.f.clock.now(),
    });
    expect(read, 'the seeded row').not.toBeNull();
    expect(plain.yesterday).not.toBeNull();
    expect(normalizeYesterday(plain.yesterday!)).toEqual(yesterdayView(read!));

    for (const points of [[], [...CARD_POINTS, FUND_VIEW], [HELD_POINT]]) {
      await denied(await d.get(await d.caller(appId, points)));
    }
    await answer(await d.get(null), 10001);
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#2] 逐张裁剪：dashboard.view 加某一张卡的点 → todo 恰好只有那张卡；加 risk.freeze → 不出 beneficiary_held_overdue（todo 为空）；加 fund.view → todo 为空、带 status',
  async () => {
    const d = await desk(h);
    const appId = newApp('trim');
    for (const [key, point] of CARDS) {
      const one = await dashboard(await d.get(await d.caller(appId, [VIEW, point])));
      expect(keysOf(one), point).toEqual([key]);
      expect(one.status, point).toBeUndefined();
    }
    const held = await dashboard(await d.get(await d.caller(appId, [VIEW, HELD_POINT])));
    expect(keysOf(held)).toEqual([]);
    const fund = await dashboard(await d.get(await d.caller(appId, [VIEW, FUND_VIEW])));
    expect(keysOf(fund)).toEqual([]);
    expect(fund.keys).toEqual(['status', 'todo', 'yesterday']);
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#3] 超级管理员与持全部点的账号：七张卡全出，恰为契约 enum 去掉 beneficiary_held_overdue 的七个 key、按 enum 顺序；beneficiary_held_overdue 不出现（即使持 risk.freeze）；都带 status',
  async () => {
    const d = await desk(h);
    const appId = newApp('all');
    const root = await d.caller(appId, [], { superAdmin: true });
    const superAdmin = await dashboard(await d.get(root));
    expect(keysOf(superAdmin)).toEqual([...CARD_KEYS]);
    expect(superAdmin.keys).toEqual(['status', 'todo', 'yesterday']);
    const everything = await dashboard(
      await d.get(await d.caller(appId, [VIEW, FUND_VIEW, HELD_POINT, ...CARD_POINTS])),
    );
    expect(keysOf(everything)).toEqual([...CARD_KEYS]);
    expect(everything.keys).toEqual(['status', 'todo', 'yesterday']);
    for (const d2 of [superAdmin, everything]) expect(keysOf(d2)).not.toContain(HELD_KEY);
    // Two points of the same account: exactly those two cards, enum order.
    const two = await dashboard(
      await d.get(await d.caller(appId, [VIEW, 'union.account_auth', 'withdraw.review'])),
    );
    expect(keysOf(two)).toEqual(['withdraw_review_pending', 'union_auth_expiring']);
  },
  TIMEOUT,
);
