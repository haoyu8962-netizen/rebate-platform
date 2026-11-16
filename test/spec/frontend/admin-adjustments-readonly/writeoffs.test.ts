// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENT_ORDER,
  COLUMN,
  PAGE_SIZE,
  TEXT,
  USER,
  VIEW_GRANTS,
  WO,
  WRITEOFFS,
  WRITEOFF_COLUMN,
  WRITEOFF_GRANTS,
  WRITEOFF_ORDER,
  WRITEOFF_TITLES,
  createServer,
  tableRead,
  unavailable,
  writeoffStatusName,
  yuan,
} from './fixtures.ts';
import {
  button,
  click,
  dataRowCount,
  hasColumn,
  hasText,
  mount,
  openTab,
  panel,
  pick,
  settled,
  tableRows,
  waitColumn,
} from './helpers.ts';

/**
 * The four candidates as the 坏账核销 table shows them: full ids, negative_since as given
 * (YYYY-MM-DD), negative_days as a number, the three amounts only through @couli/money (a negative
 * available keeps its minus sign), 状态 from the console dictionary (the code without a row),
 * 生成时间 in Beijing time (18:00Z → 02:00 the next day, written out by hand).
 */
function expectedRows(): Record<string, string>[] {
  return [
    {
      [WRITEOFF_COLUMN.id]: WO.recent,
      [WRITEOFF_COLUMN.user]: USER.negative,
      [WRITEOFF_COLUMN.since]: '2026-11-20',
      [WRITEOFF_COLUMN.days]: '90',
      [WRITEOFF_COLUMN.candidate]: yuan(800),
      [WRITEOFF_COLUMN.available]: yuan(-300),
      [WRITEOFF_COLUMN.frozen]: yuan(0),
      [WRITEOFF_COLUMN.status]: writeoffStatusName('PENDING'),
      [WRITEOFF_COLUMN.created]: '2027-02-18 02:00:00',
    },
    {
      [WRITEOFF_COLUMN.id]: WO.blocked,
      [WRITEOFF_COLUMN.user]: USER.frozen,
      [WRITEOFF_COLUMN.since]: '2026-11-01',
      [WRITEOFF_COLUMN.days]: '109',
      [WRITEOFF_COLUMN.candidate]: yuan(12000),
      [WRITEOFF_COLUMN.available]: yuan(-12345),
      [WRITEOFF_COLUMN.frozen]: yuan(5000),
      [WRITEOFF_COLUMN.status]: writeoffStatusName('PENDING'),
      [WRITEOFF_COLUMN.created]: '2027-02-17 02:00:00',
    },
    {
      [WRITEOFF_COLUMN.id]: WO.writtenOff,
      [WRITEOFF_COLUMN.user]: USER.writtenOff,
      [WRITEOFF_COLUMN.since]: '2026-10-01',
      [WRITEOFF_COLUMN.days]: '93',
      [WRITEOFF_COLUMN.candidate]: yuan(600),
      [WRITEOFF_COLUMN.available]: yuan(0),
      [WRITEOFF_COLUMN.frozen]: yuan(0),
      [WRITEOFF_COLUMN.status]: writeoffStatusName('APPROVED'),
      [WRITEOFF_COLUMN.created]: '2027-01-10 02:00:00',
    },
    {
      [WRITEOFF_COLUMN.id]: WO.cancelled,
      [WRITEOFF_COLUMN.user]: USER.recovered,
      [WRITEOFF_COLUMN.since]: '2026-09-25',
      [WRITEOFF_COLUMN.days]: '98',
      [WRITEOFF_COLUMN.candidate]: yuan(400),
      [WRITEOFF_COLUMN.available]: yuan(1500),
      [WRITEOFF_COLUMN.frozen]: yuan(0),
      [WRITEOFF_COLUMN.status]: writeoffStatusName('CANCELLED'),
      [WRITEOFF_COLUMN.created]: '2027-01-01 02:00:00',
    },
  ];
}

it(
  '[AC-F1-08ca-WRITEOFF#1] 只持 fund.writeoff：读候选单第 1 页，查询参数恰为 {page: 1, page_size: 20}；按返回顺序逐列显示候选单号、用户、负余额起始日、负余额天数、生成时金额、当前可用余额、冻结、状态中文名、生成时间',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: WRITEOFF_GRANTS });
    await mount(server);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    await settled(server);
    const queries = server.tableReads(WRITEOFFS).map((read) => read.query);
    expect(queries).toEqual([{ page: '1', page_size: PAGE_SIZE }]);
    const rows = tableRows(panel(), WRITEOFF_COLUMN.id);
    expect(rows.map((row) => pick(row, WRITEOFF_TITLES))).toEqual(expectedRows());
  },
);

it(
  '[AC-F1-08ca-WRITEOFF#2] 只持 fund.view：先显示调账单页签；切到「坏账核销」后读候选单并列出四张，该页签内没有调账单的表格',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    await openTab(TEXT.writeoffsTab);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    await settled(server);
    const queries = server.tableReads(WRITEOFFS).map((read) => read.query);
    expect(queries).toEqual([{ page: '1', page_size: PAGE_SIZE }]);
    expect(hasColumn(panel(), COLUMN.id)).toBe(false);
    const rows = tableRows(panel(), WRITEOFF_COLUMN.id);
    expect(rows.map((row) => pick(row, WRITEOFF_TITLES))).toEqual(expectedRows());
  },
);

it(
  '[AC-F1-08ca-WRITEOFF#3] 没有候选单：显示「暂无核销候选单」，表格没有数据行',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: WRITEOFF_GRANTS, writeoffs: [] });
    await mount(server);
    await waitFor(() => expect(server.tableReads(WRITEOFFS)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(panel(), TEXT.writeoffsEmpty)).toBe(true));
    expect(dataRowCount(panel())).toBe(0);
  },
);

it(
  '[AC-F1-08ca-WRITEOFF#4] 候选单读取失败（50001）：显示「核销候选单加载失败」与【重试】、没有行；重试成功后列出',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: WRITEOFF_GRANTS });
    server.once('GET', WRITEOFFS, unavailable, tableRead(WRITEOFFS));
    await mount(server);
    await waitFor(() => expect(server.tableReads(WRITEOFFS)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(panel(), TEXT.writeoffsFailed)).toBe(true));
    expect(dataRowCount(panel())).toBe(0);
    await click(button(panel(), TEXT.retry));
    await waitFor(() => expect(server.tableReads(WRITEOFFS)).toHaveLength(2));
    await settled(server);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    expect(hasText(panel(), TEXT.writeoffsFailed)).toBe(false);
  },
);
