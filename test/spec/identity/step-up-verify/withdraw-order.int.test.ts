// B1-02zk (编排裁定 D10-265), split out for the withdraw lane (B2-05d): the withdrawal side of
// test/spec/identity/step-up-verify/order.int.test.ts [AC-B1-02y#19]. Place it next to that file
// (test/spec/identity/step-up-verify/); it uses only kit.ts exports that already exist on main
// (openFixture, user, failed, stepUpRequired, succeeded, Fixture, User), no B1-02zk addition.
// It is red until POST /v1/withdrawals follows 08 BR-WDR-03 细则「提交接口的检查顺序」.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  failed,
  openFixture,
  stepUpRequired,
  succeeded,
  user,
  type Fixture,
  type User,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

const riskState = (u: User, state: 'banned' | 'normal') =>
  f.kit.db.transaction().execute((trx) =>
    f.risk.setRiskState(trx, {
      app_id: u.appId,
      user_id: u.uid,
      state,
      reason: 'b1-02zk fixture',
      reason_category: state === 'normal' ? null : 'other',
      frozen_until: null,
      changed_by: 'fixture_operator',
    }),
  );

// 08 BR-WDR-03 细则「提交接口的检查顺序」（编排裁定 D10-217、D10-233 ①；D10-265）: POST /v1/withdrawals
// judges ② step-up (10003) before ③ banned (10006, BR-ID-01 ⑤). A request that gets through ② and
// is refused by ③ leaves its token unreserved.
// B1-02zzzc (D10-1665, D10-1702): ② is cancelled, so a banned user is refused by ③ with or without a
// token, and once unbanned the withdrawal is accepted whatever X-Step-Up-Token it carries (neither
// judged nor consumed).
it('[AC-B1-02zk#1] 提现提交：封禁用户不论带不带 token 都回 10006 且不建单，解封后同一 token 换新键也照常受理', async () => {
  const u = await user(f);
  await riskState(u, 'banned');
  failed(await u.send('withdraw', { stepUp: null }), 403, 10006);
  failed(await u.send('withdraw', { stepUp: await u.mint('account_deletion') }), 403, 10006);
  expect(u.handled()).toBe(0);
  const token = await u.mint('withdraw');
  const key = randomUUID();
  failed(await u.send('withdraw', { stepUp: token, key }), 403, 10006);
  failed(await u.send('withdraw', { stepUp: token }), 403, 10006);
  expect(u.handled()).toBe(0);
  await riskState(u, 'normal');
  succeeded(await u.send('withdraw', { stepUp: token, key }));
  expect(u.handled()).toBe(1);
  succeeded(await u.send('withdraw', { stepUp: token }));
  expect(u.handled()).toBe(2);
});

// B1-02zzzc: stepUpRequired is no longer called above; the import stays (frozen), used here.
export { stepUpRequired };
