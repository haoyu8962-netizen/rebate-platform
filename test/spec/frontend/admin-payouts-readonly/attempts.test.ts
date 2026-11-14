// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DASH,
  KIND_SHOWN,
  QID,
  QNO,
  RESULT_SHOWN,
  STATUS_SHOWN,
  UNLISTED,
  VIEW_EXECUTE,
  createPayoutServer,
  oddSample,
  queueSamples,
  type PayoutServer,
} from './fixtures.ts';
import {
  COLUMN,
  EMPTY,
  ENTRY,
  FIELD,
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  SUB_TAB,
  TAB,
  cellsOf,
  click,
  entry,
  everyGrant,
  gridWith,
  listed,
  mount,
  openDialog,
  openTab,
  rowIn,
  selectTab,
  settled,
  textOf,
  values,
  writeEntries,
  type Grid,
} from './helpers.ts';

// F1-08ba ④: 【打款记录】 of a queue row opens a drawer that reads that withdrawal's detail
// (getAdminWithdrawal, no parameters) and shows a summary (提现单号, 实付金额, 提现状态) and its
// payout_attempts oldest first: 时间 (Beijing time), 类型 and 结果 by their names (unlisted codes
// as the code), 响应码 (resp_code; — when there is none). Read only: no write entry in the drawer.

/** The PAYING queue samples, newest applied first. */
const PAYING_ROWS = [QNO.paying, QNO.stuck, QNO.untried];

/**
 * Opens the queue tab `tab` of 打款队列 (listing `rows`) and the drawer of the row `number`; returns
 * the drawer.
 */
async function openAttempts(
  server: PayoutServer,
  tab: string,
  rows: readonly string[],
  number: string,
): Promise<HTMLElement> {
  await mount(server, everyGrant(VIEW_EXECUTE));
  const panel = await openTab(TAB.queue);
  await selectTab(panel, tab);
  await listed(panel, rows);
  await settled(server);
  const grid = gridWith(panel, COLUMN.net);
  await click(entry(rowIn(grid, number), ENTRY.attempts));
  const drawer = await openDialog();
  await settled(server);
  return drawer;
}

/** The attempts table of the drawer once it has `count` rows. */
async function attemptsGrid(drawer: HTMLElement, count: number): Promise<Grid> {
  return waitFor(() => {
    const grid = gridWith(drawer, COLUMN.kind);
    expect(grid.rows, 'attempt rows').toHaveLength(count);
    return grid;
  });
}

it(
  '[AC-F1-08ba-ATTEMPTS#1] 打款中的 W20261113000202【打款记录】：抽屉读一次该单详情（不带参数），摘要 提现单号 / 实付金额 ¥98.00 / 提现状态 打款中；三条尝试按时间：转账·结果未知、查询·结果未知（SYSTEM_ERROR）、查询·处理中，首条响应码为 —；抽屉内无写入口',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const drawer = await openAttempts(server, SUB_TAB.paying, PAYING_ROWS, QNO.paying);
    await waitFor(() => expect(server.detailReads(QID.paying)).toHaveLength(1));
    const queries = server.detailReads(QID.paying).map((read) => read.query);
    expect(queries, 'one detail read without parameters').toEqual([{}]);
    const grid = await attemptsGrid(drawer, 3);
    expect(values(drawer, FIELD.number), 'number').toEqual([QNO.paying]);
    expect(values(drawer, FIELD.net), 'net').toEqual(['¥98.00']);
    expect(values(drawer, FIELD.status), 'status').toEqual([STATUS_SHOWN.PAYING]);
    expect(cellsOf(grid, [COLUMN.time, COLUMN.kind, COLUMN.result])).toEqual([
      ['2026-11-1309:00:05', KIND_SHOWN.transfer, RESULT_SHOWN.unknown],
      ['2026-11-1309:01:05', KIND_SHOWN.query, RESULT_SHOWN.unknown],
      ['2026-11-1309:05:05', KIND_SHOWN.query, RESULT_SHOWN.pending],
    ]);
    const codes = cellsOf(grid, [COLUMN.code]).slice(0, 2);
    expect(codes, 'response codes').toEqual([[DASH], ['SYSTEM_ERROR']]);
    expect(writeEntries(drawer), 'no write entry in the drawer').toEqual([]);
    expect(server.writes(), 'no request other than GET').toEqual([]);
  },
);

it(
  '[AC-F1-08ba-ATTEMPTS#2] 类型与结果没有字典行的尝试显示编码（reverse / timeout，响应码 X_PENDING）；没有尝试的单（待执行 W20261112000204）抽屉显示空态、摘要照常、没有尝试行',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const odd = createPayoutServer({
      withdrawals: [...queueSamples(), oddSample()],
      permissions: VIEW_EXECUTE,
    });
    const oddRows = [...PAYING_ROWS, QNO.odd];
    let drawer = await openAttempts(odd, SUB_TAB.paying, oddRows, QNO.odd);
    const grid = await attemptsGrid(drawer, 1);
    const cells = cellsOf(grid, [COLUMN.time, COLUMN.kind, COLUMN.result, COLUMN.code]);
    const unlisted = ['2026-11-1010:00:05', UNLISTED.kind, UNLISTED.result, UNLISTED.code];
    expect(cells, 'codes of an unlisted attempt').toEqual([unlisted]);
    cleanup();

    const server = createPayoutServer({ permissions: VIEW_EXECUTE });
    const approvedRows = [QNO.approvedA, QNO.approvedB];
    drawer = await openAttempts(server, SUB_TAB.approved, approvedRows, QNO.approvedB);
    await waitFor(() => expect(server.detailReads(QID.approvedB)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(textOf(drawer)).toMatch(EMPTY));
    expect(values(drawer, FIELD.number), 'number').toEqual([QNO.approvedB]);
    expect(values(drawer, FIELD.net), 'net').toEqual(['¥1,210.11']);
    const rows = Array.from(drawer.querySelectorAll('tbody tr.ant-table-row'));
    expect(rows, 'no attempt row').toEqual([]);
  },
);
