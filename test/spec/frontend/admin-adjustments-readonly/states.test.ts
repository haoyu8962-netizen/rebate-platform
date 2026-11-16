// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  TEXT,
  VIEW_GRANTS,
  createServer,
  tableRead,
  unavailable,
} from './fixtures.ts';
import {
  busy,
  button,
  click,
  dataRowCount,
  hasText,
  main,
  mount,
  panel,
  settle,
  settled,
  waitColumn,
} from './helpers.ts';

// Only the table read of the 调账单 list is held or fails; a count read (page_size=1) the page may
// send is answered as usual.

it(
  '[AC-F1-08ca-STATE#1] 加载中：调账单表格请求未返回时显示加载状态、没有数据行，返回后列出',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    const release = server.hold('GET', ADJUSTMENTS, tableRead(ADJUSTMENTS));
    try {
      await mount(server);
      await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(1));
      await settle();
      await waitFor(() => expect(busy()).toBe(true));
      expect(dataRowCount(main())).toBe(0);
    } finally {
      release();
    }
    await settled(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    expect(busy()).toBe(false);
  },
);

it(
  '[AC-F1-08ca-STATE#2] 出错可重试：调账单表格请求失败（50001）显示「调账单加载失败」与【重试】、没有数据行；重试成功后列出',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    server.once('GET', ADJUSTMENTS, unavailable, tableRead(ADJUSTMENTS));
    await mount(server);
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(panel(), TEXT.adjustmentsFailed)).toBe(true));
    expect(dataRowCount(panel())).toBe(0);
    await click(button(panel(), TEXT.retry));
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(2));
    await settled(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    expect(hasText(panel(), TEXT.adjustmentsFailed)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-STATE#3] 空列表：显示「暂无调账单」，没有数据行，只发 GET',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS, adjustments: [] });
    await mount(server);
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(hasText(panel(), TEXT.adjustmentsEmpty)).toBe(true));
    expect(dataRowCount(panel())).toBe(0);
    expect(server.others()).toEqual([]);
  },
);
