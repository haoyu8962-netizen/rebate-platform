// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  COLUMN,
  FILTER_LABEL,
  PAGE_SIZE,
  REASONS,
  STATUSES,
  TEXT,
  USER,
  VIEW_GRANTS,
  createServer,
  fillerIds,
  reasonName,
  statusName,
  withFiller,
  type Server,
} from './fixtures.ts';
import {
  choose,
  dataRowCount,
  fill,
  hasText,
  mount,
  nextPage,
  panel,
  query,
  reset,
  settled,
  textbox,
  waitColumn,
} from './helpers.ts';

// adminListAdjustments takes reason_code, status and user_id (AND), besides page and page_size;
// the 调账单 filter offers exactly these. A parameter the operator left empty is absent.

/** The queries of the table reads sent so far. */
function queries(server: Server): Record<string, string>[] {
  return server.tableReads(ADJUSTMENTS).map((read) => read.query);
}
/** Waits for the `count`-th table read and for the server to answer it. */
async function readCount(server: Server, count: number): Promise<void> {
  await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(count));
  await settled(server);
}

it(
  '[AC-F1-08ca-FILTER#1] 状态与原因两个下拉按契约顺序恰好提供全部枚举的字典名；选「已生效」+「打款追回」后【查询】，请求恰为 {page: 1, page_size: 20, status: APPROVED, reason_code: PAYOUT_RECOVERY}，只列出红冲单与原单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const statuses = await choose(panel(), FILTER_LABEL.status, statusName('APPROVED'));
    expect(statuses).toEqual(STATUSES.map(statusName));
    const reasons = await choose(panel(), FILTER_LABEL.reason, reasonName('PAYOUT_RECOVERY'));
    expect(reasons).toEqual(REASONS.map(reasonName));
    expect(queries(server)).toHaveLength(1);
    await query();
    await readCount(server, 2);
    expect(queries(server)[1]).toEqual({
      page: '1',
      page_size: PAGE_SIZE,
      status: 'APPROVED',
      reason_code: 'PAYOUT_RECOVERY',
    });
    await waitColumn(COLUMN.id, [ADJ.reversal, ADJ.recovery]);
  },
);

it(
  '[AC-F1-08ca-FILTER#2] 用户 ID 去掉首尾空格后作 user_id：请求恰为 {page: 1, page_size: 20, user_id}，列出该用户的驳回单与撤回单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    await fill(textbox(panel(), FILTER_LABEL.user), `  ${USER.retracted} `);
    await query();
    await readCount(server, 2);
    expect(queries(server)[1]).toEqual({
      page: '1',
      page_size: PAGE_SIZE,
      user_id: USER.retracted,
    });
    await waitColumn(COLUMN.id, [ADJ.rejected, ADJ.cancelled]);
  },
);

it(
  '[AC-F1-08ca-FILTER#3] 【重置】清空三个条件并重读第 1 页：请求恰为 {page: 1, page_size: 20}，重新列出全部八张，用户 ID 输入框为空',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    await choose(panel(), FILTER_LABEL.status, statusName('PENDING'));
    await fill(textbox(panel(), FILTER_LABEL.user), USER.deleting);
    await query();
    await readCount(server, 2);
    await waitColumn(COLUMN.id, [ADJ.prefilled]);
    await reset();
    await readCount(server, 3);
    expect(queries(server)).toEqual([
      { page: '1', page_size: PAGE_SIZE },
      { page: '1', page_size: PAGE_SIZE, status: 'PENDING', user_id: USER.deleting },
      { page: '1', page_size: PAGE_SIZE },
    ]);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    expect(textbox(panel(), FILTER_LABEL.user).value).toBe('');
  },
);

it(
  '[AC-F1-08ca-FILTER#4] 筛选后翻页保留条件：状态「已生效」共 35 张，【下一页】请求恰为 {page: 2, page_size: 20, status: APPROVED}，列出第 21–35 张',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS, adjustments: withFiller(30) });
    await mount(server);
    await waitColumn(COLUMN.id, [...ADJUSTMENT_ORDER, ...fillerIds(30, 19)]);
    await settled(server);
    await choose(panel(), FILTER_LABEL.status, statusName('APPROVED'));
    await query();
    await readCount(server, 2);
    const approved = [ADJ.reversal, ADJ.recovery, ADJ.reconFix, ADJ.otherNote, ADJ.restore];
    await waitColumn(COLUMN.id, [...approved, ...fillerIds(30, 16)]);
    await nextPage(panel());
    await readCount(server, 3);
    expect(queries(server)[2]).toEqual({ page: '2', page_size: PAGE_SIZE, status: 'APPROVED' });
    await waitColumn(COLUMN.id, fillerIds(15, 1));
  },
);

it(
  '[AC-F1-08ca-FILTER#5] 没有匹配的调账单：显示「暂无调账单」，表格没有数据行',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    await fill(textbox(panel(), FILTER_LABEL.user), USER.unknown);
    await query();
    await readCount(server, 2);
    expect(queries(server)[1]).toEqual({ page: '1', page_size: PAGE_SIZE, user_id: USER.unknown });
    await waitFor(() => expect(hasText(panel(), TEXT.adjustmentsEmpty)).toBe(true));
    expect(dataRowCount(panel())).toBe(0);
  },
);
