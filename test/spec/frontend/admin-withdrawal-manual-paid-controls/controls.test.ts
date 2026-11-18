// @vitest-environment jsdom
// F1-08aq（FU-F108AL-SHORTCUT-INPUTS，D10-2022）：【批量手动打款】对话框里没有把应付金额（或「现在」）
// 填进实付金额的任何快捷入口。对话框刚打开、填写后、结果显示时，把全部表单与可交互控件按「角色: 名字」
// 整份列出，与期望清单逐项相等（BR-WDR-16：实付金额必须由录入人填写且 = net_fen）。
import { formatFen, parseFen } from '@couli/money';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  INVALID,
  MANUAL,
  REASONS,
  WHEN,
  approvedRows,
  assertRequest,
  button,
  confirm,
  dateInputValue,
  dialogs,
  disabled,
  field,
  fill,
  fillRows,
  mount,
  notice,
  open,
  paid,
  reply,
  rowOf,
  select,
  serverFor,
  settle,
  settled,
  verify,
  type ResultItem,
  type Withdrawal,
} from '../admin-withdrawal-manual-paid/helpers.ts';
import { controlsOf, operableOf } from './controls.ts';

const FIELDS = ['通道流水号', '实付时间', '实付金额（元）'];
const SHORTCUT = /应付|填入|同上|一键|复制|此刻|现在|今天|now|today/i;

/** One fillable row: exactly its three text inputs. */
const ROW_CONTROLS = ['textbox: 通道流水号', 'textbox: 实付时间', 'textbox: 实付金额（元）'];

/** Right after opening (two fillable rows, one WeChat row): corner close, 取消, 确认录入, 2 × 3 inputs. */
const OPENED = [
  'button: Close',
  'button: 取消',
  'button: 确认录入',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
];

/** Usable right after opening: everything of OPENED except 确认录入 (nothing is filled in yet). */
const OPENED_USABLE = [
  'button: Close',
  'button: 取消',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
];

/** Result state: corner close, 关闭, and the six inputs kept on screen (all locked). */
const FINISHED = [
  'button: Close',
  'button: 关闭',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
];

/** Two fillable APPROVED rows (alipay, bank card) and a WeChat row that is only marked skipped. */
function threeRows(): Withdrawal[] {
  const rows = approvedRows(3);
  rows[2]!.payout_channel = 'wechat';
  rows[2]!.payout_method = 'wechat';
  return rows;
}

function valuesOf(modal: HTMLElement, rows: readonly Withdrawal[]): string[][] {
  return rows.map((item) => {
    const row = rowOf(modal, item.out_biz_no);
    return FIELDS.map((label) => field(row, label).value);
  });
}

/** The texts fillRows types into the rows, unchanged (serials keep their surrounding spaces). */
function typed(modal: HTMLElement, rows: readonly Withdrawal[]): string[][] {
  return rows.map((item, index) => [
    `  Serial-${index + 1}-Aa  `,
    dateInputValue(field(rowOf(modal, item.out_biz_no), '实付时间'), WHEN),
    formatFen(parseFen(item.net_fen)),
  ]);
}

