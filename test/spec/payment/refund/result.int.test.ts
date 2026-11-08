// B2-15e result rule tests (claude-independent, SPEC_REF c4cfc1a2): 08 BR-PAY-06 ④ (只认验签通过的
// 退款通知或主动查询，两者走同一个处理器；逐项核对应用与商户标识、退款单号、原单、渠道、金额、状态
// 清单；任一不符不迁移、继续占用额度、记录并告警) and ⑤ (SUCCESS 同一事务：退款单 CAS、refunded_fen、
// 退款凭证、回收任务；FAILED 释放额度；未知只查询), 细则 (refund_fail_states 验证前为空); BR-PAY-07
// (PAY_REFUND 借 PAY_RECEIPTS:{biz_type} / 贷 CASH_PAY:{pay_channel}；对异常收款写反向 PAY_ANOMALY；
// 不得出现 USER_BALANCE；PAY_SUSPENSE 余额 = 未退完的异常收款合计); 02 §11 pay_refund.succeeded
// (D10-349: 回收走 pay 队列 biz.reconcile); AC-S2-82 ⑮ (全额退款成功后旧开通任务重试，权益仍为退款后
// 的结果); D10-351 ① (对异常收款退款成功：不规定入不入队回收任务，只断言业务对象的开通结果不变).
// Refund rows are seeded as B2-15e's creation leaves them (kit.ts seedRefund); notifications
// go through the api entry's /notify/pay/<channel> (../result/kit.ts withNotify), queries through
// the pay queue's handler with job refund.query. Top-level it() only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayRawNotification } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { fixture, payOrder, setConfig, suite, type Fixture, type OrderRow } from '../orders/kit.ts';
import {
  BIZ,
  acked,
  alertsMentioning,
  fulfillments,
  nacked,
  newIdentity,
  queued,
  queuedByKey,
  received,
  sends,
  userTraces,
  vouchers,
  withNotify,
} from '../result/kit.ts';
import {
  AMOUNT,
  CHANNELS,
  CLOSED_STATE,
  NOT_LISTED,
  REFUND_EVENT,
  REFUND_SUCCESS,
  anomalyRow,
  channelRefundNo,
  created,
  orderRefundNotice,
  refundAttempts,
  refundBody,
  refundChannels,
  refundEvents,
  refundJobs,
  refundNotifications,
  refundQueryJob,
  refundRow,
  refundVoucherOf,
  refundedAnswer,
  reverseAnomalyEntries,
  seedAnomaly,
  seedPaid,
  seedRefund,
  seededRefundNo,
  settled,
  subjectBalance,
  voucherShape,
  withAdmin,
  type RefundChannels,
  type RefundRow,
} from './kit.ts';

const s = suite();

/** A PAID order and a PROCESSING refund of 5 000 fen of it, on the channel. */
async function processing(
  f: Fixture,
  channels: RefundChannels,
  channel: PayChannelCode,
): Promise<{ order: OrderRow; refund: RefundRow }> {
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, channel);
  const refund = await seedRefund(f, { type: 'pay_order', id: order.id }, { amount_fen: 5_000n });
  f.clock.advanceMs(60_000);
  return { order, refund };
}

/** biz.reconcile jobs of the fixture app in pgboss (the payload names the app). */
async function recoveryJobs(f: Fixture) {
  return (await queued(f, f.subject.app_id)).filter((job) => job.job === 'biz.reconcile');
}

/**
 * The entitlement of every business object of the app (pay_fulfillments without version and
 * applied_at, which every biz.reconcile run sets); a `none` row is the same as no row.
 */
async function entitlements(f: Fixture) {
  return (await fulfillments(f))
    .filter((row) => row.state !== 'none')
    .map((row) => ({
      biz_type: row.biz_type,
      biz_ref: row.biz_ref,
      state: row.state,
      last_pay_order_id: row.last_pay_order_id,
      refunded_fen: row.refunded_fen,
    }))
    .sort((a, b) => (a.biz_ref < b.biz_ref ? -1 : a.biz_ref > b.biz_ref ? 1 : 0));
}

