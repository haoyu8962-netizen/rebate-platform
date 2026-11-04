// B2-09m through and money rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid, 08 BR-WDR-16, BR-WDR-09, D10-595. A withdrawal approved through the review route
// is recorded paid: W8 with paid_at as given, channel_order_id, manual_entry_by and manual_confirm_by the
// caller (who may be the reviewer); one voucher `wd:{id}:PAID`, the same entries as a success through
// the channel, frozen −amount, available unchanged, operator admin:<id>; a bank_card withdrawal credits
// CASH_BANK with its channel off. Requests go through the real admin entry (manual-paid-harness.ts). W5
// is the real landing. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AFTER_FREEZE,
  AMOUNT,
  ENTRY,
  REVIEW,
  RICH,
  answer,
  ago,
  approved,
  approvedItem,
  asPaidManual,
  balanceOf,
  entries,
  entryOf,
  expectItems,
  fixture,
  frozenMismatches,
  landThroughChannel,
  paid,
  payee,
  platformLine,
  reviewing,
  rowOf,
  setSwitch,
  skipped,
  suite,
  userLine,
  voucherOf,
  withManualAdmin,
  withdrawalVouchers,
} from './manual-paid-harness.ts';

const s = suite();

it('[AC-B2-09m#2] 贯通：经审核接口通过的支付宝单补录成功：result=paid，PAID_MANUAL，paid_at 是请求给的时间（不是时钟），channel_order_id、manual_entry_by、manual_confirm_by 都对，审核人和录入人是同一人；row_version + 1，其余列不变', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const both = await h.caller([REVIEW, ENTRY]);
    const who = await payee(f, h);
    const w = await reviewing(f, h, who);
    await answer(await h.approve([w.id], { caller: both }), 0, { items: [approvedItem(w.id)] });
    const reviewed = await rowOf(f, w);
    expect(reviewed).toMatchObject({ status: 'APPROVED', reviewer_id: both.id });
    const entry = entryOf(f, reviewed);

    await expectItems(await h.manualPaid([entry], { caller: both }), [paid(w.id)]);

    const now = await rowOf(f, w);
    expect(now).toEqual(asPaidManual(f, reviewed, entry, both.id));
    expect(now.paid_at).toEqual(ago(f, 5));
    expect(now.paid_at).not.toEqual(f.clock.now());
    expect(now.reviewer_id).toBe(both.id);
    expect(now.manual_entry_by).toBe(both.id);
    expect(now.manual_confirm_by).toBe(both.id);
  });
});

it('[AC-B2-09m#3] 钱（BR-WDR-09）：恰一张凭证 wd:{id}:PAID，WITHDRAW:SUCCESS:CASH_ALIPAY 的六条分录逐条对（net 12,347、fee 125、tax 88），operator admin:<调用者>；frozen 减 12,560，available 不变；另一张未结单的冻结不动，不变量 frozen = Σ 非终态单成立', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const staying = await reviewing(f, h, who);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 8_974_881n,
      frozen_fen: 25_120n,
    });

    await expectItems(await h.manualPaid([entryOf(f, w)]), [paid(w.id)]);

    const key = `wd:${w.id}:PAID`;
    expect(await voucherOf(f.db, f.appId, key)).toEqual([
      { uniq_key: key, biz_type: 'withdrawal', biz_id: w.id, operator: `admin:${h.entry.id}` },
    ]);
    expect(await entries(f.db, f.appId, key)).toEqual([
      userLine(88n, 'TAX_WITHHOLD'),
      platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
      userLine(125n, 'WITHDRAW_FEE'),
      platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
      userLine(12_347n, 'WITHDRAW_PAID'),
      platformLine('CASH_ALIPAY', -12_347n, 'WITHDRAW_PAID'),
    ]);
    expect((await withdrawalVouchers(f.db, f.appId)).filter((uniq) => uniq.includes(w.id))).toEqual(
      [`wd:${w.id}:FREEZE`, key],
    );
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 8_974_881n,
      frozen_fen: 12_560n,
    });
    expect(await rowOf(f, staying)).toEqual(staying);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09m#4] 和同样金额走 W5 的分录完全相同：同金额两张单，一张补录、一张真实 W5 落账，分录逐条相等，只有 operator 不同；两边 frozen 都归零', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const manualMember = await payee(f, h);
    const channelMember = await payee(f, h);
    const manual = await approved(f, h, manualMember);
    const through = await reviewing(f, h, channelMember, { status: 'PAYING', execute_seq: 1 });

    await expectItems(await h.manualPaid([entryOf(f, manual)]), [paid(manual.id)]);
    await landThroughChannel(f, through);

    const manualLines = await entries(f.db, f.appId, `wd:${manual.id}:PAID`);
    expect(manualLines).toHaveLength(6);
    expect(manualLines).toEqual(await entries(f.db, f.appId, `wd:${through.id}:PAID`));
    expect(await voucherOf(f.db, f.appId, `wd:${through.id}:PAID`)).toEqual([
      {
        uniq_key: `wd:${through.id}:PAID`,
        biz_type: 'withdrawal',
        biz_id: through.id,
        operator: 'system:payout',
      },
    ]);
    for (const member of [manualMember, channelMember]) {
      expect(await balanceOf(f.db, f.ledger, f.appId, member.userId)).toEqual({
        available_fen: AFTER_FREEZE,
        frozen_fen: 0n,
      });
    }
  });
});

