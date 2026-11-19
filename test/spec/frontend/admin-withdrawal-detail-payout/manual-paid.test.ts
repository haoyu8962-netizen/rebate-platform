// @vitest-environment jsdom
// F1-08am【手动成功】：复用 F1-08al 的录入对话框，一张单即一张单的批次（adminBatchManualPaid，items 只有这一张；
// BR-WDR-16 W8，BR-ID-34 动态码档）。打开时通道流水号、实付时间、实付金额三项为空；实付金额须等于应付；对话框
// 里没有任何把应付金额或当前时间填进输入框的入口（D10-2004 / D10-2050：按「角色: 名字」列全对话框控件，打开、
// 填写后、结果显示后各与整份期望相等）；实付时间不得晚于注入时钟的现在。动态码后只发一次 POST，逐单结果
// （已录入 / 跳过原因）如实显示，录入后重读详情。
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { controlsOf, operableOf } from '../admin-withdrawal-manual-paid-controls/controls.ts';
import {
  FIELD,
  FORBIDDEN,
  LATER,
  MANUAL,
  MANUAL_BODY,
  MANUAL_ENTRY,
  NAME,
  NET_SHOWN,
  NET_TYPED,
  NUMBER,
  SERIAL,
  STATUS_SHOWN,
  STEP_AGAIN,
  SUPER,
  TEXT,
  VERIFY,
  WHEN,
  WID,
  assertManual,
  assertSameWrites,
  button,
  buttons,
  click,
  dialogs,
  disabled,
  entries,
  executeOnServer,
  executes,
  field,
  fill,
  fillEntry,
  inDialog,
  keyOf,
  manuals,
  mount,
  notice,
  openManual,
  paidReply,
  payDialog,
  refreshed,
  serverFor,
  settle,
  settled,
  shows,
  skippedReply,
  statusShown,
  step,
  stepDialogs,
  submit,
  submitAgainFrom,
  timeTyped,
  values,
  verify,
  writes,
  type ManualPayload,
} from './helpers.ts';

/** Right after opening: corner close, 取消, 确认录入 and the three text inputs. */
const OPENED = [
  'button: Close',
  'button: 取消',
  'button: 确认录入',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
].sort();
/** Usable while something is missing or wrong: everything but the disabled 确认录入. */
const OPENED_USABLE = OPENED.filter((entry) => entry !== 'button: 确认录入');
/** The result: corner close, 关闭 and the three inputs kept on screen, locked. */
const FINISHED = [
  'button: Close',
  'button: 关闭',
  'textbox: 通道流水号',
  'textbox: 实付时间',
  'textbox: 实付金额（元）',
].sort();
const SHORTCUT = /应付|填入|同上|一键|复制|此刻|现在|当前时间|今天|now|today/i;

