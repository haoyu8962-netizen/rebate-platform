// B2-15c notification entry rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-04 and
// 细则「通知应答」, BR-PAY-05 ④, BR-PAY-07, BR-PAY-01 ④ (switches only affect new orders);
// specs/pay-notify.md; task §9.1 ～ §9.4, §9.6, §9.8, §9.9. Everything goes through the real api
// entry: POST /notify/pay/wechat and /notify/pay/alipay, no token, no request signature, no
// X-App-Id. pay.enabled and the channel switches stay at their default (off) throughout.
// Top-level it() only (规划/11 §4.3).
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  createBody,
  enable,
  fixture,
  payOrder,
  seedOrder,
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
  ROUTE,
  acked,
  alertsMentioning,
  anomalies,
  anomaliesAnywhere,
  anomalyVoucherOf,
  nacked,
  newIdentity,
  notifications,
  notificationsAnywhere,
  paidEvents,
  paidNotification,
  queuedByKey,
  receiptOf,
  reconDiffs,
  seedPending,
  specChannels,
  tradeNo,
  untouched,
  userTraces,
  vouchers,
  warnings,
  withNotify,
  type Built,
  type Delivery,
  type NotifyHarness,
} from './kit.ts';

const s = suite();

async function prepared(instant?: string) {
  const f = instant === undefined ? await fixture(s) : await fixture(s, instant);
  return { f, ...specChannels(f) };
}

/** Nothing of the business moved for the order: no state change, posting, job or event. */
async function nothingMoved(f: Fixture, order: OrderRow) {
  expect(await payOrder(f, order.id)).toMatchObject(untouched(order));
  expect(await vouchers(f)).toEqual([]);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
  expect(await paidEvents(f)).toEqual([]);
  expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
}

/** A CLOSED order's receipt: exactly one anomaly, its posting and recon diff, nothing else. */
async function onlyAnomaly(
  f: Fixture,
  h: NotifyHarness,
  order: OrderRow,
  trade: string,
  built: Built,
) {
  expect(await payOrder(f, order.id)).toMatchObject({ ...untouched(order), paid_at: null });
  const rows = await anomalies(f);
  expect(rows).toHaveLength(1);
  const anomaly = rows[0]!;
  expect(anomaly).toMatchObject({
    app_id: f.subject.app_id,
    pay_channel: order.pay_channel,
    channel_trade_no: trade,
    out_trade_no: order.out_trade_no,
    pay_order_id: order.id,
    amount_fen: AMOUNT,
    refunded_fen: 0n,
    status: 'open',
  });
  const evidence = JSON.stringify(anomaly.evidence);
  for (const secret of built.secrets) expect(evidence.includes(secret), secret).toBe(false);
  expect(await vouchers(f)).toEqual([anomalyVoucherOf(anomaly)]);
  const diffs = await reconDiffs(f);
  expect(diffs).toHaveLength(1);
  expect(diffs[0]).toMatchObject({
    type: 'pay_anomaly',
    source: 'R4',
    period: '2026-10-23',
    ref_type: 'pay_anomaly',
    ref_id: anomaly.id,
    expected_fen: 0n,
    actual_fen: AMOUNT,
    diff_fen: -AMOUNT,
    status: 'open',
  });
  expect(alertsMentioning(h.logs, [order.id, anomaly.id]).length).toBeGreaterThanOrEqual(1);
  expect(await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).toEqual([]);
  expect(await paidEvents(f)).toEqual([]);
  expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
}

function closedOrder(f: Fixture, channel: PayChannelCode): Promise<OrderRow> {
  return seedOrder(f, {
    pay_channel: channel,
    amount_fen: AMOUNT,
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'expired',
    launch_issued_at: f.clock.now(),
  });
}

