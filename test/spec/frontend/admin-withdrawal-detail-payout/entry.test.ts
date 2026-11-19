// @vitest-environment jsdom
// F1-08am：提现单详情页的【执行打款】（payout.execute）与【手动成功】（payout.manual_entry）只对 APPROVED
// 单出现（BR-WDR-12 EXECUTE 与 BR-WDR-16 W8 都只从 APPROVED 进入；超管持全部点）；已发出转账的单两个都不出
// （BR-WDR-12 ②「有转账记录即拒绝执行」，BR-WDR-16 有 pending / success / unknown 转账尝试不得手动成功，结果待确认
// 的处置仍走 W10）；微信零钱单不开放 W8（BR-WDR-33 ⑧）；银行卡单在通道开通前只能手动成功（BR-WDR-32 ①），入口与
// 支付宝单相同、发出的 items 同形；【撤销微信转账】先隐藏（D10-2017）、【重新计算】不做。除 ENTRY#5 外只看不点不发写请求。
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { PermissionSnapshot } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { PAYEE } from '../admin-withdrawals/fixtures.ts';
import {
  EXECUTE,
  MANUAL,
  MANUAL_BODY,
  MANUAL_ENTRY,
  NAME,
  REVIEWER_ONLY,
  SUPER,
  TEXT,
  VIEWER,
  approved,
  assertManual,
  assertNoOtherActions,
  entries,
  executes,
  fillEntry,
  inDialog,
  inStatus,
  manuals,
  mount,
  openManual,
  paidReply,
  serverFor,
  settled,
  submit,
  transfer,
  verify,
  type Withdrawal,
} from './helpers.ts';

it(
  '[AC-F1-08am-ENTRY#1] 待执行（APPROVED）单：持 payout.execute 只出【执行打款】，持 payout.manual_entry 只出【手动成功】，超管两个都出且可用；只持 fund.view 或 withdraw.review 两个都不出；都没有【撤销微信转账】【重新计算】，不点不发写请求',
  { timeout: 120_000 },
  async () => {
    const cases: { label: string; who: PermissionSnapshot; want: ReturnType<typeof entries> }[] = [
      { label: 'payout.execute', who: EXECUTE, want: { execute: true, manual: false } },
      { label: 'payout.manual_entry', who: MANUAL_ENTRY, want: { execute: false, manual: true } },
      { label: 'super', who: SUPER, want: { execute: true, manual: true } },
      { label: 'fund.view', who: VIEWER, want: { execute: false, manual: false } },
      { label: 'withdraw.review', who: REVIEWER_ONLY, want: { execute: false, manual: false } },
    ];
    for (const { label, who, want } of cases) {
      const server = serverFor();
      await mount(server, who);
      expect(entries(), label).toEqual(want);
      assertNoOtherActions();
      expect(server.writes(), label).toEqual([]);
      cleanup();
    }
  },
);

it(
  '[AC-F1-08am-ENTRY#2] 只有 APPROVED 单出两个入口：待审核、已驳回、打款中、接口打款成功、线下打款成功、打款失败的单（超管）两个都不出；APPROVED 单（超管）两个都出',
  { timeout: 150_000 },
  async () => {
    const others = [
      'PENDING_REVIEW',
      'REJECTED',
      'PAYING',
      'PAID_API',
      'PAID_MANUAL',
      'FAILED',
    ] as const;
    for (const status of others) {
      const server = serverFor(inStatus(status));
      await mount(server, SUPER);
      expect(entries(), status).toEqual({ execute: false, manual: false });
      expect(server.writes(), status).toEqual([]);
      cleanup();
    }
    const server = serverFor(inStatus('APPROVED'));
    await mount(server, SUPER);
    expect(entries(), 'APPROVED').toEqual({ execute: true, manual: true });
    assertNoOtherActions();
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08am-ENTRY#3] 已发出转账的 APPROVED 单不出入口：转账尝试为处理中、成功或结果未知时两个都不出；付款方侧失败退回（转账 fail、payer_side_after_transfer）时不出【执行打款】；没有转账尝试的同一张单（超管）两个都出',
  { timeout: 120_000 },
  async () => {
    for (const result of ['pending', 'success', 'unknown'] as const) {
      const server = serverFor(approved({ payout_attempts: [transfer(result)], execute_seq: 1 }));
      await mount(server, SUPER);
      expect(entries(), `transfer ${result}`).toEqual({ execute: false, manual: false });
      expect(server.writes()).toEqual([]);
      cleanup();
    }
    const payerSide: Withdrawal = approved({
      payout_attempts: [transfer('fail')],
      execute_seq: 1,
      hold_reason: 'payer_side_after_transfer',
      hold_at: '2026-11-17T10:00:10+08:00',
    });
    const back = serverFor(payerSide);
    await mount(back, SUPER);
    expect(entries().execute, 'transfer fail, returned by W9').toBe(false);
    expect(back.writes()).toEqual([]);
    cleanup();

    const server = serverFor(approved());
    await mount(server, SUPER);
    expect(entries(), 'no transfer attempt').toEqual({ execute: true, manual: true });
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08am-ENTRY#4] 微信零钱的 APPROVED 单（超管）：不出【手动成功】（W8 不对微信开放），【执行打款】照常可用；没有【撤销微信转账】',
  { timeout: 60_000 },
  async () => {
    const server = serverFor(approved({ payout_channel: 'wechat', payout_method: 'wechat' }));
    await mount(server, SUPER);
    expect(entries()).toEqual({ execute: true, manual: false });
    assertNoOtherActions();
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08am-ENTRY#5] 银行卡收款的 APPROVED 单（没有转账尝试；银行卡通道开通前只能手动成功）：超管与持 payout.manual_entry 都出可用的【手动成功】；录入三项、动态码后只发一次 POST /admin/v1/withdrawals/batch-manual-paid，items 与支付宝单同形 [{withdrawal_id, channel_order_id, paid_at, paid_fen: net_fen}]，显示「已录入」',
  { timeout: 180_000 },
  async () => {
    const cases: { label: string; who: PermissionSnapshot; want: ReturnType<typeof entries> }[] = [
      { label: 'payout.manual_entry', who: MANUAL_ENTRY, want: { execute: false, manual: true } },
      { label: 'super', who: SUPER, want: { execute: true, manual: true } },
    ];
    for (const { label, who, want } of cases) {
      const server = serverFor(
        approved({
          payout_channel: 'bank_card',
          payout_method: 'bank_card',
          payee: { ...PAYEE.approved },
        }),
      );
      server.once('POST', MANUAL, (request) => paidReply(server, request));
      await mount(server, who);
      expect(entries(), label).toEqual(want);
      assertNoOtherActions();
      expect(server.writes(), label).toEqual([]);

      const modal = await openManual(server);
      await fillEntry(modal);
      await submit(server, modal, NAME.manualSubmit);
      await verify();
      await waitFor(() => expect(manuals(server)).toHaveLength(1));
      await settled(server);
      assertManual(server, 0, MANUAL_BODY);
      await inDialog(TEXT.paid);
      expect(manuals(server), label).toHaveLength(1);
      expect(executes(server), label).toEqual([]);
      cleanup();
    }
  },
);
