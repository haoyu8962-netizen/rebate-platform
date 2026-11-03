// B2-09l idempotency rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch — `Idempotency-Key` required: same key and body → the first result, a `rejected`
// one too (the second does not judge again: after fixing what refused it, a new key runs it); same key
// with another body → 20901; same key while still running → 40901. A replay adds no batch, job or audit.
// A running request is held on the withdrawal row from outside. Requests go through the real admin
// entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ACTION,
  PLENTY,
  answer,
  approved,
  audits,
  expectExecuted,
  expectRejected,
  fixture,
  lockWithdrawal,
  newKey,
  payee,
  payoutJobs,
  rowOf,
  seedW,
  suite,
  track,
  transferJob,
  waiting,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#43] 同键同体（executed）：重放原样返回第一次的应答（每次 step-up 令牌不同也一样），不多一个批次、任务、审计', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const key = newKey();
    const sent = await h.execute([w.id], { key });
    await expectExecuted(sent, { paying: [w.id] });
    const after = await world(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.execute([w.id], { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }

    expect(await world(f)).toEqual(after);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
  });
});

it('[AC-B2-09l#44] 同键同体（rejected）：首次 rejected 后补好 W，同键重放仍是 rejected、不重新判定、审计不增加；换新键才执行', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const key = newKey();
    const sent = await h.execute([w.id], { key });
    await expectRejected(sent, 'watermark_stale', 'alipay');
    await seedW(f, { fen: PLENTY });
    const after = await world(f);

    const again = await h.execute([w.id], { key });

    expect(again.statusCode).toBe(sent.statusCode);
    expect(again.body).toBe(sent.body);
    expect(await world(f)).toEqual(after);
    expect(await rowOf(f, w)).toEqual(w);

    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
    expect(await audits(f, ACTION)).toHaveLength(2);
  });
});

it('[AC-B2-09l#45] 同键异体 → 20901，第一次 executed 或 rejected 都一样；什么都不多', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    const refusedKey = newKey();
    await expectRejected(await h.execute([w.id], { key: refusedKey }), 'watermark_stale', 'alipay');
    await answer(await h.execute([w.id, randomUUID()], { key: refusedKey }), 20901);

    await seedW(f, { fen: PLENTY });
    const key = newKey();
    await expectExecuted(await h.execute([w.id], { key }), { paying: [w.id] });
    const after = await world(f);

    await answer(await h.execute([w.id, randomUUID()], { key }), 20901);

    expect(await world(f)).toEqual(after);
  });
});

it('[AC-B2-09l#46] 进行中：同一 key 的第一次还在执行时再发（同体或异体）→ 40901；放行后第一次照常完成，之后重放得到它的应答，一个任务一条审计', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const key = newKey();
    const lock = await lockWithdrawal(f, w);
    const first = track(h.execute([w.id], { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次执行应在行锁上等待').toBe(true);
      await answer(await h.execute([w.id], { key }), 40901);
      await answer(await h.execute([w.id, randomUUID()], { key }), 40901);
      expect(await rowOf(f, w)).toEqual(w);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await expectExecuted(sent, { paying: [w.id] });
    expect((await h.execute([w.id], { key })).body).toBe(sent.body);
    expect(await audits(f, ACTION)).toHaveLength(1);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
  });
});

it('[AC-B2-09l#47] Idempotency-Key 必填：不带或格式不对 → 20001，什么都不写、不留幂等记录', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    const before = await world(f);

    for (const key of [null, 'short', 'bad key with spaces']) {
      await answer(await h.execute([w.id], { key }), 20001);
    }

    expect(await world(f)).toEqual(before);
    expect(before.idempotency).toEqual([]);
  });
});
