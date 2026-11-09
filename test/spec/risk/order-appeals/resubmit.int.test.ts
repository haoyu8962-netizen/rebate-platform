// B1-03zl (BR-ID-36 细则「维持后再申诉」「能否再次申诉」; CT-26e; 编排 D10-1192 ②): in GET /v1/me/appeals
// an order appeal has can_resubmit=true only when it is the latest appeal on its order, it was
// upheld, the order's count is not used up (the same rule as 30418) and the order is still voided by
// risk control (rebate_status VOID with reason BLACKLIST, the voidedOrderOwner rule); otherwise
// false. The account's own risk state plays no part. Real AppModule over HTTP; upheld appeals are
// closed by the fixture closer in ./kit.ts (the order stays as it is).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { attemptsById } from '../appeal-attempts/kit.ts';
import {
  accepted,
  close,
  listed,
  member,
  openHttp,
  orderAppeals,
  PATH,
  rejected,
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

async function list(m: Member) {
  return listed(await m.send('GET', PATH));
}

async function attemptsListed(m: Member) {
  return attemptsById((await list(m)).items);
}

/** A new appeal on `orderId` accepted as attempt `attempt` (processing: never resubmittable). */
async function submitted(m: Member, orderId: string, attempt: number) {
  f.clock.advanceMs(1000);
  const data = await accepted(await submitOrder(m, orderId, `第 ${attempt} 次订单申诉`));
  expect(data, `attempt ${attempt}`).toMatchObject({
    target_type: 'order',
    target_id: orderId,
    status: 'processing',
    attempt_no: attempt,
    can_resubmit: false,
  });
  return data;
}

for (const state of ['normal', 'banned'] as const) {
  it(`[AC-B1-03zl#20] ${state}：同一订单第 1 次被维持、订单仍 VOID + BLACKLIST、次数未满 → 列表 can_resubmit=true；再提交后旧单变 false；第 3 次被维持（次数用尽）→ false`, async () => {
    const m = await member(f, state);
    const orderId = await m.voided();

    const first = await submitted(m, orderId, 1);
    await close(f, first.appeal_id);
    const closedAt = f.clock.now().toISOString();
    expect(await list(m)).toEqual({
      items: [{ ...first, status: 'upheld', closed_at: closedAt, can_resubmit: true }],
      next_cursor: null,
    });

    const second = await submitted(m, orderId, 2);
    expect(await attemptsListed(m)).toEqual({
      [first.appeal_id]: { attempt_no: 1, can_resubmit: false },
      [second.appeal_id]: { attempt_no: 2, can_resubmit: false },
    });
    await close(f, second.appeal_id);
    expect(await attemptsListed(m)).toEqual({
      [first.appeal_id]: { attempt_no: 1, can_resubmit: false },
      [second.appeal_id]: { attempt_no: 2, can_resubmit: true },
    });

    const third = await submitted(m, orderId, 3);
    await close(f, third.appeal_id);
    const usedUp = {
      [first.appeal_id]: { attempt_no: 1, can_resubmit: false },
      [second.appeal_id]: { attempt_no: 2, can_resubmit: false },
      [third.appeal_id]: { attempt_no: 3, can_resubmit: false },
    };
    expect(await attemptsListed(m)).toEqual(usedUp);
    // Same rule as the refusal: the fourth is 30418 and the list does not change.
    f.clock.advanceMs(1000);
    await rejected(await submitOrder(m, orderId, '第 4 次订单申诉'), 422, 30418);
    expect(await attemptsListed(m)).toEqual(usedUp);
  });
}

it('[AC-B1-03zl#21] 只看该订单自己：订单 A 第 1 次被维持（true）时，同一用户订单 B 的处理中申诉为 false，B 被维持后各自 true', async () => {
  const m = await member(f, 'normal');
  const a = await m.voided();
  const b = await m.voided();
  const onA = await submitted(m, a, 1);
  await close(f, onA.appeal_id);
  const onB = await submitted(m, b, 1);
  expect(await attemptsListed(m)).toEqual({
    [onA.appeal_id]: { attempt_no: 1, can_resubmit: true },
    [onB.appeal_id]: { attempt_no: 1, can_resubmit: false },
  });
  await close(f, onB.appeal_id);
  expect(await attemptsListed(m)).toEqual({
    [onA.appeal_id]: { attempt_no: 1, can_resubmit: true },
    [onB.appeal_id]: { attempt_no: 1, can_resubmit: true },
  });
});

const NO_LONGER_VOIDED = [
  { label: '恢复为待结算 WAITING', patch: { rebate_status: 'WAITING', reason: null } },
  { label: '恢复为已结算 CREDITED', patch: { rebate_status: 'CREDITED', reason: null } },
  { label: '改为退款作废 VOID + REFUND', patch: { rebate_status: 'VOID', reason: 'REFUND' } },
] as const;

for (const { label, patch } of NO_LONGER_VOIDED) {
  it(`[AC-B1-03zl#22] 第 1 次被维持后订单不再是 VOID + BLACKLIST（${label}）→ can_resubmit=false，再提交 HTTP 400 / 20001、不新建`, async () => {
    const m = await member(f, 'normal');
    const orderId = await m.voided();
    const first = await submitted(m, orderId, 1);
    await close(f, first.appeal_id);
    // While the order is still risk-voided the appeal can be resubmitted.
    expect(await attemptsListed(m)).toEqual({
      [first.appeal_id]: { attempt_no: 1, can_resubmit: true },
    });

    f.clock.advanceMs(1000);
    const changed = await f.db
      .withSchema('app')
      .updateTable('orders')
      .set({ ...patch, updated_at: f.clock.now() })
      .where('app_id', '=', m.appId)
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    expect(changed.numUpdatedRows).toBe(1n);

    expect(await attemptsListed(m)).toEqual({
      [first.appeal_id]: { attempt_no: 1, can_resubmit: false },
    });
    await rejected(await submitOrder(m, orderId, '订单已恢复仍提交'), 400, 20001);
    expect(await orderAppeals(f, m.appId, orderId)).toHaveLength(1);
  });
}
