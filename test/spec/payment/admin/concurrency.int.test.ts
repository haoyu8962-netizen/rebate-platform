// B2-15f concurrency rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-04 (同一通知重复
// 到达、通知与查询同时到达，只生效一次), BR-PAY-02 (PO2 先取业务对象级锁，拿到锁后重新读取再判断；状态
// CAS), BR-PAY-05 ③ (后台【立即查询】后按渠道结果结束), BR-PAY-07 (PAY_RECEIPT 每张支付单至多一张);
// contracts/openapi.yaml resolveAdminPayOrder (a repeated call settles by CAS on expected_status:
// 200 with the settled pay order, or 20902).
// Real concurrency: the resolve goes through the admin entry (kit.ts withAdmin), the notification
// through the api entry's /notify/pay/<channel> (../result/kit.ts withNotify); the test holds the
// business object's advisory lock (task B2-15b §9.4 key payment.biz:<app_id>:<biz_type>:<biz_ref>)
// on a second connection while both queue up behind it, then releases it. Top-level it() only.
import { expect, it } from 'vitest';
import {
  BIZ,
  fixture,
  holdingBizLock,
  lockKey,
  payOrder,
  suite,
  track,
  untilWaiting,
  type Fixture,
  type OrderRow,
} from '../orders/kit.ts';
import {
  acked,
  anomalies,
  paidEvents,
  paidNotification,
  queuedByKey,
  receiptOf,
  vouchers,
  withNotify,
} from '../result/kit.ts';
import {
  CONFLICT,
  RESOLVE,
  adminChannels,
  answer,
  ok,
  orderOf,
  resolveAudits,
  seedNeedsManual,
  withAdmin,
  type AdminSent,
} from './kit.ts';

const s = suite();

/** The pay order was settled exactly once (BR-PAY-04 只生效一次; BR-PAY-07 至多一张). */
async function settledOnce(f: Fixture, order: OrderRow, trade: string): Promise<void> {
  const row = await payOrder(f, order.id);
  expect(row).toMatchObject({ status: 'PAID', channel_trade_no: trade, closed_at: null });
  expect(await vouchers(f)).toEqual([receiptOf(row)]);
  expect(await paidEvents(f)).toHaveLength(1);
  expect(
    (await queuedByKey(f, `biz:${order.app_id}:${BIZ}:${order.biz_ref}`)).filter(
      (job) => job.job === 'biz.reconcile',
    ),
  ).toHaveLength(1);
  expect(await anomalies(f)).toEqual([]);
}

/** A resolve that lost or won the race: 200 with the PAID order, or 20902. */
async function paidOrConflict(sent: AdminSent): Promise<number> {
  const code = sent.json().code;
  expect([0, 20902], sent.body).toContain(code);
  if (code === 0) {
    const data = await ok(sent);
    expect(orderOf(data['pay_order'])).toMatchObject({ status: 'PAID' });
  } else {
    await answer(sent, 20902, CONFLICT);
  }
  return code;
}

it('[AC-B2-15f#13] 真实并发：后台处置（渠道答已支付）与同一支付单的成功通知同时到达，在业务对象锁后排队，只生效一次——一张 PAY_RECEIPT、一个 pay_order.paid、一个 biz.reconcile，不登记异常收款；通知应答成功；处置应答为已支付的支付单或 20902', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  const trade = channels.wechat_pay.script(order, 'paid');
  const built = paidNotification(channels, channels.wechat_pay.identity, order, {
    channelTradeNo: trade,
  });
  await withAdmin(f, channels, async (h) => {
    const token = await h.stepUp(h.resolver);
    await withNotify(f, channels, async (n) => {
      const key = lockKey(f, order.biz_ref);
      const [resolved, delivered] = await holdingBizLock(f, key, async (release) => {
        const resolving = track(h.resolve(order.id, { stepUp: token }));
        const delivering = track(n.deliver('wechat_pay', built.raw));
        const waiting = await untilWaiting(f, key, 2, [resolving, delivering]);
        await release();
        const results = await Promise.all([resolving.promise, delivering.promise]);
        expect(waiting, 'the resolve and the notification both wait for the lock').toBe(true);
        return results;
      });
      acked('wechat_pay', delivered);
      await paidOrConflict(resolved);
    });
  });
  await settledOnce(f, order, trade);
});

it('[AC-B2-15f#14] 真实并发：两名有 pay.resolve 的管理员同时处置同一张 needs_manual 支付单（渠道答已支付），在业务对象锁后排队，只 PO2 一次——一张 PAY_RECEIPT、一个事件、一个开通任务；两个应答都是已支付的支付单或其一 20902；每个 code 0 的调用各一条审计', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'alipay');
  const trade = channels.alipay.script(order, 'paid');
  await withAdmin(f, channels, async (h) => {
    const other = await h.caller([RESOLVE]);
    const mine = await h.stepUp(h.resolver);
    const theirs = await h.stepUp(other);
    const key = lockKey(f, order.biz_ref);
    const sent: AdminSent[] = await holdingBizLock(f, key, async (release) => {
      const first = track(h.resolve(order.id, { stepUp: mine }));
      const second = track(h.resolve(order.id, { caller: other, stepUp: theirs }));
      const waiting = await untilWaiting(f, key, 2, [first, second]);
      await release();
      const results = await Promise.all([first.promise, second.promise]);
      expect(waiting, 'both resolves wait for the business object lock').toBe(true);
      return results;
    });
    const codes: number[] = [];
    for (const one of sent) codes.push(await paidOrConflict(one));
    expect(codes.filter((code) => code === 0).length).toBeGreaterThanOrEqual(1);
    expect(await resolveAudits(f)).toHaveLength(codes.filter((code) => code === 0).length);
  });
  await settledOnce(f, order, trade);
});