/** What a refund that did not move still looks like. */
function unmoved(refund: RefundRow) {
  return {
    id: refund.id,
    status: 'PROCESSING',
    amount_fen: refund.amount_fen,
    out_refund_no: refund.out_refund_no,
    channel_refund_no: null,
    succeeded_at: null,
    failed_at: null,
  };
}

/** Nothing of a SUCCESS happened: no PAY_REFUND, recovery job or event; refunded_fen as before. */
async function nothingBooked(f: Fixture, order: OrderRow): Promise<void> {
  expect((await vouchers(f)).map((v) => v.voucher_kind)).toEqual(['PAY_RECEIPT']);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
  expect(await refundEvents(f)).toEqual([]);
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 0n });
}

it.each(CHANNELS)(
  '[AC-B2-15e#13] %s 验签通过、逐项核对通过、状态属于 refund_success_states 的退款通知：同一事务退款单 CAS → SUCCESS、支付单 refunded_fen 加本次（状态仍 PAID）、恰一张 PAY_REFUND（借 PAY_RECEIPTS / 贷 CASH_PAY）、入队 biz.reconcile、发 pay_refund.succeeded；通知留存；应答成功；无用户侧分录',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { order, refund } = await processing(f, channels, channel);
    const refundNo = channelRefundNo(channel);
    await withNotify(f, channels, async (h) => {
      const built = channels[channel].refundNotification(
        orderRefundNotice(identity[channel], order, refund, { channelRefundNo: refundNo }),
      );
      acked(channel, await h.deliver(channel, built.raw));
    });
    expect(await refundRow(f, refund.id)).toMatchObject({
      status: 'SUCCESS',
      succeeded_at: f.clock.now(),
      failed_at: null,
      channel_refund_no: refundNo,
      amount_fen: refund.amount_fen,
      out_refund_no: refund.out_refund_no,
    });
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PAID',
      amount_fen: AMOUNT,
      refunded_fen: refund.amount_fen,
      paid_at: order.paid_at,
      channel_trade_no: order.channel_trade_no,
    });
    const books = await vouchers(f);
    expect(books.map((v) => v.voucher_kind)).toEqual(['PAY_RECEIPT', 'PAY_REFUND']);
    expect(voucherShape(books[1]!)).toEqual(refundVoucherOf(order, refund));
    expect(await subjectBalance(f, `CASH_PAY:${channel}`)).toBe(AMOUNT - refund.amount_fen);
    expect(await subjectBalance(f, `PAY_RECEIPTS:${BIZ}`)).toBe(refund.amount_fen - AMOUNT);
    const recovery = await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`);
    expect(recovery.map((job) => job.job)).toEqual(['biz.reconcile']);
    expect(recovery[0]?.payload).toMatchObject({
      app_id: f.subject.app_id,
      biz_type: BIZ,
      biz_ref: order.biz_ref,
    });
    const events = await refundEvents(f);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain(refund.id);
    expect(await refundNotifications(f, refund.out_refund_no)).toHaveLength(1);
    expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
);

it('[AC-B2-15e#14] 同一退款通知重复到达、换通知标识再到、之后再查到成功：只生效一次（一张凭证、一个事件、refunded_fen 只加一次、成功时刻不变），重复的都应答成功', async () => {
  const f = await fixture(s);
  const { channels, identity } = refundChannels(f);
  const { order, refund } = await processing(f, channels, 'wechat_pay');
  const notice = orderRefundNotice(identity.wechat_pay, order, refund);
  const first = channels.wechat_pay.refundNotification(notice);
  let succeededAt: Date | null = null;
  await withNotify(f, channels, async (h) => {
    acked('wechat_pay', await h.deliver('wechat_pay', first.raw));
    succeededAt = f.clock.now();
    f.clock.advanceMs(10_000);
    acked('wechat_pay', await h.deliver('wechat_pay', first.raw));
    const again = channels.wechat_pay.refundNotification(notice);
    acked('wechat_pay', await h.deliver('wechat_pay', again.raw));
  });
  channels.wechat_pay.setRefund(
    refund.out_refund_no,
    refundedAnswer(identity.wechat_pay, refund, order_(order), 'wechat_pay'),
  );
  const { kit, handle } = await refundJobs(f, channels);
  await settled(handle(refundQueryJob(f, refund)));
  expect(await refundRow(f, refund.id)).toMatchObject({
    status: 'SUCCESS',
    succeeded_at: succeededAt,
  });
  expect(await payOrder(f, order.id)).toMatchObject({ refunded_fen: refund.amount_fen });
  expect((await vouchers(f)).filter((v) => v.voucher_kind === 'PAY_REFUND')).toHaveLength(1);
  expect(await refundEvents(f)).toHaveLength(1);
  expect(sends(kit, 'biz.reconcile')).toEqual([]);
  expect(kit.published).toEqual([]);
  expect(channels.wechat_pay.submitted).toEqual([]);
});

/** The original's numbers of an order, as a refund answer names them. */
function order_(order: OrderRow) {
  return { outTradeNo: order.out_trade_no, channelTradeNo: order.channel_trade_no ?? '' };
}

/** What a mismatch case delivers, on which route, naming which refund number. */
interface Sent {
  readonly deliverOn: PayChannelCode;
  readonly raw: PayRawNotification;
  readonly outRefundNo: string;
}

type MismatchCase = readonly [
  label: string,
  channel: PayChannelCode,
  build: (
    f: Fixture,
    channels: RefundChannels,
    identity: Record<PayChannelCode, ReturnType<typeof newIdentity>>,
    order: OrderRow,
    refund: RefundRow,
    other: OrderRow,
  ) => Sent,
];

const MISMATCHES: readonly MismatchCase[] = [
  [
    '退款单号不是我方退款单',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const outRefundNo = seededRefundNo();
      const built = channels.wechat_pay.refundNotification(
        orderRefundNotice(identity.wechat_pay, order, refund, { outRefundNo }),
      );
      return { deliverOn: 'wechat_pay', raw: built.raw, outRefundNo };
    },
  ],
  [
    '原支付的商户单号是另一张单',
    'alipay',
    (_f, channels, identity, order, refund, other) => {
      const built = channels.alipay.refundNotification(
        orderRefundNotice(identity.alipay, order, refund, {
          outTradeNo: other.out_trade_no,
          channelTradeNo: other.channel_trade_no ?? '',
        }),
      );
      return { deliverOn: 'alipay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '商户单号一致但渠道交易号不一致',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const built = channels.wechat_pay.refundNotification(
        orderRefundNotice(identity.wechat_pay, order, refund, {
          channelTradeNo: `4200${randomBytes(12).toString('hex')}`,
        }),
      );
      return { deliverOn: 'wechat_pay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '渠道与退款单不一致（微信的退款单出现在支付宝的通知里）',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const built = channels.alipay.refundNotification(
        orderRefundNotice(identity.alipay, order, refund, { state: REFUND_SUCCESS.alipay }),
      );
      return { deliverOn: 'alipay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '退款金额少一分',
    'alipay',
    (_f, channels, identity, order, refund) => {
      const built = channels.alipay.refundNotification(
        orderRefundNotice(identity.alipay, order, refund, { refundFen: refund.amount_fen - 1n }),
      );
      return { deliverOn: 'alipay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '退款金额多一分',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const built = channels.wechat_pay.refundNotification(
        orderRefundNotice(identity.wechat_pay, order, refund, {
          refundFen: refund.amount_fen + 1n,
        }),
      );
      return { deliverOn: 'wechat_pay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '状态不在任何清单（微信 ABNORMAL）',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const built = channels.wechat_pay.refundNotification(
        orderRefundNotice(identity.wechat_pay, order, refund, { state: NOT_LISTED.wechat_pay }),
      );
      return { deliverOn: 'wechat_pay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '失败样的状态在 refund_fail_states 验证前为空时不算失败（支付宝 REFUND_CLOSED）',
    'alipay',
    (_f, channels, identity, order, refund) => {
      const built = channels.alipay.refundNotification(
        orderRefundNotice(identity.alipay, order, refund, { state: CLOSED_STATE.alipay }),
      );
      return { deliverOn: 'alipay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
  [
    '失败样的状态在 refund_fail_states 验证前为空时不算失败（微信 CLOSED）',
    'wechat_pay',
    (_f, channels, identity, order, refund) => {
      const built = channels.wechat_pay.refundNotification(
        orderRefundNotice(identity.wechat_pay, order, refund, { state: CLOSED_STATE.wechat_pay }),
      );
      return { deliverOn: 'wechat_pay', raw: built.raw, outRefundNo: refund.out_refund_no };
    },
  ],
];

it.each(MISMATCHES)(
  '[AC-B2-15e#15] 退款通知核对不符：%s → 不迁移、继续占额（仍 PROCESSING）、不记账不入队不发事件、通知留存、告警带退款单号、应答不成功',
  async (label, channel, build) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { order, refund } = await processing(f, channels, channel);
    const { kit } = await refundJobs(f, channels);
    const other = await seedPaid(f, kit, channel);
    const sent = build(f, channels, identity, order, refund, other);
    let logs: string[] = [];
    await withNotify(f, channels, async (h) => {
      nacked(sent.deliverOn, await h.deliver(sent.deliverOn, sent.raw));
      logs = h.logs;
    });
    expect(await refundRow(f, refund.id), label).toMatchObject(unmoved(refund));
    expect((await vouchers(f)).map((v) => v.voucher_kind)).toEqual(['PAY_RECEIPT', 'PAY_RECEIPT']);
    expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
    expect(await refundEvents(f)).toEqual([]);
    expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 0n });
    expect(await refundNotifications(f, sent.outRefundNo), 'the notification is kept').toHaveLength(
      1,
    );
    expect(
      alertsMentioning(logs, [sent.outRefundNo, refund.id]).length,
      'an alert naming the refund',
    ).toBeGreaterThan(0);
  },
);

it('[AC-B2-15e#16] 验签失败或应用 / 商户标识不是我方的退款通知：拒绝、不留业务痕迹；随后合格的通知照常生效', async () => {
  const f = await fixture(s);
  const { channels, identity } = refundChannels(f);
  const { order, refund } = await processing(f, channels, 'alipay');
  await withNotify(f, channels, async (h) => {
    const genuine = channels.alipay.refundNotification(
      orderRefundNotice(identity.alipay, order, refund),
    );
    nacked('alipay', await h.deliver('alipay', channels.alipay.forgeRefund(genuine)));
    const stranger = channels.alipay.refundNotification(
      orderRefundNotice(newIdentity('alipay'), order, refund),
    );
    nacked('alipay', await h.deliver('alipay', stranger.raw));
    expect(await refundNotifications(f, refund.out_refund_no)).toEqual([]);
    expect(await refundRow(f, refund.id)).toMatchObject(unmoved(refund));
    acked('alipay', await h.deliver('alipay', genuine.raw));
  });
  expect(await refundRow(f, refund.id)).toMatchObject({ status: 'SUCCESS' });
  expect(await payOrder(f, order.id)).toMatchObject({ refunded_fen: refund.amount_fen });
});

it.each(CHANNELS)(
  '[AC-B2-15e#17] %s refund_fail_states 配置了失败状态后：该状态的合格通知使退款单 → FAILED（不记账、不回收、不发事件），占用的额度释放，同一支付单可再全额退款',
  async (channel) => {
    const f = await fixture(s);
    await setConfig(f, `pay.${channel}.refund_fail_states`, [CLOSED_STATE[channel]]);
    const { channels, identity } = refundChannels(f);
    const { order, refund } = await processing(f, channels, channel);
    await withNotify(f, channels, async (h) => {
      const built = channels[channel].refundNotification(
        orderRefundNotice(identity[channel], order, refund, { state: CLOSED_STATE[channel] }),
      );
      acked(channel, await h.deliver(channel, built.raw));
    });
    expect(await refundRow(f, refund.id)).toMatchObject({
      status: 'FAILED',
      failed_at: f.clock.now(),
      succeeded_at: null,
    });
    await nothingBooked(f, order);
    await withAdmin(f, channels, async (h) => {
      const data = await created(
        await h.refund({ type: 'pay_order', id: order.id }, refundBody(AMOUNT)),
      );
      expect(data).toMatchObject({ amount_fen: Number(AMOUNT), status: 'PROCESSING' });
    });
  },
);

it.each([
  ['找不到我方支付单的异常收款，全额退回', false, 1_900n, 1_900n],
  ['关闭后收到钱的异常收款，部分退回', true, 12_345n, 1_000n],
] as const)(
  '[AC-B2-15e#18] %s：退款成功时写反向 PAY_ANOMALY（借 PAY_SUSPENSE / 贷 CASH_PAY，一张退款单一张）、异常收款 refunded_fen 加本次（退完为 refunded）、PAY_SUSPENSE 余额 = 未退完金额；不写 PAY_REFUND；业务对象的开通结果（pay_fulfillments）在退款成功前后不变——入不入队回收任务均可，入队的 biz.reconcile 跑完后仍不变（D10-351 ①；关闭单的业务对象另有已开通的 PAID 单时仍为开通）',
  async (label, withOrder, receivedFen, refundFen) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { kit, handle } = await refundJobs(f, channels);
    const { anomaly, order: closed } = await seedAnomaly(f, kit, 'wechat_pay', {
      withOrder,
      amountFen: receivedFen,
    });
    if (closed !== null) {
      // The same business object was paid again on a new order and is fulfilled.
      const paid = await seedPaid(f, kit, 'wechat_pay', {
        biz_type: closed.biz_type,
        biz_ref: closed.biz_ref,
      });
      await handle(
        received('biz.reconcile', {
          app_id: f.subject.app_id,
          biz_type: paid.biz_type,
          biz_ref: paid.biz_ref,
          pay_order_id: paid.id,
        }),
      );
      expect((await entitlements(f)).map((row) => row.state)).toEqual(['active']);
    }
    const before = await entitlements(f);
    const refund = await seedRefund(
      f,
      { type: 'pay_anomaly', id: anomaly.id },
      { amount_fen: refundFen, reason_code: 'ANOMALY_RECEIPT' },
    );
    f.clock.advanceMs(60_000);
    await withNotify(f, channels, async (h) => {
      const built = channels.wechat_pay.refundNotification({
        identity: identity.wechat_pay,
        outRefundNo: refund.out_refund_no,
        outTradeNo: anomaly.out_trade_no,
        channelTradeNo: anomaly.channel_trade_no,
        totalFen: anomaly.amount_fen,
        refundFen,
        state: REFUND_SUCCESS.wechat_pay,
      });
      acked('wechat_pay', await h.deliver('wechat_pay', built.raw));
    });
    expect(await refundRow(f, refund.id), label).toMatchObject({
      status: 'SUCCESS',
      succeeded_at: f.clock.now(),
    });
    const full = refundFen === receivedFen;
    expect(await anomalyRow(f, anomaly.id)).toMatchObject({
      refunded_fen: refundFen,
      status: full ? 'refunded' : 'open',
    });
    const books = (await vouchers(f)).filter((v) => v.voucher_kind === 'PAY_ANOMALY');
    expect(books).toHaveLength(2);
    const reverse = books.find((v) => v.uniq_key !== `PAY_ANOMALY:${anomaly.id}`);
    expect(reverse?.uniq_key, 'one reverse voucher per refund').toContain(refund.id);
    expect(reverse?.entries).toEqual(reverseAnomalyEntries(anomaly, refund));
    expect((await vouchers(f)).some((v) => v.voucher_kind === 'PAY_REFUND')).toBe(false);
    expect(await subjectBalance(f, 'PAY_SUSPENSE')).toBe(refundFen - receivedFen);
    // 08 BR-PAY-06 ⑤ does not tell refund targets apart: a recovery job may be enqueued; what
    // must hold is the result, after every biz.reconcile job queued for the app has run.
    expect(await entitlements(f)).toEqual(before);
    for (const job of await recoveryJobs(f)) {
      await settled(handle(received('biz.reconcile', job.payload ?? {})));
    }
    expect(await entitlements(f)).toEqual(before);
    expect(await refundEvents(f)).toHaveLength(1);
    expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
);

it.each(CHANNELS)(
  '[AC-B2-15e#19] %s 主动查询（任务 refund.query）走同一处理器：查到成功 → 与通知相同的同事务结果（CAS、refunded_fen、PAY_REFUND、同事务入队 biz.reconcile 与发 pay_refund.succeeded），记一条 refund_query 渠道请求，不重提退款',
  async (channel) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { order, refund } = await processing(f, channels, channel);
    const answerNo = channelRefundNo(channel);
    channels[channel].setRefund(
      refund.out_refund_no,
      refundedAnswer(identity[channel], refund, order_(order), channel, {
        channelRefundNo: answerNo,
      }),
    );
    const { kit, handle } = await refundJobs(f, channels);
    expect(await settled(handle(refundQueryJob(f, refund)))).toBe('resolved');
    expect(channels[channel].refundQueried).toEqual([refund.out_refund_no]);
    expect(channels[channel].submitted).toEqual([]);
    expect(await refundRow(f, refund.id)).toMatchObject({
      status: 'SUCCESS',
      succeeded_at: f.clock.now(),
      channel_refund_no: answerNo,
    });
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PAID',
      refunded_fen: refund.amount_fen,
    });
    const books = await vouchers(f);
    expect(books.map((v) => voucherShape(v))).toContainEqual(refundVoucherOf(order, refund));
    const attempts = await refundAttempts(f, refund.id);
    expect(attempts.map((a) => [a.kind, a.pay_order_id, a.at])).toEqual([
      ['refund_query', null, f.clock.now()],
    ]);
    expect(
      sends(kit, 'biz.reconcile').map((job) => [
        job.queue,
        job.options.singletonKey,
        job.inTransaction,
      ]),
    ).toEqual([['pay', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`, true]]);
    expect(kit.published.map((p) => [p.event.name, p.event.appId, p.inTransaction])).toEqual([
      [REFUND_EVENT, f.subject.app_id, true],
    ]);
    expect(JSON.stringify(kit.published[0]?.event.payload)).toContain(refund.id);
  },
);

