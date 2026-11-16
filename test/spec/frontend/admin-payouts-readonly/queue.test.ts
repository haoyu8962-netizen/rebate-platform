// @vitest-environment jsdom
import { waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  QID,
  QNO,
  STATUS_SHOWN,
  VIEW_EXECUTE,
  approvedFiller,
  createPayoutServer,
  fillerNo,
  queueSamples,
  type PayoutServer,
} from './fixtures.ts';
import {
  COLUMN,
  ENTRY,
  FLOW_TIMEOUT,
  SUB_TAB,
  TAB,
  cellsOf,
  click,
  entry,
  everyGrant,
  gridWith,
  listed,
  mount,
  openTab,
  pageHeading,
  pageSizeOf,
  pageTwo,
  queriesByStatus,
  rowIn,
  selectTab,
  settled,
  squash,
} from './helpers.ts';

// F1-08ba ②: the queue table of 打款队列 reads listAdminWithdrawals (GET /admin/v1/withdrawals) with
// the contract's status filter only: 待执行 = status=APPROVED, 打款中 = status=PAYING, and 全部 = both
// (the filter takes one status, so one read of each, page 1, rows merged newest applied first).
// Every read carries exactly page, page_size and status. Switching the queue tabs and paging work as
// usual; 【详情】 of a row opens withdrawals/{id}.

/** The queue samples by status, newest applied first. */
const APPROVED_ROWS = [QNO.approvedA, QNO.approvedB];
const PAYING_ROWS = [QNO.paying, QNO.stuck, QNO.untried];
const ALL_ROWS = [QNO.approvedA, QNO.paying, QNO.approvedB, QNO.stuck, QNO.untried];

/** The list reads of `server` from index `from` on. */
function readsSince(server: PayoutServer, from: number) {
  return server.listReads().slice(from);
}

async function openQueue(server: PayoutServer): Promise<{ panel: HTMLElement; size: string }> {
  await mount(server, everyGrant(VIEW_EXECUTE));
  await settled(server);
  const before = server.listReads().length;
  const panel = await openTab(TAB.queue);
  await waitFor(() => expect(readsSince(server, before).length).toBeGreaterThan(0));
  await settled(server);
  return { panel, size: pageSizeOf(readsSince(server, before)) };
}

it(
  '[AC-F1-08ba-QUEUE#1] 进「打款队列」：队列页签依次为「全部」「打款中」「待执行」、默认「全部」；全部 = 两个请求 {page:1, page_size, status:APPROVED} 与 {page:1, page_size, status:PAYING}（别无其他列表请求），列出 5 张已通过待打款与打款中的单（申请时间倒序），不列待审核与已成功的单',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    await mount(server, everyGrant(VIEW_EXECUTE));
    await settled(server);
    const before = server.listReads().length;
    const panel = await openTab(TAB.queue);
    await listed(panel, ALL_ROWS);
    await settled(server);
    const reads = readsSince(server, before);
    const size = pageSizeOf(reads);
    expect(queriesByStatus(reads), '全部 reads both statuses').toEqual([
      { page: '1', page_size: size, status: 'APPROVED' },
      { page: '1', page_size: size, status: 'PAYING' },
    ]);
    const queueTabs = within(panel).queryAllByRole('tab', { hidden: true });
    const names = queueTabs.map((tab) => squash(tab.textContent));
    expect(names, 'queue tabs').toEqual([SUB_TAB.all, SUB_TAB.paying, SUB_TAB.approved]);
    const all = await selectTab(panel, SUB_TAB.all);
    expect(all.getAttribute('aria-selected')).toBe('true');
  },
);

