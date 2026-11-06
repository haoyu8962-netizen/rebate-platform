// B1-28p: the per-device daily limit of product feedback (08 BR-ID-02 细则「商品反馈与进店」: each
// device at most feedback.daily_limit_per_device records per natural day in +08:00, default 20;
// over it → 42901 with Retry-After and nothing is written). Counted by device, whoever is logged in
// on it; another device of the same user or app has its own count; concurrent submissions of one
// device never pass the limit (brief §9.2 ③: advisory lock on (app, device), then count, then
// insert). The platform idempotency comes first: a replay of an accepted key still answers it.
// Only the orchestrator runs this file, with the shared integration global setup.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DEFAULT_DAILY_LIMIT,
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
  type Response,
} from './kit.ts';

const use = suite(createTestDatabase, acquireTestRedis);
const LIMIT_KEY = 'feedback.daily_limit_per_device';

it('[AC-B1-28p#17] 未配置上限时默认 20：同一设备当天第 21 条 42901 且不写，前 20 条都在', async () => {
  const h = use();
  const appId = newAppId();
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const ids: string[] = [];
  for (let index = 0; index < DEFAULT_DAILY_LIMIT; index += 1) {
    ids.push(accepted(h, await submit(h, device, feedbackBody(linkId))));
    h.clock.advanceMs(60_000);
  }
  answered(h, await submit(h, device, feedbackBody(linkId)), 42901);
  const rows = await feedbackRows(h.db, appId);
  expect(rows.map((row) => row.id)).toEqual(ids);
  expect(new Set(ids).size).toBe(DEFAULT_DAILY_LIMIT);
}, 120_000);

it('[AC-B1-28p#18] 配置的上限生效：feedback.daily_limit_per_device=3 时第 4 条 42901；另一 app 配 5 时可到 5 条', async () => {
  const h = use();
  const appId = newAppId();
  await setConfig(h, appId, LIMIT_KEY, 3);
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  for (let index = 0; index < 3; index += 1) {
    accepted(h, await submit(h, device, feedbackBody(linkId)));
  }
  answered(h, await submit(h, device, feedbackBody(linkId)), 42901);
  expect(await feedbackRows(h.db, appId)).toHaveLength(3);

  const wider = newAppId();
  await setConfig(h, wider, LIMIT_KEY, 5);
  const other = await registerDevice(h, wider);
  const otherLink = await seedLink(h, wider);
  for (let index = 0; index < 5; index += 1) {
    accepted(h, await submit(h, other, feedbackBody(otherLink)));
  }
  answered(h, await submit(h, other, feedbackBody(otherLink)), 42901);
  expect(await feedbackRows(h.db, wider)).toHaveLength(5);
}, 120_000);

it('[AC-B1-28p#19] 按 +08:00 自然日计：08:00 前后（跨 UTC 日界）同算一天，23:59:59 仍超限，次日 00:00 恢复', async () => {
  const h = use();
  h.clock.set('2026-11-06T07:00:00+08:00');
  const appId = newAppId();
  await setConfig(h, appId, LIMIT_KEY, 2);
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  // 07:30 +08:00 is the previous UTC day; 08:30 +08:00 is the same UTC day as 23:59 and 00:00.
  h.clock.set('2026-11-06T07:30:00+08:00');
  const early = accepted(h, await submit(h, device, feedbackBody(linkId)));
  h.clock.set('2026-11-06T08:30:00+08:00');
  const late = accepted(h, await submit(h, device, feedbackBody(linkId)));
  h.clock.set('2026-11-06T09:00:00+08:00');
  answered(h, await submit(h, device, feedbackBody(linkId)), 42901);
  h.clock.set('2026-11-06T23:59:59+08:00');
  answered(h, await submit(h, device, feedbackBody(linkId)), 42901);
  h.clock.set('2026-11-07T00:00:00+08:00');
  const next = accepted(h, await submit(h, device, feedbackBody(linkId)));
  h.clock.set('2026-11-07T00:00:30+08:00');
  const nextSecond = accepted(h, await submit(h, device, feedbackBody(linkId)));
  h.clock.set('2026-11-07T00:01:00+08:00');
  answered(h, await submit(h, device, feedbackBody(linkId)), 42901);
  const rows = await feedbackRows(h.db, appId);
  expect(rows.map((row) => row.id)).toEqual([early, late, next, nextSecond]);
  expect(rows.map((row) => row.created_at)).toEqual([
    new Date('2026-11-06T07:30:00+08:00'),
    new Date('2026-11-06T08:30:00+08:00'),
    new Date('2026-11-07T00:00:00+08:00'),
    new Date('2026-11-07T00:00:30+08:00'),
  ]);
}, 60_000);

