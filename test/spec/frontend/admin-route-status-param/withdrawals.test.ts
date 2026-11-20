// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BASE_URL,
  NO,
  REVIEW_GRANTS,
  STATUS_NAME,
  createServer,
  samples,
  snapshot,
  withFiller,
  type Server,
} from '../admin-withdrawals/fixtures.ts';
import {
  RESET,
  action,
  choose,
  click,
  listed,
  main,
  nextPage,
  query,
  scope,
  settle,
  settled,
  tabsNamed,
} from '../admin-withdrawals/helpers.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  mountAt,
  pageSizeOf,
  shownValue,
  unmountPage,
} from './helpers.ts';

// 提现审核 opened from the workbench card at /withdrawals?status=<WithdrawalStatus>
// (listAdminWithdrawals `status`, contracts/openapi.yaml WithdrawalStatus). A contract value is the
// status filter's starting value: the 提现状态 control shows it and the very first list read already
// carries it (no read without it first). A missing, empty or non-contract value (other case,
// unknown) is ignored: no status, no error, nothing shown in the control. 【查询】【重置】, paging and
// the status tabs work as before; other address parameters change nothing.

const ALL = samples().map((item) => item.out_biz_no);
/** The 提现状态 filter (not the status tabs, not 审核方式). */
const STATUS_FILTER = /提现状态/;
/** The notice of a changed but not applied filter: the starting status is applied, not a draft. */
const DRAFT_NOTICE = /尚未应用|未应用/;
/** Addresses without a status value (the frozen tests cover the bare /withdrawals). */
const NO_VALUE = [
  '/withdrawals?status=',
  '/withdrawals?dashboard_probe=case0',
  '/withdrawals?status=&dashboard_probe=case1',
];
/** Values that are not WithdrawalStatus: lower case, other case, unknown. */
const NOT_CONTRACT = ['pending_review', 'Pending_Review', 'pending'];

/** Opens the page at `address` and waits for its list reads to finish. */
async function open(address: string, server: Server = createServer()): Promise<Server> {
  await mountAt(address, server, snapshot(REVIEW_GRANTS), BASE_URL);
  await waitFor(() => expect(server.reads().length, 'a list read').toBeGreaterThan(0));
  await settled(server);
  return server;
}
/** The query of every list read, in order. */
function queries(server: Server): Record<string, string>[] {
  return server.reads().map((read) => read.query);
}
/** The list reads (page_size other than '1'), in order; page_size=1 reads are tab counts. */
function listReadsOf(server: Server): ReturnType<Server['reads']> {
  return server.reads().filter((read) => read.query['page_size'] !== '1');
}
/** The query of every list read (page_size other than '1'), in order. */
function listQueries(server: Server): Record<string, string>[] {
  return listReadsOf(server).map((read) => read.query);
}
/** Plain code-unit order of two strings. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** A key that does not depend on the order of the query parameters. */
function queryKey(query: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(query).sort(([a], [b]) => byText(a, b)));
}
/** Queries sorted by queryKey. */
function sortedQueries(list: readonly Record<string, string>[]): Record<string, string>[] {
  return [...list].sort((a, b) => byText(queryKey(a), queryKey(b)));
}
/** The query of every tab count read (page_size '1'), sorted. */
function countQueries(server: Server): Record<string, string>[] {
  const counts = server.reads().filter((read) => read.query['page_size'] === '1');
  return sortedQueries(counts.map((read) => read.query));
}
/** The five tab count reads (全部 / 待审 / 驳回 / 手动 / 自动), each only its tab's quick filter, sorted. */
function tabCounts(): Record<string, string>[] {
  return sortedQueries([
    { page: '1', page_size: '1' },
    { display_status: 'paid_manual', page: '1', page_size: '1' },
    { display_status: 'pending_review', page: '1', page_size: '1' },
    { display_status: 'rejected', page: '1', page_size: '1' },
    { page: '1', page_size: '1', status: 'PAID_API' },
  ]);
}

