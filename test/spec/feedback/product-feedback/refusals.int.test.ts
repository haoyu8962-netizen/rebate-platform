// B1-28p: refusals of POST /v1/products/{product_key}/feedback, none of which writes a row
// (CT-26q submitProductFeedback x-error-codes): feedback.enabled off → 30145; a link_id that does
// not exist or belongs to another app → 30144; any field BR-ID-30 细则「商品反馈记录」 does not list
// (contact fields included) or a value outside the contract → 20001. Each case first shows that the
// same tenant accepts a valid request, so the refusal is the rule and not a missing route.
// Only the orchestrator runs this file, with the shared integration global setup.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  accepted,
  answered,
  feedbackBody,
  feedbackRows,
  login,
  newAppId,
  registerDevice,
  seedLink,
  setConfig,
  submit,
  suite,
  type Harness,
} from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);

/** A tenant with one registered device, one link and one accepted feedback. */
async function tenant(h: Harness) {
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const first = accepted(h, await submit(h, device, feedbackBody(linkId)));
  return { appId, device, linkId, first };
}

it('[AC-B1-28p#10] feedback.enabled 关 → 30145，游客与登录用户都不写；同时开着的 app 照常收', async () => {
  const h = use();
  const open = await tenant(h);
  await setConfig(h, open.appId, 'feedback.enabled', true);
  const second = accepted(h, await submit(h, open.device, feedbackBody(open.linkId)));
  const appId = newAppId();
  await setConfig(h, appId, 'feedback.enabled', false);
  const device = await registerDevice(h, appId);
  const user = await login(h, device);
  const linkId = await seedLink(h, appId);
  answered(h, await submit(h, device, feedbackBody(linkId)), 30145);
  answered(h, await submit(h, device, feedbackBody(linkId), { token: user.token }), 30145);
  expect(await feedbackRows(h.db, appId)).toEqual([]);
  expect((await feedbackRows(h.db, open.appId)).map((row) => row.id).sort()).toEqual(
    [open.first, second].sort(),
  );
}, 60_000);

it('[AC-B1-28p#11] feedback.enabled 关时先于 link_id 核对：不存在的 link_id 也是 30145', async () => {
  const h = use();
  const open = await tenant(h);
  answered(h, await submit(h, open.device, feedbackBody(randomUUID())), 30144);
  const appId = newAppId();
  await setConfig(h, appId, 'feedback.enabled', false);
  const device = await registerDevice(h, appId);
  answered(h, await submit(h, device, feedbackBody(randomUUID())), 30145);
  expect(await feedbackRows(h.db, appId)).toEqual([]);
}, 60_000);

it('[AC-B1-28p#12] link_id 不存在 → 30144，不写', async () => {
  const h = use();
  const t = await tenant(h);
  answered(h, await submit(h, t.device, feedbackBody(randomUUID())), 30144);
  expect((await feedbackRows(h.db, t.appId)).map((row) => row.id)).toEqual([t.first]);
}, 60_000);

it('[AC-B1-28p#13] link_id 属于别的 app → 30144，两个 app 都不多写', async () => {
  const h = use();
  const t = await tenant(h);
  const other = await tenant(h);
  answered(h, await submit(h, t.device, feedbackBody(other.linkId)), 30144);
  const user = await login(h, t.device);
  answered(h, await submit(h, t.device, feedbackBody(other.linkId), { token: user.token }), 30144);
  expect((await feedbackRows(h.db, t.appId)).map((row) => row.id)).toEqual([t.first]);
  expect((await feedbackRows(h.db, other.appId)).map((row) => row.id)).toEqual([other.first]);
}, 60_000);

it.each([
  'phone',
  'contact',
  'mobile',
  'wechat',
  'email',
  'qq',
  'user_id',
  'device_id',
  'product_key',
  'feedback_id',
  'created_at',
])(
  '[AC-B1-28p#14] 未定义字段 %s（含联系方式）→ 20001，不写',
  async (field) => {
    const h = use();
    const t = await tenant(h);
    const body = feedbackBody(t.linkId, { [field]: 'synthetic-undefined-field' });
    answered(h, await submit(h, t.device, body), 20001);
    expect((await feedbackRows(h.db, t.appId)).map((row) => row.id)).toEqual([t.first]);
  },
  60_000,
);

it.each([
  ['reason', 'wrong'],
  ['reason', 'PRICE'],
  ['reason', ''],
  ['reason', null],
  ['platform', 'amazon'],
  ['shown_final_price_fen', -1],
  ['shown_final_price_fen', null],
  ['shown_final_price_fen', '12900'],
  ['shown_rebate_fen', -1],
  ['quoted_at', 'not-a-time'],
  ['note', '价'.repeat(101)],
  ['note', 5],
  ['item_ref', ''],
] as const)(
  '[AC-B1-28p#15] %s = %j 不符合契约 → 20001，不写',
  async (field, value) => {
    const h = use();
    const t = await tenant(h);
    answered(h, await submit(h, t.device, feedbackBody(t.linkId, { [field]: value })), 20001);
    expect((await feedbackRows(h.db, t.appId)).map((row) => row.id)).toEqual([t.first]);
  },
  60_000,
);

it.each([
  'platform',
  'link_id',
  'shown_final_price_fen',
  'shown_rebate_fen',
  'quoted_at',
  'reason',
])(
  '[AC-B1-28p#16] 缺必填字段 %s → 20001，不写',
  async (field) => {
    const h = use();
    const t = await tenant(h);
    const body = feedbackBody(t.linkId);
    delete body[field];
    answered(h, await submit(h, t.device, body), 20001);
    expect((await feedbackRows(h.db, t.appId)).map((row) => row.id)).toEqual([t.first]);
  },
  60_000,
);
