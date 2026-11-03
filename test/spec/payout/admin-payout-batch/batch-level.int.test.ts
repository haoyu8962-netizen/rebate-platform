// B2-09l batch-level rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-12 ① — payout.enabled off or payout.queue_paused on refuses the whole
// batch: outcome rejected, batch_id null, channel null, paying and left empty; the withdrawals do not
// move and there is no batch row, item, job or event; only the audit record and the idempotency record
// stay. Requests go through the real admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  PLENTY,
  approved,
  expectOnlyTrail,
  expectRejected,
  fixture,
  payee,
  rowOf,
  seedW,
  setSwitch,
  suite,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#7] ① payout.enabled 关 → rejected reason=payout_disabled，channel null，单不动，没有批次、item、任务、事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    await setSwitch(f, 'payout.enabled', false);
    const before = await world(f);

    await expectRejected(await h.execute([w.id]), 'payout_disabled');

    expect(await rowOf(f, w)).toEqual(w);
    const after = await world(f);
    expectOnlyTrail(before, after);
    expect(after.batches).toEqual([]);
    expect(after.items).toEqual([]);
    expect(after.jobs).toEqual([]);
    expect(after.events).toEqual(before.events);
  });
});

it('[AC-B2-09l#8] ① payout.queue_paused 开 → rejected reason=queue_paused，channel null，单不动，没有批次、item、任务、事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });
    await setSwitch(f, 'payout.queue_paused', true);
    const before = await world(f);

    await expectRejected(await h.execute([w.id]), 'queue_paused');

    expect(await rowOf(f, w)).toEqual(w);
    const after = await world(f);
    expectOnlyTrail(before, after);
    expect(after.batches).toEqual([]);
    expect(after.items).toEqual([]);
    expect(after.jobs).toEqual([]);
  });
});

it('[AC-B2-09l#9] ① 先于逐单与水位：两个开关都不满足时是 payout_disabled；没有 W、id 全是未知或非 UUID 也同样整批拒绝，不是 not_approved', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    await setSwitch(f, 'payout.enabled', false);
    await setSwitch(f, 'payout.queue_paused', true);
    const before = await world(f);

    await expectRejected(await h.execute(['not-a-uuid']), 'payout_disabled');

    expectOnlyTrail(before, await world(f));
    await setSwitch(f, 'payout.enabled', true);
    await expectRejected(await h.execute(['still-not-a-uuid']), 'queue_paused');
  });
});
