// B2-09l regroup rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-11, BR-WDR-12 细则 E-28; payout-execute.ts — an APPROVED withdrawal
// already on another batch moves by a CAS to the new one and the old batch keeps its item as moved_out,
// also when it is then listed in `left` with member_blocked, has_transfer_attempt or channel_disabled.
// One left with not_approved or a watermark reason is not moved, and a refused batch moves nothing. An
// old batch's items are never deleted. The withdrawal on an old batch is seeded as W9 leaves it
// (batch_id and execute_seq kept). D10-609 (B2-09n): a withdrawal that was never on a batch is written
// onto the batch it stays behind in, so grouping it again moves it like any other (#31). Requests go
// through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  approved,
  asMoved,
  batchOf,
  expectExecuted,
  expectOnlyTrail,
  expectRejected,
  fixture,
  heldOnBatch,
  item,
  itemsOf,
  movedOut,
  orderedItems,
  payee,
  payoutJobs,
  rowOf,
  seedReturned,
  seedReview,
  seedW,
  setSwitch,
  suite,
  transferJob,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#28] 改挂后能打：进 PAYING、batch_id 是新批次、execute_seq=2；旧批次 item 记 moved_out、moved_to_batch_id 是新批次，旧 item 不删；review_mode 不变（自动判定的单进人工批次仍是 auto）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const { batch: old, row } = await heldOnBatch(f, h, await payee(f, h), {
      kind: 'auto',
      seed: { review_mode: 'auto', reviewer_id: null },
    });
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([row.id]), { paying: [row.id] });

    expect(await rowOf(f, row)).toMatchObject({
      status: 'PAYING',
      batch_id: batchId,
      execute_seq: 2,
      executor_id: h.executor.id,
      executed_at: f.clock.now(),
      review_mode: 'auto',
      reviewer_id: null,
    });
    expect(batchId).not.toBe(old.id);
    expect(await batchOf(f, batchId)).toMatchObject({ kind: 'manual', created_by: h.executor.id });
    expect(await batchOf(f, old.id)).toEqual(old);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(old.id, row, 'paying'),
        movedOut(old.id, row, batchId),
        item(batchId, row, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, row, 2)]);
  });
});

it('[AC-B2-09l#29] 改挂后仍受阻（member_blocked、has_transfer_attempt、channel_disabled）：在 left，单留在 APPROVED，但 batch_id 也改到新批次；旧批次 moved_out，新批次记 blocked；execute_seq 不变，没有任务', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const blocked = await heldOnBatch(f, h, await payee(f, h), {
      seed: { blocked_reason: 'NEGATIVE_BALANCE' },
    });
    const closed = await heldOnBatch(f, h, await payee(f, h), { seed: { method: 'bank_card' } });
    const tried = await seedReturned(f, h, await payee(f, h));
    const triedBatch = tried.batch_id;
    expect(triedBatch).not.toBeNull();

    const batchId = await expectExecuted(
      await h.execute([blocked.row.id, closed.row.id, tried.id]),
      {
        left: [
          [blocked.row.id, 'member_blocked'],
          [closed.row.id, 'channel_disabled'],
          [tried.id, 'has_transfer_attempt'],
        ],
      },
    );

    expect(await rowOf(f, blocked.row)).toEqual(asMoved(f, blocked.row, batchId));
    expect(await rowOf(f, closed.row)).toEqual(asMoved(f, closed.row, batchId));
    expect(await rowOf(f, tried)).toEqual(asMoved(f, tried, batchId));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(blocked.batch.id, blocked.row, 'paying'),
        movedOut(blocked.batch.id, blocked.row, batchId),
        item(batchId, blocked.row, 'blocked', 'member_blocked'),
        item(closed.batch.id, closed.row, 'paying'),
        movedOut(closed.batch.id, closed.row, batchId),
        item(batchId, closed.row, 'blocked', 'channel_disabled'),
        movedOut(triedBatch!, tried, batchId),
        item(batchId, tried, 'blocked', 'has_transfer_attempt'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([]);
  });
});

it('[AC-B2-09l#30] 不改挂：not_approved（已挂旧批次的 PAYING、REJECTED）和带水位原因留下的（多通道）batch_id 不变，旧批次没有 moved_out，新批次只记 skipped / blocked', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const paying = await heldOnBatch(f, h, who, {
      seed: { status: 'PAYING', hold_reason: null, hold_at: null },
    });
    const old = paying.batch;
    const rejected = await seedReview(f, h, who, { status: 'REJECTED', batch_id: old.id });
    const stale = await heldOnBatch(f, h, who, { seed: { method: 'wechat' } });
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(
      await h.execute([paying.row.id, rejected.id, stale.row.id, free.id]),
      {
        paying: [free.id],
        left: [
          [paying.row.id, 'not_approved'],
          [rejected.id, 'not_approved'],
          [stale.row.id, 'watermark_stale'],
        ],
      },
    );

    expect(await rowOf(f, paying.row)).toEqual(paying.row);
    expect(await rowOf(f, rejected)).toEqual(rejected);
    expect(await rowOf(f, stale.row)).toEqual(stale.row);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(old.id, paying.row, 'paying'),
        item(stale.batch.id, stale.row, 'paying'),
        item(batchId, paying.row, 'skipped', 'not_approved'),
        item(batchId, rejected, 'skipped', 'not_approved'),
        item(batchId, stale.row, 'blocked', 'watermark_stale'),
        item(batchId, free, 'paying'),
      ]),
    );
  });
});

it('[AC-B2-09l#31] 从没挂过批次的单第一次留下（channel_disabled）：batch_id 写成那批、row_version + 1（D10-609），那批记 blocked；开通后再执行进 PAYING，batch_id 是新批次，第一批记 moved_out、blocked 保留', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await setSwitch(f, 'payout.channel_enabled.alipay', false);

    const first = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });

    expect(await rowOf(f, w)).toEqual(asMoved(f, w, first));
    expect(await itemsOf(f)).toEqual([item(first, w, 'blocked', 'channel_disabled')]);

    await setSwitch(f, 'payout.channel_enabled.alipay', true);
    await seedW(f, { fen: PLENTY });
    const second = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });

    expect(await rowOf(f, w)).toMatchObject({ status: 'PAYING', batch_id: second, execute_seq: 1 });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, w, 'blocked', 'channel_disabled'),
        movedOut(first, w, second),
        item(second, w, 'paying'),
      ]),
    );
  });
});

it('[AC-B2-09l#32] 整批拒绝不改挂（①、③）：已挂旧批次的单 batch_id 不变，没有 moved_out，没有新批次，旧 item 不动', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const { row } = await heldOnBatch(f, h, await payee(f, h));
    let before = await world(f);

    await expectRejected(await h.execute([row.id]), 'watermark_stale', 'alipay');
    expectOnlyTrail(before, await world(f));

    await setSwitch(f, 'payout.queue_paused', true);
    before = await world(f);
    await expectRejected(await h.execute([row.id]), 'queue_paused');
    expectOnlyTrail(before, await world(f));

    await setSwitch(f, 'payout.queue_paused', false);
    await setSwitch(f, 'payout.enabled', false);
    before = await world(f);
    await expectRejected(await h.execute([row.id]), 'payout_disabled');
    expectOnlyTrail(before, await world(f));

    expect(await rowOf(f, row)).toEqual(row);
  });
});
