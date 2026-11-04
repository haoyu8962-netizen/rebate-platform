// B2-09n whole-batch refusal rule tests on the manual batch (claude-independent, SPEC_REF 6f50a051): 08
// BR-WDR-12 ① ③, 编排裁定 D10-609 规则 4 — a refused batch writes nothing: batch_id stays null, row_version
// stays, no batch row, no item, also for a withdrawal ② left behind in that same request. Each test then
// runs the same withdrawals through a batch that does run: the refusal left no trace (row_version + 1 only
// from that run, no moved_out) and the one that stays goes onto that batch. Requests go through the real
// admin entry and the real createPayoutExecute (../admin-payout-batch/batch-harness.ts). The automatic
// batch's refusals are in auto.int.test.ts. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  W_JUST_SHORT,
  approved,
  asMoved,
  asPaying,
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
  seedW,
  setSwitch,
  suite,
  transferJob,
  withBatchAdmin,
  world,
} from '../admin-payout-batch/batch-harness.ts';

const s = suite();

it('[AC-B2-09n#17] 规则 4 ① payout.enabled 关、payout.queue_paused 开（人工）：整批 rejected，通过 ② 的和 ② 留下的单都完全不变，没有批次行、item；开关恢复后这一批执行，留下的 row_version 只加 1、没有 moved_out', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const free = await approved(f, h, who);
    const closed = await approved(f, h, who, { method: 'bank_card' });
    await seedW(f, { fen: PLENTY });

    await setSwitch(f, 'payout.enabled', false);
    let before = await world(f);
    await expectRejected(await h.execute([free.id, closed.id]), 'payout_disabled');
    expectOnlyTrail(before, await world(f));

    await setSwitch(f, 'payout.enabled', true);
    await setSwitch(f, 'payout.queue_paused', true);
    before = await world(f);
    await expectRejected(await h.execute([free.id, closed.id]), 'queue_paused');
    expectOnlyTrail(before, await world(f));
    expect(before.batches).toEqual([]);
    expect(before.items).toEqual([]);
    expect(await rowOf(f, free)).toEqual(free);
    expect(await rowOf(f, closed)).toEqual(closed);

    await setSwitch(f, 'payout.queue_paused', false);
    const batchId = await expectExecuted(await h.execute([free.id, closed.id]), {
      paying: [free.id],
      left: [[closed.id, 'channel_disabled']],
    });

    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, free, 'paying'),
        item(batchId, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#18] 规则 4 单通道 ③ watermark_stale（人工）：alipay 一单没有 W、② 留下一张从没挂过批次的银行卡单和一张挂在旧批次上的单：整批 rejected，谁都不变、不挂、不改挂，没有批次行、item；录了 W 后这一批执行，银行卡单挂上这一批', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const alipay = await approved(f, h, who);
    const closed = await approved(f, h, who, { method: 'bank_card' });
    const old = await heldOnBatch(f, h, await payee(f, h), {
      seed: { blocked_reason: 'NEGATIVE_BALANCE' },
    });
    const ids = [alipay.id, closed.id, old.row.id];
    const before = await world(f);

    await expectRejected(await h.execute(ids), 'watermark_stale', 'alipay');

    expectOnlyTrail(before, await world(f));
    expect(await rowOf(f, closed)).toEqual(closed);
    expect(await rowOf(f, old.row)).toEqual(old.row);

    await seedW(f, { fen: PLENTY });
    const batchId = await expectExecuted(await h.execute(ids), {
      paying: [alipay.id],
      left: [
        [closed.id, 'channel_disabled'],
        [old.row.id, 'member_blocked'],
      ],
    });

    expect(await rowOf(f, old.row)).toEqual(asMoved(f, old.row, batchId));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(old.batch.id, old.row, 'paying'),
        movedOut(old.batch.id, old.row, batchId),
        item(batchId, old.row, 'blocked', 'member_blocked'),
        item(batchId, alipay, 'paying'),
        item(batchId, closed, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#19] 规则 4 单通道 ③ watermark_usable_exceeded（人工）：W=13,718（可用 12,346.2）不够 net 12,347，整批 rejected，② 留下的银行卡单也完全不变；录足额 W 后这一批执行，银行卡单挂上这一批', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const alipay = await approved(f, h, who);
    const closed = await approved(f, h, who, { method: 'bank_card' });
    await seedW(f, { fen: W_JUST_SHORT, ageMs: 20 * 60_000 });
    const before = await world(f);

    await expectRejected(
      await h.execute([alipay.id, closed.id]),
      'watermark_usable_exceeded',
      'alipay',
    );

    expectOnlyTrail(before, await world(f));
    expect(await rowOf(f, alipay)).toEqual(alipay);
    expect(await rowOf(f, closed)).toEqual(closed);

    await seedW(f, { fen: PLENTY, ageMs: 10 * 60_000 });
    const batchId = await expectExecuted(await h.execute([alipay.id, closed.id]), {
      paying: [alipay.id],
      left: [[closed.id, 'channel_disabled']],
    });

    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});
