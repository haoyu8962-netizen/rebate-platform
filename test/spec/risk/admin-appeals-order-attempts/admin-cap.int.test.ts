// B1-03zn (BR-ID-36 细则「维持后再申诉」; 编排 21:27): a console registration of an order appeal
// counts every appeal on the order — whoever filed it, whatever its outcome, revoked included —
// and never restarts: with three appeals on the order the registration is 30418 (HTTP 422, the
// error envelope of the admin contract), nothing written, no audit; the app's submission answers
// the same. The order stays voided by risk control throughout (a revoked appeal's recovery ticket
// is not processed), so the target is still appealable and only the count refuses.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  appealOf,
  auditsOf,
  member,
  refused,
  snapshot,
  voidedOrder,
} from '../admin-appeals-write/kit.ts';
import { listed, rejected } from '../appeals/http-kit.ts';
import {
  VOIDED,
  appUser,
  attemptsOf,
  closeAppeal,
  orderRows,
  orderState,
  registerBody,
  seedHistory,
  setup,
  tick,
  type Outcome,
} from './kit.ts';

const h = useHarness();

const HISTORIES: readonly { readonly label: string; readonly outcomes: readonly Outcome[] }[] = [
  { label: '维持、维持、撤销', outcomes: ['upheld', 'upheld', 'revoked'] },
  { label: '撤销、撤销、撤销', outcomes: ['revoked', 'revoked', 'revoked'] },
  { label: '维持、撤销、撤销', outcomes: ['upheld', 'revoked', 'revoked'] },
  { label: '撤销、维持、撤销', outcomes: ['revoked', 'upheld', 'revoked'] },
];

it.each(HISTORIES)(
  '[AC-B1-03zn#1] 订单已有 3 条申诉（$label），订单仍为风控作废 → 后台代登记 30418，不建单、不写审计；用户端提交同样 30418',
  async ({ outcomes }) => {
    const c = await setup(h);
    const user = await member(c);
    const o = await voidedOrder(c, user);
    await seedHistory(c, user, o, outcomes);
    const u = await appUser(c, user);
    expect(await orderState(c, o.order_id)).toEqual(VOIDED);
    tick(c);
    const before = await snapshot(c);
    await refused(await c.register(registerBody('order', o.order_id)), 30418);
    expect(await snapshot(c)).toEqual(before);
    expect(await auditsOf(c, 'appeal_register')).toEqual([]);
    await rejected(await u.submit(o.order_id), 422, 30418);
    expect(await orderRows(c, o.order_id)).toHaveLength(3);
  },
);

it('[AC-B1-03zn#2] 撤销不重算：后台代登记的第 1、2、3 次都被撤销（订单仍为风控作废），第 4 次代登记 30418；用户端列表里这三条依次为第 1、2、3 次', async () => {
  const c = await setup(h);
  const user = await member(c);
  const o = await voidedOrder(c, user);
  const u = await appUser(c, user);
  const ids: string[] = [];
  for (const attempt of [1, 2, 3]) {
    tick(c);
    const d = await appealOf(
      await c.register(registerBody('order', o.order_id, `第 ${attempt} 次代登记的订单申诉`)),
    );
    expect(d, `registration ${attempt}`).toMatchObject({
      target_type: 'order',
      target_id: o.order_id,
      status: 'processing',
      source: 'admin',
    });
    expect(ids, `registration ${attempt} is a new appeal`).not.toContain(d.appeal_id);
    ids.push(d.appeal_id);
    await closeAppeal(c, d.appeal_id, 'revoked');
  }
  expect(await orderState(c, o.order_id)).toEqual(VOIDED);
  tick(c);
  const before = await snapshot(c);
  await refused(await c.register(registerBody('order', o.order_id, '第 4 次代登记')), 30418);
  expect(await snapshot(c)).toEqual(before);
  expect(await auditsOf(c, 'appeal_register')).toHaveLength(3);
  const list = await listed(await u.list());
  expect(attemptsOf(list.items)).toEqual({
    [ids[0]!]: { attempt_no: 1, can_resubmit: false },
    [ids[1]!]: { attempt_no: 2, can_resubmit: false },
    [ids[2]!]: { attempt_no: 3, can_resubmit: false },
  });
});
