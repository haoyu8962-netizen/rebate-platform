// B1-03zl (BR-ID-36: 同一对象——账户、同一笔订单——各自最多 1 条处理中、各自计次; 拍板第二批
// OPS-07: 订单申诉不改账户风险状态; BR-ID-36「申诉提交、结案都写 audit_logs」，编排: 留痕同账户申诉
// 现口径): account and order appeals of one user never stand in for each other — neither the
// "one processing appeal" rule, nor the count, nor the risk state; an order submission leaves the
// same trail as an account submission (audit records of the same kinds, an idempotency claim) but
// no risk.state_changed. Real AppModule over HTTP.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { uphold, type Driver } from '../appeal-attempts/kit.ts';
import {
  accepted,
  appeals,
  audits,
  claims,
  close,
  events,
  listed,
  member,
  openHttp,
  orderDetail,
  PATH,
  rejected,
  states,
  submitAccount,
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

function driver(m: Member): Driver {
  return {
    db: f.db,
    clock: f.clock,
    riskState: m.risk,
    subject: { app_id: m.appId, user_id: m.uid },
  };
}

const appealRow = async (m: Member, id: string) =>
  (await appeals(f, m)).find((row) => row.id === id);

for (const state of ['frozen', 'banned'] as const) {
  it(`[AC-B1-03zl#13] ${state} 且账户申诉处理中：仍可对风控作废订单提交订单申诉，账户申诉与 appealing 不变；两者再提交各回各的原单`, async () => {
    const m = await member(f, state);
    const orderId = await m.voided();
    const account = await accepted(await submitAccount(m, '账户申诉'));
    expect(account).toMatchObject({ target_type: 'account', target_id: m.uid });
    const accountRow = await appealRow(m, account.appeal_id);
    expect(accountRow).toMatchObject({ prev_risk_state: state, status: 'processing' });
    const appealing = await states(f, m);
    expect(appealing).toMatchObject([{ state: 'appealing' }]);
    const eventsBefore = await events(f, m);

    f.clock.advanceMs(1000);
    const order = await accepted(await submitOrder(m, orderId));
    expect(order.appeal_id).not.toBe(account.appeal_id);
    expect(order).toMatchObject({
      target_type: 'order',
      target_id: orderId,
      status: 'processing',
      attempt_no: 1,
      can_resubmit: false,
    });
    expect(await appealRow(m, order.appeal_id)).toMatchObject({ prev_risk_state: null });
    expect(await appealRow(m, account.appeal_id)).toEqual(accountRow);
    expect(await states(f, m)).toEqual(appealing);
    expect(await events(f, m)).toEqual(eventsBefore);

    f.clock.advanceMs(1000);
    expect(await accepted(await submitAccount(m, '账户再申诉'))).toEqual(account);
    expect(await accepted(await submitOrder(m, orderId, '订单再申诉'))).toEqual(order);
    expect(await appeals(f, m)).toHaveLength(2);
    expect(await listed(await m.send('GET', PATH))).toEqual({
      items: [order, account],
      next_cursor: null,
    });
  });
}

for (const state of ['frozen', 'banned'] as const) {
  it(`[AC-B1-03zl#14] 订单申诉处理中后账户被${state}：账户申诉照常受理（prev_risk_state=${state}），订单申诉原样保留`, async () => {
    const m = await member(f, 'normal');
    const orderId = await m.voided();
    const order = await accepted(await submitOrder(m, orderId));
    expect(order).toMatchObject({ target_type: 'order', target_id: orderId });
    expect((await orderDetail(m, orderId)).appeal_pending).toBe(true);
    const orderRow = await appealRow(m, order.appeal_id);
    await m.set(state);
    f.clock.advanceMs(1000);
    const account = await accepted(await submitAccount(m));
    expect(account.appeal_id).not.toBe(order.appeal_id);
    expect(account).toMatchObject({ target_type: 'account', target_id: m.uid, attempt_no: 1 });
    expect(await appealRow(m, account.appeal_id)).toMatchObject({ prev_risk_state: state });
    expect(await states(f, m)).toMatchObject([{ state: 'appealing' }]);
    expect(await appealRow(m, order.appeal_id)).toEqual(orderRow);
    expect(await accepted(await submitOrder(m, orderId, '订单再申诉'))).toEqual(order);
  });
}

it('[AC-B1-03zl#15] 计次互不共用：订单申诉用满 3 次（30418）后，冻结账户的账户申诉仍从第 1 次计', async () => {
  const m = await member(f, 'frozen');
  const orderId = await m.voided();
  for (const attempt of [1, 2, 3]) {
    f.clock.advanceMs(1000);
    const data = await accepted(await submitOrder(m, orderId, `第 ${attempt} 次`));
    expect(data).toMatchObject({ target_type: 'order', attempt_no: attempt });
    await close(f, data.appeal_id);
  }
  await rejected(await submitOrder(m, orderId), 422, 30418);
  expect(await states(f, m)).toMatchObject([{ state: 'frozen' }]);
  f.clock.advanceMs(1000);
  const account = await accepted(await submitAccount(m));
  expect(account).toMatchObject({ target_type: 'account', attempt_no: 1, status: 'processing' });
  expect(await states(f, m)).toMatchObject([{ state: 'appealing' }]);
});

it('[AC-B1-03zl#16] 计次互不共用：账户申诉用满 3 次（30418）后，同一用户的风控作废订单仍可申诉、从第 1 次计', async () => {
  const m = await member(f, 'frozen');
  const orderId = await m.voided();
  const d = driver(m);
  for (const attempt of [1, 2, 3]) {
    f.clock.advanceMs(1000);
    const data = await accepted(await submitAccount(m, `第 ${attempt} 次账户申诉`));
    expect(data).toMatchObject({ target_type: 'account', attempt_no: attempt });
    await uphold(d, data.appeal_id);
  }
  await rejected(await submitAccount(m), 422, 30418);
  const frozen = await states(f, m);
  expect(frozen).toMatchObject([{ state: 'frozen' }]);
  f.clock.advanceMs(1000);
  const order = await accepted(await submitOrder(m, orderId));
  expect(order).toMatchObject({
    target_type: 'order',
    target_id: orderId,
    attempt_no: 1,
    status: 'processing',
  });
  expect(await states(f, m)).toEqual(frozen);
});

it('[AC-B1-03zl#17] 留痕同账户申诉：订单申诉提交写下与账户申诉同类的审计记录与幂等占位，不发 risk.state_changed', async () => {
  const m = await member(f, 'banned');
  const orderId = await m.voided();
  const kinds = (rows: Awaited<ReturnType<typeof audits>>) =>
    rows.map((row) => ({ action: row.action, actor: row.actor }));

  const start = await audits(f, m.appId);
  const eventsStart = await events(f, m);
  const accountKey = randomUUID();
  const accountBody = { target_type: 'account', content: '账户申诉' };
  const account = await accepted(
    await m.send('POST', PATH, accountBody, { 'idempotency-key': accountKey }),
  );
  expect(account).toMatchObject({ target_type: 'account' });
  const afterAccount = await audits(f, m.appId);
  const eventsAfterAccount = await events(f, m);
  expect(eventsAfterAccount).toHaveLength(eventsStart.length + 1);

  f.clock.advanceMs(1000);
  const orderKey = randomUUID();
  const order = await accepted(
    await submitOrder(m, orderId, '订单申诉', { 'idempotency-key': orderKey }),
  );
  expect(order).toMatchObject({ target_type: 'order', target_id: orderId });
  const afterOrder = await audits(f, m.appId);

  // 编排 D10-1181 / D10-1192：「审计同账户申诉」即账户申诉现口径（提交暂不写 audit_logs，见 appeals.ts TODO），只要求两者增量同类，不另加审计要求。
  expect(kinds(afterOrder.slice(afterAccount.length))).toEqual(
    kinds(afterAccount.slice(start.length)),
  );
  expect(await claims(f, m.appId, accountKey)).toHaveLength(1);
  expect(await claims(f, m.appId, orderKey)).toHaveLength(1);
  // OPS-07: no change of the account's risk state, so no risk.state_changed.
  expect(await events(f, m)).toEqual(eventsAfterAccount);
});
