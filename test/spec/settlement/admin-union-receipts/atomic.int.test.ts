// B2-04zr atomicity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreateUnionReceipt and adminReverseUnionReceipt, 「Effects, in one transaction」 — a failure of
// the voucher, its entries, the record or the audit record ends as 50001 and leaves no record, no
// voucher, no entry, no account, no audit and no idempotency record; the same key then succeeds and
// books once. The failure is a one-shot fault in the entry's database handle (kit.ts). Top-level
// it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CREATE_ACTION,
  CREATE_FAULTS,
  REASON,
  REVERSE_ACTION,
  REVERSE_FAULTS,
  answer,
  audits,
  balanceOf,
  entryBody,
  everything,
  fixture,
  idOf,
  idempotencyRows,
  linesOf,
  newKey,
  receiptKey,
  receiptLines,
  receiptOf,
  receiptRow,
  reversalKey,
  reversalLines,
  seedReceipt,
  suite,
  withReceiptAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-04zr#22] 录入一个事务：写凭证、写分录、写记录、写审计任一步失败 → 50001，记录、凭证、分录、科目账户、审计都不留，也不留幂等记录；同一 key 重发即成功且只记一次', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    let booked = 0n;
    for (const point of CREATE_FAULTS) {
      const before = await everything(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.create(entryBody({ amount_fen: 250_000 }), { key });
      expect(h.fault.tripped, `${point} 必须在录入事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await everything(f), point).toEqual(before);
      expect(
        (await idempotencyRows(f)).filter((row) => row.key === key),
        point,
      ).toEqual([]);

      const id = idOf(await receiptOf(await h.create(entryBody({ amount_fen: 250_000 }), { key })));
      booked += 250_000n;
      expect(await linesOf(f, receiptKey('taobao', id)), point).toEqual(
        receiptLines('taobao', 'CASH_ALIPAY', 250_000n),
      );
      expect(await balanceOf(f, 'CASH_ALIPAY'), point).toBe(booked);
    }
    expect(await audits(f, CREATE_ACTION)).toHaveLength(CREATE_FAULTS.length);
  });
});

it('[AC-B2-04zr#23] 红冲一个事务：写红冲凭证、写分录、改记录、写审计任一步失败 → 50001，红冲三列仍为空，没有红冲凭证与审计，也不留幂等记录；同一 key 重发即成功且只冲一次', async () => {
  const f = fixture(s);
  await withReceiptAdmin(f, async (h) => {
    for (const point of REVERSE_FAULTS) {
      const row = await seedReceipt(f, { amountFen: 70_000n });
      const before = await everything(f);
      const key = newKey();
      const tripped = h.fault.tripped;
      h.fault.point = point;
      const sent = await h.reverse(row.receipt_id, { reason: REASON }, { key });
      expect(h.fault.tripped, `${point} 必须在红冲事务里执行`).toBe(tripped + 1);
      await answer(sent, 50001);
      expect(await everything(f), point).toEqual(before);
      expect(await receiptRow(f, row.receipt_id), point).toEqual(row);
      expect(
        (await idempotencyRows(f)).filter((item) => item.key === key),
        point,
      ).toEqual([]);

      await receiptOf(await h.reverse(row.receipt_id, { reason: REASON }, { key }));
      expect(await linesOf(f, reversalKey('taobao', row.receipt_id)), point).toEqual(
        reversalLines('taobao', 'CASH_ALIPAY', 70_000n),
      );
      expect(await balanceOf(f, 'CASH_ALIPAY'), point).toBe(0n);
    }
    expect(await audits(f, REVERSE_ACTION)).toHaveLength(REVERSE_FAULTS.length);
  });
});
