// B1-02y: where stage ⑫ sits (规划/08 BR-ID-01 判定顺序: ④ 幂等 → ④a 10405 → ⑤ 10006 → … → ⑫ 10003
// → ⑬ 42901; 细则: a 10405 consumes no step_up_token and stops every later check; BR-ID-08: the
// step-up check only runs after an idempotency miss; ruling §9.3 #1 #4 #7). An earlier stage that
// refuses leaves the token unreserved (the same token passes afterwards and is consumed once);
// a full rate limit bucket does not answer before 10003.
// B1-02zk (编排裁定 D10-265): POST /v1/withdrawals has its own order (08 BR-WDR-03 细则「提交接口的
// 检查顺序」: ⓪a 10405 → ① 30306 → ② 10003 → ③ 10006), so "⑤ before ⑫" for a request without a
// token is shown on POST /v1/me/phone (BR-ID-01 global order; POST /v1/me/deletion is on the
// BR-ID-31 10006 whitelist); the withdrawal case is tested with the withdraw lane (B2-05d).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  failed,
  openFixture,
  sendPhone,
  stepUpRequired,
  succeeded,
  user,
  type Fixture,
} from './kit.ts';

let f: Fixture;
beforeAll(async () => {
  f = await openFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
});

it('[AC-B1-02y#18] 版本过低（④a 10405）先命中时不校验、不占用 token；升级后沿用原键通过，之后该 token 不可再用', async () => {
  const u = await user(f, { minVersion: '2.0.0' });
  const token = await u.mint('phone_change');
  const key = randomUUID();
  const old = await u.send('phone', { stepUp: token, key, version: '1.0.0' });
  failed(old, 403, 10405);
  // 10405 wins over a missing or invalid token as well: ⑫ comes later.
  failed(await u.send('phone', { stepUp: null, version: '1.0.0' }), 403, 10405);
  expect(u.handled()).toBe(0);
  succeeded(await u.send('phone', { stepUp: token, key, version: '2.0.0' }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('phone', { stepUp: token, version: '2.0.0' }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#19] 封禁（⑤ 10006）先命中时不占用 token；解封后同一 token 通过一次', async () => {
  const u = await user(f);
  const set = (state: 'banned' | 'normal') =>
    f.kit.db.transaction().execute((trx) =>
      f.risk.setRiskState(trx, {
        app_id: u.appId,
        user_id: u.uid,
        state,
        reason: 'b1-02y fixture',
        reason_category: state === 'normal' ? null : 'other',
        frozen_until: null,
        changed_by: 'fixture_operator',
      }),
    );
  await set('banned');
  const token = await u.mint('phone_change');
  const key = randomUUID();
  failed(await u.send('phone', { stepUp: token, key }), 403, 10006);
  // Without a token: on a BR-ID-01 global-order operation ⑤ answers before ⑫ (B1-02zk, D10-265).
  failed(await sendPhone(f, u, { stepUp: null }), 403, 10006);
  expect(u.handled()).toBe(0);
  await set('normal');
  // The same request once unbanned reaches ⑫: 10003 was really behind 10006.
  failed(await sendPhone(f, u, { stepUp: null }), 403, 10003);
  succeeded(await u.send('phone', { stepUp: token, key }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('phone', { stepUp: token }));
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#20] 限流桶已满时先回 10003 而不是 42901；token 有效时才轮到限流', async () => {
  const u = await user(f, {
    config: {
      'rate_limit.ops': { requestDeletion: 'b1_02y_stepup' },
      'rate_limit.b1_02y_stepup': { user: [{ limit: 1, window_sec: 3600 }] },
    },
  });
  succeeded(await u.send('deletion', { stepUp: await u.mint() }));
  expect(u.handled()).toBe(1);
  // The bucket is empty now: a request without a valid token is refused by ⑫ first.
  await stepUpRequired(await u.send('deletion', { stepUp: null }));
  await stepUpRequired(await u.send('deletion', { stepUp: await u.mint('withdraw') }));
  // A valid token gets through ⑫ and is refused by ⑬: the bucket really is empty.
  const limited = await u.send('deletion', { stepUp: await u.mint() });
  failed(limited, 429, 42901);
  expect(u.handled()).toBe(1);
});

it('[AC-B1-02y#21] 未带 Idempotency-Key 的请求由幂等先拒（20001），不进入 ⑫、不占用 token', async () => {
  const u = await user(f);
  const token = await u.mint();
  const missing = await u.send('deletion', { stepUp: token, key: null });
  failed(missing, 400, 20001);
  expect(missing.json()).toMatchObject({ data: { fields: ['idempotency-key'] } });
  failed(await u.send('deletion', { stepUp: null, key: null }), 400, 20001);
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
});

it('[AC-B1-02y#22] 已作废的幂等键（20903）不校验、不占用 token；同一 token 换新键通过一次', async () => {
  const u = await user(f);
  const token = await u.mint();
  const key = randomUUID();
  const abandoned = await f.idempotency.abandon({
    appId: u.appId,
    userId: u.uid,
    action: 'account_deletion',
    key,
    traceId: randomUUID(),
  });
  expect(abandoned.status).toBe(200);
  failed(await u.send('deletion', { stepUp: token, key }), 409, 20903);
  failed(await u.send('deletion', { stepUp: null, key }), 409, 20903);
  expect(u.handled()).toBe(0);
  succeeded(await u.send('deletion', { stepUp: token }));
  expect(u.handled()).toBe(1);
  await stepUpRequired(await u.send('deletion', { stepUp: token }));
});
