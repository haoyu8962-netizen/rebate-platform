// B2-04zr reversal rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminReverseUnionReceipt and 08 BR-FUND-16, BR-FUND-20 细则 — the whole record, once: every line of
// the original voucher negated under RECEIPT:{platform}:{receipt_id}:REVERSE; reversed_at, reversed_by
// and reversal_voucher_id set together, the amount and the original voucher untouched; a record of
// either method; not compared with the balance of the cash subject or of the receivable; order of
// the remaining checks body → receipt_id (unknown, another app, not a uuid: 20001) → already reversed
// (20902 resource=union_receipt, under a race too: ledger.reverse answers a replay without an error,
// so a race is pinned on the outcome, not on the absence of a throw). Expected amounts are written by
// hand. Requests go through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CASH_ENTRY,
  REASON,
  REVERSE_ACTION,
  audits,
  auditText,
  balanceOf,
  chars,
  conflict,
  entryBody,
  everything,
  fieldsError,
  fixture,
  holdReceipt,
  idOf,
  idsOf,
  linesOf,
  nameOf,
  receiptKey,
  receiptLines,
  receiptOf,
  receiptRow,
  receiptVouchers,
  reversalKey,
  reversalLines,
  seedReceipt,
  seedReceivable,
  suite,
  track,
  transfer,
  viewOf,
  voucherOf,
  waiting,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#24] 红冲：分录逐行取反，键 RECEIPT:{platform}:{receipt_id}:REVERSE；应收、现金科目回到录入前；红冲三列都写上（时刻取时钟、操作人是红冲者、凭证号指向红冲凭证）；原记录金额、原凭证与原分录不变；记录仍在列表里；应答即红冲后的记录', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withReceiptAdmin(f, async (h) => {
    const id = idOf(await receiptOf(await h.create(entryBody())));
    const row = await receiptRow(f, id);
    const key = receiptKey('taobao', id);
    const originalVoucher = await voucherOf(f, key);
    const originalLines = await linesOf(f, key);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(50_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(1_150_000n);

    f.clock.advanceMs(60_000);
    const reverser = await h.caller([CASH_ENTRY], { displayName: '合成复核' });
    const item = await receiptOf(await h.reverse(id, { reason: REASON }, { caller: reverser }));

    const now = await receiptRow(f, id);
    const reversal = await voucherOf(f, reversalKey('taobao', id));
    expect(now).toEqual({
      ...row,
      reversed_at: f.clock.now(),
      reversed_by: reverser.id,
      reversal_voucher_id: reversal.id,
    });
    expect(now.amount_fen).toBe(1_150_000n);
    expect(item).toEqual(
      viewOf(now, { createdBy: nameOf(h.operator), reversedBy: nameOf(reverser) }),
    );

    expect(reversal).toMatchObject({
      voucher_kind: 'UNION_RECEIPT',
      order_key: null,
      beneficiary_user_id: null,
      role: null,
    });
    expect(await linesOf(f, reversalKey('taobao', id))).toEqual(
      reversalLines('taobao', 'CASH_ALIPAY', 1_150_000n),
    );
    expect(await voucherOf(f, key)).toEqual(originalVoucher);
    expect(await linesOf(f, key)).toEqual(originalLines);

    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(1_200_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
    expect(await idsOf(await h.list())).toEqual([id]);
    expect((await everything(f)).diffs).toEqual([]);
  });
});

it('[AC-B2-04zr#25] 审计 union_receipt_reverse 恰一条：操作人；含 receipt_id、platform、amount_fen、voucher_id、reversal_voucher_id 与 reason（原因只在审计里，记录没有这一列）；不含备注与账号姓名等个人信息', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const note = '外部流水号 SYN-20261020';
    const who = await h.caller([CASH_ENTRY], { displayName: '合成财务' });
    const row = await seedReceipt(f, {
      amountFen: 1_150_000n,
      createdBy: who.id,
      note,
    });
    await receiptOf(await h.reverse(row.receipt_id, { reason: REASON }, { caller: who }));
    const now = await receiptRow(f, row.receipt_id);

    const records = await audits(f, REVERSE_ACTION);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.admin_id).toBe(who.id);
    const text = auditText(record);
    for (const piece of [
      row.receipt_id,
      'taobao',
      row.voucher_id,
      now.reversal_voucher_id!,
      REASON,
    ]) {
      expect(text).toContain(piece);
    }
    expect(text).toMatch(/"amount_fen":"?1150000"?[,}]/);
    expect(text).not.toContain(note);
    expect(text).not.toContain('合成财务');
    expect(text).not.toContain(who.loginName);
    expect(Object.keys(now)).not.toContain('reason');
  });
});

