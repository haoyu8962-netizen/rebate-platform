// B2-09l watermark rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-12 ③, BR-WDR-18, 编排裁定 D10-285, D10-288, D10-290 — what passed ② all
// on one channel: a failure refuses the whole batch with the reason and that channel, nothing moves, no
// item. What passed on several channels: a failing channel's withdrawals stay APPROVED and are in `left`
// with the watermark reason, the others run; every channel failing is still `executed`, with paying
// empty and a batch. W, P and the committed sums are per channel. Expected amounts are by hand: usable =
// W × 9000 / 10000, default of payout.watermark_usable_bp. Requests go through the real admin entry
// (batch-harness.ts). Top-level it() only (规划/11 §4.3).
// D10-609 (B2-09n): one left by a failing channel of several that was on no batch is written onto this
// batch (batch_id, row_version + 1, updated_at); its status and money stay.
import { expect, it } from 'vitest';
import {
  FORECAST,
  FORECAST_SOURCE,
  HOUR,
  MINUTE,
  NET,
  PLENTY,
  W_JUST_ENOUGH,
  W_JUST_SHORT,
  ago,
  approved,
  asPaying,
  batchOf,
  changes,
  expectExecuted,
  expectOnlyTrail,
  expectRejected,
  fixture,
  heldOnBatch,
  item,
  itemsOf,
  ofNet,
  orderedItems,
  payee,
  payoutJobs,
  rowOf,
  seedHistory,
  seedReview,
  seedW,
  setSwitch,
  suite,
  transferJob,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#18] ③ 单通道 watermark_stale：没有 W，或 W 超过 2 小时 1 毫秒 → 整批 rejected、channel 是该通道，单不动、没有 item；恰好 2 小时可以执行', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    let before = await world(f);
    await expectRejected(await h.execute([w.id]), 'watermark_stale', 'alipay');
    expectOnlyTrail(before, await world(f));
    expect(await rowOf(f, w)).toEqual(w);

    await seedW(f, { fen: PLENTY, ageMs: 2 * HOUR + 1 });
    before = await world(f);
    await expectRejected(await h.execute([w.id]), 'watermark_stale', 'alipay');
    expectOnlyTrail(before, await world(f));
    expect((await world(f)).items).toEqual([]);

    await seedW(f, { fen: PLENTY, ageMs: 2 * HOUR });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});

it('[AC-B2-09l#19] ③ 单通道 watermark_below_forecast（BR-WDR-18 例）：近 7 日合计 ¥49,000，P=¥21,000，W=¥20,999.99 → 整批 rejected；W 恰好等于 P 可以执行（虽然水位低）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    const w = await approved(f, h, who);
    await seedW(f, { fen: BigInt(FORECAST) - 1n, ageMs: 20 * MINUTE });
    const before = await world(f);

    await expectRejected(await h.execute([w.id]), 'watermark_below_forecast', 'alipay');

    expectOnlyTrail(before, await world(f));
    await seedW(f, { fen: BigInt(FORECAST), ageMs: 10 * MINUTE });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});

it('[AC-B2-09l#20] ③ 单通道 watermark_usable_exceeded：net 12,347，默认可用 90%：W=13,718（可用 12,346.2）→ 整批 rejected，单不动、没有 item；W=13,719（可用 12,347.1）可以执行', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await seedW(f, { fen: W_JUST_SHORT, ageMs: 20 * MINUTE });
    const before = await world(f);

    await expectRejected(await h.execute([w.id]), 'watermark_usable_exceeded', 'alipay');

    expectOnlyTrail(before, await world(f));
    expect(await rowOf(f, w)).toEqual(w);
    await seedW(f, { fen: W_JUST_ENOUGH, ageMs: 10 * MINUTE });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});

it('[AC-B2-09l#21] ③ 在途口径：本批 12,347 + 该通道 PAYING 7,013 + t_W 后到账 1,009 = 20,369：W=22,632（可用 20,368.8）拒绝，W=22,633（可用 20,369.7）通过；t_W 前到账的、别的通道 PAYING 的都不算', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await seedReview(f, h, who, { status: 'PAYING', execute_seq: 1, ...ofNet(7_013n) });
    await seedReview(f, h, who, {
      status: 'PAYING',
      execute_seq: 1,
      method: 'wechat',
      ...ofNet(90_001n),
    });
    await seedReview(f, h, who, {
      status: 'PAID_API',
      amount_fen: 1_009n,
      fee_fen: 0n,
      tax_fen: 0n,
      paid_at: ago(f, 1),
    });
    await seedReview(f, h, who, {
      status: 'PAID_API',
      amount_fen: 50_021n,
      fee_fen: 0n,
      tax_fen: 0n,
      paid_at: ago(f, 60),
    });
    const w = await approved(f, h, who);
    await seedW(f, { fen: 22_632n, ageMs: 4 * MINUTE });
    const before = await world(f);

    await expectRejected(await h.execute([w.id]), 'watermark_usable_exceeded', 'alipay');

    expectOnlyTrail(before, await world(f));
    await seedW(f, { fen: 22_633n, ageMs: 3 * MINUTE });
    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });
  });
});

