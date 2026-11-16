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

    // Since F1-08bc (D10-1712 (a)) a super admin (holding fund.cash_entry) also gets exactly the two
    // balance entries landed with it; fund.view + payout.execute does not. Since F1-08bd the super
    // admin (holding switch.payout) also gets the pause entries of this overview: the queue runs,
    // so 【暂停队列】, and 【解除通道暂停】 on the paused 微信零钱 card.
    const pauses = ['暂停队列', '解除通道暂停'];
    const landed = (account: typeof SUPER): string[] =>
      account === SUPER
        ? [ENTRY, '录入企业支付宝余额', '录入运营账户余额', ...pauses].sort()
        : [ENTRY];
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
      expect(writeEntries(panel).sort(), 'the landed write entries').toEqual(landed(account));
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

it(
  '[AC-F1-08bc-FROZEN#2] 录入入口与【执行所选】各按自己的权限点：持 fund.view + fund.cash_entry（不持 payout.execute）时打款队列没有勾选框与【执行所选】，写入口恰为【录入企业支付宝余额】【录入运营账户余额】，按【录入运营账户余额】打开一个写着微信零钱的对话框；再加 payout.execute 时未勾选前写入口恰为这两个，勾一张后恰为这两个加【执行所选】；全程不发写请求',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const balances = ['录入企业支付宝余额', '录入运营账户余额'].sort();
    const cashier: typeof SUPER = {
      isSuper: false,
      permissions: ['fund.view', 'fund.cash_entry'],
      stepUp: {
        'fund.view': { tier: null, operations: {} },
        'fund.cash_entry': { tier: 'totp', operations: {} },
      },
    };
    const cashing = serverFor({ permissions: ['fund.view', 'fund.cash_entry'] });
    const cashPanel = await openQueue(cashing, cashier);
    expect(within(cashPanel).queryAllByRole('checkbox'), 'no checkbox').toEqual([]);
    expect(buttons(cashPanel, ENTRY), 'no 执行所选').toEqual([]);
    expect(writeEntries(cashPanel).sort(), 'the two balance entries only').toEqual(balances);
    await click(button(cashPanel, '录入运营账户余额'));
    const opened = await within(document.body).findAllByRole('dialog');
    expect(opened, 'one dialog').toHaveLength(1);
    expect(opened[0]!.textContent ?? '', 'the dialog is for 微信零钱').toContain('微信零钱');
    await settled(cashing);
    expect(cashing.writes(), 'nothing sent on opening').toEqual([]);
    cleanup();

    const both: typeof SUPER = {
      isSuper: false,
      permissions: ['fund.view', 'payout.execute', 'fund.cash_entry'],
      stepUp: {
        'fund.view': { tier: null, operations: {} },
        'payout.execute': { tier: 'totp', operations: {} },
        'fund.cash_entry': { tier: 'totp', operations: {} },
      },
    };
    const server = serverFor({ permissions: ['fund.view', 'payout.execute', 'fund.cash_entry'] });
    const panel = await openQueue(server, both);
    expect(buttons(panel, ENTRY), 'no 执行所选 before a tick').toEqual([]);
    expect(writeEntries(panel).sort(), 'the two balance entries before a tick').toEqual(balances);
    await select(panel, [QNO.approvedA]);
    expect(disabled(button(panel, ENTRY))).toBe(false);
    const afterTick = [ENTRY, ...balances].sort();
    expect(writeEntries(panel).sort(), 'with 执行所选 after a tick').toEqual(afterTick);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08bd-FROZEN#2] 暂停类入口与【执行所选】各按自己的权限点：持 fund.view + payout.execute + switch.payout（非超管）、队列运行且微信零钱暂停时，未勾选前写入口恰为【暂停队列】【解除通道暂停】，勾一张后恰为这两个加【执行所选】；队列暂停时勾选前后写入口都恰为【解除暂停】【解除通道暂停】、没有【执行所选】；持 fund.view + payout.execute + switch.pay（不持 switch.payout）时勾一张后写入口恰为【执行所选】；全程不发写请求',
  { timeout: MULTI_TIMEOUT },
  async () => {
    // F1-08bd (D10-1712 ④): the pause entries follow switch.payout, 【执行所选】 payout.execute.
    const points: typeof VIEW_EXECUTE = ['fund.view', 'payout.execute', 'switch.payout'];
    const switcher: typeof SUPER = {
      isSuper: false,
      permissions: points,
      stepUp: {
        'fund.view': { tier: null, operations: {} },
        'payout.execute': { tier: 'totp', operations: {} },
        'switch.payout': { tier: 'totp', operations: {} },
      },
    };
    const running = ['暂停队列', '解除通道暂停'];
    const server = serverFor({ permissions: points });
    const panel = await openQueue(server, switcher);
    expect(buttons(panel, ENTRY), 'no 执行所选 before a tick').toEqual([]);
    expect(writeEntries(panel).sort(), 'the pause entries before a tick').toEqual(running.sort());
    await select(panel, [QNO.approvedA]);
    expect(disabled(button(panel, ENTRY))).toBe(false);
    const withEntry = [ENTRY, ...running].sort();
    expect(writeEntries(panel).sort(), 'with 执行所选 after a tick').toEqual(withEntry);
    expect(server.writes()).toEqual([]);
    cleanup();

    const paused = ['解除暂停', '解除通道暂停'].sort();
    const halted = serverFor({ overview: switchedOverview(true, true), permissions: points });
    const haltedPanel = await openQueue(halted, switcher);
    expect(writeEntries(haltedPanel).sort(), 'queue paused, before a tick').toEqual(paused);
    await select(haltedPanel, [QNO.approvedA]);
    expect(buttons(haltedPanel, ENTRY), 'no 执行所选 while the queue is paused').toEqual([]);
    expect(writeEntries(haltedPanel).sort(), 'queue paused, after a tick').toEqual(paused);
    expect(halted.writes()).toEqual([]);
    cleanup();

    const lookalike: typeof VIEW_EXECUTE = ['fund.view', 'payout.execute', 'switch.pay'];
    const other: typeof SUPER = {
      isSuper: false,
      permissions: lookalike,
      stepUp: {
        'fund.view': { tier: null, operations: {} },
        'payout.execute': { tier: 'totp', operations: {} },
        'switch.pay': { tier: 'totp', operations: {} },
      },
    };
    const plain = serverFor({ permissions: lookalike });
    const plainPanel = await openQueue(plain, other);
    expect(writeEntries(plainPanel), 'switch.pay: no pause entry before a tick').toEqual([]);
    await select(plainPanel, [QNO.approvedA]);
    expect(writeEntries(plainPanel), 'switch.pay: only 执行所选 after a tick').toEqual([ENTRY]);
    expect(plain.writes()).toEqual([]);
  },
);
