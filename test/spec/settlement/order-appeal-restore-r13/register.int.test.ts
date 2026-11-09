// B2-09gg rule tests, the appeal entry (claude-independent, SPEC_REF 03383a10): 08 BR-ID-36 ② with
// 编排 D10-1180 (an order appeal covers a CLAWED_BACK that came from BLACKLIST_CONFIRMED) and
// contracts/openapi.yaml adminRegisterAppeal (a target that cannot be appealed is 20001
// data.fields=[target_id]). The first test walks the whole chain on the real console and worker:
// registered, revoked, the logged appeal.resolved delivered, one difference. Orders reach CLAWED_BACK
// through the real credit and the real blacklist confirmation. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  PERIOD,
  TIMEOUT,
  app,
  appealDiffs,
  blacklistClawback,
  clawedOrder,
  dedupeKeyOf,
  deliverLogged,
  loggedResolutions,
  refId,
  refundClawback,
  suite,
  withConsole,
  withConsoleAndWorker,
  type ConsoleEntry,
  type Sent,
} from './kit.ts';

const s = suite();

const registration = (orderId: string) => ({
  target_type: 'order',
  target_id: orderId,
  content: '这笔订单是我本人正常购买的，请核查。',
  reason: '本人经企业微信联系客服，核对订单信息一致',
});

/** A 200 answer carrying the appeal, its target as asked. */
function accepted(sent: Sent, orderId: string, ownerId: string): Record<string, unknown> {
  expect(sent.statusCode, sent.body).toBe(200);
  const data = sent.json().data as Record<string, unknown>;
  expect(data).toMatchObject({
    target_type: 'order',
    target_id: orderId,
    status: 'processing',
    source: 'admin',
    user: { user_id: ownerId },
  });
  return data;
}

/** 20001 data.fields=[target_id]. */
function refused(sent: Sent): void {
  expect(sent.statusCode, sent.body).toBe(400);
  const body = sent.json();
  expect(body.code, sent.body).toBe(20001);
  expect(body.data, sent.body).toEqual({ fields: ['target_id'] });
}

it(
  '[AC-B2-09gg#1] 全链路：真实入账、真实黑名单确认扣回（CLAWED_BACK / BLACKLIST）的订单，客服代登记申诉受理为处理中，撤销结案，事件日志里的 appeal.resolved（信封 data）投递给 worker 的消费者后登记一张差错单：appeal_restore、R3、ref_type order、ref_id `{order_key}#RESTORE#{entry_id}`（进入 CLAWED_BACK 的历史行）、resolution 带真实 appeal_id、rebate_status CLAWED_BACK',
  async () => {
    const a = await app(s);
    await withConsoleAndWorker(a, async (admin, worker) => {
      const { order, entryId } = await clawedOrder(a, admin);

      const appeal = accepted(
        await admin.register(registration(order.orderId)),
        order.orderId,
        order.user('self'),
      );
      const appealId = appeal['appeal_id'] as string;
      const closed = await admin.resolve(appealId, {
        decision: 'revoked',
        note: '核实后撤销',
        expected_row_version: 0,
      });
      expect(closed.statusCode, closed.body).toBe(200);

      const logged = await loggedResolutions(a);
      expect(logged).toHaveLength(1);
      expect(logged[0]!.data).toMatchObject({
        app_id: a.h.appId,
        appeal_id: appealId,
        target_type: 'order',
        target_id: order.orderId,
        status: 'revoked',
      });
      await deliverLogged(a, worker, logged[0]!);

      const rows = await appealDiffs(a.f);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'appeal_restore',
        source: 'R3',
        period: PERIOD,
        ref_type: 'order',
        ref_id: refId(order, entryId),
        expected_fen: 1000n,
        actual_fen: 0n,
        status: 'open',
        dedupe_key: dedupeKeyOf(a, order, entryId),
      });
      expect(rows[0]!.resolution).toMatchObject({
        reason_code: 'BLACKLIST',
        appeal_id: appealId,
        order_id: order.orderId,
        rebate_status: 'CLAWED_BACK',
      });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-09gg#2] 受理范围：退款扣回的 CLAWED_BACK（原因不是 BLACKLIST）、已入账未扣回的订单、不存在的订单仍 20001 data.fields=[target_id]；VOID + BLACKLIST 照旧受理；CLAWED_BACK + BLACKLIST 受理',
  async () => {
    const a = await app(s);
    await withConsole(a, async (admin: ConsoleEntry) => {
      const refunded = await refundClawback(a);
      refused(await admin.register(registration(refunded.orderId)));
      const credited = await a.h.credited();
      refused(await admin.register(registration(credited.orderId)));
      refused(await admin.register(registration(randomUUID())));

      // Written directly: the voiding itself is not what this regression is about.
      const voided = await a.h.order({ patch: { rebate_status: 'VOID', reason: 'BLACKLIST' } });
      accepted(
        await admin.register(registration(voided.orderId)),
        voided.orderId,
        voided.user('self'),
      );

      const { order } = await blacklistClawback(a, admin, await a.h.credited());
      accepted(
        await admin.register(registration(order.orderId)),
        order.orderId,
        order.user('self'),
      );
    });
  },
  TIMEOUT,
);
