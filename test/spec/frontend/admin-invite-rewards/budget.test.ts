// @vitest-environment jsdom
// F1-15b: the configuration center's invite group shows the invite reward budget used and left
// (BR-INV-24 ④; limits = config items growth.invite_reward.daily_budget_fen / total_budget_fen,
// used = `budget` of GET /admin/v1/invite-rewards) with an entry to the record subpage, both
// only for accounts with fund.view. Remaining = limit − used; a negative remainder shows 0.00.
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { REWARDS, configRows, createRewardServer } from './fixtures.ts';
import {
  ANY_FIGURE,
  CONFIG_ONLY,
  FUND_AND_CONFIG,
  NO_PERMISSION,
  RESERVED,
  SUBPAGE,
  TODAY_GRANTED,
  TODAY_LEFT,
  TOTAL_GRANTED,
  TOTAL_LEFT,
  breadcrumb,
  click,
  entries,
  expectFigure,
  mainElement,
  menuLink,
  mountAt,
  openBudgetGroup,
  reset,
  settled,
  squash,
} from './helpers.ts';

it(
  '[AC-F1-15b-BUDGET#1] 有 fund.view：邀请奖励分组显示今日已发、今日剩余、累计已占用、累计已发、累计剩余（上限取配置项）',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, '/config');
    await openBudgetGroup(server);
    // Daily limit 200.00, total limit 1,000.00 (config rows); used 30.00 today, 120.00 + 450.00.
    await waitFor(() => expectFigure(TODAY_GRANTED, 3000n));
    expectFigure(TODAY_LEFT, 17000n);
    expectFigure(RESERVED, 12000n);
    expectFigure(TOTAL_GRANTED, 45000n);
    expectFigure(TOTAL_LEFT, 43000n);
    await settled(server);
    const reads = server.rewardRequests();
    expect(reads.length, 'the used budget is read from the list endpoint').toBeGreaterThan(0);
    for (const request of reads) {
      expect(request.method).toBe('GET');
      expect(request.path).toBe(REWARDS);
      // The budget does not depend on filters: none is sent for it.
      const filters = Object.keys(request.query).filter((name) => !name.startsWith('page'));
      expect(filters).toEqual([]);
    }
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
);

it(
  '[AC-F1-15b-BUDGET#2] 已用超过上限时剩余显示 0.00 不显示负数；总预算上限 0 照算为 0.00，不写成不限',
  { timeout: 40_000 },
  async () => {
    // Daily limit 20.00 < 30.00 granted today; total limit 0 (未填).
    const server = createRewardServer({ rows: configRows(2000, 0) });
    await mountAt(server, '/config');
    await openBudgetGroup(server);
    await waitFor(() => expectFigure(TODAY_GRANTED, 3000n));
    expectFigure(TODAY_LEFT, 0n);
    expectFigure(RESERVED, 12000n);
    expectFigure(TOTAL_GRANTED, 45000n);
    expectFigure(TOTAL_LEFT, 0n);
    expect(squash(mainElement().textContent)).not.toMatch(/不限|无上限|无限/);
  },
);

it(
  '[AC-F1-15b-BUDGET#3] 非超管有 fund.view 与配置权限：同样显示预算用量与「发放记录」入口',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, '/config', FUND_AND_CONFIG);
    await openBudgetGroup(server);
    await waitFor(() => expectFigure(TODAY_GRANTED, 3000n));
    expectFigure(TOTAL_LEFT, 43000n);
    expect(entries(), 'one entry to the record subpage').toHaveLength(1);
  },
);

it(
  '[AC-F1-15b-BUDGET#4] 从邀请奖励分组的「发放记录」入口进入子页：地址 /invite-rewards，面包屑与侧栏归配置中心',
  { timeout: 40_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, '/config');
    await openBudgetGroup(server);
    await waitFor(() => expect(entries(), 'one 发放记录 entry').toHaveLength(1));
    const before = server.requests('GET', REWARDS).length;
    await click(entries()[0]!);
    await waitFor(() => expect(window.location.pathname).toBe(SUBPAGE));
    await waitFor(() => expect(server.requests('GET', REWARDS).length).toBeGreaterThan(before));
    await waitFor(() => expect(breadcrumb().slice(0, 2)).toEqual(['规则与配置', '配置中心']));
    expect(breadcrumb()).toHaveLength(3);
    expect(breadcrumb()[2]).toMatch(/发放记录/);
    expect(menuLink('配置中心').getAttribute('aria-current')).toBe('page');
  },
);

it(
  '[AC-F1-15b-BUDGET#5] 无 fund.view：配置中心不显示预算块与入口、不请求发放记录；直达 /invite-rewards 显示无权限',
  { timeout: 60_000 },
  async () => {
    const server = createRewardServer();
    await mountAt(server, '/config', CONFIG_ONLY);
    await openBudgetGroup(server);
    expect(squash(mainElement().textContent)).not.toMatch(ANY_FIGURE);
    expect(entries()).toEqual([]);
    expect(server.rewardRequests()).toEqual([]);
    reset();
    const direct = createRewardServer();
    await mountAt(direct, SUBPAGE, CONFIG_ONLY);
    await waitFor(() => expect(mainElement().textContent).toMatch(NO_PERMISSION));
    await settled(direct);
    expect(window.location.pathname).toBe(SUBPAGE);
    expect(direct.rewardRequests()).toEqual([]);
  },
);
