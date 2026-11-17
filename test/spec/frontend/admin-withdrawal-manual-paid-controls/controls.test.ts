// @vitest-environment jsdom
// F1-08aq（FU-F108AL-SHORTCUT-INPUTS，D10-2022）：【批量手动打款】对话框里没有把应付金额（或「现在」）
// 填进实付金额的任何快捷入口。对话框刚打开、填写后、结果显示时，把全部表单与可交互控件按「角色: 名字」
// 整份列出，与期望清单逐项相等（BR-WDR-16：实付金额必须由录入人填写且 = net_fen）。
import { formatFen, parseFen } from '@couli/money';
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
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
  fillRows,
  mount,
  notice,
  open,
  paid,
  reply,
  rowOf,
  select,
  serverFor,
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