it(
  '[AC-F1-08ba-QUEUE#2] 切「打款中」只发 {page:1, page_size, status:PAYING} 并列 3 张打款中的单；切「待执行」只发 {page:1, page_size, status:APPROVED} 并列 2 张；切回「全部」再发两个状态各一次并列 5 张',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const { panel, size } = await openQueue(server);
    await listed(panel, ALL_ROWS);

    let before = server.listReads().length;
    await selectTab(panel, SUB_TAB.paying);
    await listed(panel, PAYING_ROWS);
    await settled(server);
    expect(queriesByStatus(readsSince(server, before)), '打款中').toEqual([
      { page: '1', page_size: size, status: 'PAYING' },
    ]);

    before = server.listReads().length;
    await selectTab(panel, SUB_TAB.approved);
    await listed(panel, APPROVED_ROWS);
    await settled(server);
    expect(queriesByStatus(readsSince(server, before)), '待执行').toEqual([
      { page: '1', page_size: size, status: 'APPROVED' },
    ]);

    before = server.listReads().length;
    await selectTab(panel, SUB_TAB.all);
    await listed(panel, ALL_ROWS);
    await settled(server);
    expect(queriesByStatus(readsSince(server, before)), '全部').toEqual([
      { page: '1', page_size: size, status: 'APPROVED' },
      { page: '1', page_size: size, status: 'PAYING' },
    ]);
  },
);

it(
  '[AC-F1-08ba-QUEUE#3] 队列表的实付金额与状态列：实付经 @couli/money（¥500.00、¥98.00、¥1,210.11、¥100.00、¥200.00），状态列只显示后台字典的状态名（已通过待打款 / 打款中）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const { panel } = await openQueue(server);
    await listed(panel, ALL_ROWS);
    const grid = gridWith(panel, COLUMN.net);
    expect(cellsOf(grid, [COLUMN.net, COLUMN.status])).toEqual([
      ['¥500.00', STATUS_SHOWN.APPROVED],
      ['¥98.00', STATUS_SHOWN.PAYING],
      ['¥1,210.11', STATUS_SHOWN.APPROVED],
      ['¥100.00', STATUS_SHOWN.PAYING],
      ['¥200.00', STATUS_SHOWN.PAYING],
    ]);
  },
);

it(
  '[AC-F1-08ba-QUEUE#4] 「待执行」42 张时分页照常：第 1 页 {page:1, page_size, status:APPROVED} 列前 page_size 张，点第 2 页只发 {page:2, page_size, status:APPROVED} 并列下一段（申请时间倒序）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({
      withdrawals: [...queueSamples(), ...approvedFiller(40)],
      permissions: VIEW_EXECUTE,
    });
    const { panel } = await openQueue(server);
    let before = server.listReads().length;
    await selectTab(panel, SUB_TAB.approved);
    await waitFor(() => expect(readsSince(server, before).length).toBeGreaterThan(0));
    await settled(server);
    const size = pageSizeOf(readsSince(server, before));
    expect(queriesByStatus(readsSince(server, before)), 'page 1').toEqual([
      { page: '1', page_size: size, status: 'APPROVED' },
    ]);
    const approved = [
      ...APPROVED_ROWS,
      ...Array.from({ length: 40 }, (_, index) => fillerNo(index + 1)),
    ];
    const count = Number(size);
    await listed(panel, approved.slice(0, count));

    before = server.listReads().length;
    await pageTwo(panel);
    await settled(server);
    expect(queriesByStatus(readsSince(server, before)), 'page 2').toEqual([
      { page: '2', page_size: size, status: 'APPROVED' },
    ]);
    await listed(panel, approved.slice(count, count * 2));
  },
);

it(
  '[AC-F1-08ba-QUEUE#5] 队列行【详情】进 withdrawals/{id}：读该单详情并显示该单号',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const { panel } = await openQueue(server);
    await listed(panel, ALL_ROWS);
    const grid = gridWith(panel, COLUMN.net);
    await click(entry(rowIn(grid, QNO.approvedA), ENTRY.detail));
    await waitFor(() => expect(server.detailReads(QID.approvedA).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(pageHeading()).toBe(QNO.approvedA));
  },
);
