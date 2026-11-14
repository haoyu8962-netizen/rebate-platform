// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ADMIN,
  COLUMN,
  DIRECTION_NAME,
  LIST_TITLES,
  PAGE_SIZE,
  TEXT,
  USER,
  VIEW_GRANTS,
  createServer,
  fillerIds,
  reasonName,
  statusName,
  withFiller,
  yuan,
} from './fixtures.ts';
import {
  hasText,
  main,
  mount,
  nextPage,
  panel,
  pick,
  settled,
  tableRows,
  usable,
  waitColumn,
} from './helpers.ts';

/**
 * The eight list rows as the 调账单 table shows them, column by column: full ids, 方向 by the
 * enum names, 金额 without sign (only @couli/money; a null amount is 「—」), 原因 and 状态 from
 * the console dictionary (the code without a row), 红冲 「已红冲」 only on a reversed form,
 * 创建人 「系统」 for a prefilled form, 创建时间 in Beijing time (YYYY-MM-DD HH:mm:ss; the Z times
 * are written out by hand: 08:45:10Z → 16:45:10, 16:05Z → 00:05 the next day).
 */
function expectedRows(): Record<string, string>[] {
  return [
    {
      [COLUMN.id]: ADJ.prefilled,
      [COLUMN.user]: USER.deleting,
      [COLUMN.direction]: DIRECTION_NAME.decrease,
      [COLUMN.amount]: TEXT.dash,
      [COLUMN.reason]: reasonName('ACCOUNT_CLOSED'),
      [COLUMN.status]: statusName('PENDING'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: TEXT.system,
      [COLUMN.created]: '2026-12-01 02:00:00',
    },
    {
      [COLUMN.id]: ADJ.reversal,
      [COLUMN.user]: USER.payee,
      [COLUMN.direction]: DIRECTION_NAME.increase,
      [COLUMN.amount]: yuan(10000),
      [COLUMN.reason]: reasonName('PAYOUT_RECOVERY'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: ADMIN.second,
      [COLUMN.created]: '2026-11-30 16:45:10',
    },
    {
      [COLUMN.id]: ADJ.recovery,
      [COLUMN.user]: USER.payee,
      [COLUMN.direction]: DIRECTION_NAME.decrease,
      [COLUMN.amount]: yuan(10000),
      [COLUMN.reason]: reasonName('PAYOUT_RECOVERY'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: TEXT.reversed,
      [COLUMN.creator]: ADMIN.first,
      [COLUMN.created]: '2026-11-30 10:30:00',
    },
    {
      [COLUMN.id]: ADJ.reconFix,
      [COLUMN.user]: USER.recon,
      [COLUMN.direction]: DIRECTION_NAME.increase,
      [COLUMN.amount]: yuan(123456789),
      [COLUMN.reason]: reasonName('RECON_FIX'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: ADMIN.second,
      [COLUMN.created]: '2026-11-29 00:05:00',
    },
    {
      [COLUMN.id]: ADJ.rejected,
      [COLUMN.user]: USER.retracted,
      [COLUMN.direction]: DIRECTION_NAME.decrease,
      [COLUMN.amount]: TEXT.dash,
      [COLUMN.reason]: reasonName('ACCOUNT_CLOSED'),
      [COLUMN.status]: statusName('REJECTED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: TEXT.system,
      [COLUMN.created]: '2026-11-20 02:00:00',
    },
    {
      [COLUMN.id]: ADJ.otherNote,
      [COLUMN.user]: USER.service,
      [COLUMN.direction]: DIRECTION_NAME.increase,
      [COLUMN.amount]: yuan(5),
      [COLUMN.reason]: reasonName('OTHER'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: ADMIN.first,
      [COLUMN.created]: '2026-11-15 09:00:00',
    },
    {
      [COLUMN.id]: ADJ.restore,
      [COLUMN.user]: USER.restored,
      [COLUMN.direction]: DIRECTION_NAME.increase,
      [COLUMN.amount]: yuan(2000),
      [COLUMN.reason]: reasonName('RESTORE'),
      [COLUMN.status]: statusName('APPROVED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: ADMIN.second,
      [COLUMN.created]: '2026-11-10 12:00:00',
    },
    {
      [COLUMN.id]: ADJ.cancelled,
      [COLUMN.user]: USER.retracted,
      [COLUMN.direction]: DIRECTION_NAME.decrease,
      [COLUMN.amount]: TEXT.dash,
      [COLUMN.reason]: reasonName('ACCOUNT_CLOSED'),
      [COLUMN.status]: statusName('CANCELLED'),
      [COLUMN.reversal]: TEXT.dash,
      [COLUMN.creator]: TEXT.system,
      [COLUMN.created]: '2026-11-05 02:00:00',
    },
  ];
}

it(
  '[AC-F1-08ca-LIST#1] 进入后只读第 1 页：表格请求的查询参数恰为 {page: 1, page_size: 20}（不带筛选），按返回顺序（created_at 倒序）列出八张调账单',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    const queries = server.tableReads(ADJUSTMENTS).map((read) => read.query);
    expect(queries).toEqual([{ page: '1', page_size: PAGE_SIZE }]);
    expect(hasText(main(), TEXT.forbidden)).toBe(false);
    expect(hasText(main(), TEXT.adjustmentsEmpty)).toBe(false);
  },
);

it(
  '[AC-F1-08ca-LIST#2] 每行在各自的列下显示：调账单号、用户、方向（调增 / 调减）、金额（@couli/money 元两位小数，预填单无金额为「—」）、原因与状态的字典名、红冲列「已红冲」、创建人（系统预填为「系统」）、创建时间（北京时间），每行恰有 1 个可用的【详情】',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS });
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    const rows = tableRows(panel(), COLUMN.id);
    expect(rows.map((row) => pick(row, LIST_TITLES))).toEqual(expectedRows());
    const entries = rows.map((row) => usable(row.element, TEXT.detailEntry).length);
    expect(entries).toEqual(ADJUSTMENT_ORDER.map(() => 1));
  },
);

it(
  '[AC-F1-08ca-LIST#3] 页码分页：38 张时第 1 页 20 行；【下一页】请求恰为 {page: 2, page_size: 20}，只显示第 21–38 张、不再显示第 1 页的行',
  { timeout: 60_000 },
  async () => {
    const server = createServer({ permissions: VIEW_GRANTS, adjustments: withFiller(30) });
    await mount(server);
    // The eight samples first, then the filler (one created_at, id descending: 30, 29, …).
    await waitColumn(COLUMN.id, [...ADJUSTMENT_ORDER, ...fillerIds(30, 19)]);
    await settled(server);
    await nextPage(panel());
    await waitFor(() => expect(server.tableReads(ADJUSTMENTS)).toHaveLength(2));
    await settled(server);
    const queries = server.tableReads(ADJUSTMENTS).map((read) => read.query);
    expect(queries).toEqual([
      { page: '1', page_size: PAGE_SIZE },
      { page: '2', page_size: PAGE_SIZE },
    ]);
    await waitColumn(COLUMN.id, fillerIds(18, 1));
  },
);
