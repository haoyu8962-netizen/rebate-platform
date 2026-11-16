// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SUB_TAB, listed, selectTab } from '../admin-payouts-readonly/helpers.ts';
import {
  CID,
  CNO,
  ENTRY,
  EXECUTOR,
  OFF_NOTE,
  QID,
  QNO,
  SUPER,
  VIEW,
  VIEWER,
  VIEW_EXECUTE,
  executeSamples,
  netSum,
  pausedOverview,
  selectedText,
  switchedOverview,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  button,
  buttons,
  checkbox,
  choicesOf,
  click,
  disabled,
  liveTexts,
  openQueue,
  queueRow,
  select,
  serverFor,
  settled,
  ticked,
  writeEntries,
} from './helpers.ts';

// F1-08bb ①: only an account holding payout.execute (a super admin holds every point) gets the
// checkboxes and 【执行所选】 on 打款队列; only APPROVED rows (待执行) can be ticked; the bar with the
// count, the net sum and 【执行所选】 shows only once something is ticked. fund.view alone gets neither.
// While the overview says payout_enabled off or queue_paused, 【执行所选】 is not rendered at all
// (the ticks stay possible) and the bar says why. 录入余额 and 暂停 / 解除暂停 (F1-08bc / bd) are
// not offered.

const sample = executeSamples();
const rowOf = (id: string) => sample.find((row) => row.withdrawal_id === id)!;
const A = rowOf(QID.approvedA);
const C = rowOf(CID);
const APPROVED = [QNO.approvedA, CNO, QNO.approvedB];
const PAYING = [QNO.paying, QNO.stuck, QNO.untried];

it(
  '[AC-F1-08bb-ACCESS#1] 只持 fund.view：打款队列没有任何勾选框、批量栏与【执行所选】（含隐藏）；持 fund.view + payout.execute 与超管：待执行单各有一个可用、未勾的勾选框，打款中的单没有可用勾选框，未勾选时没有【执行所选】，勾一张后只出现【执行所选】这一个写入口；全程不发写请求',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const viewing = serverFor({ permissions: VIEW });
    const viewPanel = await openQueue(viewing, VIEWER);
    expect(within(viewPanel).queryAllByRole('checkbox'), 'fund.view: no checkbox').toEqual([]);
    expect(buttons(viewPanel, ENTRY), 'fund.view: no 执行所选').toEqual([]);
    expect(writeEntries(viewPanel), 'fund.view: no write entry').toEqual([]);
    expect(liveTexts(viewPanel), 'fund.view: no selection bar').toEqual([]);
    expect(viewing.writes()).toEqual([]);
    cleanup();

    for (const account of [EXECUTOR, SUPER]) {
      const server = serverFor({ permissions: VIEW_EXECUTE });
      const panel = await openQueue(server, account);
      for (const number of APPROVED)
        expect(checkbox(panel, number).checked, `${number} not ticked`).toBe(false);
      for (const number of PAYING)
        expect(choicesOf(queueRow(panel, number)), `${number}: no usable checkbox`).toEqual([]);
      expect(buttons(panel, ENTRY), 'no 执行所选 before a tick').toEqual([]);
      expect(liveTexts(panel), 'no selection bar before a tick').toEqual([]);
      await select(panel, [QNO.approvedA]);
      expect(disabled(button(panel, ENTRY))).toBe(false);
      expect(writeEntries(panel), 'the only write entry').toEqual([ENTRY]);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08bb-SELECT#1] 批量栏随勾选出现：aria-live 精确为「已选 N 张，合计实付 ¥…」（实付合计经 @couli/money），取消勾选后随之更新，全部取消后批量栏与【执行所选】消失；「待执行」页签里的待执行单同样可勾',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openQueue(server);
    await select(panel, [CNO]);
    expect(liveTexts(panel)).toEqual([selectedText(1, netSum([C]))]);
    await select(panel, [QNO.approvedA]);
    expect(liveTexts(panel)).toEqual([selectedText(2, netSum([A, C]))]);
    expect(disabled(button(panel, ENTRY))).toBe(false);
    await click(checkbox(panel, CNO));
    expect(checkbox(panel, CNO).checked).toBe(false);
    expect(liveTexts(panel)).toEqual([selectedText(1, netSum([A]))]);
    await click(checkbox(panel, QNO.approvedA));
    expect(checkbox(panel, QNO.approvedA).checked).toBe(false);
    expect(liveTexts(panel)).toEqual([]);
    expect(buttons(panel, ENTRY)).toEqual([]);
    expect(ticked(panel)).toEqual([]);

    await selectTab(panel, SUB_TAB.approved);
    await listed(panel, APPROVED);
    await settled(server);
    for (const number of APPROVED)
      expect(checkbox(panel, number).checked, `${number} in 待执行`).toBe(false);
    await select(panel, [QNO.approvedA]);
    expect(liveTexts(panel)).toEqual([selectedText(1, netSum([A]))]);
    expect(disabled(button(panel, ENTRY))).toBe(false);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08bb-PAUSED#1] 概览为打款开关关闭或队列暂停时：待执行单仍可勾、批量栏照常统计，但【执行所选】不渲染（含隐藏、置灰），批量栏写明原因（开关关闭、队列暂停各一句，按概览字段逐项出现）；不发写请求',
  { timeout: MULTI_TIMEOUT },
  async () => {
    for (const scenario of [
      { overview: pausedOverview(), notes: [OFF_NOTE.payout, OFF_NOTE.queue] },
      { overview: switchedOverview(true, true), notes: [OFF_NOTE.queue] },
      { overview: switchedOverview(false, false), notes: [OFF_NOTE.payout] },
    ]) {
      const server = serverFor({ overview: scenario.overview });
      const panel = await openQueue(server);
      await select(panel, [QNO.approvedA]);
      expect(liveTexts(panel)).toEqual([selectedText(1, netSum([A]))]);
      expect(buttons(panel, ENTRY), 'no 执行所选, not even hidden').toEqual([]);
      expect(writeEntries(panel), 'no write entry').toEqual([]);
      for (const note of [OFF_NOTE.payout, OFF_NOTE.queue])
        expect(
          within(panel).queryAllByText(note, { exact: true }),
          `${note} ${scenario.notes.includes(note) ? 'shown once' : 'not shown'}`,
        ).toHaveLength(scenario.notes.includes(note) ? 1 : 0);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);
