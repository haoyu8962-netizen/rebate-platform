// B2-15c active query rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04 (主动查询
// 走同一套核对、查询节奏 pay.query_schedule、持久化队列任务), BR-PAY-07; task §9.4, §9.5;
// D-PAY-11 (queue pay, job order.query, singletonKey order.query:<pay_order_id>:<档位>).
// The pay queue's handler (createPayJobHandler) runs here over the fixture's database with the
// spec channels; the first scheduled query comes from a real order placement through the api
// entry (B2-15b's route, FakePayChannel). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createBody,
  enable,
  fixture,
  payOrder,
  setConfig,
  success,
  suite,
  withHttp,
  type Fixture,
  type OrderRow,
} from '../orders/kit.ts';
import {
  AMOUNT,
  BIZ,
  CHANNELS,
  NOT_PAID,
  SUCCESS,
  alertsMentioning,
  attemptsOf,
  jobKit,
  newIdentity,
  payJobHandler,
  queuedByKey,
  receiptOf,
  received,
  returnedQuery,
  seedPending,
  sends,
  specChannels,
  tradeNo,
  untouched,
  vouchers,
  type QueuedJob,
  type SpecTrade,
} from './kit.ts';

const s = suite();

/** A wechat_pay order placed through the api entry, and its first scheduled query job. */
async function placed(f: Fixture): Promise<{ order: OrderRow; first: QueuedJob }> {
  await enable(f);
  let id = '';
  await withHttp(f, async (send) => {
    const data = await success(
      await send('create', { body: createBody(randomUUID(), 'wechat_pay') }),
    );
    id = String(data['pay_order_id']);
  });
  const order = await payOrder(f, id);
  const scheduled = (await queuedByKey(f, `order.query:${id}:`)).filter(
    (job) => job.singleton_key !== `order.query:${id}:returned`,
  );
  expect(
    scheduled.map((job) => job.job),
    'the first scheduled query',
  ).toEqual(['order.query']);
  const first = scheduled[0]!;
  expect(first.payload).not.toBeNull();
  return { order, first };
}

function notPaid(identity: SpecTrade['identity']): SpecTrade {
  return {
    state: 'not_paid',
    channelState: NOT_PAID.wechat_pay,
    amountFen: null,
    channelTradeNo: null,
    identity,
  };
}

