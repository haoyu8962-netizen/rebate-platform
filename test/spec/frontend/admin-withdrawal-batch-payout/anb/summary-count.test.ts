// @vitest-environment jsdom
// F1-08anc（FU-F108AN-SUMMARY-UNREVIEWED-COUNT，D10-2961 / D10-2994 / D10-2995）：批量自动打款结果对话框的汇总
// 在勾选中有待审核单（BR-WDR-12 细则：勾选中的 PENDING_REVIEW 单不在本操作中审核、结果列显示「未审核」）时，
// 必须在「进入打款 P 张，留在待执行 L 张」后接「，未审核 U 张」，U 是勾选中的待审核单张数（不是留下张数）。
// 汇总全文取自工作树 apps/admin/src/texts/withdrawals.ts batchPayout.summary，在这里独立写成全文期望，不 import
// 实现的文案；定位方式同 ./receipt.test.ts（对话框里以「进入打款」开头的叶子元素恰为一处），但比较的是该元素
// 的 textContent 原文（只去首尾空白、不删内部空白），与期望全文严格相等。约定见 ../helpers.ts 与 ./helpers.ts 开头。
// 三组裁定输入（留下 0 / 未审核 1、留下 1 / 未审核 2、留下 1 / 未审核 1）使「未审核张数 = 留下张数 + 1」之类
// 取错来源的实现不能同时通过；第四组（同页另有一张未勾选的待审核单）使「按本页全部待审核单计」的实现不能通过。
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LEFT_TEXT,
  SUPER,
  TEXT,
  assertBatch,
  compact,
  confirm,
  executedReply,
  mount,
  openBatch,
  row,
  rowOf,
  select,
  serverFor,
  settled,
  shows,
  verify,
  writes,
  type LeftReason,
  type Server,
  type Withdrawal,
} from '../helpers.ts';
import { ONE_BATCH, ownDialog, writeLines } from './helpers.ts';

/** Two paying, none left, one unreviewed (full text). */
const ONE_PENDING = '进入打款 2 张，留在待执行 0 张，未审核 1 张；列表与页签计数已刷新。';
/** One paying, one left, two unreviewed (full text). */
const TWO_PENDING = '进入打款 1 张，留在待执行 1 张，未审核 2 张；列表与页签计数已刷新。';
/** One paying, one left, one unreviewed (full text). */
const ONE_LEFT_ONE_PENDING = '进入打款 1 张，留在待执行 1 张，未审核 1 张；列表与页签计数已刷新。';
/** Where a summary starts (located by compact text, compared in full). */
const SUMMARY_START = '进入打款';

/** Ticks `rows`, opens 【批量自动打款】, confirms and passes the dynamic code; one write follows. */
async function execute(server: Server, rows: readonly Withdrawal[]): Promise<void> {
  await select(rows);
  const modal = await openBatch(server);
  await confirm(server, modal);
  await verify();
  await waitFor(() => expect(writes(server)).toHaveLength(1));
  await settled(server);
}

/**
 * The summaries of the result dialog: the leaf elements whose compact text starts with
 * 「进入打款」, each as its textContent with only the outer whitespace trimmed (inner kept).
 */
function summaryLeaves(): string[] {
  return Array.from(ownDialog().querySelectorAll<HTMLElement>('*'))
    .filter((one) => one.children.length === 0)
    .filter((one) => compact(one.textContent).startsWith(SUMMARY_START))
    .map((one) => (one.textContent ?? '').trim());
}

/** Waits for exactly one summary in the result dialog and returns the summaries (raw text). */
async function summaryOf(): Promise<string[]> {
  await waitFor(() => expect(summaryLeaves(), 'one summary').toHaveLength(1));
  return summaryLeaves();
}

/** The row of `one` in the result dialog shows `text`. */
function showsIn(one: Withdrawal, text: string): boolean {
  return shows(rowOf(ownDialog(), one.out_biz_no), text);
}

it(
  '[AC-F1-08anc-SUMMARY#1] 超管混选一张待审核单与两张待执行单，服务端回 executed、两张都进入打款（left 为空）：请求体只有两张待执行单（列表顺序）；结果对话框里汇总全文恰为「进入打款 2 张，留在待执行 0 张，未审核 1 张；列表与页签计数已刷新。」，待审核单为「未审核」、两张待执行单为「已发起打款」',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const bank = row(2, 'APPROVED', 9801, 'bank_card');
    const pending = row(3, 'PENDING_REVIEW', 30000, 'alipay');
    const server = serverFor([alipay, bank, pending]);
    const paying = [alipay.withdrawal_id, bank.withdrawal_id];
    server.once('POST', '/admin/v1/payout-batches', () => executedReply(server, paying));
    await mount(server, SUPER);
    await execute(server, [pending, bank, alipay]);
    assertBatch(server, 0, paying);

    expect(await summaryOf(), 'the summary in full').toEqual([ONE_PENDING]);
    expect(showsIn(pending, TEXT.unreviewed), 'pending: unreviewed').toBe(true);
    expect(showsIn(pending, TEXT.paying), 'pending: not paying').toBe(false);
    expect(showsIn(alipay, TEXT.paying), 'alipay: paying').toBe(true);
    expect(showsIn(bank, TEXT.paying), 'bank card: paying').toBe(true);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);

