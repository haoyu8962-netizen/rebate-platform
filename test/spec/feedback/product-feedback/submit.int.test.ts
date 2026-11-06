// B1-28p: POST /v1/products/{product_key}/feedback records one row of app.product_feedbacks
// (CT-26q submitProductFeedback; 08 BR-ID-02 细则「商品反馈与进店」: guests who accepted the privacy
// policy and logged-in users may submit, counted by device, a login also keeps user_id; BR-ID-30
// 细则「商品反馈记录」: only the listed fields are kept). Idempotent: a replay of the same
// Idempotency-Key answers the first result and writes nothing more.
// Only the orchestrator runs this file, with the shared integration global setup.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  NOW,
  PRODUCT_KEY,
  QUOTED_AT,
  accepted,
  answered,
  feedbackBody,
  feedbackRows,
  login,
  newAppId,
  registerDevice,
  seedLink,
  submit,
  suite,
  unregisteredDevice,
  withdrawPrivacy,
} from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it('[AC-B1-28p#1] 已同意隐私政策的游客（已注册设备、签名、无令牌）提交成功：记一条，带设备标识，不带 user_id，字段照请求原样', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const body = feedbackBody(linkId, {
    item_ref: 'synthetic-item-ref-0001',
    reason: 'rebate',
    note: '返利和页面不一样',
  });
  const id = accepted(h, await submit(h, device, body));
  expect(await feedbackRows(h.db, appId)).toEqual([
    {
      id,
      app_id: appId,
      device_id: device.id,
      user_id: null,
      platform: 'jd',
      product_key: PRODUCT_KEY,
      item_ref: 'synthetic-item-ref-0001',
      link_id: linkId,
      shown_final_price_fen: '12900',
      shown_rebate_fen: '350',
      quoted_at: new Date(QUOTED_AT),
      reason: 'rebate',
      note: '返利和页面不一样',
      created_at: new Date(NOW),
    },
  ]);
}, 60_000);

it('[AC-B1-28p#2] 登录用户提交成功：记录另带 user_id，设备标识是签名设备', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const user = await login(h, device);
  const linkId = await seedLink(h, appId);
  const id = accepted(
    h,
    await submit(h, device, feedbackBody(linkId, { reason: 'info' }), { token: user.token }),
  );
  const rows = await feedbackRows(h.db, appId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id,
    app_id: appId,
    device_id: device.id,
    user_id: user.uid,
    product_key: PRODUCT_KEY,
    link_id: linkId,
    reason: 'info',
    item_ref: null,
    note: null,
    created_at: new Date(NOW),
  });
}, 60_000);

it.each([
  ['price', null, null],
  ['other', 0, '图片和标题对不上'],
  ['info', null, '价'.repeat(100)],
] as const)(
  '[AC-B1-28p#3] 原因 %s、返利 %s、说明 %j 都按契约收下：返利 null 存 null，说明最多 100 字',
  async (reason, rebate, note) => {
    const h = use();
    const appId = newAppId();
    const device = await registerDevice(h, appId);
    const linkId = await seedLink(h, appId);
    const body = feedbackBody(linkId, { reason, shown_rebate_fen: rebate, note });
    const id = accepted(h, await submit(h, device, body));
    const rows = await feedbackRows(h.db, appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      reason,
      shown_rebate_fen: rebate === null ? null : String(rebate),
      note,
    });
  },
  60_000,
);

it('[AC-B1-28p#4] 不带 note 与 item_ref 也收下，两列存 null', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const body = feedbackBody(linkId);
  delete body['note'];
  const id = accepted(h, await submit(h, device, body));
  const rows = await feedbackRows(h.db, appId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id, note: null, item_ref: null });
}, 60_000);

it('[AC-B1-28p#5] 设备未注册（未经隐私同意领取 device_id）的签名请求 10402，不写；同 app 已注册设备照常提交', async () => {
  const h = use();
  const appId = newAppId();
  const linkId = await seedLink(h, appId);
  const device = await registerDevice(h, appId);
  accepted(h, await submit(h, device, feedbackBody(linkId)));
  answered(h, await submit(h, unregisteredDevice(appId), feedbackBody(linkId)), 10402);
  const rows = await feedbackRows(h.db, appId);
  expect(rows.map((row) => row.device_id)).toEqual([device.id]);
}, 60_000);

it('[AC-B1-28p#6] 撤回隐私同意后（设备失效）再提交 10402，不再写；撤回前的那条保留', async () => {
  const h = use();
  const appId = newAppId();
  const linkId = await seedLink(h, appId);
  const device = await registerDevice(h, appId);
  const id = accepted(h, await submit(h, device, feedbackBody(linkId)));
  await withdrawPrivacy(h, device);
  answered(h, await submit(h, device, feedbackBody(linkId, { reason: 'other' })), 10402);
  expect((await feedbackRows(h.db, appId)).map((row) => row.id)).toEqual([id]);
}, 60_000);

it('[AC-B1-28p#7] 幂等：同一 Idempotency-Key 重放返回同一 feedback_id，只有一条；换键是新的一条', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const body = feedbackBody(linkId);
  const first = await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0001' });
  const id = accepted(h, first);
  h.clock.advanceMs(1_000);
  const replay = await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0001' });
  expect(accepted(h, replay)).toBe(id);
  expect(replay.json<unknown>()).toEqual(first.json<unknown>());
  expect((await feedbackRows(h.db, appId)).map((row) => row.id)).toEqual([id]);
  const other = accepted(
    h,
    await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0002' }),
  );
  expect(other).not.toBe(id);
  expect((await feedbackRows(h.db, appId)).map((row) => row.id)).toEqual([id, other]);
}, 60_000);

it('[AC-B1-28p#8] 幂等：同键不同请求体 20901，不写第二条', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const id = accepted(
    h,
    await submit(h, device, feedbackBody(linkId), { idempotencyKey: 'idem-idem-idem-0003' }),
  );
  answered(
    h,
    await submit(h, device, feedbackBody(linkId, { reason: 'other' }), {
      idempotencyKey: 'idem-idem-idem-0003',
    }),
    20901,
  );
  expect((await feedbackRows(h.db, appId)).map((row) => row.id)).toEqual([id]);
}, 60_000);

it('[AC-B1-28p#9] 游客与登录用户各提交一条：只有登录那条带 user_id，设备相同', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const user = await login(h, device);
  const linkId = await seedLink(h, appId);
  const guestId = accepted(h, await submit(h, device, feedbackBody(linkId)));
  h.clock.advanceMs(1_000);
  const userId = accepted(h, await submit(h, device, feedbackBody(linkId), { token: user.token }));
  const rows = await feedbackRows(h.db, appId);
  expect(rows.map((row) => [row.id, row.device_id, row.user_id])).toEqual([
    [guestId, device.id, null],
    [userId, device.id, user.uid],
  ]);
}, 60_000);
