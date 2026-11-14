// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BASE_URL,
  RECON_GRANTS,
  REF,
  STATUS_NAME,
  createServer,
  diffs,
  snapshot,
  withFiller,
  type Server,
} from '../admin-recon/fixtures.ts';
import {
  LABEL,
  RESET,
  action,
  choose,
  click,
  main,
  nextPage,
  query,
  rowsOf,
  scope,
  settle,
  settled,
} from '../admin-recon/helpers.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  mountAt,
  pageSizeOf,
  shownValue,
  unmountPage,
} from './helpers.ts';

// 对账与差错 opened from the workbench card at /recon?status=<AdminReconDiffStatus>
// (listAdminReconDiffs `status`, contracts/openapi.yaml AdminReconDiffStatus). A contract value is
// the status filter's starting value: the 状态 control shows it and the very first list read already
// carries it (no read without it first). A missing, empty or non-contract value (other case,
// unknown) is ignored: no status, no error, nothing shown in the control. 【查询】【重置】 and paging
// work as before; other address parameters change nothing.

const REFS = diffs().map((item) => item.ref_id);
/** The 状态 filter (the only filter whose label holds 状态). */
const STATUS_FILTER = LABEL.status;
/** A status with other parameters around it (a workbench probe, a page, another filter). */
const WITH_OTHERS = '/recon?dashboard_probe=case3&status=written_off&page=2&source=R2';
/** Addresses without a status value (the frozen tests cover the bare /recon). */
const NO_VALUE = [
  '/recon?status=',
  '/recon?dashboard_probe=case0',
  '/recon?status=&dashboard_probe=case1',
];
/** Values that are not AdminReconDiffStatus: upper case, other case, unknown. */
const NOT_CONTRACT = ['OPEN', 'Open', 'pending'];

/** Opens the page at `address` and waits for its list reads to finish. */
async function open(address: string, server: Server = createServer()): Promise<Server> {
  await mountAt(address, server, snapshot(RECON_GRANTS), BASE_URL);
  await waitFor(() => expect(server.reads().length, 'a list read').toBeGreaterThan(0));
  await settled(server);
  return server;
}
/** The query of every list read, in order. */
function queries(server: Server): Record<string, string>[] {
  return server.reads().map((read) => read.query);
}
/** The sample refs (of the six differences) that have a row in the list. */
function listed(): string[] {
  return REFS.filter((ref) => rowsOf(scope(), [ref]).length > 0);
}

it(
  '[AC-F1-14c-RECON#1] 进页 /recon?status=open：首个（也是唯一一个）列表请求即带 status=open，状态控件显示「待处理」，只列待处理的两条差错单，不报错',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/recon?status=open');
    const size = pageSizeOf(server.reads());
    expect(queries(server), 'first read carries the status').toEqual([
      { page: '1', page_size: size, status: 'open' },
    ]);
    await waitFor(() => expect(listed()).toEqual([REF.ledger, REF.appeal]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.open);
    expect(main().querySelector('.ant-result'), 'no error result').toBeNull();
  },
);

it(
  '[AC-F1-14c-RECON#2] 地址里的其他参数不影响：/recon?dashboard_probe=case3&status=written_off&page=2&source=R2 首个列表请求只带 page=1、page_size 与 status=written_off，控件显示「已核销」，只列该条',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open(WITH_OTHERS);
    const size = pageSizeOf(server.reads());
    expect(queries(server), 'only the status is taken').toEqual([
      { page: '1', page_size: size, status: 'written_off' },
    ]);
    await waitFor(() => expect(listed()).toEqual([REF.settle]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.written_off);
    expect(main().querySelector('.ant-result'), 'no error result').toBeNull();
  },
);

it(
  '[AC-F1-14c-RECON#3] 带 status=open 进页后点【重置】：只重读一次且不带 status，控件清空，六条差错单重新列出',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/recon?status=open');
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'open' }]);
    await waitFor(() => expect(listed()).toEqual([REF.ledger, REF.appeal]));
    const before = server.reads().length;
    await click(action(scope(), RESET));
    await settle();
    await settled(server);
    expect(queries(server).slice(before), 'one read, no status').toEqual([
      { page: '1', page_size: size },
    ]);
    await waitFor(() => expect(listed()).toEqual(REFS));
    expect(shownValue(STATUS_FILTER), 'control emptied').toBe('');
  },
);

