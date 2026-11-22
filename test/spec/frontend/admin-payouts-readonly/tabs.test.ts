// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  EXECUTE,
  LOOKUP,
  QNO,
  REVIEW,
  VIEW,
  VIEW_EXECUTE,
  createPayoutServer,
  type Grants,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  FORBIDDEN,
  MULTI_TIMEOUT,
  SUPER,
  TAB,
  everyGrant,
  listed,
  main,
  mount,
  openTab,
  pageSizeOf,
  pageTabNames,
  panelOf,
  settled,
  tabsIn,
  textOf,
} from './helpers.ts';

// F1-08ba ①: the page tabs of /withdrawals. An account holding fund.view or payout.execute (a super
// admin holds every point) sees 「审核列表」「打款队列」「结果待确认」, in that order, with 审核列表
// selected and working as before; neither the payout overview nor the unknown results are read
// until their tab is entered. Without both points the two tabs are not there and neither is read.

/** The review list's rows of the queue samples (every status, newest applied first). */
const REVIEW_ROWS = [
  QNO.approvedA,
  QNO.paying,
  QNO.pending,
  QNO.approvedB,
  QNO.stuck,
  QNO.paid,
  QNO.untried,
];
const PAGE_TABS = [TAB.review, TAB.queue, TAB.unknown];

interface Account {
  readonly name: string;
  readonly grants: Grants;
  readonly snapshot: ReturnType<typeof everyGrant>;
}

it(
  '[AC-F1-08ba-TABS#1] 持 fund.view + payout.execute 进 /withdrawals：页签依次为「审核列表」「打款队列」「结果待确认」，默认选中审核列表并照旧只读一次列表（另有 5 个页签计数读，F1-08an）（只带 page 与 page_size）、列出全部提现单；未进页签前不请求 payout-overview 与 unknown-payouts',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await waitFor(() => expect(pageTabNames()).toEqual(PAGE_TABS));
    const review = tabsIn(main(), TAB.review)[0]!;
    const selected = review.getAttribute('aria-selected');
    expect(selected, 'the review list is selected by default').toBe('true');
    const panel = await panelOf(review);
    await listed(panel, REVIEW_ROWS);
    await settled(server);
    const lists = server.listReads().filter((read) => read.query['page_size'] !== '1');
    const size = pageSizeOf(lists);
    const queries = lists.map((read) => read.query);
    expect(queries, 'one review list read').toEqual([{ page: '1', page_size: size }]);
    const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const key = (query: Readonly<Record<string, string>>): string =>
      JSON.stringify(Object.entries(query).sort(([a], [b]) => byText(a, b)));
    const sorted = (list: readonly Record<string, string>[]): Record<string, string>[] =>
      [...list].sort((a, b) => byText(key(a), key(b)));
    const counts = server.listReads().filter((read) => read.query['page_size'] === '1');
    expect(sorted(counts.map((read) => read.query)), 'five tab counts').toEqual(
      sorted([
        { page: '1', page_size: '1' },
        { display_status: 'paid_manual', page: '1', page_size: '1' },
        { display_status: 'pending_review', page: '1', page_size: '1' },
        { display_status: 'rejected', page: '1', page_size: '1' },
        { page: '1', page_size: '1', status: 'PAID_API' },
      ]),
    );
    expect(server.overviewReads(), 'no overview read before its tab').toEqual([]);
    expect(server.unknownReads(), 'no unknown read before its tab').toEqual([]);
  },
);

