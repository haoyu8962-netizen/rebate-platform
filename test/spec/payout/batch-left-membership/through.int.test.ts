// B2-09n through rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-11 (一张单同一时刻只挂在一个
// 批次上), BR-WDR-12 (换批次，原批次记「已移出」), 编排裁定 D10-602, D10-609. A withdrawal that was never on a
// batch and stays behind is written onto that batch, so the next batch finds it there and the first one
// records moved_out; the amounts, the status and the number of transfers do not change. Requests go through
// the real admin entry and the real createPayoutExecute (../admin-payout-batch/batch-harness.ts). Expected
// values are by hand. No helper file on purpose: batch-harness.ts loads the entry by a computed name, so a
// new support file in this task's test_paths would judge every frozen test of the batch files as changed in
// the red check. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  AMOUNT,
  PLENTY,
  RICH,
  answer,
  approved,
  asMoved,
  asPaying,
  balanceOf,
  batchOf,
  changes,
  expectExecuted,
  fixture,
  item,
  itemsOf,
  movedOut,
  newKey,
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

it('[AC-B2-09n#1] 贯通：从没挂过批次的 APPROVED 单第一批 channel_disabled 留下，batch_id 是第一批、有 blocked item；开通道后第二批执行进 PAYING，batch_id 是第二批，第一批 item 记 moved_out、moved_to_batch_id 是第二批，blocked 保留；转账任务恰一个，没有转账尝试，余额、凭证、分录都不变', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    const w = await approved(f, h, who);
    await setSwitch(f, 'payout.channel_enabled.alipay', false);
    const before = await world(f);

    const first = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });

    expect(await rowOf(f, w)).toEqual(asMoved(f, w, first));
    expect(await batchOf(f, first)).toMatchObject({ kind: 'manual', created_by: h.executor.id });
    expect(await itemsOf(f)).toEqual([item(first, w, 'blocked', 'channel_disabled')]);
    expect(await payoutJobs(f)).toEqual([]);

    const left = await rowOf(f, w);
    await setSwitch(f, 'payout.channel_enabled.alipay', true);
    await seedW(f, { fen: PLENTY });

    const second = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });

    expect(second).not.toBe(first);
    expect(await rowOf(f, w)).toEqual(asPaying(f, left, second, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, w, 'blocked', 'channel_disabled'),
        movedOut(first, w, second),
        item(second, w, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: w.id, user_id: who.userId, status: 'PAYING' },
    ]);
    const after = await world(f);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.entries).toEqual(before.entries);
    expect(after.balances).toEqual(before.balances);
    expect(after.attempts).toEqual([]);
    expect(await balanceOf(f.db, f.ledger, f.appId, who.userId)).toEqual({
      available_fen: RICH - AMOUNT,
      frozen_fen: AMOUNT,
    });
  });
});

it('[AC-B2-09n#2] 连续留下：第一批挂上后第二批仍 channel_disabled → 改挂第二批，第一批记 moved_out；第三批开通后进 PAYING，第二批记 moved_out；row_version 每次只加 1，每个批次各记一次', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h));
    await setSwitch(f, 'payout.channel_enabled.alipay', false);

    const first = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });
    expect(await rowOf(f, w)).toEqual(asMoved(f, w, first));
    const onFirst = await rowOf(f, w);

    const second = await expectExecuted(await h.execute([w.id]), {
      left: [[w.id, 'channel_disabled']],
    });
    expect(await rowOf(f, w)).toEqual(asMoved(f, onFirst, second));
    const onSecond = await rowOf(f, w);

    await setSwitch(f, 'payout.channel_enabled.alipay', true);
    await seedW(f, { fen: PLENTY });
    const third = await expectExecuted(await h.execute([w.id]), { paying: [w.id] });

    expect(await rowOf(f, w)).toEqual(asPaying(f, onSecond, third, h.executor.id));
    expect((await rowOf(f, w)).row_version).toBe(w.row_version + 3);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, w, 'blocked', 'channel_disabled'),
        movedOut(first, w, second),
        item(second, w, 'blocked', 'channel_disabled'),
        movedOut(second, w, third),
        item(third, w, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, w, 1)]);
  });
});

it('[AC-B2-09n#3] 同一 Idempotency-Key 重放留下的请求：同一个 batch_id，row_version 只加 1，只有一个批次一条 item', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h), { method: 'bank_card' });
    const key = newKey();

    const first = await expectExecuted(await h.execute([w.id], { key }), {
      left: [[w.id, 'channel_disabled']],
    });
    const replay = await expectExecuted(await h.execute([w.id], { key }), {
      left: [[w.id, 'channel_disabled']],
    });

    expect(replay).toBe(first);
    expect(await rowOf(f, w)).toEqual(asMoved(f, w, first));
    expect((await world(f)).batches).toHaveLength(1);
    expect(await itemsOf(f)).toEqual([item(first, w, 'blocked', 'channel_disabled')]);
  });
});

it('[AC-B2-09n#4] 挂批次和批次、item 同一事务：写 item 失败 → 50001，batch_id、row_version 都回滚，没有批次；同一 key 重发才挂上', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const w = await approved(f, h, await payee(f, h), { method: 'bank_card' });
    const before = await world(f);
    const key = newKey();

    h.fault.point = 'items';
    const sent = await h.execute([w.id], { key });

    expect(h.fault.tripped, 'item 必须在执行事务里').toBe(1);
    await answer(sent, 50001);
    expect(await world(f)).toEqual(before);
    expect(await rowOf(f, w)).toEqual(w);

    const batchId = await expectExecuted(await h.execute([w.id], { key }), {
      left: [[w.id, 'channel_disabled']],
    });

    expect(await rowOf(f, w)).toEqual(asMoved(f, w, batchId));
    expect(await itemsOf(f)).toEqual([item(batchId, w, 'blocked', 'channel_disabled')]);
  });
});