it('[AC-B2-04zr#26] 已红冲的记录用新键再冲 → 20902 data.resource=union_receipt：不新增凭证、不写审计，红冲三列都保持首次的值（换人、换时刻、换原因也一样）', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f, { amountFen: 500_000n });
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.reverse(row.receipt_id, { reason: REASON }));
    const first = await receiptRow(f, row.receipt_id);
    expect(first.reversed_by).toBe(h.operator.id);
    const after = await everything(f);

    f.clock.advanceMs(60_000);
    const colleague = await h.caller([CASH_ENTRY]);
    await conflict(await h.reverse(row.receipt_id, { reason: REASON }));
    await conflict(await h.reverse(row.receipt_id, { reason: '再冲一次' }, { caller: colleague }));

    expect(await receiptRow(f, row.receipt_id)).toEqual(first);
    expect(await everything(f)).toEqual(after);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
  });
});

it('[AC-B2-04zr#27] 并发：同一记录两个不同键的红冲（都在记录行锁上等待后放行，以及直接同时到）→ 恰一个成功、一个 20902 union_receipt；只有一张红冲凭证、一条审计，现金只回冲一次；红冲三列与审计原因都是成功者的', async () => {
  const f = fixture(s);
  const held = await seedReceipt(f, { amountFen: 400_000n });
  const raced = await seedReceipt(f, { amountFen: 30_000n });
  await withReceiptAdmin(f, async (h) => {
    const first = await h.caller([CASH_ENTRY]);
    const second = await h.caller([CASH_ENTRY]);
    const contenders = [
      { caller: first, reason: '第一位的原因' },
      { caller: second, reason: '第二位的原因' },
    ];
    const reverseBoth = (receiptId: string) =>
      contenders.map(({ caller, reason }) => track(h.reverse(receiptId, { reason }, { caller })));

    const lock = await holdReceipt(f, held.receipt_id);
    const pending = reverseBoth(held.receipt_id);
    try {
      expect(await waiting(f, 2, pending), '两个红冲都应在记录行锁上等待').toBe(true);
      expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key).sort()).toEqual(
        [receiptKey('taobao', held.receipt_id), receiptKey('taobao', raced.receipt_id)].sort(),
      );
    } finally {
      await lock.release();
    }
    const lockedResults = await Promise.all(pending.map((request) => request.promise));
    const racedResults = await Promise.all(
      reverseBoth(raced.receipt_id).map((request) => request.promise),
    );

    for (const [row, results] of [
      [held, lockedResults],
      [raced, racedResults],
    ] as const) {
      expect(results.map((sent) => sent.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
      const winner = results.findIndex((sent) => sent.statusCode === 200);
      const loser = winner === 0 ? 1 : 0;
      const item = await receiptOf(results[winner]!);
      await conflict(results[loser]!);

      const now = await receiptRow(f, row.receipt_id);
      const reversal = await voucherOf(f, reversalKey('taobao', row.receipt_id));
      expect(now.reversed_by).toBe(contenders[winner]!.caller.id);
      expect(now.reversal_voucher_id).toBe(reversal.id);
      expect(item['reversal_voucher_id']).toBe(reversal.id);

      const records = (await audits(f, REVERSE_ACTION)).filter((record) =>
        auditText(record).includes(row.receipt_id),
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.admin_id).toBe(contenders[winner]!.caller.id);
      expect(auditText(records[0]!)).toContain(contenders[winner]!.reason);
      expect(auditText(records[0]!)).not.toContain(contenders[loser]!.reason);
    }
    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key).sort()).toEqual(
      [
        receiptKey('taobao', held.receipt_id),
        receiptKey('taobao', raced.receipt_id),
        reversalKey('taobao', held.receipt_id),
        reversalKey('taobao', raced.receipt_id),
      ].sort(),
    );
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(0n);
  });
});

it('[AC-B2-04zr#28] 未知 receipt_id、别的 app 的记录、不是 UUID 的 id → 20001 data.fields=[receipt_id]（不回 404）；两个 app 都什么都不变', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const foreign = await seedReceipt(other);
  await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    const foreignBefore = await everything(other);
    await fieldsError(await h.reverse(randomUUID()), ['receipt_id']);
    await fieldsError(await h.reverse(foreign.receipt_id), ['receipt_id']);
    await fieldsError(await h.reverse('not-a-uuid'), ['receipt_id']);
    expect(await everything(f)).toEqual(before);
    expect(await everything(other)).toEqual(foreignBefore);
  });
});