it(
  '[AC-F1-08ba-TABS#2] 只持 fund.view、只持 payout.execute：都见三个页签，超管见四个页签（另有「自动到账设置」，F1-08ap），都默认审核列表（只持 payout.execute 时审核列表显示无权限、不读提现单）；只持 withdraw.review 或只持 user.lookup：不见「打款队列」「结果待确认」；未进页签时都不请求 payout-overview 与 unknown-payouts',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const PAGE_TABS_WITH_SETTINGS = [TAB.review, TAB.queue, TAB.unknown, '自动到账设置'];
    const seeing: readonly Account[] = [
      { name: 'fund.view', grants: VIEW, snapshot: everyGrant(VIEW) },
      { name: 'payout.execute', grants: EXECUTE, snapshot: everyGrant(EXECUTE) },
      { name: 'super', grants: VIEW_EXECUTE, snapshot: SUPER },
    ];
    for (const account of seeing) {
      const server = createPayoutServer({ permissions: account.grants });
      await mount(server, account.snapshot);
      const tabs = account.name === 'super' ? PAGE_TABS_WITH_SETTINGS : PAGE_TABS;
      await waitFor(() => expect(pageTabNames(), account.name).toEqual(tabs));
      const review = tabsIn(main(), TAB.review)[0]!;
      const selected = review.getAttribute('aria-selected');
      expect(selected, `${account.name}: the review list is selected`).toBe('true');
      const panel = await panelOf(review);
      if (account.grants === EXECUTE) {
        await waitFor(() => expect(textOf(panel), account.name).toMatch(FORBIDDEN));
        await settled(server);
        expect(server.listReads(), `${account.name}: no withdrawal read`).toEqual([]);
      } else {
        await listed(panel, REVIEW_ROWS);
        await settled(server);
      }
      expect(server.overviewReads(), `${account.name}: no overview read`).toEqual([]);
      expect(server.unknownReads(), `${account.name}: no unknown read`).toEqual([]);
      cleanup();
    }

    const hidden: readonly Account[] = [
      { name: 'withdraw.review', grants: REVIEW, snapshot: everyGrant(REVIEW) },
      { name: 'user.lookup', grants: LOOKUP, snapshot: everyGrant(LOOKUP) },
    ];
    for (const account of hidden) {
      const server = createPayoutServer({ permissions: account.grants });
      await mount(server, account.snapshot);
      await settled(server);
      expect(tabsIn(main(), TAB.queue), `${account.name}: no queue tab`).toEqual([]);
      expect(tabsIn(main(), TAB.unknown), `${account.name}: no unknown tab`).toEqual([]);
      expect(server.overviewReads(), `${account.name}: no overview read`).toEqual([]);
      expect(server.unknownReads(), `${account.name}: no unknown read`).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08ba-TABS#3] 进「打款队列」只读一次 payout-overview（不带参数）、不读 unknown-payouts；进「结果待确认」只读一次 unknown-payouts；再回「审核列表」，审核列表的行照旧（全部状态、申请时间倒序）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await openTab(TAB.queue);
    await waitFor(() => expect(server.overviewReads()).toHaveLength(1));
    await settled(server);
    const overviewQueries = server.overviewReads().map((read) => read.query);
    expect(overviewQueries, 'one overview read without parameters').toEqual([{}]);
    expect(server.unknownReads(), 'no unknown read in the queue tab').toEqual([]);
    await openTab(TAB.unknown);
    await waitFor(() => expect(server.unknownReads()).toHaveLength(1));
    await settled(server);
    expect(server.unknownReads(), 'one unknown read').toHaveLength(1);
    const review = await openTab(TAB.review);
    await listed(review, REVIEW_ROWS);
  },
);

it(
  '[AC-F1-08an-COUNTS#1] 持 fund.view + payout.execute 进 /withdrawals：恰 5 个 page_size=1 的页签计数读（全部 / 待审 / 驳回 / 手动 / 自动，各只带该页签的快捷筛选），审核列表的列表读恰 1 条',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const key = (query: Readonly<Record<string, string>>): string =>
      JSON.stringify(Object.entries(query).sort(([a], [b]) => byText(a, b)));
    const sorted = (list: readonly Record<string, string>[]): Record<string, string>[] =>
      [...list].sort((a, b) => byText(key(a), key(b)));
    const expected = sorted([
      { page: '1', page_size: '1' },
      { display_status: 'paid_manual', page: '1', page_size: '1' },
      { display_status: 'pending_review', page: '1', page_size: '1' },
      { display_status: 'rejected', page: '1', page_size: '1' },
      { page: '1', page_size: '1', status: 'PAID_API' },
    ]);
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const countsOf = (): Record<string, string>[] => {
      const counts = server.listReads().filter((read) => read.query['page_size'] === '1');
      return sorted(counts.map((read) => read.query));
    };
    await mount(server, everyGrant(VIEW_EXECUTE));
    await waitFor(() => expect(pageTabNames()).toEqual(PAGE_TABS));
    const review = tabsIn(main(), TAB.review)[0]!;
    await listed(await panelOf(review), REVIEW_ROWS);
    await waitFor(() => expect(countsOf(), 'five tab counts').toEqual(expected));
    await settled(server);
    expect(countsOf(), 'five tab counts, once each').toEqual(expected);
    const lists = server.listReads().filter((read) => read.query['page_size'] !== '1');
    expect(lists, 'one review list read').toHaveLength(1);
  },
);
