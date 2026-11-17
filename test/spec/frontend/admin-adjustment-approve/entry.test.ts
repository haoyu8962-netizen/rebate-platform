// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADJ,
  ADJUSTMENTS,
  ADJUSTMENT_ORDER,
  ALL_FUND,
  READER,
  READ_TEXT,
  SECOND,
  SUPER_ADMIN,
  TEXT,
  WRITEOFF_ONLY,
  createApproveServer,
  secondPending,
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
  ready,
  rowOf,
  rowsWithApprove,
  settled,
  usable,
  type ApproveServer,
} from './helpers.ts';

/** Forms that are not PENDING: approved, a reversal, reversed, rejected, cancelled. */
const DECIDED: readonly string[] = [
  ADJ.reconFix,
  ADJ.reversal,
  ADJ.recovery,
  ADJ.rejected,
  ADJ.cancelled,
];

/** Neither 【批准】 nor the dialog's decisions anywhere on the page. */
function noDecisionEntries(): void {
  expect(buttons(document.body, TEXT.approveEntry)).toEqual([]);
  expect(buttons(document.body, TEXT.approve)).toEqual([]);
  expect(buttons(document.body, TEXT.reject)).toEqual([]);
}
/** The detail of `adjustId` offers no 【批准】. */
async function detailWithout(server: ApproveServer, adjustId: string): Promise<void> {
  await openDetail(server, adjustId);
  expect(buttons(drawer(), TEXT.approveEntry), adjustId).toEqual([]);
}

it(
  '[AC-F1-08cc-ENTRY#1] 持 fund.adjust：【批准】只在系统预填的待批准行上，恰 1 个可用；其余七行（已生效、红冲单、已被红冲、已驳回、已撤回）都没有；页面上（对话框外）没有【驳回】【批准并短信验证】；进页不发任何写请求',
  { timeout: 60_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    expect(rowsWithApprove(ADJUSTMENT_ORDER)).toEqual([ADJ.prefilled]);
    expect(usable(rowOf(ADJ.prefilled), TEXT.approveEntry)).toHaveLength(1);
    expect(buttons(rowOf(ADJ.prefilled), TEXT.approveEntry)).toHaveLength(1);
    expect(buttons(main(), TEXT.approve)).toEqual([]);
    expect(buttons(main(), TEXT.reject)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-ENTRY#2] 持 fund.adjust 的详情：待批准单的详情恰 1 个可用【批准】；已生效、红冲单、已被红冲、已驳回、已撤回单的详情都没有【批准】',
  { timeout: 90_000 },
  async () => {
    const server = createApproveServer();
    await ready(server);
    await openDetail(server, ADJ.prefilled);
    expect(usable(drawer(), TEXT.approveEntry)).toHaveLength(1);
    expect(buttons(drawer(), TEXT.approveEntry)).toHaveLength(1);
    for (const adjustId of DECIDED) await detailWithout(server, adjustId);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-ENTRY#3] 超管：【批准】同样只在待批准行与其详情上，各恰 1 个可用',
  { timeout: 60_000 },
  async () => {
    const server = createApproveServer({ permissions: ALL_FUND });
    await ready(server, ADJUSTMENT_ORDER, SUPER_ADMIN);
    expect(rowsWithApprove(ADJUSTMENT_ORDER)).toEqual([ADJ.prefilled]);
    expect(usable(rowOf(ADJ.prefilled), TEXT.approveEntry)).toHaveLength(1);
    await openDetail(server, ADJ.prefilled);
    expect(usable(drawer(), TEXT.approveEntry)).toHaveLength(1);
    expect(server.others()).toEqual([]);
  },
);

it(
  '[AC-F1-08cc-ENTRY#4] 两张待批准单：每张待批准行各恰 1 个可用【批准】（列表顺序：新的在前），其余行没有',
  { timeout: 60_000 },
  async () => {
    const server = createApproveServer({ extra: [secondPending()] });
    const order = [SECOND, ...ADJUSTMENT_ORDER];
    await ready(server, order);
    expect(rowsWithApprove(order)).toEqual([SECOND, ADJ.prefilled]);
    expect(usable(rowOf(SECOND), TEXT.approveEntry)).toHaveLength(1);
    expect(usable(rowOf(ADJ.prefilled), TEXT.approveEntry)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08cc-ENTRY#5] 只持 fund.view + fund.writeoff：待批准行与其详情都没有【批准】【驳回】【批准并短信验证】（不置灰，直接不出现）；只持 fund.writeoff 也没有；同一页面换成持 fund.adjust 的账号才出现',
  { timeout: 120_000 },
  async () => {
    const reader = createApproveServer({ permissions: ['fund.view', 'fund.writeoff'] });
    await ready(reader, ADJUSTMENT_ORDER, READER);
    noDecisionEntries();
    await openDetail(reader, ADJ.prefilled);
    noDecisionEntries();
    await openTab(READ_TEXT.writeoffsTab);
    await settled(reader);
    noDecisionEntries();
    expect(reader.others()).toEqual([]);
    cleanup();

    const writeoff = createApproveServer({ permissions: ['fund.writeoff'] });
    await mount(writeoff, WRITEOFF_ONLY);
    await waitFor(() => expect(column(panel(), '候选单号')).toHaveLength(4));
    await settled(writeoff);
    noDecisionEntries();
    expect(writeoff.requestsUnder(ADJUSTMENTS)).toEqual([]);
    cleanup();

    const adjuster = createApproveServer();
    await ready(adjuster);
    expect(rowsWithApprove(ADJUSTMENT_ORDER)).toEqual([ADJ.prefilled]);
    expect(usable(rowOf(ADJ.prefilled), TEXT.approveEntry)).toHaveLength(1);
  },
);
