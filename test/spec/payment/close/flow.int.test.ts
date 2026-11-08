// B2-15d close flow rule tests (claude-independent, SPEC_REF ec81e625): 08 BR-PAY-05 ①② (从未向渠道
// 下单、也没有返回过调起参数的单直接 PO3；其余必须先查询：渠道已支付 → PO2、不关闭；否则调关单接口，只有
// 渠道明确「已关闭」才 PO3), BR-PAY-02 (PO2 / PO3 先取业务对象锁、重读、CAS；PAID、CLOSED 为终态),
// BR-PAY-07 (PO2 恰一张 PAY_RECEIPT); task §9.1, §9.2, §9.5; payment/AGENTS.md rule 7 (外部写先落单:
// every query and close is a pay_query_attempts row).
// The close job's handler (application/pay-close.ts runOrderClose) runs over the fixture's database
// with scripted spec channels; the jobs it enqueues are recorded, not run. Top-level it() only
// (规划/11 §4.3).
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { TTL_MS, fixture, payOrder, seedOrder, suite } from '../orders/kit.ts';
import {
  AMOUNT,
  BIZ,
  CHANNELS,
  anomalies,
  jobKit,
  receiptOf,
  sends,
  tradeNo,
  vouchers,
} from '../result/kit.ts';
import {
  WAIT_MS,
  attemptKinds,
  closeChannels,
  closePayload,
  closeRunner,
  closeSends,
  placementAttempt,
  seedClosing,
} from './kit.ts';

const s = suite();

/** An order as another flow left it: settled, closed, or handed to the back office. */
function leftAs(
  state: 'PAID' | 'CLOSED' | 'needs_manual',
  channel: PayChannelCode,
  now: Date,
): Parameters<typeof seedClosing>[2] {
  if (state === 'PAID') {
    return { status: 'PAID', paid_at: now, channel_trade_no: tradeNo(channel), closing: false };
  }
  if (state === 'CLOSED') return { status: 'CLOSED', closed_at: now, closing: false };
  // Past expire_at + pay.close_wait_minutes with no result: needs_manual (BR-PAY-05 ③).
  return {
    needs_manual: true,
    created_at: new Date(now.getTime() - WAIT_MS - TTL_MS - 60_000),
    expire_at: new Date(now.getTime() - WAIT_MS - 60_000),
  };
}

it.each([
  ['user_cancel', 'wechat_pay'],
  ['expired', 'alipay'],
] as const)(
  '[AC-B2-15d#1] 从未向渠道下单、也没向客户端返回过调起参数的单（%s，%s）：不查询、不调关单，直接 PO3——CLOSED、closed_at 为当前时刻、close_reason 照原因，不写账、不再入队关单',
  async (reason, channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedOrder(f, {
      pay_channel: channel,
      amount_fen: AMOUNT,
      launch_issued_at: null,
      ...(reason === 'user_cancel' ? { closing: true, close_reason: 'user_cancel' } : {}),
    });
    // The cancel's job runs half a minute later; the expiry job at expire_at (still not closing).
    f.clock.set(
      reason === 'expired' ? order.expire_at : new Date(order.created_at.getTime() + 30_000),
    );
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, reason));
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'CLOSED',
      closed_at: f.clock.now(),
      close_reason: reason,
      needs_manual: false,
      paid_at: null,
      channel_trade_no: null,
      amount_fen: order.amount_fen,
    });
    expect(channels[channel].calls).toEqual([]);
    expect(await attemptKinds(f, order)).toEqual({ query: 0, close: 0, other: 0 });
    expect(sends(kit, 'order.close')).toEqual([]);
    expect(await vouchers(f)).toEqual([]);
  },
  60_000,
);

