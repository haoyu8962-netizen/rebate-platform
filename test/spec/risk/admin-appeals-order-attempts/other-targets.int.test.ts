// B1-03zn (BR-ID-36 细则「维持后再申诉」: the count is per object — one account (per penalty), one
// order, one blocked request): the order's per-order count applies to the order only. A user whose
// order already has three appeals (the last revoked) is refused 30418 on that order, while the same
// user's account appeals (two upheld on the current penalty) and blocked-request appeals (two upheld)
// are counted as before (B1-03ze): the console registers their third appeal.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DAY,
  accountAppeal,
  appealOf,
  at,
  auditsOf,
  blocked,
  blockedAppeal,
  member,
  refused,
  restricted,
  snapshot,
  voidedOrder,
} from '../admin-appeals-write/kit.ts';
import { VOIDED, orderRows, orderState, registerBody, seedHistory, setup, tick } from './kit.ts';

const h = useHarness();

it('[AC-B1-03zn#7] 账户申诉计次照旧：同一处罚已维持 2 次 → 代登记第 3 次成功（appealing）；同一用户的订单已有 3 条（末条撤销）→ 订单代登记 30418，两者互不计入', async () => {
  const c = await setup(h);
  const penalty = at(-20 * DAY);
  const user = await member(c, { state: null });
  await restricted(c, user.id, 'banned', penalty);
  for (let n = 0; n < 2; n += 1) {
    await accountAppeal(c, user, 'banned', {
      status: 'upheld',
      penalty_started_at: penalty,
      created_at: at(-(15 - 3 * n) * DAY),
    });
  }
  const o = await voidedOrder(c, user);
  await seedHistory(c, user, o, ['upheld', 'upheld', 'revoked']);
  expect(await orderState(c, o.order_id)).toEqual(VOIDED);
  tick(c);
  const before = await snapshot(c);
  await refused(await c.register(registerBody('order', o.order_id)), 30418);
  expect(await snapshot(c)).toEqual(before);
  expect(await orderRows(c, o.order_id)).toHaveLength(3);
  tick(c);
  const d = await appealOf(await c.register(registerBody('account', user.id, '账户被封禁，申诉')));
  expect(d).toMatchObject({
    target_type: 'account',
    target_id: user.id,
    prev_risk_state: 'banned',
    status: 'processing',
    source: 'admin',
    risk_state: 'appealing',
  });
  expect(await auditsOf(c, 'appeal_register')).toHaveLength(1);
});

it('[AC-B1-03zn#8] 被拦请求申诉计次照旧：提现被拦已维持 2 次 → 代登记第 3 次成功；同一用户的订单已有 3 条（末条撤销）→ 订单代登记 30418，两者互不计入', async () => {
  const c = await setup(h);
  const user = await member(c);
  const b = await blocked(c, {
    request_type: 'withdraw',
    user,
    rules: [{ rule_id: 'WITHDRAW_VELOCITY', dimension: 'alipay' }],
    blocked_at: at(-20 * DAY),
  });
  for (let n = 0; n < 2; n += 1) {
    await blockedAppeal(c, b, { status: 'upheld', created_at: at(-(15 - 3 * n) * DAY) });
  }
  const o = await voidedOrder(c, user);
  await seedHistory(c, user, o, ['upheld', 'upheld', 'revoked']);
  expect(await orderState(c, o.order_id)).toEqual(VOIDED);
  tick(c);
  const before = await snapshot(c);
  await refused(await c.register(registerBody('order', o.order_id)), 30418);
  expect(await snapshot(c)).toEqual(before);
  expect(await orderRows(c, o.order_id)).toHaveLength(3);
  tick(c);
  const d = await appealOf(
    await c.register(registerBody('blocked_request', b.id, '提现被拦，申诉')),
  );
  expect(d).toMatchObject({
    user: { user_id: user.id },
    target_type: 'blocked_request',
    target_id: b.id,
    request_type: 'withdraw',
    status: 'processing',
    source: 'admin',
  });
  expect(await auditsOf(c, 'appeal_register')).toHaveLength(1);
});
