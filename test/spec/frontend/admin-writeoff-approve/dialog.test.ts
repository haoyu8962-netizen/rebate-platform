// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SUMMARY, SUMMARY_LABELS, TEXT, USER, WO, createWriteoffServer, yuan } from './fixtures.ts';
import {
  buttons,
  fields,
  hasText,
  nonReadsSince,
  openApprove,
  ready,
  stepUpDialogs,
  usable,
} from './helpers.ts';

/** The dialog has no control a person could change (the amount is never sent). */
function noInputs(dialog: HTMLElement): void {
  for (const role of ['textbox', 'spinbutton', 'combobox', 'radio', 'checkbox'] as const)
    expect(within(dialog).queryAllByRole(role), role).toEqual([]);
}
/** 【取消】 and 【批准核销】 each shown once and usable. */
function decisions(dialog: HTMLElement): void {
  for (const name of [TEXT.cancel, TEXT.approve]) {
    expect(usable(dialog, name), name).toHaveLength(1);
    expect(buttons(dialog, name), name).toHaveLength(1);
  }
}

it(
  '[AC-F1-08cd-DIALOG#1] 行上【批准核销】打开「批准坏账核销」：候选单摘要（候选单号、用户、负余额起始日、负余额天数、生成时金额 8 元、当前可用余额负 3 元、冻结 0，金额只经 @couli/money）、「核销金额按批准时余额」说明与后果说明（记坏账、关联账户风控标记）；没有冻结提示、没有任何输入项；【取消】【批准核销】可用；打开不发写请求、不弹验证',
  { timeout: 60_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const since = server.log.length;
    const dialog = await openApprove(server, WO.recent);
    expect(fields(dialog, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: WO.recent,
      [SUMMARY.user]: USER.negative,
      [SUMMARY.since]: '2026-11-20',
      [SUMMARY.days]: '90',
      [SUMMARY.candidate]: yuan(800),
      [SUMMARY.available]: yuan(-300),
      [SUMMARY.frozen]: yuan(0),
    });
    expect(hasText(dialog, TEXT.amountNotice)).toBe(true);
    expect(hasText(dialog, TEXT.consequence)).toBe(true);
    expect(hasText(dialog, TEXT.frozenPending)).toBe(false);
    noInputs(dialog);
    decisions(dialog);
    expect(stepUpDialogs()).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cd-DIALOG#2] 有冻结金额的待批准候选单（approve_blocked=true）：对话框摘要显示当前可用余额负 123.45 元、冻结 50 元，并显示「该用户有冻结中的提现金额（提现单未到终态），暂不能核销：请先把提现单处理到终态，候选单保持待批准。」；说明与后果说明照常；打开不发写请求',
  { timeout: 60_000 },
  async () => {
    const server = createWriteoffServer();
    await ready(server);
    const since = server.log.length;
    const dialog = await openApprove(server, WO.blocked);
    expect(fields(dialog, SUMMARY_LABELS)).toEqual({
      [SUMMARY.id]: WO.blocked,
      [SUMMARY.user]: USER.frozen,
      [SUMMARY.since]: '2026-11-01',
      [SUMMARY.days]: '109',
      [SUMMARY.candidate]: yuan(12000),
      [SUMMARY.available]: yuan(-12345),
      [SUMMARY.frozen]: yuan(5000),
    });
    expect(hasText(dialog, TEXT.frozenPending)).toBe(true);
    expect(hasText(dialog, TEXT.amountNotice)).toBe(true);
    expect(hasText(dialog, TEXT.consequence)).toBe(true);
    noInputs(dialog);
    expect(buttons(dialog, TEXT.cancel)).toHaveLength(1);
    expect(buttons(dialog, TEXT.approve)).toHaveLength(1);
    expect(stepUpDialogs()).toEqual([]);
    expect(nonReadsSince(server, since)).toEqual([]);
  },
);

it(
  '[AC-F1-08cd-DIALOG#3] 冻结提示只看列表的 approve_blocked、不看冻结金额本身（开关 ledger.bad_debt_require_no_frozen.enabled 关闭时服务端给 approve_blocked=false）：同一张有冻结 50 元的候选单，对话框不显示冻结提示，【批准核销】可用',
  { timeout: 60_000 },
  async () => {
    const server = createWriteoffServer({ requireNoFrozen: false });
    await ready(server);
    const dialog = await openApprove(server, WO.blocked);
    expect(fields(dialog, [SUMMARY.available, SUMMARY.frozen])).toEqual({
      [SUMMARY.available]: yuan(-12345),
      [SUMMARY.frozen]: yuan(5000),
    });
    expect(hasText(dialog, TEXT.frozenPending)).toBe(false);
    decisions(dialog);
  },
);
