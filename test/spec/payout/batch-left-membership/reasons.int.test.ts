// B2-09n per-reason rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-11, BR-WDR-12 ②, 编排裁定
// D10-609 规则 1、5 — member_blocked, has_transfer_attempt and channel_disabled on a withdrawal with no batch
// write this batch: batch_id, row_version + 1, updated_at the injected clock, every other column as it was;
// the others of the same batch run. One already on another batch moves as before and the old batch records
// moved_out. Requests go through the real admin entry and the real createPayoutExecute
// (../admin-payout-batch/batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  approved,
  asMoved,
  asPaying,
  changes,
  expectExecuted,
  fixture,
  heldOnBatch,
  item,
  itemsOf,
  movedOut,
  orderedItems,
  payee,
  payoutJobs,
  rowOf,
  seedHold,
  seedReturned,
  seedRiskState,
  seedSent,
  seedW,
  suite,
  transferJob,
  withBatchAdmin,
} from '../admin-payout-batch/batch-harness.ts';

const s = suite();

it('[AC-B2-09n#5] 规则 1 member_blocked（风控冻结、有效 hold、blocked_reason 非空）：原 batch_id 为 null 的写成本批，row_version + 1，updated_at 是注入时钟，其余列不变；同批可打的照常 PAYING，只有它有任务和事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const frozenMember = await payee(f, h);
    await seedRiskState(f, frozenMember, 'frozen');
    const frozen = await approved(f, h, frozenMember);
    const heldMember = await payee(f, h);
    await seedHold(f, heldMember, { reason: 'manual', hold_until: null });
    const onHold = await approved(f, h, heldMember);
    const marked = await approved(f, h, await payee(f, h), { blocked_reason: 'NEGATIVE_BALANCE' });
    const who = await payee(f, h);
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const stopped = [frozen, onHold, marked];

    const batchId = await expectExecuted(
      await h.execute([free.id, ...stopped.map((row) => row.id)]),
      { paying: [free.id], left: stopped.map((row) => [row.id, 'member_blocked']) },
    );

    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, free, 'paying'),
        ...stopped.map((row) => item(batchId, row, 'blocked', 'member_blocked')),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: free.id, user_id: who.userId, status: 'PAYING' },
    ]);
    for (const row of stopped) expect(await rowOf(f, row)).toEqual(asMoved(f, row, batchId));
  });
});

it('[AC-B2-09n#6] 规则 1 has_transfer_attempt：转账尝试 fail 的单，原 batch_id 为 null 的写成本批，row_version + 1，updated_at 是注入时钟，execute_seq 不变，不再投递；同批可打的照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const tried = await approved(f, h, who);
    await seedSent(f, tried, 'transfer', 'fail');
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([tried.id, free.id]), {
      paying: [free.id],
      left: [[tried.id, 'has_transfer_attempt']],
    });

    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, tried, 'blocked', 'has_transfer_attempt'),
        item(batchId, free, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
    expect(await rowOf(f, tried)).toEqual(asMoved(f, tried, batchId));
  });
});

it('[AC-B2-09n#7] 规则 1 channel_disabled：银行卡默认未开通的单，原 batch_id 为 null 的写成本批，row_version + 1，updated_at 是注入时钟，其余列不变；同批支付宝照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const closed = await approved(f, h, who, { method: 'bank_card' });
    const free = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([closed.id, free.id]), {
      paying: [free.id],
      left: [[closed.id, 'channel_disabled']],
    });

    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, closed, 'blocked', 'channel_disabled'),
        item(batchId, free, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
    expect(await rowOf(f, closed)).toEqual(asMoved(f, closed, batchId));
  });
});

it('[AC-B2-09n#8] 规则 5 同批混着两种：已挂别批的三种原因照旧改挂、旧批次记 moved_out；原 batch_id 为 null 的挂上本批，不记 moved_out；两边 row_version 都只加 1', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const blockedOld = await heldOnBatch(f, h, await payee(f, h), {
      seed: { blocked_reason: 'NEGATIVE_BALANCE' },
    });
    const closedOld = await heldOnBatch(f, h, await payee(f, h), {
      seed: { method: 'bank_card' },
    });
    const triedOld = await seedReturned(f, h, await payee(f, h));
    const triedBatch = triedOld.batch_id;
    expect(triedBatch).not.toBeNull();
    const closedNew = await approved(f, h, await payee(f, h), { method: 'bank_card' });

    const batchId = await expectExecuted(
      await h.execute([blockedOld.row.id, closedOld.row.id, triedOld.id, closedNew.id]),
      {
        left: [
          [blockedOld.row.id, 'member_blocked'],
          [closedOld.row.id, 'channel_disabled'],
          [triedOld.id, 'has_transfer_attempt'],
          [closedNew.id, 'channel_disabled'],
        ],
      },
    );

    expect(await rowOf(f, blockedOld.row)).toEqual(asMoved(f, blockedOld.row, batchId));
    expect(await rowOf(f, closedOld.row)).toEqual(asMoved(f, closedOld.row, batchId));
    expect(await rowOf(f, triedOld)).toEqual(asMoved(f, triedOld, batchId));
    expect(await rowOf(f, closedNew)).toEqual(asMoved(f, closedNew, batchId));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(blockedOld.batch.id, blockedOld.row, 'paying'),
        movedOut(blockedOld.batch.id, blockedOld.row, batchId),
        item(batchId, blockedOld.row, 'blocked', 'member_blocked'),
        item(closedOld.batch.id, closedOld.row, 'paying'),
        movedOut(closedOld.batch.id, closedOld.row, batchId),
        item(batchId, closedOld.row, 'blocked', 'channel_disabled'),
        movedOut(triedBatch!, triedOld, batchId),
        item(batchId, triedOld, 'blocked', 'has_transfer_attempt'),
        item(batchId, closedNew, 'blocked', 'channel_disabled'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([]);
  });
});