it('[AC-B2-09m#5] 银行卡单用 CASH_BANK，payout.channel_enabled.bank_card 显式关着也能补录（BR-WDR-32 ①）', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    await setSwitch(f, 'payout.channel_enabled.bank_card', false);
    const who = await payee(f, h);
    const w = await approved(f, h, who, { method: 'bank_card' });
    const entry = entryOf(f, w);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await entries(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([
      userLine(88n, 'TAX_WITHHOLD'),
      platformLine('TAX_PAYABLE', -88n, 'TAX_WITHHOLD'),
      userLine(125n, 'WITHDRAW_FEE'),
      platformLine('FEE_INCOME', -125n, 'WITHDRAW_FEE'),
      userLine(12_347n, 'WITHDRAW_PAID'),
      platformLine('CASH_BANK', -12_347n, 'WITHDRAW_PAID'),
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: RICH - AMOUNT,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09m#6] 金额为 0 的分录不写（BR-WDR-09）：fee、tax 都是 0 的 5,003 只有 WITHDRAW_PAID 两条，frozen 减 5,003', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who, { amount_fen: 5_003n, fee_fen: 0n, tax_fen: 0n });

    await expectItems(await h.manualPaid([entryOf(f, w)]), [paid(w.id)]);

    expect(await entries(f.db, f.appId, `wd:${w.id}:PAID`)).toEqual([
      userLine(5_003n, 'WITHDRAW_PAID'),
      platformLine('CASH_ALIPAY', -5_003n, 'WITHDRAW_PAID'),
    ]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: 8_994_998n,
      frozen_fen: 0n,
    });
  });
});

it('[AC-B2-09m#7] 结果一项对一项、按请求顺序；流水号恰好 64 字符和 1 字符都可以；paid_at 带 Z 也按同一瞬间存', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const third = await approved(f, h, who);
    const notYet = await reviewing(f, h, who);
    const long = entryOf(f, first, { channel_order_id: 'x'.repeat(64) });
    const short = entryOf(f, second, { channel_order_id: '7' });
    const utc = entryOf(f, third, { paid_at: ago(f, 7).toISOString() });

    await expectItems(await h.manualPaid([long, entryOf(f, notYet), short, utc]), [
      paid(first.id),
      skipped(notYet.id, 'not_approved'),
      paid(second.id),
      paid(third.id),
    ]);

    expect(await rowOf(f, first)).toEqual(asPaidManual(f, first, long, h.entry.id));
    expect(await rowOf(f, second)).toEqual(asPaidManual(f, second, short, h.entry.id));
    expect(await rowOf(f, third)).toEqual(asPaidManual(f, third, utc, h.entry.id));
    expect((await rowOf(f, third)).paid_at).toEqual(ago(f, 7));
    expect(await rowOf(f, notYet)).toEqual(notYet);
  });
});
