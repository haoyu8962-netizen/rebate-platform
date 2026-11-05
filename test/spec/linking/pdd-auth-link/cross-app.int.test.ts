import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  authorityHarness,
  customOf,
  expectedLink,
  issued,
  planOver,
  refused,
  type AppUser,
  type InjectResponse,
  type Tenant,
} from './kit.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647): two Apps on one entry. Every pddAuthorityUrl call is the
// requesting App's (context and identity), over its own slot and its user's attr_code; each answer
// reaches only the request that asked, and each state row stays in its App.
const h = authorityHarness({ createTestDatabase, acquireTestRedis });

/** The one pddAuthorityUrl call a request made, checked against the requesting App and user. */
async function onlyCallOf(t: Tenant, u: AppUser, request: () => Promise<InjectResponse>) {
  const before = h.authorityUrlCalls().length;
  const response = await request();
  const mine = h.authorityUrlCalls().slice(before);
  expect(mine).toHaveLength(1);
  const call = mine[0]!;
  expect(call.ctx.appId).toBe(t.appId);
  expect(call.identity.claims.appId).toBe(t.appId);
  expect(call.identity.claims.promotionSlot).toBe(t.pid('self_buy'));
  expect(call.identity.claims.userId).toBe(u.attrCode);
  expect(customOf(call.identity)).toEqual({ app: 'n', uid: u.attrCode, sc: 'self_buy' });
  return { response, link: expectedLink(call.result) };
}

it('[AC-B1-06zf#16] 跨 App 不串：两个 App 的 auth-url 与 open 各用本 App 的推广位与用户 attr_code 生成，链接只回给发起请求的那个，state 行各在本 App', async () => {
  const one = await h.tenant();
  const two = await h.tenant();
  const a = await one.user();
  const b = await two.user();
  const linkA = await a.searchLink();
  const linkB = await b.searchLink();
  expect(one.pid('self_buy')).not.toBe(two.pid('self_buy'));

  const urlA = await onlyCallOf(one, a, () => a.authUrl('pdd'));
  expect((await issued(urlA.response)).auth_url).toBe(urlA.link);
  const urlB = await onlyCallOf(two, b, () => b.authUrl('pdd'));
  expect((await issued(urlB.response)).auth_url).toBe(urlB.link);

  const openA = await onlyCallOf(one, a, () => a.open(linkA));
  expect((await refused(openA.response, 422, 30111)).data).toEqual({
    auth_jump: planOver(openA.link),
  });
  const openB = await onlyCallOf(two, b, () => b.open(linkB));
  expect((await refused(openB.response, 422, 30111)).data).toEqual({
    auth_jump: planOver(openB.link),
  });

  for (const [t, u, link] of [
    [one, a, linkA],
    [two, b, linkB],
  ] as const) {
    const rows = await t.sessions();
    expect(rows.map((row) => [row.app_id, row.user_id, row.device_id, row.link_id])).toEqual([
      [t.appId, u.uid, u.deviceId, null],
      [t.appId, u.uid, u.deviceId, link],
    ]);
  }
}, 120_000);

it('[AC-B1-06zf#17] 跨 App 不串：用本 App 的身份打开另一 App 的 link 是 30144，不生成链接、不写 state；本 App 自己的 open 照常生成', async () => {
  const one = await h.tenant();
  const two = await h.tenant();
  const a = await one.user();
  const b = await two.user();
  const linkA = await a.searchLink();
  const linkB = await b.searchLink();
  const before = h.authorityUrlCalls().length;
  await refused(await a.open(linkB), 404, 30144);
  expect(h.authorityUrlCalls()).toHaveLength(before);
  expect(await one.sessions()).toEqual([]);
  expect(await two.sessions()).toEqual([]);

  const own = await onlyCallOf(one, a, () => a.open(linkA));
  await refused(own.response, 422, 30111);
  expect(await two.sessions()).toEqual([]);
}, 120_000);