/** Focus, click, double-click, press keys and paste on an empty input, then blur: still ''. */
async function poke(node: HTMLInputElement): Promise<void> {
  await act(async () => {
    node.focus();
    fireEvent.focus(node);
    fireEvent.mouseDown(node);
    fireEvent.mouseUp(node);
    fireEvent.click(node);
    fireEvent.dblClick(node);
    for (const name of ['Tab', 'Enter', 'ArrowDown', 'ArrowUp']) {
      fireEvent['keyDown'](node, { ['key']: name, code: name });
      fireEvent['keyUp'](node, { ['key']: name, code: name });
    }
    fireEvent.paste(node, { clipboardData: { getData: () => '1' } });
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
  '[AC-F1-08am-MANUAL#1] 持 payout.manual_entry：【手动成功】打开录入对话框，列出单号与应付，三项为空、【确认录入】不可用，控件清单整份等于关闭、取消、确认录入与三个文本输入；实付金额不等于应付（差一分、多一分、三位小数、整数不同）时提示「实付金额必须等于应付金额」、不可提交、控件清单不变、输入原样；三项逐项轮换（另两项填对，这一项留空，流水号另测只填空格）时【确认录入】都不可用、不弹验证、不发请求；填对后控件清单仍相同；【取消】后再打开三项又为空，全程不发请求',
  { timeout: 150_000 },
  async () => {
    const server = serverFor();
    await mount(server, MANUAL_ENTRY);
    const modal = await openManual(server);
    expect(shows(modal, NUMBER)).toBe(true);
    expect(shows(modal, NET_SHOWN)).toBe(true);
    expect(values(modal)).toEqual(['', '', '']);
    expect(controlsOf(modal)).toEqual(OPENED);
    expect(disabled(button(modal, NAME.manualSubmit))).toBe(true);
    expect(operableOf(modal)).toEqual(OPENED_USABLE);

    for (const wrong of ['97.99', '98.01', '98.000', '100.00']) {
      const typed = await fillEntry(modal, WHEN, wrong);
      await notice(TEXT.amountMismatch, modal);
      expect(values(modal), wrong).toEqual(typed);
      expect(field(modal, FIELD.amount).getAttribute('aria-invalid'), wrong).toBe('true');
      expect(disabled(button(modal, NAME.manualSubmit)), wrong).toBe(true);
      expect(controlsOf(modal), wrong).toEqual(OPENED);
      expect(operableOf(modal), wrong).toEqual(OPENED_USABLE);
      await click(button(modal, NAME.manualSubmit));
      expect(dialogs()).toEqual([modal]);
      expect(writes(server)).toEqual([]);
    }

    // The three are all required: the other two right, this one left empty (the serial also only
    // blanks) → 【确认录入】 stays unusable and nothing is sent.
    const time = timeTyped(field(modal, FIELD.paidAt), WHEN);
    const missing: { label: string; serial: string; at: string; amount: string }[] = [
      { label: 'serial empty', serial: '', at: time, amount: NET_TYPED },
      { label: 'serial blanks only', serial: '   ', at: time, amount: NET_TYPED },
      { label: 'paid time empty', serial: SERIAL, at: '', amount: NET_TYPED },
      { label: 'amount empty', serial: SERIAL, at: time, amount: '' },
    ];
    for (const { label, serial, at, amount } of missing) {
      await fill(field(modal, FIELD.serial), serial);
      await fill(field(modal, FIELD.paidAt), at);
      await fill(field(modal, FIELD.amount), amount);
      await settle();
      expect(disabled(button(modal, NAME.manualSubmit)), label).toBe(true);
      expect(controlsOf(modal), label).toEqual(OPENED);
      expect(operableOf(modal), label).toEqual(OPENED_USABLE);
      await click(button(modal, NAME.manualSubmit));
      expect(dialogs(), label).toEqual([modal]);
      expect(stepDialogs(), label).toEqual([]);
      expect(writes(server), label).toEqual([]);
    }

    const typed = await fillEntry(modal);
    expect(values(modal)).toEqual(typed);
    expect(disabled(button(modal, NAME.manualSubmit))).toBe(false);
    expect(controlsOf(modal)).toEqual(OPENED);
    expect(operableOf(modal)).toEqual(OPENED);
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);

    await click(button(modal, NAME.cancel));
    await waitFor(() => expect(dialogs()).toEqual([]));
    const fresh = await openManual(server);
    expect(values(fresh)).toEqual(['', '', '']);
    expect(controlsOf(fresh)).toEqual(OPENED);
    await settled(server);
    expect(writes(server)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
);

it(
  '[AC-F1-08am-MANUAL#2] 刚打开时对实付金额与实付时间输入框聚焦、点击、双击、按键、粘贴后失焦，值仍为空、控件清单不变；实付时间晚于注入时钟的现在 1 秒时提示「实付时间不能晚于当前时间」、不可提交、控件清单不变，不发请求',
  { timeout: 90_000 },
  async () => {
    const server = serverFor();
    await mount(server, SUPER);
    const modal = await openManual(server);
    expect(controlsOf(modal)).toEqual(OPENED);
    for (const label of [FIELD.amount, FIELD.paidAt]) {
      await poke(field(modal, label));
      expect(controlsOf(modal), label).toEqual(OPENED);
      expect(writes(server)).toEqual([]);
    }
    expect(values(modal)).toEqual(['', '', '']);

    const typed = await fillEntry(modal, LATER);
    await notice(TEXT.future, modal);
    expect(values(modal)).toEqual(typed);
    expect(field(modal, FIELD.paidAt).getAttribute('aria-invalid')).toBe('true');
    expect(disabled(button(modal, NAME.manualSubmit))).toBe(true);
    expect(controlsOf(modal)).toEqual(OPENED);
    expect(operableOf(modal)).toEqual(OPENED_USABLE);
    expect(controlsOf(modal).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    await settled(server);
    expect(writes(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08am-MANUAL#3] 填对三项 →【确认录入】→ 动态码（双击也只发一次）→ 只发一次 POST /admin/v1/withdrawals/batch-manual-paid，items 恰为这一张（流水号去首尾空白、实付时间、实付金额 = net_fen），带 X-Step-Up-Token 与 Idempotency-Key；显示「已录入」，结果态控件只剩关闭类、三项锁定保留原文；详情重读为线下打款成功、两个入口消失，不发执行打款',
  { timeout: 120_000 },
  async () => {
    const server = serverFor();
    server.once('POST', MANUAL, (request) => paidReply(server, request));
    await mount(server, MANUAL_ENTRY);
    const modal = await openManual(server);
    const typed = await fillEntry(modal);
    const before = server.detailReads(WID).length;
    await submit(server, modal, NAME.manualSubmit, true);
    await verify(true);
    await waitFor(() => expect(manuals(server)).toHaveLength(1));
    await settled(server);
    assertManual(server, 0);
    await inDialog(TEXT.paid);
    const result = payDialog();
    expect(controlsOf(result)).toEqual(FINISHED);
    expect(operableOf(result)).toEqual(['button: Close', 'button: 关闭'].sort());
    expect(values(result)).toEqual(typed);
    expect(controlsOf(result).filter((entry) => SHORTCUT.test(entry))).toEqual([]);
    await refreshed(server, before);
    await waitFor(() => expect(statusShown(STATUS_SHOWN.PAID_MANUAL)).toBe(true));
    expect(statusShown(STATUS_SHOWN.APPROVED)).toBe(false);
    expect(entries()).toEqual({ execute: false, manual: false });
    expect(manuals(server)).toHaveLength(1);
    expect(executes(server)).toEqual([]);
    expect(server.requests('POST', VERIFY)).toHaveLength(1);
  },
);

it(
  '[AC-F1-08am-MANUAL#4] 服务端逐单跳过（会员有提现阻断、存在未定的转账尝试、流水号已被他单使用）：如实显示跳过原因，单据仍已通过待打款、不显示线下打款成功；该单已先被执行打款（not_approved，先提交的生效）：显示「提现单不再是待执行状态，本次未录入」、不显示线下打款成功，随后重读详情显示打款中、两个入口都不再出现；每次只发一次',
  { timeout: 200_000 },
  async () => {
    const reasons = ['member_blocked', 'has_transfer_attempt', 'channel_order_id_taken'] as const;
    for (const reason of reasons) {
      const server = serverFor();
      server.once('POST', MANUAL, () => skippedReply(reason));
      await mount(server, MANUAL_ENTRY);
      const modal = await openManual(server);
      await fillEntry(modal);
      await submit(server, modal, NAME.manualSubmit);
      await verify();
      await waitFor(() => expect(manuals(server)).toHaveLength(1));
      await settled(server);
      assertManual(server, 0);
      await inDialog(TEXT.skipped[reason]!);
      expect(statusShown(STATUS_SHOWN.APPROVED), reason).toBe(true);
      expect(statusShown(STATUS_SHOWN.PAID_MANUAL), reason).toBe(false);
      expect(shows(document.body, TEXT.unknown), reason).toBe(false);
      expect(writes(server)).toHaveLength(1);
      cleanup();
    }

    // The execute was committed first (BR-WDR-16: the first to commit wins).
    const raced = serverFor();
    raced.once('POST', MANUAL, () => {
      executeOnServer(raced);
      return skippedReply('not_approved');
    });
    await mount(raced, SUPER);
    const modal = await openManual(raced);
    await fillEntry(modal);
    const before = raced.detailReads(WID).length;
    await submit(raced, modal, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(raced)).toHaveLength(1));
    await settled(raced);
    assertManual(raced, 0);
    await inDialog(TEXT.skipped.not_approved!);
    expect(shows(document.body, TEXT.unknown), 'not_approved').toBe(false);
    await refreshed(raced, before);
    await waitFor(() => expect(statusShown(STATUS_SHOWN.PAYING)).toBe(true));
    expect(statusShown(STATUS_SHOWN.APPROVED), 'not_approved').toBe(false);
    expect(statusShown(STATUS_SHOWN.PAID_MANUAL), 'not_approved').toBe(false);
    expect(entries(), 'not_approved: both entries gone').toEqual({
      execute: false,
      manual: false,
    });
    expect(writes(raced)).toHaveLength(1);
    expect(executes(raced)).toEqual([]);
  },
);

it(
  '[AC-F1-08am-MANUAL#5] 提交收到 10003：重新动态码、验证前不重发，验证后原 Idempotency-Key 与逐字节相同的请求体再发并显示「已录入」；对照：另一次首次提交即收 10403 提示「无权限执行此操作（需要 payout.manual_entry 权限点）」、不进入结果未知、输入解锁可改，改流水号后再提交换新键',
  { timeout: 180_000 },
  async () => {
    const server = serverFor();
    server.once('POST', MANUAL, STEP_AGAIN);
    server.once('POST', MANUAL, (request) => paidReply(server, request));
    await mount(server, MANUAL_ENTRY);
    const modal = await openManual(server);
    await fillEntry(modal);
    await submit(server, modal, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(1));
    await settled(server);
    await step();
    await notice(TEXT.again);
    await settle();
    expect(manuals(server), 'nothing resent before the new verification').toHaveLength(1);
    await verify();
    await waitFor(() => expect(manuals(server)).toHaveLength(2));
    await settled(server);
    assertManual(server, 1);
    assertSameWrites(server, MANUAL, 2);
    await inDialog(TEXT.paid);
    cleanup();

    const other = serverFor();
    other.once('POST', MANUAL, FORBIDDEN);
    other.once('POST', MANUAL, (request) => paidReply(other, request));
    await mount(other, MANUAL_ENTRY);
    const dialog = await openManual(other);
    await fillEntry(dialog);
    await submit(other, dialog, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(other)).toHaveLength(1));
    await settled(other);
    assertManual(other, 0);
    await notice(TEXT.manualForbidden);
    expect(shows(document.body, TEXT.unknown)).toBe(false);
    expect(buttons(document.body, NAME.retry)).toEqual([]);
    await settle();
    expect(manuals(other)).toHaveLength(1);

    const again = await submitAgainFrom(other, NAME.manualSubmit, NAME.manual);
    for (const label of [FIELD.serial, FIELD.paidAt, FIELD.amount])
      expect(disabled(field(again, label)), `${label} unlocked`).toBe(false);
    const changed = `${SERIAL}-2`;
    if (values(again)[1] === '') await fillEntry(again);
    await fill(field(again, FIELD.serial), changed);
    await settle();
    await submit(other, again, NAME.manualSubmit);
    await verify();
    await waitFor(() => expect(manuals(other)).toHaveLength(2));
    await settled(other);
    const corrected: ManualPayload = {
      items: [{ ...MANUAL_BODY.items[0]!, channel_order_id: changed }],
    };
    assertManual(other, 1, corrected);
    expect(keyOf(manuals(other)[1]!)).not.toBe(keyOf(manuals(other)[0]!));
    await inDialog(TEXT.paid);
  },
);