it(
  '[AC-F1-14c-WITHDRAWALS#1] 进页 /withdrawals?status=PENDING_REVIEW：首个（也是唯一一个）列表请求（另有 5 个页签计数读，F1-08an）即带 status=PENDING_REVIEW，提现状态控件显示「待审核」，只列待审核的单，不报错、不提示筛选未应用',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    const size = pageSizeOf(listReadsOf(server));
    expect(listQueries(server), 'first read carries the status').toEqual([
      { page: '1', page_size: size, status: 'PENDING_REVIEW' },
    ]);
    expect(countQueries(server), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.pending]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.PENDING_REVIEW);
    expect(main().textContent, 'applied, not a draft').not.toMatch(DRAFT_NOTICE);
    expect(main().querySelector('.ant-result'), 'no error result').toBeNull();
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#2] 地址里的其他参数不影响：/withdrawals?dashboard_probe=case0&status=PAID_MANUAL&review_mode=auto&page=2 首个列表请求只带 page=1、page_size 与 status=PAID_MANUAL，控件显示「线下打款成功」，只列该单',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open(
      '/withdrawals?dashboard_probe=case0&status=PAID_MANUAL&review_mode=auto&page=2',
    );
    const size = pageSizeOf(listReadsOf(server));
    expect(listQueries(server), 'only the status is taken').toEqual([
      { page: '1', page_size: size, status: 'PAID_MANUAL' },
    ]);
    expect(countQueries(server), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.manualPaid]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.PAID_MANUAL);
    expect(main().querySelector('.ant-result'), 'no error result').toBeNull();
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#3] 带 status=PENDING_REVIEW 进页后点【重置】：只重读一次且不带 status，控件清空，七张单重新列出',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    const size = pageSizeOf(listReadsOf(server));
    expect(listQueries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
    expect(countQueries(server), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.pending]));
    const before = server.reads().length;
    await click(action(scope(), RESET));
    await settle();
    await settled(server);
    expect(queries(server).slice(before), 'one read, no status').toEqual([
      { page: '1', page_size: size },
    ]);
    await waitFor(() => expect(listed(ALL)).toEqual(ALL));
    expect(shownValue(STATUS_FILTER), 'control emptied').toBe('');
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#4] 带 status=PENDING_REVIEW 进页后把提现状态改为「已驳回」并【查询】：改选时不发请求，【查询】只发一次、带 status=REJECTED，控件显示「已驳回」，只列驳回单',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    const size = pageSizeOf(listReadsOf(server));
    expect(listQueries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
    expect(countQueries(server), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.pending]));
    const before = server.reads().length;
    await choose(scope(), STATUS_FILTER, /^已驳回$/);
    expect(shownValue(STATUS_FILTER), 'control shows the choice').toBe(STATUS_NAME.REJECTED);
    await query();
    await settled(server);
    expect(queries(server).slice(before), 'one read after 【查询】').toEqual([
      { page: '1', page_size: size, status: 'REJECTED' },
    ]);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.rejected]));
    expect(shownValue(STATUS_FILTER), 'control keeps it').toBe(STATUS_NAME.REJECTED);
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#5] 带 status=PENDING_REVIEW 进页后换页与切页签照常：第 2 页请求 page=2 仍带 status；切「待审」页签请求 page=1、display_status=pending_review 且仍带 status',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const many = createServer(withFiller(200));
    const server = await open('/withdrawals?status=PENDING_REVIEW', many);
    const size = pageSizeOf(listReadsOf(server));
    expect(listQueries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
    expect(countQueries(server), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed([NO.pending])).toEqual([NO.pending]));
    let before = server.reads().length;
    await nextPage();
    await settle();
    await settled(server);
    expect(queries(server).slice(before), 'page 2 keeps it').toEqual([
      { page: '2', page_size: size, status: 'PENDING_REVIEW' },
    ]);
    await waitFor(() => expect(listed([NO.pending])).toEqual([]));
    expect(shownValue(STATUS_FILTER), 'control keeps it').toBe(STATUS_NAME.PENDING_REVIEW);

    const tabs = tabsNamed('待审', scope());
    expect(tabs.length, 'a status tab 待审').toBeGreaterThan(0);
    before = server.reads().length;
    await click(tabs[0]!);
    await settle();
    await settled(server);
    expect(queries(server).slice(before), 'tab ANDs with it').toEqual([
      { page: '1', page_size: size, display_status: 'pending_review', status: 'PENDING_REVIEW' },
    ]);
    await waitFor(() => expect(listed([NO.pending])).toEqual([NO.pending]));
    expect(shownValue(STATUS_FILTER), 'control keeps it').toBe(STATUS_NAME.PENDING_REVIEW);
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#6] status 缺省或为空照旧：合法的 status=APPROVED 生效；而 ?status=、?dashboard_probe=case0、?status=&dashboard_probe=case1 进页时首个列表请求不带 status，控件为空，七张单全列，不报错',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const valid = await open('/withdrawals?status=APPROVED');
    const validSize = pageSizeOf(listReadsOf(valid));
    expect(listQueries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'APPROVED' },
    ]);
    expect(countQueries(valid), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.approved]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.APPROVED);
    for (const address of NO_VALUE) {
      unmountPage();
      const server = await open(address);
      const size = pageSizeOf(listReadsOf(server));
      expect(listQueries(server), address).toEqual([{ page: '1', page_size: size }]);
      expect(countQueries(server), `${address}: five tab counts`).toEqual(tabCounts());
      await waitFor(() => expect(listed(ALL), address).toEqual(ALL));
      expect(shownValue(STATUS_FILTER), address).toBe('');
      expect(main().querySelector('.ant-result'), address).toBeNull();
    }
  },
);