it('[AC-B2-09l#22] 「单通道」看通过 ② 的单：alipay 一单、银行卡一单（未开通）、一个已挂旧批次的受阻单，通过 ② 的只有 alipay，水位失败 → 整批 rejected，left 也是空的，谁都不动、不改挂', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const alipay = await approved(f, h, who);
    const bank = await approved(f, h, who, { method: 'bank_card' });
    const { row: onOld } = await heldOnBatch(f, h, await payee(f, h), {
      seed: { blocked_reason: 'NEGATIVE_BALANCE' },
    });
    const before = await world(f);

    await expectRejected(
      await h.execute([alipay.id, bank.id, onOld.id, 'not-a-uuid']),
      'watermark_stale',
      'alipay',
    );

    expectOnlyTrail(before, await world(f));
    expect(await rowOf(f, onOld)).toEqual(onOld);
  });
});

it('[AC-B2-09l#23] ③ 多通道（D10-288）：alipay 足额、wechat 没有 W → executed，alipay 进 paying，wechat 在 left 且 reason=watermark_stale、留在 APPROVED 记 blocked，没有它的任务和事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id],
      left: [[wechat.id, 'watermark_stale']],
    });

    expect(await rowOf(f, alipay)).toEqual(asPaying(f, alipay, batchId, h.executor.id));
    expect(await rowOf(f, wechat)).toEqual({
      ...wechat,
      batch_id: batchId,
      row_version: wechat.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, alipay, 'paying'),
        item(batchId, wechat, 'blocked', 'watermark_stale'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, alipay, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: alipay.id, user_id: who.userId, status: 'PAYING' },
    ]);
  });
});

it('[AC-B2-09l#24] ③ 多通道两个通道都失败（D10-290）：仍是 executed，paying 空，left 两条各带自己的水位原因，有 batch_id（kind=manual），不是 rejected；没有任务、事件，单都不动', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    await seedW(f, { fen: BigInt(FORECAST) - 1n });
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });

    const batchId = await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [],
      left: [
        [alipay.id, 'watermark_below_forecast'],
        [wechat.id, 'watermark_stale'],
      ],
    });

    expect(await batchOf(f, batchId)).toMatchObject({
      kind: 'manual',
      created_by: h.executor.id,
    });
    // D10-609: status and money do not move; both are now on this batch.
    expect(await rowOf(f, alipay)).toEqual({
      ...alipay,
      batch_id: batchId,
      row_version: alipay.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await rowOf(f, wechat)).toEqual({
      ...wechat,
      batch_id: batchId,
      row_version: wechat.row_version + 1,
      updated_at: f.clock.now(),
    });
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(batchId, alipay, 'blocked', 'watermark_below_forecast'),
        item(batchId, wechat, 'blocked', 'watermark_stale'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09l#25] 水位按通道分开算（净额）：两个通道各 net 12,347、各 W=13,719 都够（两边加起来算就不够）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: W_JUST_ENOUGH });
    await seedW(f, { fen: W_JUST_ENOUGH, channel: 'wechat' });

    await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id, wechat.id],
    });
    expect(NET * 2n * 10_000n).toBeGreaterThan(W_JUST_ENOUGH * 9_000n);
  });
});

it('[AC-B2-09l#26] 水位按通道分开算（P）：alipay 近 7 日合计 ¥49,000、P=¥21,000 只比 alipay 的 W；wechat 没有近期提现、P=0，W=13,719 够', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: BigInt(FORECAST) });
    await seedW(f, { fen: W_JUST_ENOUGH, channel: 'wechat' });

    await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id, wechat.id],
    });
  });
});

it('[AC-B2-09l#27] 水位按通道分开算（在途）：wechat 已有 PAYING 90,001，W=13,719 不够 → wechat 留下 watermark_usable_exceeded；同样 W 的 alipay 不受影响照常 PAYING', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    await seedReview(f, h, who, {
      status: 'PAYING',
      execute_seq: 1,
      method: 'wechat',
      ...ofNet(90_001n),
    });
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: W_JUST_ENOUGH });
    await seedW(f, { fen: W_JUST_ENOUGH, channel: 'wechat' });

    const batchId = await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id],
      left: [[wechat.id, 'watermark_usable_exceeded']],
    });
    expect(await rowOf(f, wechat)).toEqual({
      ...wechat,
      batch_id: batchId,
      row_version: wechat.row_version + 1,
      updated_at: f.clock.now(),
    });
  });
});
