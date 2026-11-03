// B2-09l concurrency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-12 (重复点击靠状态 CAS 去重); payout AGENTS.md 硬规则 1. Two admins on
// one withdrawal: one moves it to PAYING, the other finds it not_approved; one job, execute_seq + 1 once.
// The interleaving is made with a lock and no timing: the withdrawal row is held from outside, the
// requests must wait on it, then it is released, or moved by the holder first. Requests go through the
// real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  EXECUTE,
  PLENTY,
  approved,
  asPaying,
  audits,
  changes,
  expectExecuted,
  fixture,
  item,
  itemsOf,
  lockWithdrawal,
  moveToPaying,
  orderedItems,
  payee,
  payoutJobs,
  resultOf,
  rowOf,
  seedW,
  suite,
  track,
  transferJob,
  waiting,
  withBatchAdmin,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#33] 两个管理员同时执行同一张单：只有一个进 PAYING，另一个 executed 但 left=not_approved；任务恰一个，execute_seq 只加 1，事件一个；各有一个批次一条审计', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const colleague = await h.caller([EXECUTE]);
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });

    const lock = await lockWithdrawal(f, w);
    const first = track(h.execute([w.id]));
    const second = track(h.execute([w.id], { caller: colleague }));
    try {
      expect(await waiting(f, 2, [first, second]), '两个执行都应在锁上等待').toBe(true);
    } finally {
      await lock.release();
    }

    const results = [await resultOf(await first.promise), await resultOf(await second.promise)];
    const winner = results.find((data) => data.paying.length === 1);
    const loser = results.find((data) => data.paying.length === 0);
    expect(winner?.paying).toEqual([w.id]);
    expect(winner?.left).toEqual([]);
    expect(loser?.outcome).toBe('executed');
    expect(loser?.left).toEqual([{ withdrawal_id: w.id, reason: 'not_approved' }]);
    expect(loser?.batch_id).not.toBe(winner?.batch_id);

    const moved = await rowOf(f, w);
    expect(moved.status).toBe('PAYING');
    expect(moved.execute_seq).toBe(w.execute_seq + 1);
    expect(moved.row_version).toBe(w.row_version + 1);
    expect(moved.batch_id).toBe(winner?.batch_id);
    expect([h.executor.id, colleague.id]).toContain(moved.executor_id);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' },
    ]);
    expect(await audits(f, ACTION)).toHaveLength(2);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(winner?.batch_id ?? '', w, 'paying'),
        item(loser?.batch_id ?? '', w, 'skipped', 'not_approved'),
      ]),
    );
  });
});

it('[AC-B2-09l#34] CAS（确定性）：执行在行锁上等待时，别的事务把这一单改成 PAYING → 这一单 not_approved，同批另一单照常 PAYING；这一单没有新任务，别人写的列不变', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const taken = await approved(f, h, await payee(f, h));
    const free = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });

    const lock = await lockWithdrawal(f, taken);
    const pending = track(h.execute([taken.id, free.id]));
    try {
      expect(await waiting(f, 1, [pending]), '执行应在行锁上等待').toBe(true);
    } finally {
      await lock.release((trx) => moveToPaying(trx, taken, f.clock.now()));
    }

    const batchId = await expectExecuted(await pending.promise, {
      paying: [free.id],
      left: [[taken.id, 'not_approved']],
    });

    expect(await rowOf(f, free)).toEqual(asPaying(f, free, batchId, h.executor.id));
    expect(await rowOf(f, taken)).toMatchObject({
      status: 'PAYING',
      execute_seq: taken.execute_seq + 1,
      executor_id: null,
      batch_id: null,
    });
    expect(await payoutJobs(f)).toEqual([transferJob(f, free, 1)]);
  });
});

it('[AC-B2-09l#35] 重复点击（串行、新键）：已是 PAYING 的单再执行 → not_approved，不再投递，execute_seq 不变', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const batchId = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
    const moved = await rowOf(f, w);

    const again = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'not_approved']],
    });

    expect(again).not.toBe(batchId);
    expect(await rowOf(f, w)).toEqual(moved);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
  });
});
