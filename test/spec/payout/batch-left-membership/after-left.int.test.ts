// B2-09n rule tests of what comes after staying behind (claude-independent, SPEC_REF 6f50a051): 08
// BR-WDR-10 W3, BR-WDR-16 W8, BR-WDR-09, BR-WDR-11, 编排裁定 D10-609 — a withdrawal on a batch because it stayed
// behind can still be recorded paid and rejected. batch_id stays that batch, no new batch, no new item, no
// job; a later batch finds it not_approved and records no moved_out. W8 and EXECUTE go through the real admin
// entry of ../admin-manual-paid/manual-paid-harness.ts, W3 through the one of
// ../admin-withdrawal-review/review-harness.ts on the same fixture. Expected amounts are by hand: amount
// 12,560 on a balance of 9,000,001, available 8,987,441 after the freeze. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { asMoved, orderedItems } from '../admin-payout-batch/batch-harness.ts';
import {
  AFTER_FREEZE,
  RICH,
  approved,
  asPaidManual,
  balanceOf,
  entryOf,
  expectExecuted,
  expectItems,
  fixture,
  item,
  itemsOf,
  paid,
  payee,
  payoutJobs,
  rowOf,
  suite,
  withManualAdmin,
  type Payee,
  type WithdrawalRow,
} from '../admin-manual-paid/manual-paid-harness.ts';
import {
  rejectBody,
  rejectedBy,
  withReviewAdmin,
} from '../admin-withdrawal-review/review-harness.ts';

const s = suite();

it('[AC-B2-09n#24] W8：channel_disabled 留下挂上批次的单仍可线下补录：PAID_MANUAL，batch_id 仍是那批，row_version 再加 1，不写 item、不建批次、没有任务；冻结解除；之后再组批次 not_approved，batch_id 不变，那批没有 moved_out', async () => {
  const f = fixture(s);
  await withManualAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who, { method: 'bank_card' });

    const batchId = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });
    expect(await rowOf(f, w)).toEqual(asMoved(f, w, batchId));
    const left = await rowOf(f, w);
    const entry = entryOf(f, left);

    await expectItems(await h.manualPaid([entry]), [paid(w.id)]);

    expect(await rowOf(f, w)).toEqual(asPaidManual(f, left, entry, h.entry.id));
    expect((await rowOf(f, w)).batch_id).toBe(batchId);
    expect(await itemsOf(f)).toEqual([item(batchId, w, 'blocked', 'channel_disabled')]);
    expect(await payoutJobs(f)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: AFTER_FREEZE,
      frozen_fen: 0n,
    });

    const paidRow = await rowOf(f, w);
    const later = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'not_approved']],
    });

    expect(await rowOf(f, w)).toEqual(paidRow);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, w, 'blocked', 'channel_disabled'),
        item(later, w, 'skipped', 'not_approved'),
      ]),
    );
  });
});

it('[AC-B2-09n#25] W3：channel_disabled 留下挂上批次的单仍可驳回：REJECTED，batch_id 仍是那批，execute_seq 不变，不写 item、没有任务；冻结的钱全退回 available', async () => {
  const f = fixture(s);
  let who!: Payee;
  let left!: WithdrawalRow;
  let batchId!: string;
  await withManualAdmin(f, async (h) => {
    who = await payee(f, h);
    const w = await approved(f, h, who, { method: 'bank_card' });

    batchId = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });
    expect(await rowOf(f, w)).toEqual(asMoved(f, w, batchId));
    left = await rowOf(f, w);
  });

  await withReviewAdmin(f, async (h) => {
    await rejectedBy(
      f,
      await h.reject(left.id, rejectBody()),
      left,
      h.reviewer.id,
      'PAYEE_INFO_INVALID',
    );

    expect(await rowOf(f, left)).toMatchObject({
      status: 'REJECTED',
      batch_id: batchId,
      execute_seq: left.execute_seq,
      row_version: left.row_version + 1,
    });
    expect(await itemsOf(f)).toEqual([item(batchId, left, 'blocked', 'channel_disabled')]);
    expect(await payoutJobs(f)).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: RICH,
      frozen_fen: 0n,
    });
  });
});
