// B2-09n watermark rule tests (claude-independent, SPEC_REF 6f50a051): 08 BR-WDR-12 ③, BR-WDR-18, 编排裁定
// D10-288, D10-290, D10-609 规则 2 — a batch of several channels keeps a failing channel's withdrawals
// APPROVED: one with no batch is written onto this batch; one already on another batch stays where it is and
// its old batch records no moved_out. Requests go through the real admin entry and the real
// createPayoutExecute (../admin-payout-batch/batch-harness.ts). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  FORECAST,
  FORECAST_SOURCE,
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
  seedHistory,
  seedW,
  setSwitch,
  suite,
  transferJob,
  transferJobs,
  withBatchAdmin,
} from '../admin-payout-batch/batch-harness.ts';

const s = suite();

it('[AC-B2-09n#9] 规则 2 一个通道失败：alipay 足额、wechat 没有 W → 原 batch_id 为 null 的 wechat 单挂上本批；已挂别批的 wechat 单不改挂，旧批次没有 moved_out；只有 alipay 有任务和事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const alipay = await approved(f, h, who);
    const fresh = await approved(f, h, who, { method: 'wechat' });
    const old = await heldOnBatch(f, h, who, { seed: { method: 'wechat' } });
    await seedW(f, { fen: PLENTY });

    const batchId = await expectExecuted(await h.execute([alipay.id, fresh.id, old.row.id]), {
      paying: [alipay.id],
      left: [
        [fresh.id, 'watermark_stale'],
        [old.row.id, 'watermark_stale'],
      ],
    });

    expect(await rowOf(f, alipay)).toEqual(asPaying(f, alipay, batchId, h.executor.id));
    expect(await rowOf(f, old.row)).toEqual(old.row);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(old.batch.id, old.row, 'paying'),
        item(batchId, alipay, 'paying'),
        item(batchId, fresh, 'blocked', 'watermark_stale'),
        item(batchId, old.row, 'blocked', 'watermark_stale'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([transferJob(f, alipay, 1)]);
    expect(await changes(f.db, f.appId)).toEqual([
      { withdrawal_id: alipay.id, user_id: who.userId, status: 'PAYING' },
    ]);
    expect(await rowOf(f, fresh)).toEqual(asMoved(f, fresh, batchId));
  });
});

it('[AC-B2-09n#10] 规则 2 两个通道都失败：仍是 executed、paying 空；两个通道原 batch_id 为 null 的都挂上本批，已挂别批的都不改挂、没有 moved_out；没有任务和事件', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    await seedHistory(f, h, who, FORECAST_SOURCE);
    await seedW(f, { fen: BigInt(FORECAST) - 1n });
    const alipayFresh = await approved(f, h, who);
    const wechatFresh = await approved(f, h, who, { method: 'wechat' });
    const alipayOld = await heldOnBatch(f, h, who);
    const wechatOld = await heldOnBatch(f, h, who, { seed: { method: 'wechat' } });

    const batchId = await expectExecuted(
      await h.execute([alipayFresh.id, wechatFresh.id, alipayOld.row.id, wechatOld.row.id]),
      {
        paying: [],
        left: [
          [alipayFresh.id, 'watermark_below_forecast'],
          [wechatFresh.id, 'watermark_stale'],
          [alipayOld.row.id, 'watermark_below_forecast'],
          [wechatOld.row.id, 'watermark_stale'],
        ],
      },
    );

    expect(await rowOf(f, alipayOld.row)).toEqual(alipayOld.row);
    expect(await rowOf(f, wechatOld.row)).toEqual(wechatOld.row);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(alipayOld.batch.id, alipayOld.row, 'paying'),
        item(wechatOld.batch.id, wechatOld.row, 'paying'),
        item(batchId, alipayFresh, 'blocked', 'watermark_below_forecast'),
        item(batchId, wechatFresh, 'blocked', 'watermark_stale'),
        item(batchId, alipayOld.row, 'blocked', 'watermark_below_forecast'),
        item(batchId, wechatOld.row, 'blocked', 'watermark_stale'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual([]);
    expect(await changes(f.db, f.appId)).toEqual([]);
    expect(await rowOf(f, alipayFresh)).toEqual(asMoved(f, alipayFresh, batchId));
    expect(await rowOf(f, wechatFresh)).toEqual(asMoved(f, wechatFresh, batchId));
  });
});

it('[AC-B2-09n#11] 水位留下挂上本批后，W 补足再组批次：进 PAYING，batch_id 是新批次，原批次 item 记 moved_out，blocked 保留，execute_seq=1、任务恰一个', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: PLENTY });

    const first = await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id],
      left: [[wechat.id, 'watermark_stale']],
    });
    expect(await rowOf(f, wechat)).toEqual(asMoved(f, wechat, first));
    const left = await rowOf(f, wechat);

    await seedW(f, { fen: PLENTY, channel: 'wechat' });
    const second = await expectExecuted(await h.execute([wechat.id]), { paying: [wechat.id] });

    expect(await rowOf(f, wechat)).toEqual(asPaying(f, left, second, h.executor.id));
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, alipay, 'paying'),
        item(first, wechat, 'blocked', 'watermark_stale'),
        movedOut(first, wechat, second),
        item(second, wechat, 'paying'),
      ]),
    );
    expect(await payoutJobs(f)).toEqual(
      transferJobs(f, [
        { id: alipay.id, seq: 1 },
        { id: wechat.id, seq: 1 },
      ]),
    );
  });
});

it('[AC-B2-09n#12] 水位留下挂上本批后再次水位留下：已挂别批，不改挂，batch_id 仍是第一批、row_version 不再加，第一批没有 moved_out，第二批记 blocked', async () => {
  const f = fixture(s);
  await withBatchAdmin(f, async (h) => {
    const who = await payee(f, h);
    await setSwitch(f, 'payout.channel_enabled.wechat', true);
    const alipay = await approved(f, h, who);
    const wechat = await approved(f, h, who, { method: 'wechat' });
    await seedW(f, { fen: PLENTY });

    const first = await expectExecuted(await h.execute([alipay.id, wechat.id]), {
      paying: [alipay.id],
      left: [[wechat.id, 'watermark_stale']],
    });
    expect(await rowOf(f, wechat)).toEqual(asMoved(f, wechat, first));
    const left = await rowOf(f, wechat);

    const another = await approved(f, h, who);
    const second = await expectExecuted(await h.execute([another.id, wechat.id]), {
      paying: [another.id],
      left: [[wechat.id, 'watermark_stale']],
    });

    expect(await rowOf(f, wechat)).toEqual(left);
    expect(await itemsOf(f)).toEqual(
      orderedItems([
        item(first, alipay, 'paying'),
        item(first, wechat, 'blocked', 'watermark_stale'),
        item(second, another, 'paying'),
        item(second, wechat, 'blocked', 'watermark_stale'),
      ]),
    );
  });
});
