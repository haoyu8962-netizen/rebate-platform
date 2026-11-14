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

it(
  '[AC-F1-14c-WITHDRAWALS#1] 进页 /withdrawals?status=PENDING_REVIEW：首个（也是唯一一个）列表请求即带 status=PENDING_REVIEW，提现状态控件显示「待审核」，只列待审核的单，不报错、不提示筛选未应用',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/withdrawals?status=PENDING_REVIEW');
    const size = pageSizeOf(server.reads());
    expect(queries(server), 'first read carries the status').toEqual([
      { page: '1', page_size: size, status: 'PENDING_REVIEW' },
    ]);
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
    const size = pageSizeOf(server.reads());
    expect(queries(server), 'only the status is taken').toEqual([
      { page: '1', page_size: size, status: 'PAID_MANUAL' },
    ]);
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
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
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
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
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
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'PENDING_REVIEW' }]);
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
    const validSize = pageSizeOf(valid.reads());
    expect(queries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'APPROVED' },
    ]);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.approved]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.APPROVED);
    for (const address of NO_VALUE) {
      unmountPage();
      const server = await open(address);
      const size = pageSizeOf(server.reads());
      expect(queries(server), address).toEqual([{ page: '1', page_size: size }]);
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
    const validSize = pageSizeOf(valid.reads());
    expect(queries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'FAILED' },
    ]);
    await waitFor(() => expect(listed(ALL)).toEqual([NO.failed]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.FAILED);
    for (const value of NOT_CONTRACT) {
      unmountPage();
      const server = await open(`/withdrawals?status=${value}`);
      const size = pageSizeOf(server.reads());
      expect(queries(server), `status=${value}`).toEqual([{ page: '1', page_size: size }]);
      await waitFor(() => expect(listed(ALL), value).toEqual(ALL));
      expect(shownValue(STATUS_FILTER), `status=${value}`).toBe('');
      expect(main().querySelector('.ant-result'), `status=${value}`).toBeNull();
    }
  },
);