it.each(CHANNELS)(
  '[AC-B2-15c#6] %s 首次合格通知（开关全关也照常处理）：同一事务 PO2 + 恰一张 PAY_RECEIPT（借 CASH_PAY / 贷 PAY_RECEIPTS）+ 按业务对象入队一次开通 + pay_order.paid；原文加密留存；提交后应答成功；不碰用户余额',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    f.clock.advanceMs(60_000);
    const trade = tradeNo(channel);
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      acked(channel, await h.deliver(channel, built.raw));
      expect(channels[channel].verified).toHaveLength(1);
      expect(channels[channel].verified[0]?.body).toBe(built.raw.body);
      expect(await payOrder(f, order.id)).toMatchObject({
        ...untouched(order),
        status: 'PAID',
        paid_at: expect.any(Date),
        channel_trade_no: trade,
        closing: false,
        out_trade_no: order.out_trade_no,
        user_id: order.user_id,
        biz_ref: order.biz_ref,
      });
      expect(await vouchers(f)).toEqual([receiptOf(order)]);
      const rows = await notifications(f);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        app_id: f.subject.app_id,
        pay_channel: channel,
        notify_id: built.notifyId,
        out_trade_no: order.out_trade_no,
        out_refund_no: null,
        verify_result: 'ok',
        received_at: f.clock.now(),
      });
      expect(rows[0]?.handle_result).toEqual(expect.any(String));
      const cipher = Buffer.from(rows[0]?.payload_cipher ?? Buffer.alloc(0));
      expect(cipher.length).toBeGreaterThan(0);
      for (const secret of [built.raw.body, ...built.secrets, order.out_trade_no]) {
        expect(cipher.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
      }
      expect(
        (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).map((job) => [
          job.job,
          job.singleton_key,
        ]),
      ).toEqual([['biz.reconcile', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`]]);
      const events = await paidEvents(f);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ pay_order_id: order.id });
      expect(await anomalies(f)).toEqual([]);
      expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#7] %s 同一通知重复到达、渠道另发一条同交易的通知：都应答成功，状态、凭证、开通任务、事件只生效一次，每条不同的通知各留存一份',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    const first = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    const again = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      acked(channel, await h.deliver(channel, first.raw));
      const paid = await payOrder(f, order.id);
      expect(paid.status).toBe('PAID');
      for (const raw of [first.raw, first.raw, again.raw]) {
        f.clock.advanceMs(30_000);
        acked(channel, await h.deliver(channel, raw));
      }
      expect(channels[channel].verified).toHaveLength(4);
      expect(await payOrder(f, order.id)).toEqual(paid);
      expect(await vouchers(f)).toEqual([receiptOf(order)]);
      expect((await notifications(f)).map((row) => row.notify_id).sort()).toEqual(
        [first.notifyId, again.notifyId].sort(),
      );
      expect(await paidEvents(f)).toHaveLength(1);
      expect(
        (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).filter(
          (job) => job.job === 'biz.reconcile',
        ),
      ).toHaveLength(1);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#8] %s 验签通过但金额不等于 amount_fen：不迁移、不记账、不开通；每条通知都留存；告警按单去重；应答不成功',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    await withNotify(f, channels, async (h) => {
      const sent: Built[] = [];
      for (const amountFen of [AMOUNT - 1n, AMOUNT - 1n, AMOUNT + 1n]) {
        const built = paidNotification(channels, identity[channel], order, {
          channelTradeNo: trade,
          amountFen,
        });
        sent.push(built);
        nacked(channel, await h.deliver(channel, built.raw));
      }
      await nothingMoved(f, order);
      const rows = await notifications(f);
      expect(rows.map((row) => row.notify_id).sort()).toEqual(sent.map((b) => b.notifyId).sort());
      for (const row of rows) {
        expect(row).toMatchObject({ verify_result: 'ok', out_trade_no: order.out_trade_no });
        expect(row.handle_result).toEqual(expect.any(String));
      }
      expect(warnings(h.logs, 'pay_notify_mismatch')).toHaveLength(1);
      expect(await anomalies(f)).toEqual([]);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#9] %s 签名无效（改过正文、换过签名）：拒绝，不写任何表、不迁移，只计数告警 pay_notify_rejected，应答不成功；同一夹具的真通知照常生效',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const trade = tradeNo(channel);
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      const bad = [channels[channel].alterBody(built), channels[channel].forgeSignature(built)];
      for (const raw of bad) nacked(channel, await h.deliver(channel, raw));
      expect(channels[channel].verified).toHaveLength(2);
      expect(await notificationsAnywhere(built.notifyId, f)).toBe(0);
      expect(await anomaliesAnywhere(trade, f)).toBe(0);
      expect(await reconDiffs(f)).toEqual([]);
      await nothingMoved(f, order);
      const rejected = warnings(h.logs, 'pay_notify_rejected');
      expect(rejected).toHaveLength(2);
      for (const line of rejected) expect(line).toMatchObject({ pay_channel: channel });
      acked(channel, await h.deliver(channel, built.raw));
      expect((await payOrder(f, order.id)).status).toBe('PAID');
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#10] %s 应用或商户标识不是我方（全不是、只有一半是）：签名有效也拒绝，不留业务痕迹，计数告警，应答不成功',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const foreign = newIdentity(channel);
    const half = { merchantRef: identity[channel].merchantRef, appRef: foreign.appRef };
    const trades: string[] = [];
    const ids: string[] = [];
    await withNotify(f, channels, async (h) => {
      for (const who of [foreign, half]) {
        const trade = tradeNo(channel);
        const built = paidNotification(channels, who, order, { channelTradeNo: trade });
        trades.push(trade);
        ids.push(built.notifyId);
        nacked(channel, await h.deliver(channel, built.raw));
      }
      expect(channels[channel].verified).toHaveLength(2);
      for (const id of ids) expect(await notificationsAnywhere(id, f)).toBe(0);
      for (const trade of trades) expect(await anomaliesAnywhere(trade, f)).toBe(0);
      expect(await reconDiffs(f)).toEqual([]);
      await nothingMoved(f, order);
      expect(warnings(h.logs, 'pay_notify_rejected')).toHaveLength(2);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#11] %s 渠道状态不在 success_states 清单（支付宝 TRADE_FINISHED 在实测前不算）：不迁移、留存、告警、应答不成功',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const states =
      channel === 'alipay'
        ? ['TRADE_FINISHED', 'WAIT_BUYER_PAY', 'TRADE_CLOSED']
        : ['NOTPAY', 'USERPAYING', 'success'];
    await withNotify(f, channels, async (h) => {
      for (const state of states) {
        const built = paidNotification(channels, identity[channel], order, { state });
        nacked(channel, await h.deliver(channel, built.raw));
      }
      await nothingMoved(f, order);
      expect(await notifications(f)).toHaveLength(states.length);
      expect(await anomalies(f)).toEqual([]);
      expect(warnings(h.logs, 'pay_notify_mismatch').length).toBeGreaterThanOrEqual(1);
    });
  },
  60_000,
);

it('[AC-B2-15c#12] pay.alipay.success_states 被配置为含 TRADE_FINISHED 后，该状态的合格通知照常迁移记账；未配置的微信仍只认 SUCCESS', async () => {
  const { f, channels, identity } = await prepared();
  await setConfig(f, 'pay.alipay.success_states', ['TRADE_SUCCESS', 'TRADE_FINISHED']);
  const alipay = await seedPending(f, 'alipay');
  const wechat = await seedPending(f, 'wechat_pay');
  await withNotify(f, channels, async (h) => {
    const finished = paidNotification(channels, identity.alipay, alipay, {
      state: 'TRADE_FINISHED',
    });
    acked('alipay', await h.deliver('alipay', finished.raw));
    expect((await payOrder(f, alipay.id)).status).toBe('PAID');
    const other = paidNotification(channels, identity.wechat_pay, wechat, {
      state: 'TRADE_FINISHED',
    });
    nacked('wechat_pay', await h.deliver('wechat_pay', other.raw));
    expect((await payOrder(f, wechat.id)).status).toBe('PENDING');
    expect(await vouchers(f)).toEqual([receiptOf(alipay)]);
  });
}, 60_000);

it.each(CHANNELS)(
  '[AC-B2-15c#13] %s 支付单已 CLOSED 而通知合格：不迁移；登记异常收款 + PAY_ANOMALY（借 CASH_PAY / 贷 PAY_SUSPENSE）+ 差错单 R4 pay_anomaly（会计日 +08:00）+ 告警，不开通；登记提交后应答成功；重复与同交易的新通知只登记一次',
  async (channel) => {
    // 17:30Z is 01:30 the next day at +08:00: the period is the accounting date.
    const { f, channels, identity } = await prepared('2026-10-22T17:30:00.000Z');
    const order = await closedOrder(f, channel);
    const trade = tradeNo(channel);
    const built = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    const second = paidNotification(channels, identity[channel], order, { channelTradeNo: trade });
    await withNotify(f, channels, async (h) => {
      acked(channel, await h.deliver(channel, built.raw));
      await onlyAnomaly(f, h, order, trade, built);
      acked(channel, await h.deliver(channel, built.raw));
      acked(channel, await h.deliver(channel, second.raw));
      await onlyAnomaly(f, h, order, trade, built);
      expect(await notifications(f)).toHaveLength(2);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#14] %s 商户单号找不到我方支付单而渠道已收款：登记异常收款（金额以通知为准）+ PAY_ANOMALY + 差错单 + 告警、留存原文，应答不成功（重发不重复登记）；状态不是成功的不登记',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const ghost = `S${randomBytes(10).toString('hex').toUpperCase()}`;
    const trade = tradeNo(channel);
    const built = channels[channel].notification({
      identity: identity[channel],
      outTradeNo: ghost,
      amountFen: 777n,
      state: channel === 'alipay' ? 'TRADE_SUCCESS' : 'SUCCESS',
      channelTradeNo: trade,
    });
    const unpaid = channels[channel].notification({
      identity: identity[channel],
      outTradeNo: `S${randomBytes(10).toString('hex').toUpperCase()}`,
      amountFen: 888n,
      state: NOT_PAID[channel],
      channelTradeNo: tradeNo(channel),
    });
    await withNotify(f, channels, async (h) => {
      nacked(channel, await h.deliver(channel, built.raw));
      nacked(channel, await h.deliver(channel, built.raw));
      const rows = await anomalies(f);
      expect(rows).toHaveLength(1);
      const anomaly = rows[0]!;
      expect(anomaly).toMatchObject({
        pay_channel: channel,
        channel_trade_no: trade,
        out_trade_no: ghost,
        pay_order_id: null,
        amount_fen: 777n,
        refunded_fen: 0n,
        status: 'open',
      });
      expect(await vouchers(f)).toEqual([anomalyVoucherOf(anomaly)]);
      expect(await reconDiffs(f)).toMatchObject([
        { type: 'pay_anomaly', source: 'R4', ref_type: 'pay_anomaly', ref_id: anomaly.id },
      ]);
      expect(alertsMentioning(h.logs, [anomaly.id, ghost]).length).toBeGreaterThanOrEqual(1);
      expect((await notifications(f)).map((row) => row.out_trade_no)).toEqual([ghost]);

      nacked(channel, await h.deliver(channel, unpaid.raw));
      expect(await anomalies(f)).toHaveLength(1);
      expect(await notifications(f)).toHaveLength(2);
      expect(await paidEvents(f)).toEqual([]);
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#15] %s 应答不含业务信息：各种不成功的应答逐字节相同，各种成功的应答逐字节相同，都不带单号、金额或支付单 id',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const pending = await seedPending(f, channel);
    const another = await seedPending(f, channel);
    const closed = await closedOrder(f, channel);
    const good = paidNotification(channels, identity[channel], pending);
    await withNotify(f, channels, async (h) => {
      const no: Delivery[] = [];
      const yes: Delivery[] = [];
      no.push(await h.deliver(channel, channels[channel].alterBody(good)));
      no.push(await h.deliver(channel, channels[channel].forgeSignature(good)));
      no.push(
        await h.deliver(channel, paidNotification(channels, newIdentity(channel), pending).raw),
      );
      no.push(
        await h.deliver(
          channel,
          paidNotification(channels, identity[channel], another, { amountFen: 1n }).raw,
        ),
      );
      no.push(
        await h.deliver(
          channel,
          paidNotification(channels, identity[channel], another, { state: NOT_PAID[channel] }).raw,
        ),
      );
      yes.push(await h.deliver(channel, good.raw));
      yes.push(await h.deliver(channel, good.raw));
      yes.push(await h.deliver(channel, paidNotification(channels, identity[channel], closed).raw));
      for (const sent of no) nacked(channel, sent);
      for (const sent of yes) acked(channel, sent);
      expect(new Set(no.map((d) => `${d.statusCode} ${d.body}`)).size).toBe(1);
      expect(new Set(yes.map((d) => `${d.statusCode} ${d.body}`)).size).toBe(1);
      for (const sent of [...no, ...yes]) {
        for (const value of [
          pending.id,
          pending.out_trade_no,
          closed.id,
          String(AMOUNT),
          '123.45',
        ]) {
          expect(sent.body.includes(value), value).toBe(false);
        }
      }
    });
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15c#16] %s 通知原文、付款人标识、密文、签名不进任何日志行（成功、重复、不符、拒绝都算）',
  async (channel) => {
    const { f, channels, identity } = await prepared();
    const order = await seedPending(f, channel);
    const other = await seedPending(f, channel);
    const good = paidNotification(channels, identity[channel], order);
    const mismatch = paidNotification(channels, identity[channel], other, { amountFen: 2n });
    const foreign = paidNotification(channels, newIdentity(channel), other);
    await withNotify(f, channels, async (h: NotifyHarness) => {
      acked(channel, await h.deliver(channel, good.raw));
      acked(channel, await h.deliver(channel, good.raw));
      nacked(channel, await h.deliver(channel, mismatch.raw));
      nacked(channel, await h.deliver(channel, channels[channel].alterBody(good)));
      nacked(channel, await h.deliver(channel, foreign.raw));
      expect(warnings(h.logs, 'pay_notify_rejected').length).toBeGreaterThanOrEqual(2);
      expect(warnings(h.logs, 'pay_notify_mismatch').length).toBeGreaterThanOrEqual(1);
      const all = h.logs.join('\n');
      for (const built of [good, mismatch, foreign]) {
        expect(all.includes(built.raw.body)).toBe(false);
        for (const secret of built.secrets) expect(all.includes(secret), secret).toBe(false);
      }
    });
  },
  60_000,
);

it('[AC-B2-15c#17] 向渠道下单时给的通知地址就是该渠道的通知入口（/notify/pay/wechat、/notify/pay/alipay）', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    for (const channel of CHANNELS) {
      await success(
        await send('create', { body: createBody(randomBytes(8).toString('hex'), channel) }),
      );
      const calls = f.channels[channel].createCalls();
      expect(calls).toHaveLength(1);
      expect(new URL(calls[0]!.notifyUrl, 'https://notify.invalid').pathname, channel).toBe(
        ROUTE[channel],
      );
    }
  });
}, 60_000);