it('[AC-B2-04zr#29] reason 必填，去空白后 1–200 字：缺失、空串、全空白、超过 200 字 → 20001 data.fields=[reason]，先于 receipt_id 与是否已红冲的判断；请求不带金额，多带的键被拒；恰好 200 字可以且记入审计', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  const done = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.reverse(done.receipt_id));
    const before = await everything(f);
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: chars(201) }]) {
      await fieldsError(await h.reverse(row.receipt_id, body), ['reason']);
    }
    await fieldsError(await h.reverse(randomUUID(), { reason: '   ' }), ['reason']);
    await fieldsError(await h.reverse(done.receipt_id, { reason: '   ' }), ['reason']);
    await fieldsError(await h.reverse(row.receipt_id, { reason: REASON, amount_fen: 1 }), [
      'amount_fen',
    ]);
    expect(await everything(f)).toEqual(before);

    await receiptOf(await h.reverse(row.receipt_id, { reason: chars(200) }));
    const records = (await audits(f, REVERSE_ACTION)).filter((record) =>
      auditText(record).includes(row.receipt_id),
    );
    expect(records).toHaveLength(1);
    expect(auditText(records[0]!)).toContain(chars(200));
  });
});

it('[AC-B2-04zr#30] method=R1_RECON、created_by 为空的记录也能红冲：method 与 created_by 不变，created_by_name 为空，reversed_by 是操作人', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f, { platform: 'jd', amountFen: 151_000n });
  expect(row).toMatchObject({ method: 'R1_RECON', created_by: null });
  await withReceiptAdmin(f, async (h) => {
    const item = await receiptOf(await h.reverse(row.receipt_id));
    const now = await receiptRow(f, row.receipt_id);
    expect(now).toMatchObject({
      method: 'R1_RECON',
      created_by: null,
      reversed_by: h.operator.id,
    });
    expect(item).toEqual(viewOf(now, { reversedBy: nameOf(h.operator) }));
    expect(item['created_by_name']).toBeNull();
    expect(await linesOf(f, reversalKey('jd', row.receipt_id))).toEqual(
      reversalLines('jd', 'CASH_ALIPAY', 151_000n),
    );
    expect(await balanceOf(f, 'UNION_RECEIVABLE:jd')).toBe(0n);
  });
});

it('[AC-B2-04zr#31] 改金额：录错 1,000,000 → 红冲 → 重录 1,150,000：重录是新记录、新凭证（不是 REVERSE 键），应收 50,000、现金 1,150,000；两条记录都在列表里，原记录仍是已红冲', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withReceiptAdmin(f, async (h) => {
    const wrong = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 1_000_000 }))));
    await receiptOf(await h.reverse(wrong));
    const right = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 1_150_000 }))));
    expect(right).not.toBe(wrong);

    const keys = [
      receiptKey('taobao', wrong),
      reversalKey('taobao', wrong),
      receiptKey('taobao', right),
    ];
    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key).sort()).toEqual(
      keys.sort(),
    );
    expect(await linesOf(f, receiptKey('taobao', right))).toEqual(
      receiptLines('taobao', 'CASH_ALIPAY', 1_150_000n),
    );
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(50_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(1_150_000n);

    const again = await receiptRow(f, right);
    expect(again).toMatchObject({ reversed_at: null, reversal_voucher_id: null });
    const old = await receiptRow(f, wrong);
    expect(old.amount_fen).toBe(1_000_000n);
    expect(old.reversal_voucher_id).not.toBeNull();
    expect(((await idsOf(await h.list())) as string[]).sort()).toEqual([wrong, right].sort());
  });
});

it('[AC-B2-04zr#32] 红冲不与余额比较：现金已支出到 0（红冲后 −100,000）照冲；多收使应收为负的记录红冲后回到 0；都不开差错单', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f, { amountFen: 100_000n });
  expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(-100_000n);
  await transfer(f, 'COMMISSION_REVENUE', 'CASH_ALIPAY', 100_000n);
  expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.reverse(row.receipt_id));
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(-100_000n);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(0n);
    expect((await everything(f)).diffs).toEqual([]);
  });
});

it('[AC-B2-04zr#33] 开关只管录入：payout.channel_enabled.bank_card 关着时，已有的 CASH_BANK 记录照样能红冲，CASH_BANK 回冲', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f, { cash: 'CASH_BANK', amountFen: 90_000n });
  await withReceiptAdmin(f, async (h) => {
    await receiptOf(await h.reverse(row.receipt_id));
    expect(await linesOf(f, reversalKey('taobao', row.receipt_id))).toEqual(
      reversalLines('taobao', 'CASH_BANK', 90_000n),
    );
    expect(await balanceOf(f, 'CASH_BANK')).toBe(0n);
  });
});
