// B2-09l through rule tests (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch, 08 BR-WDR-12, BR-WDR-11 (ADD-05), BR-WDR-09. The purpose of the order: a
// withdrawal approved through the review route, with a W entered through the W route, reaches PAYING
// through this route, W4 with executor_id the caller, executed_at the injected Clock, execute_seq + 1,
// a new kind=manual batch; one payout.transfer job with withdrawal_id, execute_seq and app_id; one
// wallet.withdrawal_changed. The money stays frozen: no voucher, no entry. Requests go through the real
// admin entry (batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AMOUNT,
  EXECUTE,
  PLENTY,
  REVIEW,
  RICH,
  answer,
  approved,
  approvedItem,
  asPaying,
  balanceOf,
  batchOf,
  changes,
  expectExecuted,
  fixture,
  frozenMismatches,
  heldOnBatch,
  item,
  itemsOf,
  orderedItems,
  payee,
  payoutJobs,
  pending,
  rowOf,
  seedW,
  suite,
  transferJob,
  transferJobs,
  watermarkBody,
  withBatchAdmin,
  world,
} from './batch-harness.ts';

const s = suite();

it('[AC-B2-09l#3] 贯通：经审核接口通过的单、经水位接口录足额 W，经本接口执行：executed；单 PAYING，executor_id 是调用者、executed_at 是注入时钟、execute_seq + 1、batch_id 是新批次；批次 kind=manual、created_by 是调用者；payout.transfer 任务恰一个且带 withdrawal_id、execute_seq、app_id；PAYING 的 wallet.withdrawal_changed 恰一个', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await pending(f, h, who);
    await answer(await h.approve([w.id]), 0, { items: [approvedItem(w.id)] });
    await answer(await h.enterWatermark(watermarkBody(f, 3_000_001)), 0);
    const reviewed = await rowOf(f, w);
    expect(reviewed.status).toBe('APPROVED');

    const batchId = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });

    expect(await rowOf(f, w)).toEqual(asPaying(f, reviewed, batchId, h.executor.id));
    expect(await batchOf(f, batchId)).toMatchObject({
      kind: 'manual',
      created_by: h.executor.id,
      created_at: f.clock.now(),
    });
    expect(await itemsOf(f)).toEqual([item(batchId, w, 'paying')]);
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    const paying = (await changes(f.db, f.appId)).filter((data) => data['status'] === 'PAYING');
    expect(paying).toEqual([{ withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' }]);
  });
});

it('[AC-B2-09l#4] 不碰账（BR-WDR-09）：执行前后 available、frozen 都不变，没有凭证和分录，冻结不变量成立', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await seedW(f, { fen: PLENTY });
    const before = await world(f);

    await expectExecuted(await h.execute([w.id]), { paying: [w.id] });

    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: RICH - AMOUNT,
      frozen_fen: AMOUNT,
    });
    const after = await world(f);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.entries).toEqual(before.entries);
    expect(after.balances).toEqual(before.balances);
    expect(after.attempts).toEqual([]);
    expect(await frozenMismatches(f.db, f.appId)).toEqual([]);
  });
});

it('[AC-B2-09l#5] 执行人可以是审核人（ADD-05）：同一管理员审核并执行成功，reviewer_id 与 executor_id 是同一个人；批次也不要第二人', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const both = await h.caller([REVIEW, EXECUTE]);
    const w = await pending(f, h, await payee(f, h));
    await answer(await h.approve([w.id], { caller: both }), 0, { items: [approvedItem(w.id)] });
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([w.id], { caller: both }), {
      paying: [w.id],
    });

    expect(await rowOf(f, w)).toMatchObject({
      status: 'PAYING',
      reviewer_id: both.id,
      executor_id: both.id,
    });
    expect((await batchOf(f, batchId)).created_by).toBe(both.id);
  });
});

it('[AC-B2-09l#6] 一批多单、同一会员多单：每单一个任务一个事件，各按自己的 execute_seq；经 W9 回到 APPROVED 的单再执行 execute_seq=2，jobId 带新序号（BR-WDR-12 验收）', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const first = await approved(f, h, who);
    const second = await approved(f, h, who);
    const { row: returned } = await heldOnBatch(f, h, await payee(f, h));
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([first.id, second.id, returned.id]), {
      paying: [first.id, second.id, returned.id],
    });

    expect(await rowOf(f, first)).toEqual(asPaying(f, first, batchId, h.executor.id));
    expect(await rowOf(f, second)).toEqual(asPaying(f, second, batchId, h.executor.id));
    expect(await rowOf(f, returned)).toMatchObject({
      status: 'PAYING',
      execute_seq: 2,
      batch_id: batchId,
    });
    expect(await payoutJobs(f)).toEqual(
      transferJobs(f, [
        { id: first.id, seq: 1 },
        { id: second.id, seq: 1 },
        { id: returned.id, seq: 2 },
      ]),
    );
    expect(await changes(f.db, f.appId)).toHaveLength(3);
    const ofThisBatch = (await itemsOf(f)).filter((row) => row.batch_id === batchId);
    expect(ofThisBatch).toEqual(
      orderedItems([
        item(batchId, first, 'paying'),
        item(batchId, second, 'paying'),
        item(batchId, returned, 'paying'),
      ]),
    );
  });
});
