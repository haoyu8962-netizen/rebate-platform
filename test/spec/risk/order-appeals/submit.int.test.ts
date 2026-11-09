// B1-03zl (BR-ID-36 ②; 契约 submitAppeal; 拍板第二批 OPS-07; 编排 D10-1181 ②): a signed-in user
// appeals one of their own orders whose rebate risk control voided. Real AppModule over HTTP.
// Checks run in the contract's order: 20001 / 30701 (target) → the processing appeal on the same
// order is returned → 30418 → create.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  accepted,
  appeals,
  audits,
  claims,
  events,
  listed,
  member,
  NOT_VOIDED,
  openHttp,
  orderAppeals,
  orderDetail,
  PATH,
  rejected,
  states,
  submitOrder,
  type Fixture,
  type Member,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openHttp();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

/** Everything a refused submission must leave as it was. */
async function snapshot(m: Member) {
  return {
    appeals: await appeals(f, m),
    states: await states(f, m),
    events: await events(f, m),
    audits: await audits(f, m.appId),
  };
}

it('[AC-B1-03zl#1] 本人被风控作废的订单（VOID + BLACKLIST）受理：建处理中订单申诉，账户风险状态不变，订单详情 appeal_pending=true，列表可见', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  expect((await orderDetail(m, orderId)).appeal_pending).toBe(false);
  const before = { states: await states(f, m), events: await events(f, m) };
  f.clock.advanceMs(1000);
  const content = '  订单返利被作废\n请核查🙂 ';
  const data = await accepted(await submitOrder(m, orderId, content));
  expect(data).toEqual({
    appeal_id: expect.any(String),
    target_type: 'order',
    target_id: orderId,
    status: 'processing',
    content,
    created_at: expect.any(String),
    closed_at: null,
    attempt_no: 1,
    can_resubmit: false,
  });
  expect(Date.parse(data.created_at)).toBe(f.clock.now().getTime());
  const rows = await appeals(f, m);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: data.appeal_id,
    user_id: m.uid,
    target_type: 'order',
    target_id: orderId,
    request_type: null,
    prev_risk_state: null,
    penalty_started_at: null,
    status: 'processing',
    content,
    handler_id: null,
    closed_at: null,
  });
  expect(rows[0]!.deadline_at.getTime()).toBeGreaterThan(f.clock.now().getTime());
  // OPS-07: an order appeal never touches the account's risk state nor publishes a change of it.
  expect(await states(f, m)).toEqual(before.states);
  expect(await states(f, m)).toMatchObject([{ state: 'normal' }]);
  expect(await events(f, m)).toEqual(before.events);
  expect((await orderDetail(m, orderId)).appeal_pending).toBe(true);
  expect(await listed(await m.send('GET', PATH))).toEqual({ items: [data], next_cursor: null });
});

for (const state of ['frozen', 'banned'] as const) {
  it(`[AC-B1-03zl#2] ${state} 用户（申诉接口在 10006 白名单内）也能提交订单申诉：不进 appealing、不记 prev_risk_state`, async () => {
    const m = await member(f, state);
    const orderId = await m.voided();
    const before = { states: await states(f, m), events: await events(f, m) };
    const data = await accepted(await submitOrder(m, orderId));
    expect(data).toMatchObject({
      target_type: 'order',
      target_id: orderId,
      status: 'processing',
      attempt_no: 1,
      can_resubmit: false,
    });
    expect(await appeals(f, m)).toMatchObject([
      { id: data.appeal_id, target_type: 'order', prev_risk_state: null, status: 'processing' },
    ]);
    expect(await states(f, m)).toEqual(before.states);
    expect(await states(f, m)).toMatchObject([{ state }]);
    expect(await events(f, m)).toEqual(before.events);
    expect(await listed(await m.send('GET', PATH))).toEqual({ items: [data], next_cursor: null });
  });
}

const UNKNOWN_TARGETS: readonly {
  readonly label: string;
  readonly target: (m: Member) => Promise<string>;
}[] = [
  { label: '不存在的 order_id', target: async () => randomUUID() },
  { label: '同 App 他人的订单（也被风控作废）', target: (m) => m.stranger() },
  {
    label: '别的 App 的订单（也被风控作废）',
    target: async () => (await member(f, 'normal')).voided(),
  },
];