it(
  '[AC-F1-08aq-CONTROLS#1] 刚打开时对话框的全部表单与可交互控件整份等于：关闭、取消、确认录入与每张可填单三个文本输入',
  { timeout: 60_000 },
  async () => {
    const rows = threeRows();
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    expect(controlsOf(modal)).toEqual([...OPENED].sort());
    for (const item of rows.slice(0, 2))
      expect(controlsOf(rowOf(modal, item.out_biz_no))).toEqual([...ROW_CONTROLS].sort());
    const wechat = rowOf(modal, rows[2]!.out_biz_no);
    await notice('跳过：微信零钱单不支持线下打款', wechat);
    expect(controlsOf(wechat)).toEqual([]);
    // Usable right now: everything except 确认录入 (nothing is filled in yet).
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    expect(operableOf(modal)).toEqual([...OPENED_USABLE].sort());
    expect(valuesOf(modal, rows.slice(0, 2))).toEqual(rows.slice(0, 2).map(() => ['', '', '']));
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08aq-CONTROLS#2] 填好全部可填行后控件清单与刚打开时完全相同，每个输入框的值等于填入的原文',
  { timeout: 60_000 },
  async () => {
    const rows = threeRows();
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    const opened = controlsOf(modal);
    expect(opened).toEqual([...OPENED].sort());
    const body = await fillRows(modal, rows.slice(0, 2));
    expect(body.items).toHaveLength(2);
    expect(controlsOf(modal)).toEqual(opened);
    expect(controlsOf(modal)).toEqual([...OPENED].sort());
    for (const item of rows.slice(0, 2))
      expect(controlsOf(rowOf(modal, item.out_biz_no))).toEqual([...ROW_CONTROLS].sort());
    expect(controlsOf(rowOf(modal, rows[2]!.out_biz_no))).toEqual([]);
    expect(valuesOf(modal, rows.slice(0, 2))).toEqual(typed(modal, rows.slice(0, 2)));
    expect(disabled(button(modal, '确认录入'))).toBe(false);
    expect(operableOf(modal)).toEqual([...OPENED].sort());
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08aq-CONTROLS#3] 逐单结果（一张 paid、一张 skipped）显示后只剩只读结果与关闭类按钮，没有可改实付金额的控件',
  { timeout: 60_000 },
  async () => {
    const rows = threeRows();
    const server = serverFor(rows);
    const outcomes: ResultItem[] = [
      paid([rows[0]!])[0]!,
      { withdrawal_id: rows[1]!.withdrawal_id, result: 'skipped', reason: 'member_blocked' },
    ];
    server.once('POST', MANUAL, () => reply(server, outcomes));
    await mount(server);
    await select(rows);
    const modal = await open();
    const body = await fillRows(modal, rows.slice(0, 2));
    const filled = typed(modal, rows.slice(0, 2));
    expect(valuesOf(modal, rows.slice(0, 2))).toEqual(filled);
    await confirm(server, modal);
    await verify();
    await notice('已录入', rowOf(modal, rows[0]!.out_biz_no));
    await notice(REASONS.member_blocked, rowOf(modal, rows[1]!.out_biz_no));
    await settled(server);
    assertRequest(server, body);
    await waitFor(() => expect(dialogs()).toEqual([modal]));
    expect(controlsOf(modal)).toEqual([...FINISHED].sort());
    // Only the close buttons can be used; the inputs stay on screen locked, with what was typed.
    expect(operableOf(modal)).toEqual(['button: Close', 'button: 关闭'].sort());
    for (const item of rows.slice(0, 2)) {
      const row = rowOf(modal, item.out_biz_no);
      expect(controlsOf(row)).toEqual([...ROW_CONTROLS].sort());
      expect(operableOf(row)).toEqual([]);
      expect(FIELDS.map((label) => disabled(field(row, label)))).toEqual([true, true, true]);
    }
    expect(controlsOf(rowOf(modal, rows[2]!.out_biz_no))).toEqual([]);
    expect(valuesOf(modal, rows.slice(0, 2))).toEqual(filled);
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
  },
);

/**
 * Wrong amounts for the two fillable rows (net 12345.67 and 98.01), round by round: one cent
 * short, and three decimals (98.010 / 12345.670 equal the amount due in value, not in format).
 */
const WRONG_AMOUNTS = [
  ['12345.66', '98.010'],
  ['12345.670', '98.00'],
];

/** Which of a row's three inputs are marked invalid. */
function invalidOf(row: HTMLElement): boolean[] {
  return FIELDS.map((label) => field(row, label).getAttribute('aria-invalid') === 'true');
}

it(
  '[AC-F1-08aq-CONTROLS#4] 实付金额不等于应付、行内显示「实付金额必须等于应付金额」时控件清单仍与刚打开时相同，输入值原样',
  { timeout: 60_000 },
  async () => {
    const rows = threeRows();
    const fillable = rows.slice(0, 2);
    expect(fillable.map((item) => formatFen(parseFen(item.net_fen)))).toEqual([
      '12345.67',
      '98.01',
    ]);
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    const opened = controlsOf(modal);
    expect(opened).toEqual([...OPENED].sort());
    for (const amounts of WRONG_AMOUNTS) {
      const expected: string[][] = [];
      for (const [index, item] of fillable.entries()) {
        const row = rowOf(modal, item.out_biz_no);
        await fill(field(row, '通道流水号'), `  Serial-${index + 1}-Aa  `);
        const date = field(row, '实付时间');
        const when = dateInputValue(date, WHEN);
        await fill(date, when);
        await fill(field(row, '实付金额（元）'), amounts[index]!);
        expected.push([`  Serial-${index + 1}-Aa  `, when, amounts[index]!]);
      }
      await settle();
      for (const item of fillable) {
        const row = rowOf(modal, item.out_biz_no);
        await notice(INVALID.amount, row);
        expect(invalidOf(row)).toEqual([false, false, true]);
        expect(controlsOf(row)).toEqual([...ROW_CONTROLS].sort());
      }
      expect(controlsOf(modal)).toEqual(opened);
      expect(controlsOf(modal)).toEqual([...OPENED].sort());
      expect(controlsOf(rowOf(modal, rows[2]!.out_biz_no))).toEqual([]);
      expect(valuesOf(modal, fillable)).toEqual(expected);
      expect(disabled(button(modal, '确认录入'))).toBe(true);
      expect(operableOf(modal)).toEqual([...OPENED_USABLE].sort());
      expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
      expect(dialogs()).toEqual([modal]);
      expect(server.writes()).toEqual([]);
    }
  },
);

/** Keys pressed and released on each empty input (none may fill in the amount due or "now"). */
const KEYS = ['Tab', 'Enter', 'ArrowDown', 'ArrowUp'];

/** Focus, click, double-click and press keys on an input, then blur it; its value stays ''. */
async function poke(node: HTMLInputElement): Promise<void> {
  await act(async () => {
    node.focus();
    fireEvent.focus(node);
    fireEvent.mouseDown(node);
    fireEvent.mouseUp(node);
    fireEvent.click(node);
    fireEvent.dblClick(node);
    for (const name of KEYS) {
      fireEvent['keyDown'](node, { ['key']: name, code: name });
      fireEvent['keyUp'](node, { ['key']: name, code: name });
    }
  });
  await settle();
  expect(node.value).toBe('');
  await act(async () => {
    node.blur();
    fireEvent.blur(node);
  });
  await settle();
  expect(node.value).toBe('');
}

it(
  '[AC-F1-08aq-CONTROLS#5] 刚打开时对实付金额与实付时间输入框聚焦、点击、双击、按键后失焦，值仍为空、不出现新控件、不发写请求',
  { timeout: 60_000 },
  async () => {
    const rows = threeRows();
    const fillable = rows.slice(0, 2);
    const server = serverFor(rows);
    await mount(server);
    await select(rows);
    const modal = await open();
    const opened = controlsOf(modal);
    expect(opened).toEqual([...OPENED].sort());
    for (const item of fillable) {
      for (const label of ['实付金额（元）', '实付时间']) {
        await poke(field(rowOf(modal, item.out_biz_no), label));
        expect(field(rowOf(modal, item.out_biz_no), label).value).toBe('');
        expect(controlsOf(modal)).toEqual(opened);
        expect(server.writes()).toEqual([]);
      }
    }
    expect(valuesOf(modal, fillable)).toEqual(fillable.map(() => ['', '', '']));
    expect(controlsOf(modal)).toEqual([...OPENED].sort());
    for (const item of fillable)
      expect(controlsOf(rowOf(modal, item.out_biz_no))).toEqual([...ROW_CONTROLS].sort());
    expect(controlsOf(rowOf(modal, rows[2]!.out_biz_no))).toEqual([]);
    expect(disabled(button(modal, '确认录入'))).toBe(true);
    expect(operableOf(modal)).toEqual([...OPENED_USABLE].sort());
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    expect(dialogs()).toEqual([modal]);
    expect(server.writes()).toEqual([]);
  },
);
