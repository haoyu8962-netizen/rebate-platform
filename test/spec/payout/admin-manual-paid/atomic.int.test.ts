// B2-09m atomicity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid "Effects of each paid item, on one transaction", "An unexpected failure of one item
// ends the request with 5xx; items already recorded stay recorded, and the same key runs the rest again
// (those come back not_approved)". The failure is a one-shot fault in the entry's database handle
// (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  AFTER_FREEZE,
  AMOUNT,
  answer,
  approved,
  asPaidManual,
  audits,
  balanceOf,
  changes,
  entryOf,
  expectItems,
  fixture,
  newKey,
  paid,
  payee,
  rowOf,
  skipped,
  state,
  suite,
  taxOf,
  voucherOf,
  withManualAdmin,
  type FaultPoint,
} from './manual-paid-harness.ts';

const s = suite();

async function itemFault(point: FaultPoint): Promise<void> {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    const entry = entryOf(f, w);
    const before = await state(f);
    const key = newKey();

    h.fault.point = point;
    const sent = await h.manualPaid([entry], { key });

    expect(h.fault.tripped, `${point} 必须在这一项的事务里执行`).toBe(1);
    await answer(sent, 50001);
    expect(await state(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: AMOUNT,
    });

    await expectItems(await h.manualPaid([entry], { key }), [paid(w.id)]);
    expect(await rowOf(f, w)).toEqual(asPaidManual(f, w, entry, h.entry.id));
    expect(await voucherOf(f.db, f.appId, `wd:${w.id}:PAID`)).toHaveLength(1);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toHaveLength(1);
    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 12_560n,
        cum_withheld_fen: 88n,
      },
    ]);
  });
}

it('[AC-B2-09m#66] 写审计失败 → 50001，这一项的状态、凭证、tax_ytd、事件都不留，幂等键也不留；同一 key 重发即成功，钱和台账只动一次', async () => {
  await itemFault('audit');
});

it('[AC-B2-09m#67] 过账失败 → 50001，这一项的状态、凭证、tax_ytd、事件、审计都不留；同一 key 重发即成功，钱和台账只动一次', async () => {
  await itemFault('voucher');
});

it('[AC-B2-09m#68] 写 tax_ytd 失败 → 50001，这一项的状态、凭证、事件、审计都不留；同一 key 重发即成功，钱和台账只动一次', async () => {
  await itemFault('tax_ytd');
});

it('[AC-B2-09m#69] 部分完成：第 2 项抛意外错误时 50001，第 1 项已提交不回滚（有凭证、审计、事件、tax_ytd），第 2 项回滚，第 3 项还没跑；同键重试时第 1 项 not_approved，第 2、3 项 paid；每单恰一张凭证、一条审计，第 1 项的钱不动第二次', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const third = await approved(f, h, who);
    const items = [entryOf(f, first), entryOf(f, second), entryOf(f, third)];
    const key = newKey();

    h.fault.point = 'audit';
    h.fault.contains = second.id;
    const sent = await h.manualPaid(items, { key });

    expect(h.fault.tripped, '第 2 项的审计必须在它自己的事务里写').toBe(1);
    await answer(sent, 50001);
    expect(await rowOf(f, first)).toEqual(asPaidManual(f, first, items[0]!, h.entry.id));
    expect(await rowOf(f, second)).toEqual(second);
    expect(await rowOf(f, third)).toEqual(third);
    expect(await voucherOf(f.db, f.appId, `wd:${first.id}:PAID`)).toHaveLength(1);
    expect(await voucherOf(f.db, f.appId, `wd:${second.id}:PAID`)).toEqual([]);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: first.id, user_id: who.userId, status: 'PAID_MANUAL' },
    ]);

    await expectItems(await h.manualPaid(items, { key }), [
      skipped(first.id, 'not_approved'),
      paid(second.id),
      paid(third.id),
    ]);

    for (const [index, row] of [first, second, third].entries()) {
      expect(await rowOf(f, row)).toEqual(asPaidManual(f, row, items[index]!, h.entry.id));
      expect(await voucherOf(f.db, f.appId, `wd:${row.id}:PAID`)).toHaveLength(1);
    }
    expect(await audits(f, ACTION)).toHaveLength(3);
    expect(await changes(f.db, f.appId)).toHaveLength(3);
    expect(await taxOf(f, who)).toEqual([
      {
        year: 2026,
        income_type: 'SERVICE_FEE',
        identity_hmac: who.hmac,
        cum_income_fen: 37_680n,
        cum_withheld_fen: 264n,
      },
    ]);
  });
});
