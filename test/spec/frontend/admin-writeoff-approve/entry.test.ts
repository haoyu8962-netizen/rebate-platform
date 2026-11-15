// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ALL_FUND,
  COLUMN,
  DECIDED,
  PENDING,
  READ_TEXT,
  SUPER_ADMIN,
  TEXT,
  WO,
  WRITEOFF_COLUMN,
  WRITEOFF_ORDER,
  createWriteoffServer,
  writeoffStatusName,
} from './fixtures.ts';
import {
  approveWithSms,
  buttons,
  dialogsTitled,
  main,
  mount,
  openApprove,
  openTab,
  ready,
  rowApprove,
  rowOf,
  rowsWithApprove,
  settled,
  statusOf,
  stepUpDialogs,
  usable,
  waitColumn,
} from './helpers.ts';

/** Each PENDING row has exactly one usable 【批准核销】; the decided rows have none. */
function entriesOnPendingRows(): void {
  expect(rowsWithApprove(WRITEOFF_ORDER)).toEqual(PENDING);
  for (const id of PENDING) {
    expect(usable(rowOf(id), TEXT.approveEntry), id).toHaveLength(1);
    expect(buttons(rowOf(id), TEXT.approveEntry), id).toHaveLength(1);
  }
  for (const id of DECIDED) expect(rowApprove(id), id).toEqual([]);
  expect(buttons(main(), TEXT.approveEntry)).toHaveLength(PENDING.length);
}

it(
  '[AC-F1-08cd-ENTRY#1] 只持 fund.writeoff：【批准核销】只在两张待批准候选单（含有冻结金额、approve_blocked 的那张）的行上，各恰 1 个可用；已核销、已取消两行没有；页面别处没有；进页不弹对话框、不发任何写请求、不读调账单',
  { timeout: 60_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    entriesOnPendingRows();
    expect(dialogsTitled(TEXT.title)).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(server.others()).toEqual([]);
    expect(server.requestsUnder(ADJUSTMENTS)).toEqual([]);
  },
);

it(
  '[AC-F1-08cd-ENTRY#2] 超管：先显示的调账单页签上没有【批准核销】；切到「坏账核销」后【批准核销】同样只在两张待批准候选单的行上，各恰 1 个可用；不发任何写请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteoffServer({ permissions: ALL_FUND });
    await mount(server, SUPER_ADMIN);
    await waitColumn(COLUMN.id, ADJUSTMENT_ORDER);
    await settled(server);
    expect(buttons(document.body, TEXT.approveEntry)).toEqual([]);
    await openTab(READ_TEXT.writeoffsTab);
    await waitColumn(WRITEOFF_COLUMN.id, WRITEOFF_ORDER);
    await settled(server);
    entriesOnPendingRows();
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cd-ENTRY#3] 一张候选单核销成功后：该行变为已核销、不再有【批准核销】；另一张待批准候选单的【批准核销】仍恰 1 个可用',
  { timeout: 90_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    await approveWithSms(server, await openApprove(server, WO.recent));
    await waitFor(() => expect(dialogsTitled(TEXT.title)).toEqual([]));
    await waitFor(() => expect(statusOf(WO.recent)).toBe(writeoffStatusName('APPROVED')));
    await settled(server);
    expect(rowsWithApprove(WRITEOFF_ORDER)).toEqual([WO.blocked]);
    expect(usable(rowOf(WO.blocked), TEXT.approveEntry)).toHaveLength(1);
    expect(buttons(main(), TEXT.approveEntry)).toHaveLength(1);
  },
);