it(
  '[AC-F1-08anc-SUMMARY#2] 混选两张待审核单与两张待执行单，服务端回 executed：支付宝单进入打款，银行卡单因打款通道未开通留在 left；请求体只有两张待执行单（列表顺序）；结果对话框里汇总全文恰为「进入打款 1 张，留在待执行 1 张，未审核 2 张；列表与页签计数已刷新。」（未审核张数是待审核单张数，不是留下张数）',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const first = row(2, 'PENDING_REVIEW', 30000, 'alipay');
    const bank = row(3, 'APPROVED', 9801, 'bank_card');
    const second = row(4, 'PENDING_REVIEW', 7700, 'wechat');
    const reason: LeftReason = 'channel_disabled';
    const left = [{ withdrawal_id: bank.withdrawal_id, reason }];
    const server = serverFor([alipay, first, bank, second]);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(server, [alipay.withdrawal_id], left),
    );
    await mount(server, SUPER);
    await execute(server, [second, bank, first, alipay]);
    assertBatch(server, 0, [alipay.withdrawal_id, bank.withdrawal_id]);

    expect(await summaryOf(), 'the summary in full').toEqual([TWO_PENDING]);
    for (const one of [first, second]) {
      expect(showsIn(one, TEXT.unreviewed), `${one.out_biz_no}: unreviewed`).toBe(true);
      expect(showsIn(one, TEXT.paying), `${one.out_biz_no}: not paying`).toBe(false);
    }
    expect(showsIn(alipay, TEXT.paying), 'alipay: paying').toBe(true);
    expect(showsIn(bank, LEFT_TEXT[reason]), 'bank card: its own reason').toBe(true);
    expect(showsIn(bank, TEXT.paying), 'bank card: not paying').toBe(false);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);

it(
  '[AC-F1-08anc-SUMMARY#3] 混选一张待审核单与两张待执行单，服务端回 executed：支付宝单进入打款，银行卡单因打款通道未开通留在 left；请求体只有两张待执行单（列表顺序）；结果对话框里汇总全文恰为「进入打款 1 张，留在待执行 1 张，未审核 1 张；列表与页签计数已刷新。」（留下 1 张时未审核仍是待审核单张数 1，不是留下张数加一）',
  { timeout: 120_000 },
  async () => {
    const alipay = row(1, 'APPROVED', 1234567, 'alipay');
    const pending = row(2, 'PENDING_REVIEW', 30000, 'alipay');
    const bank = row(3, 'APPROVED', 9801, 'bank_card');
    const reason: LeftReason = 'channel_disabled';
    const left = [{ withdrawal_id: bank.withdrawal_id, reason }];
    const server = serverFor([alipay, pending, bank]);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(server, [alipay.withdrawal_id], left),
    );
    await mount(server, SUPER);
    await execute(server, [bank, pending, alipay]);
    assertBatch(server, 0, [alipay.withdrawal_id, bank.withdrawal_id]);

    expect(await summaryOf(), 'the summary in full').toEqual([ONE_LEFT_ONE_PENDING]);
    expect(showsIn(pending, TEXT.unreviewed), 'pending: unreviewed').toBe(true);
    expect(showsIn(pending, TEXT.paying), 'pending: not paying').toBe(false);
    expect(showsIn(alipay, TEXT.paying), 'alipay: paying').toBe(true);
    expect(showsIn(bank, LEFT_TEXT[reason]), 'bank card: its own reason').toBe(true);
    expect(showsIn(bank, TEXT.paying), 'bank card: not paying').toBe(false);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);

it(
  '[AC-F1-08anc-SUMMARY#4] 列表同一页有两张待审核单与两张待执行单，只勾其中一张待审核单与两张待执行单（另一张待审核单不勾），服务端回 executed：支付宝单进入打款，银行卡单因打款通道未开通留在 left；请求体只有两张待执行单（列表顺序）；结果对话框里汇总全文恰为「进入打款 1 张，留在待执行 1 张，未审核 1 张；列表与页签计数已刷新。」（按勾选中的待审核单计，不按本页全部待审核单计）',
  { timeout: 120_000 },
  async () => {
    const unticked = row(1, 'PENDING_REVIEW', 5500, 'wechat');
    const alipay = row(2, 'APPROVED', 1234567, 'alipay');
    const pending = row(3, 'PENDING_REVIEW', 30000, 'alipay');
    const bank = row(4, 'APPROVED', 9801, 'bank_card');
    const reason: LeftReason = 'channel_disabled';
    const left = [{ withdrawal_id: bank.withdrawal_id, reason }];
    const server = serverFor([unticked, alipay, pending, bank]);
    server.once('POST', '/admin/v1/payout-batches', () =>
      executedReply(server, [alipay.withdrawal_id], left),
    );
    await mount(server, SUPER);
    await execute(server, [bank, pending, alipay]);
    assertBatch(server, 0, [alipay.withdrawal_id, bank.withdrawal_id]);

    expect(await summaryOf(), 'the summary in full').toEqual([ONE_LEFT_ONE_PENDING]);
    expect(showsIn(pending, TEXT.unreviewed), 'ticked pending: unreviewed').toBe(true);
    expect(showsIn(pending, TEXT.paying), 'ticked pending: not paying').toBe(false);
    expect(showsIn(alipay, TEXT.paying), 'alipay: paying').toBe(true);
    expect(showsIn(bank, LEFT_TEXT[reason]), 'bank card: its own reason').toBe(true);
    expect(showsIn(bank, TEXT.paying), 'bank card: not paying').toBe(false);
    expect(writeLines(server)).toEqual(ONE_BATCH);
  },
);