it(
  '[AC-F1-14c-RECON#4] 带 status=open 进页后把状态改为「处理中」并【查询】：改选时不发请求，【查询】只发一次、带 status=processing，控件显示「处理中」，只列处理中的差错单',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = await open('/recon?status=open');
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'open' }]);
    await waitFor(() => expect(listed()).toEqual([REF.ledger, REF.appeal]));
    const before = server.reads().length;
    await choose(scope(), STATUS_FILTER, /^处理中$/);
    expect(shownValue(STATUS_FILTER), 'control shows the choice').toBe(STATUS_NAME.processing);
    await query();
    await settled(server);
    expect(queries(server).slice(before), 'one read after 【查询】').toEqual([
      { page: '1', page_size: size, status: 'processing' },
    ]);
    await waitFor(() => expect(listed()).toEqual([REF.channel]));
    expect(shownValue(STATUS_FILTER), 'control keeps it').toBe(STATUS_NAME.processing);
  },
);

it(
  '[AC-F1-14c-RECON#5] 带 status=open 进页后换页照常：第 2 页请求 page=2（同一 page_size）仍带 status=open，控件仍显示「待处理」',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const many = createServer(withFiller(200));
    const server = await open('/recon?status=open', many);
    const size = pageSizeOf(server.reads());
    expect(queries(server)).toEqual([{ page: '1', page_size: size, status: 'open' }]);
    await waitFor(() => expect(listed()).toEqual([REF.ledger, REF.appeal]));
    const before = server.reads().length;
    await nextPage();
    await settle();
    await settled(server);
    expect(queries(server).slice(before), 'page 2 keeps it').toEqual([
      { page: '2', page_size: size, status: 'open' },
    ]);
    await waitFor(() => expect(listed()).toEqual([]));
    expect(shownValue(STATUS_FILTER), 'control keeps it').toBe(STATUS_NAME.open);
  },
);

it(
  '[AC-F1-14c-RECON#6] status 缺省或为空照旧：合法的 status=closed 生效；而 ?status=、?dashboard_probe=case0、?status=&dashboard_probe=case1 进页时首个列表请求不带 status，控件为空，六条差错单全列，不报错',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const valid = await open('/recon?status=closed');
    const validSize = pageSizeOf(valid.reads());
    expect(queries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'closed' },
    ]);
    await waitFor(() => expect(listed()).toEqual([REF.union]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.closed);
    for (const address of NO_VALUE) {
      unmountPage();
      const server = await open(address);
      const size = pageSizeOf(server.reads());
      expect(queries(server), address).toEqual([{ page: '1', page_size: size }]);
      await waitFor(() => expect(listed(), address).toEqual(REFS));
      expect(shownValue(STATUS_FILTER), address).toBe('');
      expect(main().querySelector('.ant-result'), address).toBeNull();
    }
  },
);

it(
  '[AC-F1-14c-RECON#7] status 不是契约枚举值照旧：合法的 status=adjusted 生效；而 OPEN（大写）、Open（大小写不同）、pending（未知值）进页时首个列表请求不带 status，控件不显示该值，六条差错单全列，不报错',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const valid = await open('/recon?status=adjusted');
    const validSize = pageSizeOf(valid.reads());
    expect(queries(valid), 'contract value applied').toEqual([
      { page: '1', page_size: validSize, status: 'adjusted' },
    ]);
    await waitFor(() => expect(listed()).toEqual([REF.monthEnd]));
    expect(shownValue(STATUS_FILTER), 'control shows it').toBe(STATUS_NAME.adjusted);
    for (const value of NOT_CONTRACT) {
      unmountPage();
      const server = await open(`/recon?status=${value}`);
      const size = pageSizeOf(server.reads());
      expect(queries(server), `status=${value}`).toEqual([{ page: '1', page_size: size }]);
      await waitFor(() => expect(listed(), value).toEqual(REFS));
      expect(shownValue(STATUS_FILTER), `status=${value}`).toBe('');
      expect(main().querySelector('.ant-result'), `status=${value}`).toBeNull();
    }
  },
);
