// B2-09l atomicity rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch "One transaction" — the status, batch, items, job, event and audit record live
// and die together: an unexpected failure is 50001, the withdrawal stays APPROVED, no batch, item, job,
// event, and the idempotency key is not kept, so the same key runs it again. The failure is a one-shot
// fault in the entry's database handle (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  ACTION,
  PLENTY,
  answer,
  approved,
  audits,
  changes,
  expectExecuted,
  expectRejected,
  fixture,
  newKey,
  payee,
  payoutJobs,
  rowOf,
  seedW,
  suite,
  transferJob,
  withBatchAdmin,
  world,
  type FaultPoint,
} from './batch-harness.ts';

const s = suite();

async function executedFault(point: FaultPoint): Promise<void> {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const before = await world(f);
    const key = newKey();

    h.fault.point = point;
    const sent = await h.execute([w.id], { key });

    expect(h.fault.tripped, `${point} 必须在执行事务里`).toBe(1);
    await answer(sent, 50001);
    expect(await world(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);

    await expectExecuted(await h.execute([w.id], { key }), { paying: [w.id] });
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' },
    ]);
  });
}

it('[AC-B2-09l#52] 写审计失败 → 50001：单仍 APPROVED，没有批次、item、任务、事件，幂等键也不留；同一 key 重发即执行，只有一条审计一个任务', async () => {
  await executedFault('audit');
});

it('[AC-B2-09l#53] 写 item 失败（任务、事件之后）→ 50001：任务和事件随事务一起回滚，什么都不留；同一 key 重发即执行，只有一条审计一个任务', async () => {
  await executedFault('items');
});

it('[AC-B2-09l#54] rejected 的审计写失败 → 50001，什么都不留、幂等键不留；同一 key 重发得到 rejected，一条审计', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const before = await world(f);
    const key = newKey();

    h.fault.point = 'audit';
    const sent = await h.execute([w.id], { key });

    expect(h.fault.tripped, 'rejected 的审计也必须在事务里').toBe(1);
    await answer(sent, 50001);
    expect(await world(f)).toEqual(before);

    await expectRejected(await h.execute([w.id], { key }), 'watermark_stale', 'alipay');
    expect(await audits(f, ACTION)).toHaveLength(1);
  });
});
