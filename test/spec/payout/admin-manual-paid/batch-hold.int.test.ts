// B2-09m batch and hold rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid "A withdrawal on a batch stays on it", "hold_reason and hold_at cleared", and the
// 执行结果 column is rendered from the response and not stored: no payout_batch_items row, no new batch.
// Requests go through the real admin entry (manual-paid-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  approved,
  asPaidManual,
  entryOf,
  expectItems,
  fixture,
  heldOnBatch,
  item,
  itemsOf,
  paid,
  payee,
  payoutJobs,
  rowOf,
  skipped,
  state,
  suite,
  withManualAdmin,
} from './manual-paid-harness.ts';

const s = suite();

const MONEY = { amount_fen: 12_560n, fee_fen: 125n, tax_fen: 88n } as const;

it('[AC-B2-09m#47] 挂在批次上、hold_reason=single_cap 的单补录后 batch_id 不变，不写 item、不建批次、没有任务，execute_seq 不变；hold_reason、hold_at 被清空；needs_manual 仍是 false', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const { batch, row } = await heldOnBatch(f, h, await payee(f, h), { seed: MONEY });
    expect(row.hold_reason).toBe('single_cap');
    expect(row.hold_at).not.toBeNull();
    expect(row.needs_manual).toBe(false);
    const before = await state(f);
    const entry = entryOf(f, row);

    await expectItems(await h.manualPaid([entry]), [paid(row.id)]);

    const now = await rowOf(f, row);
    expect(now).toEqual(asPaidManual(f, row, entry, h.entry.id));
    expect(now.batch_id).toBe(batch.id);
    expect(now.execute_seq).toBe(row.execute_seq);
    expect(now.hold_reason).toBeNull();
    expect(now.hold_at).toBeNull();
    expect(now.needs_manual).toBe(false);
    expect(await itemsOf(f)).toEqual([item(batch.id, row, 'paying')]);
    expect((await state(f)).batches).toEqual(before.batches);
    expect(await payoutJobs(f)).toEqual([]);
  });
});

it('[AC-B2-09m#48] 跳过的项 hold 和批次都不动，执行结果不落库：不写 item', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const { batch, row } = await heldOnBatch(f, h, await payee(f, h), { seed: MONEY });
    const free = await approved(f, h, await payee(f, h));

    await expectItems(await h.manualPaid([entryOf(f, row, { paid_fen: 1 }), entryOf(f, free)]), [
      skipped(row.id, 'amount_mismatch'),
      paid(free.id),
    ]);

    expect(await rowOf(f, row)).toEqual(row);
    expect(await itemsOf(f)).toEqual([item(batch.id, row, 'paying')]);
  });
});
