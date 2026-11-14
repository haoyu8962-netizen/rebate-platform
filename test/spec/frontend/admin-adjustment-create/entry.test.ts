// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ALL_FUND,
  COLUMN,
  LATER_ENTRIES,
  READER,
  READ_TEXT,
  SUPER_ADMIN,
  TEXT,
  WRITEOFF_ONLY,
  createWriteServer,
} from './fixtures.ts';
import {
  buttons,
  column,
  drawer,
  main,
  mount,
  openDetail,
  openTab,
  panel,
  rowReverse,
  rowWith,
  settled,
  usable,
  waitColumn,
} from './helpers.ts';

/** The rows that may be reversed: APPROVED, not a reversal, not reversed yet (list order). */
const REVERSIBLE: readonly string[] = [ADJ.reconFix, ADJ.otherNote, ADJ.restore];

/** Ids of the list rows offering 【红冲】, in list order. */
function rowsWithReverse(): string[] {
  return ADJUSTMENT_ORDER.filter((adjustId) => rowReverse(adjustId).length > 0);
}
/** Usable 【红冲】 of each reversible row. */
function usableReverses(): number[] {
  const counts: number[] = [];
  for (const adjustId of REVERSIBLE) {
    const row = rowWith(panel(), COLUMN.id, adjustId).element;
    counts.push(usable(row, TEXT.reverseEntry).length);
  }
  return counts;
}
/** Later write entries found anywhere on the page, by name. */
function laterEntries(): string[] {
  return LATER_ENTRIES.filter((name) => buttons(document.body, name).length > 0);
}
/** Neither entry of this task anywhere on the page. */
function noEntries(): void {
  expect(buttons(document.body, TEXT.createEntry)).toEqual([]);
  expect(buttons(document.body, TEXT.reverseEntry)).toEqual([]);
}

it(
  '[AC-F1-08cb-ENTRY#1] 持 fund.adjust：标题行（页签外）恰 1 个可用【新建调账】；【红冲】只在已生效、非红冲单、未被红冲的三行（对账修正、其他、订单恢复），每行 1 个可用；不出现【批准】【驳回】【批准核销】【撤回】【保存待批】；进页不发任何写请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(usable(main(), TEXT.createEntry)).toHaveLength(1);
    expect(buttons(main(), TEXT.createEntry)).toHaveLength(1);
    expect(buttons(panel(), TEXT.createEntry)).toEqual([]);
    expect(rowsWithReverse()).toEqual(REVERSIBLE);
    expect(usableReverses()).toEqual([1, 1, 1]);
    expect(laterEntries()).toEqual(['批准']);
    expect(server.unexpected()).toEqual([]);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-ENTRY#2] 持 fund.adjust 的详情：已生效未红冲单（对账修正）有 1 个可用【红冲】；已被红冲的原单、红冲单本身、系统预填待批单、已驳回单都没有【红冲】，也没有【批准】【驳回】',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer();
    await mount(server);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);

    await openDetail(server, ADJ.reconFix);
    expect(usable(drawer(), TEXT.reverseEntry)).toHaveLength(1);
    expect(buttons(drawer(), TEXT.reverseEntry)).toHaveLength(1);
    for (const adjustId of [ADJ.recovery, ADJ.reversal, ADJ.prefilled, ADJ.rejected]) {
      await openDetail(server, adjustId);
      expect(buttons(drawer(), TEXT.reverseEntry), adjustId).toEqual([]);
      expect(laterEntries(), adjustId).toEqual(['批准']);
      const inDetail = LATER_ENTRIES.filter((name) => buttons(drawer(), name).length > 0);
      expect(inDetail, adjustId).toEqual(adjustId === ADJ.prefilled ? ['批准'] : []);
    }
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cb-ENTRY#3] 只持 fund.view + fund.writeoff：列表、已生效未红冲单详情、坏账核销页签都没有【新建调账】【红冲】（不置灰，直接不出现）；只持 fund.writeoff 时标题行同样没有；同一页面换成持 fund.adjust 的账号才出现',
  { timeout: 90_000 },
  async () => {
    const reader = createWriteServer({ permissions: ['fund.view', 'fund.writeoff'] });
    await mount(reader, READER);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(reader);
    noEntries();
    await openDetail(reader, ADJ.reconFix);
    noEntries();
    await openTab(READ_TEXT.writeoffsTab);
    await settled(reader);
    noEntries();
    expect(reader.others()).toEqual([]);
    cleanup();

    const writeoff = createWriteServer({ permissions: ['fund.writeoff'] });
    await mount(writeoff, WRITEOFF_ONLY);
    await waitFor(() => expect(column(panel(), '候选单号')).toHaveLength(4));
    await settled(writeoff);
    noEntries();
    expect(writeoff.requestsUnder(ADJUSTMENTS)).toEqual([]);
    cleanup();

    const adjuster = createWriteServer();
    await mount(adjuster);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(adjuster);
    expect(usable(main(), TEXT.createEntry)).toHaveLength(1);
    expect(rowsWithReverse()).toEqual(REVERSIBLE);
  },
);

it(
  '[AC-F1-08cb-ENTRY#4] 超管：标题行恰 1 个可用【新建调账】，【红冲】同样只在三行可红冲的单上；不出现后续任务的写入口',
  { timeout: 60_000 },
  async () => {
    const server = createWriteServer({ permissions: ALL_FUND });
    await mount(server, SUPER_ADMIN);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(usable(main(), TEXT.createEntry)).toHaveLength(1);
    expect(rowsWithReverse()).toEqual(REVERSIBLE);
    expect(usableReverses()).toEqual([1, 1, 1]);
    expect(laterEntries()).toEqual(['批准']);
  },
);
