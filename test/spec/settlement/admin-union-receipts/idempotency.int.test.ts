// B2-04zr idempotency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreateUnionReceipt, adminReverseUnionReceipt — `Idempotency-Key` required: same key and body →
// the first result, whatever X-Step-Up-Token carries; same key with another body → 20901; same key
// while still running → 40901; there is no business key, so two keys with the same body are two
// collections; a new key for a record already reversed is 20902. A running entry is kept running on
// the foreign key of created_by, a running reversal on the record's row lock (kit.ts). Requests go
// through the real admin entry (kit.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  REASON,
  REVERSE_ACTION,
  answer,
  audits,
  balanceOf,
  conflict,
  entryBody,
  everything,
  fixture,
  holdAdmin,
  holdReceipt,
  idOf,
  idempotencyRows,
  newKey,
  receiptKey,
  receiptOf,
  receiptRows,
  receiptVouchers,
  reversalKey,
  seedReceipt,
  seedReceivable,
  suite,
  track,
  waiting,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#15] 录入：同键同体重放原样返回第一次的应答（每次的 step-up 令牌不同也一样），只有一张凭证、一行记录、一条审计，金额只记一次', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withReceiptAdmin(f, async (h) => {
    const key = newKey();
    const body = entryBody({ note: '10 月账单回款' });
    const sent = await h.create(body, { key });
    const id = idOf(await receiptOf(sent));
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.create(body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await everything(f)).toEqual(after);
    expect((await receiptRows(f)).map((row) => row.receipt_id)).toEqual([id]);
    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key)).toEqual([
      receiptKey('taobao', id),
    ]);
    expect(await audits(f, CREATE_ACTION)).toHaveLength(1);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(50_000n);
  });
});

it('[AC-B2-04zr#16] 录入：同键异体（金额、日期、平台、科目、备注任一不同）→ 20901，不新增任何东西', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const key = newKey();
    await receiptOf(await h.create(entryBody(), { key }));
    const after = await everything(f);
    for (const patch of [
      { amount_fen: 1_150_001 },
      { receipt_date: '2026-10-21' },
      { platform: 'jd' },
      { cash_account: 'CASH_BANK' },
      { note: '换一个备注' },
    ]) {
      await answer(await h.create(entryBody(patch), { key }), 20901);
    }
    expect(await everything(f)).toEqual(after);
  });
});

it('[AC-B2-04zr#17] 录入：同一 key 的第一次还在执行时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答，审计一条', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    const key = newKey();
    const lock = await holdAdmin(f, h.operator.id);
    const first = track(h.create(entryBody(), { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次录入应在 created_by 外键上等待').toBe(true);
      await answer(await h.create(entryBody(), { key }), 40901);
      await answer(await h.create(entryBody({ amount_fen: 1 }), { key }), 40901);
      expect(await receiptRows(f)).toEqual([]);
      expect(await receiptVouchers(f)).toEqual([]);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await receiptOf(sent);
    const replay = await h.create(entryBody(), { key });
    expect(replay.body).toBe(sent.body);
    expect(await receiptRows(f)).toHaveLength(1);
    expect(await audits(f, CREATE_ACTION)).toHaveLength(1);
    const rows = (await idempotencyRows(f)).filter((row) => row.key === key);
    expect(rows.map((row) => ({ path: row.path, status: row.status }))).toEqual([
      { path: '/admin/v1/union-receipts', status: 'completed' },
    ]);
  });
});

it('[AC-B2-04zr#18] 没有业务键：异键同体是两笔真实回款——两行、两张凭证、两条审计、不同 receipt_id，应收减两次', async () => {
  const f = fixture(s);
  await seedReceivable(f, 'taobao', 1_200_000n);
  await withReceiptAdmin(f, async (h) => {
    const body = entryBody({ amount_fen: 400_000 });
    const first = idOf(await receiptOf(await h.create(body)));
    const second = idOf(await receiptOf(await h.create(body)));
    expect(second).not.toBe(first);

    expect((await receiptRows(f)).map((row) => row.receipt_id).sort()).toEqual(
      [first, second].sort(),
    );
    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key).sort()).toEqual(
      [receiptKey('taobao', first), receiptKey('taobao', second)].sort(),
    );
    expect(await audits(f, CREATE_ACTION)).toHaveLength(2);
    expect(await balanceOf(f, 'UNION_RECEIVABLE:taobao')).toBe(400_000n);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(800_000n);
  });
});

it('[AC-B2-04zr#19] Idempotency-Key 必填：录入与红冲不带或格式不对 → 20001，什么都不变、不留幂等记录', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const before = await everything(f);
    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.create(entryBody(), { key }), 20001);
      await answer(await h.reverse(row.receipt_id, { reason: REASON }, { key }), 20001);
    }
    expect(await everything(f)).toEqual(before);
    expect(await idempotencyRows(f)).toEqual([]);
  });
});

it('[AC-B2-04zr#20] 红冲：同键同体重放原样返回第一次的应答，只有一张红冲凭证、一条审计；同键异体 → 20901；新键 → 20902 union_receipt；都不新增东西', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f, { amountFen: 300_000n });
  await withReceiptAdmin(f, async (h) => {
    const key = newKey();
    const body = { reason: REASON };
    const sent = await h.reverse(row.receipt_id, body, { key });
    await receiptOf(sent);
    const after = await everything(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.reverse(row.receipt_id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.reverse(row.receipt_id, { reason: '换一个原因' }, { key }), 20901);
    await conflict(await h.reverse(row.receipt_id, body));

    expect(await everything(f)).toEqual(after);
    expect((await receiptVouchers(f)).map((voucher) => voucher.uniq_key).sort()).toEqual(
      [receiptKey('taobao', row.receipt_id), reversalKey('taobao', row.receipt_id)].sort(),
    );
    expect(await audits(f, REVERSE_ACTION)).toHaveLength(1);
    expect(await balanceOf(f, 'CASH_ALIPAY')).toBe(0n);
  });
});

it('[AC-B2-04zr#21] 红冲：同一 key 的第一次在记录行锁上等待时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答', async () => {
  const f = fixture(s);
  const row = await seedReceipt(f);
  await withReceiptAdmin(f, async (h) => {
    const key = newKey();
    const lock = await holdReceipt(f, row.receipt_id);
    const first = track(h.reverse(row.receipt_id, { reason: REASON }, { key }));
    try {
      expect(await waiting(f, 1, [first]), '红冲应在记录行锁上等待').toBe(true);
      await answer(await h.reverse(row.receipt_id, { reason: REASON }, { key }), 40901);
      await answer(await h.reverse(row.receipt_id, { reason: '另一个原因' }, { key }), 40901);
      expect((await receiptRows(f))[0]?.reversed_at).toBeNull();
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await receiptOf(sent);
    const replay = await h.reverse(row.receipt_id, { reason: REASON }, { key });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, REVERSE_ACTION)).toHaveLength(1);
  });
});
