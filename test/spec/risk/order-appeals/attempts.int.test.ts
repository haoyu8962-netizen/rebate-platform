// B1-03zl (BR-ID-36 细则「维持后再申诉」; CT-26e; 契约 submitAppeal): order appeals count per
// order, the first included, at most 3; the fourth after three upheld → HTTP 422 / 30418, nothing
// written. A processing appeal on the order is returned before the count is judged (never 30418).
// Another order of the same user starts again at 1. Real AppModule over HTTP; upheld appeals are
// closed by the fixture closer in ./kit.ts (the order stays voided).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attemptsById } from '../appeal-attempts/kit.ts';
import {
  accepted,
  appeals,
  audits,
  close,
  events,
  listed,
  member,
  openHttp,
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

async function snapshot(m: Member) {
  return {
    appeals: await appeals(f, m),
    states: await states(f, m),
    events: await events(f, m),
    audits: await audits(f, m.appId),
  };
}

/** A new appeal on `orderId` accepted as attempt `attempt`, then closed as upheld. */
async function round(m: Member, orderId: string, attempt: number) {
  f.clock.advanceMs(1000);
  const data = await accepted(await submitOrder(m, orderId, `第 ${attempt} 次订单申诉`));
  expect(data, `attempt ${attempt}`).toMatchObject({
    target_type: 'order',
    target_id: orderId,
    status: 'processing',
    attempt_no: attempt,
    can_resubmit: false,
  });
  await close(f, data.appeal_id);
  return data;
}

for (const state of ['normal', 'frozen', 'banned'] as const) {
  it(`[AC-B1-03zl#9] ${state}：同一订单第 1、2、3 次均被维持，第 4 次 HTTP 422 / 30418，不建单、状态不变`, async () => {
    const m = await member(f, state);
    const orderId = await m.voided();
    const ids: string[] = [];
    for (const attempt of [1, 2, 3]) ids.push((await round(m, orderId, attempt)).appeal_id);
    const before = await snapshot(m);
    f.clock.advanceMs(1000);
    await rejected(await submitOrder(m, orderId, '第 4 次订单申诉'), 422, 30418);
    expect(await snapshot(m)).toEqual(before);
    const list = await listed(await m.send('GET', PATH));
    expect(attemptsById(list.items)).toEqual({
      [ids[0]!]: { attempt_no: 1, can_resubmit: false },
      [ids[1]!]: { attempt_no: 2, can_resubmit: false },
      [ids[2]!]: { attempt_no: 3, can_resubmit: false },
    });
  });
}

it('[AC-B1-03zl#10] 按订单计次：订单 A 用满 3 次后 30418，同一用户的另一笔风控作废订单 B 从第 1 次计、可满 3 次', async () => {
  const m = await member(f, 'normal');
  const a = await m.voided();
  const b = await m.voided();
  const ids: Record<string, number> = {};
  for (const attempt of [1, 2, 3]) ids[(await round(m, a, attempt)).appeal_id] = attempt;
  await rejected(await submitOrder(m, a), 422, 30418);
  for (const attempt of [1, 2, 3]) ids[(await round(m, b, attempt)).appeal_id] = attempt;
  await rejected(await submitOrder(m, b), 422, 30418);
  const list = await listed(await m.send('GET', PATH));
  expect(list.items).toHaveLength(6);
  expect(
    Object.fromEntries(
      Object.entries(attemptsById(list.items)).map(([id, value]) => [id, value.attempt_no]),
    ),
  ).toEqual(ids);
});

it('[AC-B1-03zl#11] 第 3 次处理中再提交：返回第 3 次原单，不 30418、不新建', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  await round(m, orderId, 1);
  await round(m, orderId, 2);
  f.clock.advanceMs(1000);
  const third = await accepted(await submitOrder(m, orderId, '第 3 次订单申诉'));
  expect(third).toMatchObject({ attempt_no: 3, status: 'processing', can_resubmit: false });
  const before = await snapshot(m);
  f.clock.advanceMs(1000);
  expect(await accepted(await submitOrder(m, orderId, '再提交一次'))).toEqual(third);
  expect(await snapshot(m)).toEqual(before);
});

it('[AC-B1-03zl#12] 目标校验先于计次：订单 A 次数用满后，同 App 他人订单仍 30701、本人未作废订单仍 20001', async () => {
  const m = await member(f, 'normal');
  const orderId = await m.voided();
  for (const attempt of [1, 2, 3]) await round(m, orderId, attempt);
  await rejected(await submitOrder(m, orderId), 422, 30418);
  const before = await snapshot(m);
  await rejected(await submitOrder(m, await m.stranger()), 404, 30701);
  await rejected(
    await submitOrder(m, await m.own({ rebate_status: 'VOID', reason: 'REFUND' })),
    400,
    20001,
  );
  expect(await snapshot(m)).toEqual(before);
});
