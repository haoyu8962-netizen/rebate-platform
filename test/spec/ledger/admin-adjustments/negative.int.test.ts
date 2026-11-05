// B2-12c negative balance (claude-independent): BR-FUND-24 ⑤ (调减可使 available < 0，不写 frozen),
// BR-FUND-10, the contract example of adminCreateAdjustment (available 3000 → −7000), and the
// production ledger of the admin entry (D10-587): the decrease that crosses below zero publishes
// account.went_negative, the increase that brings available back to ≥ 0 runs payout's recovery hook
// (the NEGATIVE_BALANCE block of the member's withdrawal is lifted in the same transaction).
// The seeds' own ledger has no bus and no hook (kit.ts), so every event here is the entry's.
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  DAY,
  audits,
  balanceOf,
  expectAdjusted,
  expectMentions,
  fixture,
  member,
  moneyOf,
  newForm,
  seedReconDiff,
  seedWithdrawal,
  shift,
  suite,
  wentNegative,
  withAdjustAdmin,
  withdrawalNow,
} from './kit.ts';

const s = suite();

it('[AC-B2-12c#6] 契约示例：available 3000 以 PAYOUT_RECOVERY 调减 10000（支付宝提现单 + 差错单）→ 应答前后 3000 / −7000，借 USER_BALANCE.available 10000 / 贷 CASH_ALIPAY 10000，negative_since 记为当天，event_log 恰好一条 account.went_negative，审计 adjustment_create 含单号、会员、方向、金额、原因码与前后 available', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 3000n });
    const withdrawalId = await seedWithdrawal(f, userId, { channel: 'alipay' });
    const diff = await seedReconDiff(f, {
      source: 'R2',
      type: 'channel_mismatch',
      ref_type: 'withdrawal',
      ref_id: withdrawalId,
    });
    const refs = [
      { ref_type: 'withdrawal', ref_id: withdrawalId },
      { ref_type: 'recon_diff', ref_id: diff.id },
    ] as const;
    const sent = await h.create(
      newForm({
        userId,
        direction: 'decrease',
        amount: 10_000n,
        reason: 'PAYOUT_RECOVERY',
        refs,
        note: '迟到成功重复出款，追回',
      }),
    );
    const done = await expectAdjusted(f, sent, {
      caller: h.maker,
      userId,
      direction: 'decrease',
      amount: 10_000n,
      reason: 'PAYOUT_RECOVERY',
      contra: 'CASH_ALIPAY',
      refs,
      note: '迟到成功重复出款，追回',
      before: { available: 3000n, frozen: 0n },
    });
    expect(done.after).toBe(-7000n);
    expect(await balanceOf(f, userId)).toMatchObject({
      available_fen: -7000n,
      frozen_fen: 0n,
      negative_since: DAY,
    });
    const events = await wentNegative(f, userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { data: { user_id: userId } } });
    const recorded = await audits(f, CREATE_ACTION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.admin_id).toBe(h.maker.id);
    expectMentions(recorded[0]!, {
      ids: [done.row.adjust_id, userId],
      values: ['decrease', '10000', 'PAYOUT_RECOVERY', '3000', '-7000'],
    });
  });
});

it('[AC-B2-12c#7] 生产路径带回正钩子：available −500、有一张 NEGATIVE_BALANCE 拦截的已批提现单时，调增 500 使余额正好回到 0 → 同一笔解除拦截（blocked_reason 清空、updated_at 取时钟、row_version + 1、状态不变），不发 account.went_negative', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 100n });
    const blocked = await seedWithdrawal(f, userId, {
      status: 'APPROVED',
      amount: 100n,
      blocked: true,
    });
    await shift(f, userId, -500n);
    expect(await moneyOf(f, userId)).toEqual({ available: -500n, frozen: 100n });
    const before = await withdrawalNow(f, blocked);
    const diff = await seedReconDiff(f);
    const refs = [{ ref_type: 'recon_diff', ref_id: diff.id }] as const;

    const sent = await h.create(
      newForm({
        userId,
        direction: 'increase',
        amount: 500n,
        reason: 'RECON_FIX',
        refs,
        note: '少记的结算补回',
        contra: 'COMMISSION_REVENUE',
      }),
    );
    await expectAdjusted(f, sent, {
      caller: h.maker,
      userId,
      direction: 'increase',
      amount: 500n,
      reason: 'RECON_FIX',
      contra: 'COMMISSION_REVENUE',
      refs,
      note: '少记的结算补回',
      before: { available: -500n, frozen: 100n },
    });
    expect(await withdrawalNow(f, blocked)).toEqual({
      ...before,
      blocked_reason: null,
      updated_at: f.clock.now(),
      row_version: before.row_version + 1,
    });
    expect(await wentNegative(f, userId)).toEqual([]);
  });
});

it('[AC-B2-12c#8] 只在跨过 0 时发 account.went_negative：调减到正好 0 不发；再调减 1 到 −1 发一条；已为负再调减不再发', async () => {
  const f = fixture(s);
  await withAdjustAdmin(f, async (h) => {
    const userId = await member(f, { available: 500n });
    const diff = await seedReconDiff(f);
    const refs = [{ ref_type: 'recon_diff', ref_id: diff.id }] as const;
    const decrease = (amount: bigint) =>
      h.create(
        newForm({
          userId,
          direction: 'decrease',
          amount,
          reason: 'RECON_FIX',
          refs,
          note: '多记的结算冲减',
          contra: 'MKT_EXPENSE',
        }),
      );
    const expectation = (amount: bigint, available: bigint) => ({
      caller: h.maker,
      userId,
      direction: 'decrease' as const,
      amount,
      reason: 'RECON_FIX',
      contra: 'MKT_EXPENSE',
      refs,
      note: '多记的结算冲减',
      before: { available, frozen: 0n },
    });

    await expectAdjusted(f, await decrease(500n), expectation(500n, 500n));
    expect(await moneyOf(f, userId)).toEqual({ available: 0n, frozen: 0n });
    expect(await wentNegative(f, userId)).toEqual([]);

    await expectAdjusted(f, await decrease(1n), expectation(1n, 0n));
    expect(await wentNegative(f, userId)).toHaveLength(1);

    await expectAdjusted(f, await decrease(300n), expectation(300n, -1n));
    expect(await moneyOf(f, userId)).toEqual({ available: -301n, frozen: 0n });
    expect(await wentNegative(f, userId)).toHaveLength(1);
  });
});