it.each([
  ['已向客户端返回过调起参数', 'launch'],
  ['下单结果未知（有下单尝试、未返回调起参数）', 'unknown'],
  ['已向渠道下单、调起参数因取消抢先而没返回', 'prepay'],
] as const)(
  '[AC-B2-15d#2] %s 的单不能直接关：先向渠道查询；渠道答「单据不存在」且未过 expire_at + 宽限 → 保持 PENDING（closing）、不关闭',
  async (_label, kind) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order =
      kind === 'launch'
        ? await seedClosing(f, 'wechat_pay')
        : await seedClosing(f, 'wechat_pay', { launch_issued_at: null });
    if (kind !== 'launch') await placementAttempt(f, order, kind);
    channels.wechat_pay.script(order, 'not_exist');
    f.clock.advanceMs(30_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PENDING',
      closing: true,
      closed_at: null,
      paid_at: null,
    });
    const ops = channels.wechat_pay.opsOf(order);
    expect(ops.length, 'the channel was asked').toBeGreaterThanOrEqual(1);
    expect(ops[0], 'query comes first').toBe('query');
    expect(await vouchers(f)).toEqual([]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15d#3] %s 关单流程中查询到渠道已支付（金额、标识、状态都核对通过）：走 PO2 不关闭——PAID、恰一张 PAY_RECEIPT、开通入队与 pay_order.paid 各一，不调关单接口、不再入队关单',
  async (channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    const trade = channels[channel].scriptPaid(order);
    f.clock.advanceMs(30_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PAID',
      paid_at: f.clock.now(),
      channel_trade_no: trade,
      closed_at: null,
      needs_manual: false,
    });
    expect(channels[channel].opsOf(order)).not.toContain('close');
    expect(channels[channel].opsOf(order)).toContain('query');
    expect(await vouchers(f)).toEqual([receiptOf(order)]);
    expect(await anomalies(f)).toEqual([]);
    expect(sends(kit, 'biz.reconcile').map((job) => [job.queue, job.options.singletonKey])).toEqual(
      [['pay', `biz:${order.app_id}:${BIZ}:${order.biz_ref}`]],
    );
    expect(kit.published.map((p) => p.event.name)).toEqual(['pay_order.paid']);
    expect(sends(kit, 'order.close')).toEqual([]);
    expect((await attemptKinds(f, order)).close).toBe(0);
  },
  60_000,
);

it.each([
  ['wechat_pay', 'not_paid'],
  ['alipay', 'not_paid'],
  ['wechat_pay', 'closed'],
  ['alipay', 'closed'],
] as const)(
  '[AC-B2-15d#4] %s 查询为 %s → 调渠道关单接口，渠道明确「已关闭」才 PO3：CLOSED、closed_at 为当前时刻；先查后关，每次查询与关单各落一行尝试；不写账、不再入队',
  async (channel, state) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    channels[channel].script(order, state);
    f.clock.advanceMs(30_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'CLOSED',
      closed_at: f.clock.now(),
      close_reason: 'user_cancel',
      paid_at: null,
      channel_trade_no: null,
      needs_manual: false,
    });
    const ops = channels[channel].opsOf(order);
    expect(ops[0], 'query first').toBe('query');
    expect(ops, 'the channel close was called').toContain('close');
    expect(await attemptKinds(f, order)).toEqual({
      query: ops.filter((op) => op === 'query').length,
      close: ops.filter((op) => op === 'close').length,
      other: 0,
    });
    expect(await vouchers(f)).toEqual([]);
    expect(await anomalies(f)).toEqual([]);
    expect(sends(kit, 'order.close')).toEqual([]);
    expect(kit.published).toEqual([]);
  },
  60_000,
);