it('[AC-B1-28p#20] 按设备计数：同一设备上游客与登录用户共用额度；同一用户换设备、同 app 另一台设备各有额度', async () => {
  const h = use();
  const appId = newAppId();
  await setConfig(h, appId, LIMIT_KEY, 2);
  const linkId = await seedLink(h, appId);
  const shared = await registerDevice(h, appId);
  const user = await login(h, shared);
  accepted(h, await submit(h, shared, feedbackBody(linkId)));
  accepted(h, await submit(h, shared, feedbackBody(linkId), { token: user.token }));
  answered(h, await submit(h, shared, feedbackBody(linkId)), 42901);
  answered(h, await submit(h, shared, feedbackBody(linkId), { token: user.token }), 42901);

  const second = await registerDevice(h, appId);
  const again = await login(h, second, user.uid);
  accepted(h, await submit(h, second, feedbackBody(linkId), { token: again.token }));
  accepted(h, await submit(h, second, feedbackBody(linkId), { token: again.token }));
  answered(h, await submit(h, second, feedbackBody(linkId), { token: again.token }), 42901);

  const stranger = await registerDevice(h, appId);
  accepted(h, await submit(h, stranger, feedbackBody(linkId)));

  const rows = await feedbackRows(h.db, appId);
  const perDevice = new Map<string, number>();
  for (const row of rows) perDevice.set(row.device_id, (perDevice.get(row.device_id) ?? 0) + 1);
  expect(Object.fromEntries(perDevice)).toEqual({
    [shared.id]: 2,
    [second.id]: 2,
    [stranger.id]: 1,
  });
  expect(rows.filter((row) => row.user_id === user.uid)).toHaveLength(3);
}, 60_000);

it('[AC-B1-28p#21] 超限后重放已收下的 Idempotency-Key 仍得原结果，不算新的一条，也不是 42901', async () => {
  const h = use();
  const appId = newAppId();
  await setConfig(h, appId, LIMIT_KEY, 2);
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  const body = feedbackBody(linkId);
  const first = await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0011' });
  const id = accepted(h, first);
  accepted(h, await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0012' }));
  answered(h, await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0013' }), 42901);
  const replay = await submit(h, device, body, { idempotencyKey: 'idem-idem-idem-0011' });
  expect(accepted(h, replay)).toBe(id);
  expect(replay.json<unknown>()).toEqual(first.json<unknown>());
  expect(await feedbackRows(h.db, appId)).toHaveLength(2);
}, 60_000);

it('[AC-B1-28p#22] 并发：同一设备同时提交 8 条、上限 3 时恰好 3 条收下，其余 42901，库里 3 条', async () => {
  const h = use();
  const appId = newAppId();
  await setConfig(h, appId, LIMIT_KEY, 3);
  const device = await registerDevice(h, appId);
  const linkId = await seedLink(h, appId);
  // Warm-up on another device of the app: the route answers before the burst starts.
  const warm = await registerDevice(h, appId);
  accepted(h, await submit(h, warm, feedbackBody(linkId)));
  const responses: Response[] = await Promise.all(
    Array.from({ length: 8 }, () => submit(h, device, feedbackBody(linkId))),
  );
  const ok = responses.filter((response) => response.statusCode === 200);
  const limited = responses.filter((response) => response.statusCode === 429);
  expect(responses.map((response) => response.statusCode).sort()).toEqual([
    200, 200, 200, 429, 429, 429, 429, 429,
  ]);
  const ids = ok.map((response) => accepted(h, response));
  for (const response of limited) answered(h, response, 42901);
  const rows = (await feedbackRows(h.db, appId)).filter((row) => row.device_id === device.id);
  expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
}, 60_000);
