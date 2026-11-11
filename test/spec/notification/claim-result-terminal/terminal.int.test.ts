import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assembled } from '../risk-state-message/worker-kit.ts';
import {
  CONSUMER,
  fixture,
  job,
  openSuite,
  QUEUE,
  type Suite,
} from '../claim-result-message/db-kit.ts';

// B1-18kn（D10-1274）：CLAIM_RESULT 的 {rebate} 只计发送那一刻不在终态（VOID、CLAWED_BACK）的已通过
// 订单里申请人本人的当前版本份额；终态按 0 计、照发不吞（BR-TEXT-09；BR-CALC-15 终态一路
// 「终态期间这些行不计入任何应得或待入账」）。全部经真实 claim.resolved 消费者（worker 装配）。

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** 找回已通过、通知尚未消费时订单状态变化：这里只置被测读端的输入状态，版本行保持原样。 */
async function setRebateStatus(f: Fixture, orderId: string, rebateStatus: string) {
  await f.db
    .withSchema('app')
    .updateTable('orders')
    .set({ rebate_status: rebateStatus })
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .execute();
}

/** 经 worker 装配注册的唯一 claim.resolved 消费者投递一次，返回站内信与通知日志。 */
async function consume(f: Fixture) {
  const event = f.event();
  const app = await assembled('worker', f.db, f.clock);
  try {
    const matches = app.registrations.filter((r) => r.name === QUEUE);
    expect(matches).toHaveLength(1);
    await matches[0]!.handler(job(event));
    expect(
      await f.db
        .selectFrom('processed_events')
        .select(['event_id', 'consumer'])
        .where('event_id', '=', event.eventId)
        .execute(),
    ).toEqual([{ event_id: event.eventId, consumer: CONSUMER }]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
  return { event, rows: await f.rows() };
}

async function terminalAfterApproval(rebateStatus: 'VOID' | 'CLAWED_BACK') {
  const f = await fixture(suite);
  // 当前版本（v2）申请人本人份额为正：订单作废或扣回而 N 不变时版本行原样保留。
  const { order } = await f.item(321n);
  await setRebateStatus(f, order.order_id, 'ESTIMATED');
  await setRebateStatus(f, order.order_id, rebateStatus);
  const { event, rows } = await consume(f);
  expect(rows.inbox).toMatchObject([
    {
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      title: '找回结果',
      body: '订单找回成功，预估返 ¥0',
    },
  ]);
  expect(rows.logs).toMatchObject([
    {
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      channel: 'inbox',
      status: 'success',
      dedupe_key: `claim.resolved:${event.eventId}`,
    },
  ]);
}

it('[AC-B1-18kn#1] [BR-TEXT-09] [BR-CALC-15] 延迟消费时已通过订单已 VOID 而当前版本本人份额为正：预估返按 0 计，照发不吞', async () => {
  await terminalAfterApproval('VOID');
});

it('[AC-B1-18kn#2] [BR-TEXT-09] [BR-CALC-15] 延迟消费时已通过订单已 CLAWED_BACK 而当前版本本人份额为正：预估返按 0 计，照发不吞', async () => {
  await terminalAfterApproval('CLAWED_BACK');
});

it.each(['ESTIMATED', 'WAITING'] as const)(
  '[AC-B1-18kn#3] [BR-TEXT-09] [BR-CALC-15] 多单混合（在途 %s、CREDITED、VOID、CLAWED_BACK）：只计在途与已入账两单的本人份额之和',
  async (inFlight) => {
    const f = await fixture(suite);
    const pending = await f.item(123n);
    const credited = await f.item(4000n);
    const voided = await f.item(50000n);
    const clawed = await f.item(600000n);
    // 驳回条目的订单不在终态也不计入（找回只加通过条目）。
    await f.item(7000000n, 'rejected');
    await setRebateStatus(f, pending.order.order_id, inFlight);
    await setRebateStatus(f, credited.order.order_id, 'CREDITED');
    await setRebateStatus(f, voided.order.order_id, 'VOID');
    await setRebateStatus(f, clawed.order.order_id, 'CLAWED_BACK');
    const { rows } = await consume(f);
    // 123 + 4000 = 4123 分；非终态两单金额不受影响（对照），终态两单的 50000、600000 不计。
    expect(rows.inbox).toMatchObject([
      { user_id: f.userId, code: 'CLAIM_RESULT', body: '订单找回成功，预估返 ¥41.23' },
    ]);
    expect(rows.logs).toMatchObject([
      { user_id: f.userId, code: 'CLAIM_RESULT', channel: 'inbox', status: 'success' },
    ]);
  },
);
