// @vitest-environment jsdom
// F1-08an：审核列表上【批量自动打款】与【一键组批】按权限点 payout.execute 出现（BR-WDR-11：服务端校验为准，
// 界面按权限点隐藏只是辅助；超管持有全部权限点）。【批量自动打款】只在勾到待执行（APPROVED）单后出现，
// 与【批量通过】【批量手动打款】同一批量栏、各管各的勾选子集。约定见 ./helpers.ts 开头。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCHES,
  EXECUTOR,
  NAME,
  RECORDER,
  REVIEWER,
  SUPER,
  TEXT,
  VIEWER,
  assertBatch,
  button,
  buttons,
  checkbox,
  click,
  confirm,
  disabled,
  executedReply,
  listOf,
  main,
  mixedRows,
  mount,
  numbersIn,
  openBatch,
  resultShown,
  row,
  select,
  serverFor,
  settled,
  usableBoxes,
  verify,
  writes,
  type Withdrawal,
} from './helpers.ts';

it(
  '[AC-F1-08an-ENTRY#1] 持 fund.view + payout.execute：待执行（APPROVED）行各有一个可用勾选框（含带「暂停」标记的），待审核、打款中、已成功行没有；未勾选时没有【批量自动打款】、有一个可用的【一键组批】；勾一张待执行单后恰有一个可用的【批量自动打款】，没有【批量通过】【批量手动打款】；取消勾选后【批量自动打款】消失；全程不发写请求',
  { timeout: 90_000 },
  async () => {
    const rows = mixedRows();
    const server = serverFor(listOf(rows));
    await mount(server, EXECUTOR);
    for (const item of listOf(rows))
      expect(usableBoxes(item), `${item.out_biz_no} (${item.status})`).toHaveLength(
        item.status === 'APPROVED' ? 1 : 0,
      );
    expect(buttons(main(), NAME.entry), 'no 批量自动打款 before a tick').toEqual([]);
    expect(disabled(button(main(), NAME.group)), '一键组批 usable').toBe(false);

    await select([rows.a]);
    expect(disabled(button(main(), NAME.entry)), '批量自动打款 usable').toBe(false);
    expect(buttons(main(), NAME.approve)).toEqual([]);
    expect(buttons(main(), NAME.manual)).toEqual([]);

    await click(checkbox(rows.a));
    expect(checkbox(rows.a).checked).toBe(false);
    expect(buttons(main(), NAME.entry), 'gone once nothing is ticked').toEqual([]);
    expect(server.writes()).toEqual([]);
    expect(writes(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08an-ENTRY#2] 超管：只勾待审核单时只有【批量通过】、没有【批量自动打款】，再勾一张待执行单后【批量自动打款】【批量手动打款】都可用，【一键组批】在；只持 fund.view、只持 withdraw.review、持 fund.view + payout.manual_entry 时都没有【批量自动打款】【一键组批】（隐藏，不是置灰；勾了各自可勾的单也没有）；全程不发写请求',
  { timeout: 120_000 },
  async () => {
    {
      const rows = mixedRows();
      const server = serverFor(listOf(rows));
      await mount(server, SUPER);
      expect(disabled(button(main(), NAME.group)), 'super: 一键组批 usable').toBe(false);
      await select([rows.p]);
      expect(disabled(button(main(), NAME.approve))).toBe(false);
      expect(buttons(main(), NAME.entry), 'a pending row only: no 批量自动打款').toEqual([]);
      await select([rows.a]);
      expect(disabled(button(main(), NAME.entry)), 'super: 批量自动打款 usable').toBe(false);
      expect(disabled(button(main(), NAME.manual)), 'super: 批量手动打款 usable').toBe(false);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    for (const { label, who, tick } of [
      { label: 'fund.view', who: VIEWER, tick: null },
      { label: 'withdraw.review', who: REVIEWER, tick: 'p' as const },
      { label: 'fund.view + payout.manual_entry', who: RECORDER, tick: 'a' as const },
    ]) {
      const rows = mixedRows();
      const server = serverFor(listOf(rows));
      await mount(server, who);
      expect(buttons(main(), NAME.group), `${label}: no 一键组批`).toEqual([]);
      expect(buttons(main(), NAME.entry), `${label}: no 批量自动打款`).toEqual([]);
      if (tick !== null) {
        await select([rows[tick]]);
        expect(buttons(main(), NAME.entry), `${label}: no 批量自动打款 after a tick`).toEqual([]);
        expect(buttons(main(), NAME.group), `${label}: no 一键组批 after a tick`).toEqual([]);
      } else {
        for (const item of listOf(rows))
          expect(usableBoxes(item), `${label}: ${item.out_biz_no}`).toEqual([]);
      }
      expect(server.writes(), `${label}: no write`).toEqual([]);
      cleanup();
    }
  },
);

const OLD_AUTO = 'b2000031-0000-4000-8000-000000000031';
const OLD_MANUAL = 'b2000032-0000-4000-8000-000000000032';

/**
 * List order: A a plain APPROVED row; S decided auto, left APPROVED on its own kind=auto batch
 * because the bank-card channel was not open (auto_decision.execute_blocked=channel_disabled,
 * the batch item skipped); R returned to APPROVED by W9 (hold_reason daily_cap, execute_seq 1,
 * still on its old manual batch, no transfer attempt); P PENDING_REVIEW. BR-WDR-12: S and R are
 * moved onto the new manual batch in the same transaction, so both can be ticked and grouped.
 */
function rebatchRows(): Record<'a' | 's' | 'r' | 'p', Withdrawal> {
  return {
    a: row(1, 'APPROVED', 1234567),
    s: row(2, 'APPROVED', 28000, 'bank_card', {
      review_mode: 'auto',
      reviewer_id: null,
      auto_decision: {
        result: 'auto',
        failed_conditions: [],
        warn_values: {
          high_commission_order_ratio_bp: 0,
          invalid_ratio_bp: 0,
          withdraw_received_ratio_bp: 0,
        },
        rule_version: 3,
        decided_at: '2026-11-19T10:57:01+08:00',
        execute_blocked: 'channel_disabled',
      },
      reviewed_at: '2026-11-19T10:57:01+08:00',
      batch_id: OLD_AUTO,
      batch: { batch_id: OLD_AUTO, kind: 'auto', created_at: '2026-11-19T10:57:01+08:00' },
      batch_items: [
        {
          batch_id: OLD_AUTO,
          result: 'skipped',
          reason: 'channel_disabled',
          moved_to_batch_id: null,
          at: '2026-11-19T10:57:02+08:00',
        },
      ],
      payout_attempts: [],
    }),
    r: row(3, 'APPROVED', 20000, 'alipay', {
      auto_decision: {
        result: 'manual',
        failed_conditions: ['max_amount', 'risk_flag:first_withdrawal'],
        warn_values: {
          high_commission_order_ratio_bp: 1200,
          invalid_ratio_bp: 300,
          withdraw_received_ratio_bp: 4500,
        },
        rule_version: 3,
        decided_at: '2026-11-19T10:56:01+08:00',
        execute_blocked: null,
      },
      reviewed_at: '2026-11-19T10:56:05+08:00',
      hold_reason: 'daily_cap',
      hold_at: '2026-11-19T10:56:20+08:00',
      executor_id: null,
      executed_at: null,
      execute_seq: 1,
      batch_id: OLD_MANUAL,
      batch: { batch_id: OLD_MANUAL, kind: 'manual', created_at: '2026-11-19T10:56:10+08:00' },
      batch_items: [
        {
          batch_id: OLD_MANUAL,
          result: 'paying',
          reason: null,
          moved_to_batch_id: null,
          at: '2026-11-19T10:56:11+08:00',
        },
      ],
      payout_attempts: [],
    }),
    p: row(4, 'PENDING_REVIEW', 30000),
  };
}

it(
  '[AC-F1-08an-ENTRY#3] 已挂在别的批次上的待执行单可进人工组批（BR-WDR-12 换批次）：自动批次上因通道未开通受阻的单（batch_id 指向该自动批次、auto_decision.execute_blocked=channel_disabled）与经 W9 退回、仍挂在旧批次上的单（hold_reason 有值）各有一个可用勾选框；持 payout.execute 按【一键组批】选中这两张与普通待执行单（不选待审核单），超管手动勾这两张也行；动态码后请求体恰为按列表顺序的这些 withdrawal_ids',
  { timeout: 180_000 },
  async () => {
    {
      const rows = rebatchRows();
      const server = serverFor(listOf(rows));
      const ids = [rows.a, rows.s, rows.r].map((one) => one.withdrawal_id);
      server.once('POST', BATCHES, () => executedReply(server, ids));
      await mount(server, EXECUTOR);
      for (const item of [rows.a, rows.s, rows.r])
        expect(usableBoxes(item), `${item.out_biz_no}: one usable checkbox`).toHaveLength(1);
      expect(usableBoxes(rows.p), 'pending: no checkbox for payout.execute').toEqual([]);
      await click(button(main(), NAME.group));
      await settled(server);
      expect(server.writes(), '一键组批 sends no write').toEqual([]);
      for (const item of [rows.a, rows.s, rows.r])
        expect(checkbox(item).checked, `${item.out_biz_no} picked by 一键组批`).toBe(true);
      const modal = await openBatch(server);
      const numbers = listOf(rows).map((one) => one.out_biz_no);
      expect(numbersIn(modal, numbers), 'the three executable rows in list order').toEqual(
        [rows.a, rows.s, rows.r].map((one) => one.out_biz_no),
      );
      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);
      assertBatch(server, 0, ids);
      await resultShown(rows.s.out_biz_no, TEXT.paying);
      await resultShown(rows.r.out_biz_no, TEXT.paying);
      cleanup();
    }
    {
      const rows = rebatchRows();
      const server = serverFor(listOf(rows));
      const ids = [rows.s, rows.r].map((one) => one.withdrawal_id);
      server.once('POST', BATCHES, () => executedReply(server, ids));
      await mount(server, SUPER);
      await select([rows.r, rows.s]);
      const modal = await openBatch(server);
      expect(
        numbersIn(
          modal,
          listOf(rows).map((one) => one.out_biz_no),
        ),
        'super: the two ticked rows in list order',
      ).toEqual([rows.s.out_biz_no, rows.r.out_biz_no]);
      await confirm(server, modal);
      await verify();
      await waitFor(() => expect(writes(server)).toHaveLength(1));
      await settled(server);
      assertBatch(server, 0, ids);
      cleanup();
    }
  },
);