it.each([
  ['查询超时（结果未知）', 'timeout'],
  ['渠道答「退款不存在」', 'not_exist'],
  ['状态不在清单', 'not_listed'],
  ['应答不带应用与商户标识', 'no_identity'],
  ['金额不等', 'amount'],
] as const)(
  '[AC-B2-15e#20] 主动查询无定论：%s → 退款单不迁移、继续占额，记一条 refund_query 渠道请求，不用同一退款单号重提、不记账不入队不发事件',
  async (label, kind) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { order, refund } = await processing(f, channels, 'wechat_pay');
    const answerOf = refundedAnswer(identity.wechat_pay, refund, order_(order), 'wechat_pay');
    if (kind === 'timeout') channels.wechat_pay.setRefund(refund.out_refund_no, 'timeout');
    if (kind === 'not_listed') {
      channels.wechat_pay.setRefund(refund.out_refund_no, {
        ...answerOf,
        channelState: NOT_LISTED.wechat_pay,
      });
    }
    if (kind === 'no_identity') {
      channels.wechat_pay.setRefund(refund.out_refund_no, { ...answerOf, identity: null });
    }
    if (kind === 'amount') {
      channels.wechat_pay.setRefund(refund.out_refund_no, {
        ...answerOf,
        refundFen: refund.amount_fen - 1n,
      });
    }
    const { kit, handle } = await refundJobs(f, channels);
    await settled(handle(refundQueryJob(f, refund)));
    expect(await refundRow(f, refund.id), label).toMatchObject(unmoved(refund));
    expect(channels.wechat_pay.refundQueried).toEqual([refund.out_refund_no]);
    expect(channels.wechat_pay.submitted).toEqual([]);
    expect((await refundAttempts(f, refund.id)).map((a) => a.kind)).toEqual(['refund_query']);
    expect(sends(kit, 'biz.reconcile')).toEqual([]);
    expect(kit.published).toEqual([]);
    await nothingBooked(f, order);
  },
);