it.each([
  ['渠道查询超时（结果未知）', 'wechat_pay', 'timeout', 'channel'],
  ['查询未支付、关单结果未知', 'alipay', 'not_paid', 'unknown'],
  ['查询已关闭、关单结果未知', 'wechat_pay', 'closed', 'unknown'],
] as const)(
  '[AC-B2-15d#5] %s（%s）：没有渠道明确的「已关闭」就不关——支付单保持 PENDING、closing、业务对象不释放，并入队下一次关单（同一张单、延迟执行）',
  async (_label, channel, state, answer) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    channels[channel].script(order, state, answer);
    f.clock.advanceMs(30_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    // An unknown answer may also fail the job (the queue retries it); either way nothing closes.
    await close(closePayload(order, 'user_cancel')).catch(() => undefined);
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PENDING',
      closing: true,
      closed_at: null,
      needs_manual: false,
    });
    expect(channels[channel].opsOf(order)[0]).toBe('query');
    const next = closeSends(kit, order);
    expect(next.map((job) => job.queue)).toEqual(['pay']);
    expect(next[0]?.options.singletonKey?.startsWith(`order.close:${order.id}`)).toBe(true);
    expect(next[0]?.options.delaySeconds ?? 0).toBeGreaterThan(0);
    expect((await attemptKinds(f, order)).close).toBe(
      channels[channel].opsOf(order).filter((op) => op === 'close').length,
    );
    expect(await vouchers(f)).toEqual([]);
  },
  60_000,
);

it.each(CHANNELS)(
  '[AC-B2-15d#6] %s 查询时未支付、关单那一刻用户付了款（关单接口答已支付）：绝不 CLOSED、不登记异常收款；若本次就判定成功则 PAID 且恰一张 PAY_RECEIPT，否则保持 PENDING 待下次',
  async (channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel);
    channels[channel].script(order, 'not_paid', 'pays');
    f.clock.advanceMs(30_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    const after = await payOrder(f, order.id);
    expect(['PENDING', 'PAID']).toContain(after.status);
    expect(after.closed_at).toBeNull();
    expect(await anomalies(f)).toEqual([]);
    expect(await vouchers(f)).toEqual(after.status === 'PAID' ? [receiptOf(order)] : []);
    expect(closeSends(kit, order)).toHaveLength(after.status === 'PAID' ? 0 : 1);
  },
  60_000,
);

it('[AC-B2-15d#7] 过期关单任务执行时支付单还没到 expire_at、也不在关单流程中：什么都不做（不查询、不关、不改单）', async () => {
  const f = await fixture(s);
  const channels = closeChannels(f);
  const order = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    amount_fen: AMOUNT,
    launch_issued_at: f.clock.now(),
  });
  channels.wechat_pay.script(order, 'not_paid');
  f.clock.set(new Date(order.expire_at.getTime() - 60_000));
  const kit = await jobKit(f, channels);
  const close = await closeRunner(kit);
  await close(closePayload(order, 'expired'));
  expect(await payOrder(f, order.id)).toEqual(order);
  expect(channels.wechat_pay.calls).toEqual([]);
  expect(await attemptKinds(f, order)).toEqual({ query: 0, close: 0, other: 0 });
}, 60_000);

it.each([
  ['PAID', 'wechat_pay'],
  ['CLOSED', 'alipay'],
  ['needs_manual', 'wechat_pay'],
] as const)(
  '[AC-B2-15d#8] 关单任务执行时支付单已是 %s（%s）：重读后结束——不查询、不调关单、不改单、不入队（终态不迁移；needs_manual 后停止自动处理）',
  async (state, channel) => {
    const f = await fixture(s);
    const channels = closeChannels(f);
    const order = await seedClosing(f, channel, leftAs(state, channel, f.clock.now()));
    channels[channel].script(order, 'not_paid');
    f.clock.advanceMs(5 * 60_000);
    const kit = await jobKit(f, channels);
    const close = await closeRunner(kit);
    await close(closePayload(order, 'user_cancel'));
    expect(await payOrder(f, order.id)).toEqual(order);
    expect(channels[channel].calls).toEqual([]);
    expect(kit.sent).toEqual([]);
    expect(await attemptKinds(f, order)).toEqual({ query: 0, close: 0, other: 0 });
    expect(await vouchers(f)).toEqual([]);
  },
  60_000,
);
