// B1-03zn (BR-ID-36 细则「维持后再申诉」「客服代为登记」; 编排 21:27): the app's submissions (POST
// /v1/me/appeals) and the console's registrations (POST /admin/v1/appeals) on one order are one
// count: the N-th appeal on the order, from either side, is attempt N; once three are on it both
// sides answer 30418 (app: HTTP 422 with the app error envelope; console: HTTP 422 with the admin
// error envelope), whether the third was upheld or revoked. A processing appeal on the order is
// returned by either side, never duplicated.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  appealOf,
  auditsOf,
  member,
  refused,
  snapshot,
  voidedOrder,
  type Member,
  type Order,
} from '../admin-appeals-write/kit.ts';
import { accepted, listed, rejected } from '../appeals/http-kit.ts';
import {
  VOIDED,
  appUser,
  attemptsOf,
  closeAppeal,
  orderRows,
  orderState,
  registerBody,
  setup,
  tick,
  type AppUser,
  type Context,
  type Outcome,
} from './kit.ts';

const h = useHarness();

/** The third appeal's outcome: either way it counts (revoked never restarts the count). */
const OUTCOMES: readonly Outcome[] = ['upheld', 'revoked'];

/** One new app submission on the order, accepted as attempt `attempt`. */
async function submitted(c: Context, u: AppUser, o: Order, attempt: number) {
  tick(c);
  const data = await accepted(await u.submit(o.order_id, `第 ${attempt} 次用户端订单申诉`));
  expect(data, `app submission ${attempt}`).toMatchObject({
    target_type: 'order',
    target_id: o.order_id,
    status: 'processing',
    attempt_no: attempt,
    can_resubmit: false,
  });
  return data.appeal_id;
}

/** One new console registration on the order (a new processing appeal, source admin). */
async function registered(c: Context, o: Order, user: Member, attempt: number) {
  tick(c);
  const d = await appealOf(
    await c.register(registerBody('order', o.order_id, `第 ${attempt} 次代登记的订单申诉`)),
  );
  expect(d, `console registration ${attempt}`).toMatchObject({
    user: { user_id: user.id },
    target_type: 'order',
    target_id: o.order_id,
    status: 'processing',
    source: 'admin',
  });
  return d.appeal_id;
}

/** Both sides refuse the order with 30418 and nothing is written. */
async function usedUp(c: Context, u: AppUser, o: Order, label: string) {
  expect(await orderState(c, o.order_id), `${label}: the order is still voided`).toEqual(VOIDED);
  tick(c);
  const before = await snapshot(c);
  const audits = (await auditsOf(c, 'appeal_register')).length;
  await refused(await c.register(registerBody('order', o.order_id)), 30418);
  await rejected(await u.submit(o.order_id), 422, 30418);
  expect(await snapshot(c), `${label}: nothing written`).toEqual(before);
  expect(await auditsOf(c, 'appeal_register')).toHaveLength(audits);
  expect(await orderRows(c, o.order_id)).toHaveLength(3);
}

it('[AC-B1-03zn#3] 两端交替且每次都撤销：用户端第 1 次、后台第 2 次、用户端第 3 次依次计次，之后后台与用户端都 30418；用户端列表为第 1、2、3 次', async () => {
  const c = await setup(h);
  const user = await member(c);
  const o = await voidedOrder(c, user);
  const u = await appUser(c, user);
  const first = await submitted(c, u, o, 1);
  await closeAppeal(c, first, 'revoked');
  const second = await registered(c, o, user, 2);
  await closeAppeal(c, second, 'revoked');
  const third = await submitted(c, u, o, 3);
  await closeAppeal(c, third, 'revoked');
  await usedUp(c, u, o, 'after three revoked appeals');
  const list = await listed(await u.list());
  expect(attemptsOf(list.items)).toEqual({
    [first]: { attempt_no: 1, can_resubmit: false },
    [second]: { attempt_no: 2, can_resubmit: false },
    [third]: { attempt_no: 3, can_resubmit: false },
  });
});

it('[AC-B1-03zn#4] 用户端 2 条（维持）+ 后台代登记第 3 条：处理中时用户端再提交返回这条（第 3 次）；第 3 条无论维持还是撤销，之后用户端与后台都 30418', async () => {
  const c = await setup(h);
  const user = await member(c);
  const u = await appUser(c, user);
  for (const outcome of OUTCOMES) {
    const o = await voidedOrder(c, user);
    for (const attempt of [1, 2]) {
      await closeAppeal(c, await submitted(c, u, o, attempt), 'upheld');
    }
    const third = await registered(c, o, user, 3);
    tick(c);
    expect(await accepted(await u.submit(o.order_id, '处理中再提交')), outcome).toMatchObject({
      appeal_id: third,
      status: 'processing',
      attempt_no: 3,
    });
    expect(await orderRows(c, o.order_id)).toHaveLength(3);
    await closeAppeal(c, third, outcome);
    await usedUp(c, u, o, `third ${outcome}`);
  }
});

it('[AC-B1-03zn#5] 后台代登记 2 条（维持）+ 用户端第 3 条：处理中时后台再登记返回这条；第 3 条无论维持还是撤销，之后后台与用户端都 30418', async () => {
  const c = await setup(h);
  const user = await member(c);
  const u = await appUser(c, user);
  for (const outcome of OUTCOMES) {
    const o = await voidedOrder(c, user);
    for (const attempt of [1, 2]) {
      await closeAppeal(c, await registered(c, o, user, attempt), 'upheld');
    }
    const third = await submitted(c, u, o, 3);
    tick(c);
    const again = await appealOf(
      await c.register(registerBody('order', o.order_id, '处理中再登记')),
    );
    expect(again, outcome).toMatchObject({
      appeal_id: third,
      status: 'processing',
      source: 'app',
    });
    expect(await orderRows(c, o.order_id)).toHaveLength(3);
    await closeAppeal(c, third, outcome);
    await usedUp(c, u, o, `third ${outcome}`);
  }
});