it.each(CHANNELS)(
  '[AC-B2-15c#18] %s 主动查询结果合格（客户端返回触发）：与通知同一套核对与结算，PO2 + 恰一张 PAY_RECEIPT + 同事务入队开通与 pay_order.paid，记录查询尝试；再查一次不重复',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    channels[channel].setTrade(
      order.out_trade_no,
      channels[channel].paid(identity[channel], AMOUNT, trade),
    );
    f.clock.advanceMs(20_000);
    const kit = await jobKit(f, channels);
    const handle = await payJobHandler(kit);
    await handle(returnedQuery(order));
    expect(channels[channel].queried).toEqual([order.out_trade_no]);
    expect(await payOrder(f, order.id)).toMatchObject({
      ...untouched(order),
      status: 'PAID',
      paid_at: expect.any(Date),
      channel_trade_no: trade,
      closing: false,
    });
    expect(await vouchers(f)).toEqual([receiptOf(order)]);
    const attempts = await attemptsOf(f, order.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ kind: 'query', pay_refund_id: null, at: f.clock.now() });
    expect(attempts[0]?.result).toEqual(expect.any(String));
    expect(
      sends(kit, 'biz.reconcile').map((job) => [
        job.queue,
        job.options.singletonKey,
        job.inTransaction,
      ]),
    ).toEqual([['pay', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`, true]]);
    expect(kit.published.map((p) => [p.event.name, p.event.appId, p.inTransaction])).toEqual([
      ['pay_order.paid', f.subject.app_id, true],
    ]);
    expect(kit.published[0]?.event.payload).toMatchObject({ pay_order_id: order.id });

    f.clock.advanceMs(20_000);
    await handle(returnedQuery(order));
    expect(await vouchers(f)).toEqual([receiptOf(order)]);
    expect(sends(kit, 'biz.reconcile')).toHaveLength(1);
    expect(kit.published).toHaveLength(1);
    expect((await payOrder(f, order.id)).channel_trade_no).toBe(trade);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#19] %s 查询结果核对不过（金额不符、状态不在清单、标识不是我方、渠道没报状态或标识）：不迁移、不记账、不开通，记录尝试并告警',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const spec = channels[channel];
    const variants: [string, (trade: string) => SpecTrade][] = [
      ['amount', (trade) => spec.paid(identity[channel], AMOUNT - 1n, trade)],
      [
        'state',
        (trade) =>
          spec.paid(
            identity[channel],
            AMOUNT,
            trade,
            channel === 'alipay' ? 'TRADE_FINISHED' : 'REFUND',
          ),
      ],
      ['identity', (trade) => spec.paid(newIdentity(channel), AMOUNT, trade)],
      [
        'bare',
        (trade) => ({
          state: 'paid',
          channelState: SUCCESS[channel],
          amountFen: AMOUNT,
          channelTradeNo: trade,
          identity: null,
        }),
      ],
    ];
    const kit = await jobKit(f, channels);
    const handle = await payJobHandler(kit);
    for (const [name, trade] of variants) {
      const order = await seedPending(f, channel);
      spec.setTrade(order.out_trade_no, trade(tradeNo(channel)));
      await handle(returnedQuery(order));
      expect(await payOrder(f, order.id), name).toMatchObject(untouched(order));
      expect(await attemptsOf(f, order.id), name).toHaveLength(1);
      expect(
        alertsMentioning(kit.logs, [order.id, order.out_trade_no]).length,
        name,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(await vouchers(f)).toEqual([]);
    expect(sends(kit, 'biz.reconcile')).toEqual([]);
    expect(kit.published).toEqual([]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#20] %s 查询为未支付、单据不存在或渠道超时（结果未知）：支付单保持 PENDING，只记录查询尝试',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = specChannels(f);
    const spec = channels[channel];
    const kit = await jobKit(f, channels);
    const handle = await payJobHandler(kit);
    const unpaid = await seedPending(f, channel);
    spec.setTrade(unpaid.out_trade_no, {
      state: 'not_paid',
      channelState: NOT_PAID[channel],
      amountFen: null,
      channelTradeNo: null,
      identity: identity[channel],
    });
    const missing = await seedPending(f, channel);
    const timeout = await seedPending(f, channel);
    spec.setTrade(timeout.out_trade_no, 'timeout');
    await handle(returnedQuery(unpaid));
    await handle(returnedQuery(missing));
    // An unknown answer may fail the job so that the queue retries it; either way nothing moves.
    await handle(returnedQuery(timeout)).catch(() => undefined);
    for (const order of [unpaid, missing, timeout]) {
      expect(await payOrder(f, order.id)).toMatchObject(untouched(order));
      expect(await attemptsOf(f, order.id)).toHaveLength(1);
    }
    expect(spec.queried).toEqual([unpaid.out_trade_no, missing.out_trade_no, timeout.out_trade_no]);
    expect(await vouchers(f)).toEqual([]);
    expect(sends(kit, 'biz.reconcile')).toEqual([]);
    expect(kit.published).toEqual([]);
  },
  60_000,
);

it('[AC-B2-15c#21] 下单成功即入队首次定时查询（创建后 10 秒，pgboss 持久化）；每档执行完仍 PENDING 就按创建时刻入队下一档（30 秒、1 分、3 分、10 分、expire_at）；expire_at 那次查询后交给关单任务', async () => {
  const f = await fixture(s);
  const { order, first } = await placed(f);
  expect(Math.round(first.delay)).toBe(10);
  const { channels, identity } = specChannels(f);
  channels.wechat_pay.setTrade(order.out_trade_no, notPaid(identity.wechat_pay));
  const kit = await jobKit(f, channels);
  const handle = await payJobHandler(kit);
  const created = order.created_at.getTime();
  const keys = new Set<string>([first.singleton_key ?? '']);
  let job = received('order.query', first.payload!);
  for (const [at, next] of [
    [10, 30],
    [30, 60],
    [60, 180],
    [180, 600],
    [600, 900],
  ] as const) {
    f.clock.set(new Date(created + at * 1000));
    const before = kit.sent.length;
    await handle(job);
    const fresh = kit.sent.slice(before);
    expect(
      fresh.map((sent) => [sent.queue, sent.name]),
      `at ${at}s`,
    ).toEqual([['pay', 'order.query']]);
    const sent = fresh[0]!;
    expect(sent.options.delaySeconds, `at ${at}s`).toBe(next - at);
    const key = sent.options.singletonKey ?? '';
    expect(key.startsWith(`order.query:${order.id}:`), key).toBe(true);
    expect(keys.has(key), key).toBe(false);
    expect(key).not.toBe(`order.query:${order.id}:returned`);
    keys.add(key);
    job = received(sent.name, sent.payload);
  }
  f.clock.set(order.expire_at);
  const before = kit.sent.length;
  await handle(job);
  expect(
    kit.sent.slice(before).map((sent) => [sent.queue, sent.name, sent.options.singletonKey]),
  ).toEqual([['pay', 'order.close', `order.close:${order.id}`]]);
  expect(channels.wechat_pay.queried).toHaveLength(6);
  expect((await payOrder(f, order.id)).status).toBe('PENDING');
  // The placement's own prepay attempt, then one row per query.
  expect(await attemptsOf(f, order.id)).toHaveLength(7);
}, 90_000);

it('[AC-B2-15c#22] pay.query_schedule 可覆盖；定时查询晚到时下一档仍按创建时刻算，已错过的档不补', async () => {
  const f = await fixture(s);
  await setConfig(f, 'pay.query_schedule', [5, 20, 40]);
  const { order, first } = await placed(f);
  expect(Math.round(first.delay)).toBe(5);
  const { channels, identity } = specChannels(f);
  channels.wechat_pay.setTrade(order.out_trade_no, notPaid(identity.wechat_pay));
  const kit = await jobKit(f, channels);
  const handle = await payJobHandler(kit);
  const created = order.created_at.getTime();
  // Due at 5 s, runs at 27 s: the 20 s slot is gone, the next one is 40 s.
  f.clock.set(new Date(created + 27_000));
  await handle(received('order.query', first.payload!));
  const second = sends(kit, 'order.query');
  expect(second.map((sent) => sent.options.delaySeconds)).toEqual([13]);
  f.clock.set(new Date(created + 40_000));
  await handle(received('order.query', second[0]!.payload));
  const third = sends(kit, 'order.query');
  expect(third.map((sent) => sent.options.delaySeconds)).toEqual([13, 860]);
  expect(sends(kit, 'order.close')).toEqual([]);
}, 90_000);

it('[AC-B2-15c#23] 定时查询查到已支付即结算且不再入队下一档；同一档定时任务重复执行也不重复结算、不入队', async () => {
  const f = await fixture(s);
  const { order, first } = await placed(f);
  const { channels, identity } = specChannels(f);
  const trade = tradeNo('wechat_pay');
  channels.wechat_pay.setTrade(
    order.out_trade_no,
    channels.wechat_pay.paid(identity.wechat_pay, order.amount_fen, trade),
  );
  const kit = await jobKit(f, channels);
  const handle = await payJobHandler(kit);
  f.clock.set(new Date(order.created_at.getTime() + 10_000));
  await handle(received('order.query', first.payload!));
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', channel_trade_no: trade });
  expect(await vouchers(f)).toEqual([receiptOf(order)]);
  expect(sends(kit, 'order.query')).toEqual([]);
  expect(sends(kit, 'order.close')).toEqual([]);
  expect(sends(kit, 'biz.reconcile')).toHaveLength(1);
  f.clock.set(new Date(order.created_at.getTime() + 30_000));
  await handle(received('order.query', first.payload!));
  expect(await vouchers(f)).toEqual([receiptOf(order)]);
  expect(kit.sent.map((sent) => sent.name)).toEqual(['biz.reconcile']);
  expect(kit.published).toHaveLength(1);
}, 90_000);