for (const { label, target } of UNKNOWN_TARGETS) {
  it(`[AC-B1-03zl#3] ${label} → HTTP 404 / 30701，不写任何行`, async () => {
    const m = await member(f, 'normal');
    const orderId = await target(m);
    const before = await snapshot(m);
    await rejected(await submitOrder(m, orderId), 404, 30701);
    expect(await snapshot(m)).toEqual(before);
    // Nothing is written on the order's own app either (the foreign app's order is untouched).
    expect(
      await f.db
        .withSchema('app')
        .selectFrom('appeals')
        .select('id')
        .where('target_id', '=', orderId)
        .execute(),
    ).toEqual([]);
  });
}

for (const { label, patch } of NOT_VOIDED) {
  it(`[AC-B1-03zl#4] 本人订单但未被风控作废（${label}）→ HTTP 400 / 20001，不写；同一用户的风控作废单可受理`, async () => {
    const m = await member(f, 'normal');
    // The order target is wired: the user's own risk-voided order is accepted, so the 20001 below
    // is the eligibility check, not the "order appeals are not supported" refusal.
    const voided = await m.voided();
    const first = await accepted(await submitOrder(m, voided));
    expect(first).toMatchObject({ target_type: 'order', target_id: voided });
    const orderId = await m.own(patch);
    const before = await snapshot(m);
    await rejected(await submitOrder(m, orderId), 400, 20001);
    expect(await snapshot(m)).toEqual(before);
    expect(await orderAppeals(f, m.appId, orderId)).toEqual([]);
  });
}

it('[AC-B1-03zl#5] 同一订单已有处理中申诉：换幂等键再提交返回原单（同 id、原文不变），不新建、不 30418', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  const first = await accepted(await submitOrder(m, orderId, '第一次'));
  const before = await snapshot(m);
  for (const content of ['第二次', '第三次', '第四次']) {
    f.clock.advanceMs(1000);
    const again = await accepted(await submitOrder(m, orderId, content));
    expect(again).toEqual(first);
  }
  expect(await snapshot(m)).toEqual(before);
  expect(await orderAppeals(f, m.appId, orderId)).toHaveLength(1);
});

it('[AC-B1-03zl#6] 同幂等键同请求原样回放，同键不同请求 20901；原单、状态与事件不变', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  const key = randomUUID();
  const traceId = randomUUID();
  const firstResponse = await submitOrder(m, orderId, '原始订单申诉', {
    'idempotency-key': key,
    'x-trace-id': traceId,
  });
  const first = await accepted(firstResponse);
  expect(first).toMatchObject({ target_type: 'order', target_id: orderId });
  const before = await snapshot(m);
  const replay = await submitOrder(m, orderId, '原始订单申诉', {
    'idempotency-key': key,
    'x-trace-id': traceId,
  });
  await accepted(replay);
  expect(replay.json()).toEqual(firstResponse.json());
  await rejected(
    await submitOrder(m, orderId, '被篡改', { 'idempotency-key': key, 'x-trace-id': traceId }),
    409,
    20901,
  );
  expect(await snapshot(m)).toEqual(before);
  expect(await claims(f, m.appId, key)).toHaveLength(1);
});

it('[AC-B1-03zl#7] 同一订单并发两次提交（不同幂等键）：都 200、同一张申诉单，只建一行', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  const responses = await Promise.all([
    submitOrder(m, orderId, '并发订单申诉'),
    submitOrder(m, orderId, '并发订单申诉'),
  ]);
  const data = [];
  for (const response of responses) data.push(await accepted(response));
  expect(data[0]).toMatchObject({ target_type: 'order', target_id: orderId });
  expect(data[1]).toEqual(data[0]);
  expect(await orderAppeals(f, m.appId, orderId)).toHaveLength(1);
  expect(await states(f, m)).toMatchObject([{ state: 'normal' }]);
});

it('[AC-B1-03zl#8] 一笔订单只算它自己：同一用户两笔风控作废单各自一张处理中申诉，详情各自 appeal_pending', async () => {
  const m = await member(f, 'normal');
  const a = await m.voided();
  const b = await m.voided();
  const untouched = await m.voided();
  const first = await accepted(await submitOrder(m, a));
  f.clock.advanceMs(1000);
  const second = await accepted(await submitOrder(m, b));
  expect(second.appeal_id).not.toBe(first.appeal_id);
  expect([first.target_id, second.target_id]).toEqual([a, b]);
  expect(second).toMatchObject({ attempt_no: 1, status: 'processing' });
  expect((await orderDetail(m, a)).appeal_pending).toBe(true);
  expect((await orderDetail(m, b)).appeal_pending).toBe(true);
  expect((await orderDetail(m, untouched)).appeal_pending).toBe(false);
  expect(await listed(await m.send('GET', PATH))).toEqual({
    items: [second, first],
    next_cursor: null,
  });
});