it(
  '[AC-F1-14c-WITHDRAWALS#7] status 不是契约枚举值照旧：合法的 status=FAILED 生效；而 pending_review（小写）、Pending_Review（大小写不同）、pending（未知值）进页时首个列表请求不带 status，控件不显示该值，七张单全列，不报错',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const valid = await open('/withdrawals?status=FAILED');
    const validSize = pageSizeOf(listReadsOf(valid));
    expect(listQueries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'FAILED' },
    ]);
    expect(countQueries(valid), 'five tab counts, no address status').toEqual(tabCounts());
    await waitFor(() => expect(listed(ALL)).toEqual([NO.failed]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.FAILED);
    for (const value of NOT_CONTRACT) {
      unmountPage();
      const server = await open(`/withdrawals?status=${value}`);
      const size = pageSizeOf(listReadsOf(server));
      expect(listQueries(server), `status=${value}`).toEqual([{ page: '1', page_size: size }]);
      expect(countQueries(server), `status=${value}: five tab counts`).toEqual(tabCounts());
      await waitFor(() => expect(listed(ALL), value).toEqual(ALL));
      expect(shownValue(STATUS_FILTER), `status=${value}`).toBe('');
      expect(main().querySelector('.ant-result'), `status=${value}`).toBeNull();
    }
  },
);

it(
  '[AC-F1-08an-COUNTS#1] 进页 /withdrawals 与 /withdrawals?status=PENDING_REVIEW：恰 5 个 page_size=1 的页签计数读（全部 / 待审 / 驳回 / 手动 / 自动，各只带该页签的快捷筛选、不带地址里的 status），列表读恰 1 条',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const bare = await open('/withdrawals');
    await waitFor(() => expect(countQueries(bare), 'five tab counts').toEqual(tabCounts()));
    await settled(bare);
    expect(countQueries(bare), 'five tab counts, once each').toEqual(tabCounts());
    expect(listQueries(bare), 'one list read').toHaveLength(1);
    unmountPage();
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    await waitFor(() => expect(countQueries(server), 'five tab counts').toEqual(tabCounts()));
    await settled(server);
    expect(countQueries(server), 'no address status in the counts').toEqual(tabCounts());
    expect(listQueries(server), 'one list read').toHaveLength(1);
  },
);
