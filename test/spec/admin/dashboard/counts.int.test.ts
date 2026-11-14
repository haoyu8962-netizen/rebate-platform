// B1-10w count, isolation and route rule tests (claude-independent, SPEC_REF 00959234): each card's
// count is the owning module's exported count function on the same database and app (D10-1401:
// payout countWithdrawReviewPending, orders countClaimsPendingReview, settlement
// countSettleBillPending, ledger countReconDiffOpen, risk countProcessingAppeals, agent
// countOverdueAgentReports at the injected clock, union countUnionAuthPending); a visible card
// with nothing waiting is returned with count 0; claim_review_pending carries the breakdown
// auto_matched / manual_review summing to count; another app's rows never change the counts; the
// routes are the contract's, verbatim. Task brief §9 items 3–5. Real admin entry and PostgreSQL;
// rows through the module kits (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CARD_KEYS,
  ROUTES,
  TIMEOUT,
  breakdownOf,
  cardOf,
  dashboard,
  desk,
  expectedCounts,
  keysOf,
  newApp,
  seedCards,
  useHarness,
  type Amounts,
  type CardKey,
  type Dashboard,
} from './kit.ts';

const h = useHarness();

// Every card gets a different number of waiting rows, in SOME (1..7) and in MORE (8..14), so the
// seven count functions return pairwise distinct values: swapping two cards' count functions, or
// wiring a card to the wrong one, changes at least one card's count. settle_bill_pending stays at
// most 9 (its bill ids are 2026-01 … 2026-09).
const SOME: Amounts = {
  settle_bill_pending: 1,
  withdraw_review_pending: 2,
  claim_review_pending: 3,
  recon_diff_open: 4,
  appeal_pending: 5,
  agent_report_overdue: 6,
  union_auth_expiring: 7,
};
const MORE: Amounts = {
  settle_bill_pending: 8,
  withdraw_review_pending: 9,
  claim_review_pending: 10,
  recon_diff_open: 11,
  appeal_pending: 12,
  agent_report_overdue: 13,
  union_auth_expiring: 14,
};

/** The expected counts are pairwise distinct (what makes a swap of two cards visible). */
function expectDistinct(counts: Record<string, number>): void {
  expect(new Set(Object.values(counts)).size, JSON.stringify(counts)).toBe(CARD_KEYS.length);
}

function countsOf(d: Dashboard): Record<string, number> {
  return Object.fromEntries(d.cards.map((card) => [card.key, card.count]));
}

it(
  '[AC-B1-10w#4] 计数正确：本 app 每张卡都有待办时，每张卡 count = 直接调用对应模块导出计数函数的结果（同一库、同一 app，agent 用注入时钟）；claim_review_pending 带 breakdown（auto_matched / manual_review 与计数函数一致）且两项之和 = count',
  async () => {
    const d = await desk(h);
    const appId = newApp('counts');
    const admin = await d.caller(appId, [], { superAdmin: true });
    // The route answers before any row is written (on main this is where the test stops).
    expect(keysOf(await dashboard(await d.get(admin)))).toEqual([...CARD_KEYS]);
    await seedCards(h, d.f, appId, SOME);
    const got = await dashboard(await d.get(admin));
    expect(keysOf(got)).toEqual([...CARD_KEYS]);
    const { counts, claims } = await expectedCounts(h, appId, d.f.clock.now());
    for (const key of CARD_KEYS) expect(counts[key], `${key} seeded`).toBeGreaterThan(0);
    expectDistinct(counts);
    expect(countsOf(got)).toEqual(counts);
    const claim = cardOf(got, 'claim_review_pending');
    const breakdown = breakdownOf(claim);
    expect(breakdown).toEqual({
      auto_matched: claims.breakdown.auto_matched,
      manual_review: claims.breakdown.manual_review,
    });
    expect(breakdown['auto_matched']! + breakdown['manual_review']!).toBe(claim.count);
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#5] 没有数据时可见的卡照样返回、count = 0（与计数函数一致），claim_review_pending 的 breakdown 两项都是 0',
  async () => {
    const d = await desk(h);
    const appId = newApp('empty');
    const got = await dashboard(await d.get(await d.caller(appId, [], { superAdmin: true })));
    expect(keysOf(got)).toEqual([...CARD_KEYS]);
    const { counts } = await expectedCounts(h, appId, d.f.clock.now());
    const zero = Object.fromEntries(CARD_KEYS.map((key) => [key, 0]));
    expect(counts).toEqual(zero);
    expect(countsOf(got)).toEqual(zero);
    // Contract AdminDashboardTodo.oldest_at: null when count is 0 (the key may also be absent).
    for (const card of got.cards) {
      expect(card.oldest_at ?? null, `${card.key} oldest_at`).toBeNull();
    }
    const claim = cardOf(got, 'claim_review_pending');
    expect(breakdownOf(claim)).toEqual({ auto_matched: 0, manual_review: 0 });
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#6] 跨 app 不串：另一 app 写入更多待办后，本 app 的每张卡计数不变且仍等于本 app 的计数函数结果；另一 app 的管理员看到的是它自己的计数',
  async () => {
    const d = await desk(h);
    const a = newApp('own');
    const b = newApp('other');
    const adminA = await d.caller(a, [], { superAdmin: true });
    const adminB = await d.caller(b, [], { superAdmin: true });
    expect(keysOf(await dashboard(await d.get(adminA)))).toEqual([...CARD_KEYS]);
    await seedCards(h, d.f, a, SOME);
    const before = countsOf(await dashboard(await d.get(adminA)));
    await seedCards(h, d.f, b, MORE);
    const now = d.f.clock.now();
    const afterA = countsOf(await dashboard(await d.get(adminA)));
    expect(afterA).toEqual(before);
    const expectedA = (await expectedCounts(h, a, now)).counts;
    expectDistinct(expectedA);
    expect(afterA).toEqual(expectedA);
    const gotB = await dashboard(await d.get(adminB));
    const expectedB = (await expectedCounts(h, b, now)).counts;
    expectDistinct(expectedB);
    expect(countsOf(gotB)).toEqual(expectedB);
    for (const key of CARD_KEYS) expect(expectedB[key], key).not.toBe(afterA[key]);
  },
  TIMEOUT,
);

it(
  '[AC-B1-10w#7] route 与契约逐字一致：settle_bill_pending → /settle-bills?awaiting_confirm=true、appeal_pending → /risk/appeals?status=processing、claim_review_pending → /claims?status=manual_review、agent_report_overdue → /agent/reports?overdue=true、union_auth_expiring → /union/accounts?auth=expiring；有无数据 route 都一样',
  async () => {
    const d = await desk(h);
    const appId = newApp('routes');
    const admin = await d.caller(appId, [], { superAdmin: true });
    const empty = await dashboard(await d.get(admin));
    await seedCards(h, d.f, appId, SOME);
    const full = await dashboard(await d.get(admin));
    for (const got of [empty, full]) {
      for (const [key, route] of Object.entries(ROUTES) as [CardKey, string][]) {
        expect(cardOf(got, key).route, key).toBe(route);
      }
    }
    expect(full.cards.map((card) => card.route)).toEqual(empty.cards.map((card) => card.route));
  },
  TIMEOUT,
);
