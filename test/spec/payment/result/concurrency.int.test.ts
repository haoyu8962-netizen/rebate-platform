// B2-15c real-concurrency rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04 (同一
// 通知重复到达、通知与查询同时到达，只生效一次), BR-PAY-07 (每张支付单至多一张 PAY_RECEIPT); task
// §9.4 (先取业务对象锁再重读再判断，CAS), §9.9 (两种先后 + 200 轮压力).
// Barrier: a second connection holds the business object's advisory lock (B2-15b's key); the
// notification goes through the real api entry, the query through the pay queue's handler with
// the entry's own job queue and event bus. Top-level it() only (规划/11 §4.3).
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  suite,
  track,
  untilWaiting,
  type Fixture,
  type Tracked,
} from '../orders/kit.ts';
import {
  BIZ,
  acked,
  jobKit,
  notifications,
  paidEvents,
  paidNotification,
  payJobHandler,
  queuedByKey,
  receiptOf,
  returnedQuery,
  seedPending,
  specChannels,
  tradeNo,
  vouchers,
  withNotify,
  type Delivery,
} from './kit.ts';

const s = suite();

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

it.each([
  ['notify', 'query', 'wechat_pay'],
  ['query', 'notify', 'alipay'],
] as const)(
  '[AC-B2-15c#28] 真实并发：%s 先到、%s 后到，再加一条重复通知（%s）：只迁移一次、只有一张 PAY_RECEIPT、一次开通入队、一个 pay_order.paid，通知都应答成功',
  async (first, second, channel: PayChannelCode) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    channels[channel].setTrade(
      order.out_trade_no,
      channels[channel].paid(identity[channel], order.amount_fen, trade),
    );
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      const kit = await jobKit(f, channels, { queue: h.queue, events: h.events });
      const handle = await payJobHandler(kit);
      const key = lockKey(f, order.biz_ref);
      const start = (who: 'notify' | 'query'): Tracked<Delivery | null> =>
        track(
          who === 'notify'
            ? h.deliver(channel, built.raw)
            : handle(returnedQuery(order)).then(() => null),
        );
      const [a, b, c] = await holdingBizLock(f, key, async (release) => {
        const one = start(first);
        expect(await untilWaiting(f, key, 1, [one]), `${first} waits on the lock`).toBe(true);
        const two = start(second);
        expect(await untilWaiting(f, key, 2, [one, two]), `${second} waits too`).toBe(true);
        const three = track(h.deliver(channel, built.raw));
        await pause(200);
        await release();
        return Promise.all([one.promise, two.promise, three.promise]);
      });
      for (const result of [a, b, c]) {
        if (result !== null) acked(channel, result);
      }
      expect(await payOrder(f, order.id)).toMatchObject({
        status: 'PAID',
        channel_trade_no: trade,
      });
      expect(await vouchers(f)).toEqual([receiptOf(order)]);
      expect(await paidEvents(f)).toHaveLength(1);
      expect((await notifications(f)).map((row) => row.notify_id)).toEqual([built.notifyId]);
      expect(
        (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).map((job) => job.job),
      ).toEqual(['biz.reconcile']);
    });
  },
  90_000,
);

/** Per order of the app: PAY_RECEIPT vouchers, notification rows and paid events. */
async function tallies(f: Fixture) {
  const result = await sql<{
    id: string;
    status: string;
    receipts: number;
    notes: number;
    events: number;
  }>`
    SELECT o.id::text AS id, o.status,
      (SELECT count(*)::int FROM app.ledger_vouchers v
        WHERE v.app_id = o.app_id AND v.uniq_key = 'PAY_RECEIPT:' || o.id::text) AS receipts,
      (SELECT count(*)::int FROM app.pay_notifications n
        WHERE n.app_id = o.app_id AND n.out_trade_no = o.out_trade_no) AS notes,
      (SELECT count(*)::int FROM app.event_log e
        WHERE e.app_id = o.app_id AND e.name = 'pay_order.paid'
          AND e.payload->'data'->>'pay_order_id' = o.id::text) AS events
    FROM app.pay_orders o WHERE o.app_id = ${f.subject.app_id}
    ORDER BY o.created_at, o.id`.execute(f.db);
  return result.rows;
}

it('[AC-B2-15c#29] 压力：200 轮里同一通知两次与一次主动查询同时到达（两渠道、先后轮换），每张单都只迁移一次、恰一张 PAY_RECEIPT、一份通知留存、一个 pay_order.paid，通知都应答成功', async () => {
  const f = await fixture(s);
  const { channels, identity } = specChannels(f);
  await withNotify(f, channels, async (h) => {
    const kit = await jobKit(f, channels, { queue: h.queue, events: h.events });
    const handle = await payJobHandler(kit);
    for (let round = 0; round < 200; round += 1) {
      const channel: PayChannelCode = round % 2 === 0 ? 'wechat_pay' : 'alipay';
      const order = await seedPending(f, channel, { amount_fen: BigInt(100 + round) });
      const trade = tradeNo(channel);
      channels[channel].setTrade(
        order.out_trade_no,
        channels[channel].paid(identity[channel], order.amount_fen, trade),
      );
      const built = paidNotification(channels, identity[channel], order, {
        channelTradeNo: trade,
      });
      const ops: (() => Promise<Delivery | null>)[] = [
        () => h.deliver(channel, built.raw),
        () => handle(returnedQuery(order)).then(() => null),
        () => h.deliver(channel, built.raw),
      ];
      const shift = round % ops.length;
      const ordered = [...ops.slice(shift), ...ops.slice(0, shift)];
      const results = await Promise.all(ordered.map((op) => op()));
      for (const result of results) {
        if (result !== null) acked(channel, result);
      }
    }
    const rows = await tallies(f);
    expect(rows).toHaveLength(200);
    const wrong = rows.filter(
      (row) => row.status !== 'PAID' || row.receipts !== 1 || row.notes !== 1 || row.events !== 1,
    );
    expect(wrong).toEqual([]);
    expect(await vouchers(f)).toHaveLength(200);
  });
}, 300_000);