it('[AC-B2-15e#21] 退款通知与主动查询并发到达：只生效一次（一次 CAS、一张凭证、一个事件、refunded_fen 只加一次）', async () => {
  const f = await fixture(s);
  const { channels, identity } = refundChannels(f);
  const { order, refund } = await processing(f, channels, 'alipay');
  channels.alipay.setRefund(
    refund.out_refund_no,
    refundedAnswer(identity.alipay, refund, order_(order), 'alipay'),
  );
  await withNotify(f, channels, async (h) => {
    const { handle } = await refundJobs(f, channels, { queue: h.queue, events: h.events });
    const built = channels.alipay.refundNotification(
      orderRefundNotice(identity.alipay, order, refund),
    );
    const [delivered, queried] = await Promise.all([
      h.deliver('alipay', built.raw),
      settled(handle(refundQueryJob(f, refund))),
    ]);
    acked('alipay', delivered);
    expect(queried).toBe('resolved');
  });
  expect(await refundRow(f, refund.id)).toMatchObject({ status: 'SUCCESS' });
  expect(await payOrder(f, order.id)).toMatchObject({ refunded_fen: refund.amount_fen });
  expect((await vouchers(f)).filter((v) => v.voucher_kind === 'PAY_REFUND')).toHaveLength(1);
  expect(await refundEvents(f)).toHaveLength(1);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toHaveLength(1);
});

