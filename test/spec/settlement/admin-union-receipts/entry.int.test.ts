// B2-04zr entry rule tests, the effects (claude-independent, SPEC_REF 6f50a051): 08 BR-FUND-20 细则
// 「联盟回款凭证」 and contracts/openapi.yaml adminCreateUnionReceipt — one voucher
// RECEIPT:{platform}:{receipt_id}, debit the cash subject / credit UNION_RECEIVABLE:{platform} for the
// amount that actually arrived, never the receivable; voucher_kind UNION_RECEIPT, the placeholder
// ledger_type REBATE_CREDIT (specs/ledger-rules.md §7 第 3 条); the record method ADMIN_ENTRY, created_by
// the operator, voucher_id its voucher; the accounting day from the injected Clock, not receipt_date;
// not compared with the receivable, no difference opened, nothing in revenue or loss; audit
// union_receipt_create without personal data. Expected amounts are written by hand. Requests go
// through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  BANK_SWITCH,
  CREATE_ACTION,
  TODAY,
  audits,
  auditText,
  balanceOf,
  entryBody,
  everything,
  fixture,
  idOf,
  linesOf,
  nameOf,
  receiptKey,
  receiptLines,
  receiptOf,
  receiptRow,
  receiptVouchers,
  seedReceivable,
  setSwitch,
  subjectsWithEntries,
  suite,
  viewOf,
  voucherOf,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#2] BR-FUND-20 例：应收 1,200,000、回款 1,150,000 → 一张凭证 RECEIPT:taobao:{receipt_id}，借 CASH_ALIPAY 1,150,000 / 贷 UNION_RECEIVABLE:taobao 1,150,000（实际到账额，不是应收额）；应收余额剩 50,000，不开差错单，不记损益；voucher_kind UNION_RECEIPT、会计日取时钟不取 receipt_date；记录 method ADMIN_ENTRY、created_by 为操作人、voucher_id 指向凭证；应答即该记录', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const note = '10 月账单回款';
    const item = await receiptOf(await h.create(entryBody({ note })));
    const id = idOf(item);
    const key = receiptKey('taobao', id);

    const row = await receiptRow(f, id);
    expect(row).toMatchObject({
      app_id: f.appId,
      platform: 'taobao',
      day: '2026-10-20',
      amount_fen: 1_150_000n,
      method: 'ADMIN_ENTRY',
      cash_account: 'CASH_ALIPAY',
      note,
      created_by: h.operator.id,
      created_at: f.clock.now(),
      reversed_at: null,
      reversed_by: null,
      reversal_voucher_id: null,
    });
    expect(item).toEqual(viewOf(row, { createdBy: nameOf(h.operator) }));

    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key)).toEqual([key]);
    const voucher = await voucherOf(f, key);
    expect(row.voucher_id).toBe(voucher.id);
    expect(voucher).toMatchObject({
      voucher_kind: 'UNION_RECEIPT',
      order_key: null,
      beneficiary_user_id: null,
      role: null,
      day: TODAY,
    });
    expect(await linesOf(f, key)).toEqual(receiptLines('taobao', 'CASH_ALIPAY', 1_150_000n));

    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(50_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(1_150_000n);
    // 差额不进损益：只有这三个科目有分录，收入科目仍是入账时的金额。
    expect(await subjectsWithEntries(f)).toEqual([
      'CASH_ALIPAY',
      'COMMISSION_REVENUE',
      'UNION_RECEIVABLE:taobao',
    ]);
    expect(await balanceOf(f, 'COMMISSION_REVENUE')).toBe(-1_200_000n);
    const after = await everything(f);
    expect(after.diffs).toEqual(before.diffs);
    expect(after.diffs).toEqual([]);
    expect(after.holds).toEqual([]);
    expect(after.balances).toEqual(before.balances);
  });
});

it('[AC-B2-04zr#3] 银行卡通道开通时 cash_account=CASH_BANK：借 CASH_BANK / 贷 UNION_RECEIVABLE:{platform}，CASH_ALIPAY 不动；未带 note 的记录 note 为 null', async () => {
  const f = fixture(s);
  await setSwitch(f, BANK_SWITCH, true);
  await seedReceivable(f, 'jd', 800_000n);
  await withReceiptAdmin(f, async (h) => {
    const item = await receiptOf(
      await h.create(entryBody({ platform: 'jd', amount_fen: 300_000, cash_account: 'CASH_BANK' })),
    );
    const id = idOf(item);
    const row = await receiptRow(f, id);
    expect(row).toMatchObject({
      platform: 'jd',
      amount_fen: 300_000n,
      cash_account: 'CASH_BANK',
      note: null,
    });
    expect(item).toEqual(viewOf(row, { createdBy: nameOf(h.operator) }));
    const key = receiptKey('jd', id);
    expect(await linesOf(f, key)).toEqual(receiptLines('jd', 'CASH_BANK', 300_000n));
    expect(await balanceOf(f, 'CASH_BANK')).toBe(300_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:jd')).toBe(500_000n);
  });
});

it('[AC-B2-04zr#4] 不与应收比较：多收使应收变负也照常录入（应收 100,000、回款 300,000 → −200,000），应收为 0 的平台同样可录（→ −50,000）；都不开差错单、不记损益', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 100_000n);
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.create(entryBody({ amount_fen: 300_000 })));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(-200_000n);

    await receiptOf(await h.create(entryBody({ platform: 'pdd', amount_fen: 50_000 })));
    expect(await balanceOf(f, 'UNION_RECEIVABLE:pdd')).toBe(-50_000n);

    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(350_000n);
    expect(await balanceOf(f, 'COMMISSION_REVENUE')).toBe(-100_000n);
    expect((await everything(f)).diffs).toEqual([]);
  });
});

it('[AC-B2-04zr#5] 金额整数分精确：契约上限 9,007,199,254,740,991 分原样入记录与分录，应答同值', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const item = await receiptOf(await h.create(entryBody({ amount_fen: 9_007_199_254_740_991 })));
    expect(item['amount_fen']).toBe(9_007_199_254_740_991);
    const id = idOf(item);
    expect((await receiptRow(f, id)).amount_fen).toBe(9_007_199_254_740_991n);
    expect(await linesOf(f, receiptKey('taobao', id))).toEqual(
      receiptLines('taobao', 'CASH_ALIPAY', 9_007_199_254_740_991n),
    );
  });
});

it('[AC-B2-04zr#6] 审计 union_receipt_create 恰一条：操作人；含 receipt_id、platform、receipt_date、amount_fen、cash_account、voucher_id；不含备注与账号姓名等个人信息', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const note = '外部流水号 SYN-20261020';
    const who = await h.caller(['fund.cash_entry'], { displayName: '合成财务' });
    const id = idOf(await receiptOf(await h.create(entryBody({ note }), { caller: who })));
    const row = await receiptRow(f, id);

    const records = await audits(f, CREATE_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(who.id);
    const text = auditText(record);
    for (const piece of [id, 'taobao', '2026-10-20', 'CASH_ALIPAY', row.voucher_id]) {
      expect(text).toContain(piece);
    }
    expect(text).toMatch(/"amount_fen":"?1150000"?[,}]/);
    expect(text).not.toContain(note);
    expect(text).not.toContain('合成财务');
    expect(text).not.toContain(who.loginName);
  });
});