it.each([
  ['开通成功后', true],
  ['开通失败（开通任务未生效、尚无开通结果）', false],
] as const)(
  '[AC-B2-15e#22] AC-S2-82 ⑮：%s全额退款成功 → 回收任务按当前事实重算为 revoked；之后旧的开通任务重试，权益仍是退款后的结果',
  async (label, opened) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { kit, handle } = await refundJobs(f, channels);
    const order = await seedPaid(f, kit, 'wechat_pay');
    const fulfil = received('biz.reconcile', {
      app_id: f.subject.app_id,
      biz_type: BIZ,
      biz_ref: order.biz_ref,
      pay_order_id: order.id,
    });
    if (opened) await handle(fulfil);
    expect(
      (await fulfillments(f)).map((row) => row.state),
      label,
    ).toEqual(opened ? ['active'] : []);
    const refund = await seedRefund(f, { type: 'pay_order', id: order.id }, { amount_fen: AMOUNT });
    channels.wechat_pay.setRefund(
      refund.out_refund_no,
      refundedAnswer(identity.wechat_pay, refund, order_(order), 'wechat_pay'),
    );
    f.clock.advanceMs(60_000);
    expect(await settled(handle(refundQueryJob(f, refund)))).toBe('resolved');
    const recovery = sends(kit, 'biz.reconcile');
    expect(recovery).toHaveLength(1);
    await handle(received('biz.reconcile', recovery[0]!.payload));
    expect(await fulfillments(f)).toMatchObject([{ state: 'revoked', refunded_fen: AMOUNT }]);
    f.clock.advanceMs(60_000);
    await handle(fulfil);
    expect(await fulfillments(f)).toMatchObject([{ state: 'revoked', refunded_fen: AMOUNT }]);
    expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: AMOUNT });
  },
);
