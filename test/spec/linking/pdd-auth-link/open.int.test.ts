import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  STATE_TTL_MS,
  authorityHarness,
  customOf,
  expectAuthSteps,
  expectAuthorityIdentity,
  expectNoState,
  expectedLink,
  opened,
  planOver,
  planValues,
  refused,
  type InjectResponse,
  type Tenant,
} from './kit.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ①②③): a Pinduoduo open the filing query answers "not filed"
// refuses with 30111 whose data.auth_jump is built over the link pddAuthorityUrl generated for the
// identity the conversion uses; the state is bound to uid + device record + the opened link and
// never put in the link. Filing is still decided by the authority query (BR-ID-22). D10-654: when
// the account in use has no active slot of the link's scene, the open answers 50301 maintenance
// before any union call and writes no state.
const h = authorityHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-06zf#7] 拼多多 open 未备案 30111：data.auth_jump 的 h5 步是 pddAuthorityUrl 返回的网页地址（mobile_short_url → url，https），scheme 步若有就是上游 schema_url 原样；不是 example.test 占位', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const response = await u.open(linkId);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const link = expectedLink(calls[0]!.result);
  // The demo answers schema_url, mobile_short_url and url, all distinct: the web address is
  // mobile_short_url, and schema_url (the demo scheme) never stands in for it.
  const answer = calls[0]!.result!;
  expect(link).toBe(answer.mobile_short_url);
  expect(link).not.toBe(answer.url);
  expect(link).not.toBe(answer.schema_url);
  const body = await refused(response, 422, 30111);
  expect(body.data).toEqual({ auth_jump: planOver(link) });
  expectAuthSteps(body.data?.['auth_jump'], answer);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#8] 拼多多 open 30111：state 只进 union_auth_sessions，一行绑 uid、设备记录与本次 open 的 link，链接与响应里都不带它', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const body = await refused(await u.open(linkId), 422, 30111);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  const rows = await t.sessions();
  expect(rows).toEqual([
    expect.objectContaining({
      app_id: t.appId,
      user_id: u.uid,
      device_id: u.deviceId,
      platform: 'pdd',
      mode: 'bind',
      link_id: linkId,
      used_at: null,
      client: 'ios',
      auth_methods: null,
      auth_app_refs: null,
    }),
  ]);
  const state = rows[0]!.state;
  expect(rows[0]!.expire_at.getTime() - rows[0]!.created_at.getTime()).toBe(STATE_TTL_MS);
  expectNoState(planValues(body.data?.['auth_jump']), state);
  expect(JSON.stringify(body)).not.toContain(state);
}, 60_000);

it('[AC-B1-06zf#9] 拼多多 open 调 pddAuthorityUrl 的身份就是备案查询与转链用的：同一 App、同一账户的 self_buy 推广位、同一 custom_parameters，不含 user_id', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  await refused(await u.open(linkId), 422, 30111);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expectAuthorityIdentity(call, {
    appId: t.appId,
    pid: t.pid('self_buy'),
    attrCode: u.attrCode,
    scene: 'self_buy',
    privateValues: [u.uid, u.deviceId],
  });
  const queries = h.queryCalls(t.appId);
  expect(queries).toHaveLength(1);
  expect(call.identity.claims).toEqual(queries[0]!.identity.claims);
  expect(customOf(call.identity)).toEqual(customOf(queries[0]!.identity));

  // The same user filed: the open converts with the identity the link was generated for.
  h.fileUsers();
  await opened(await u.open(linkId));
  const converts = h.convertCalls(t.appId);
  expect(converts).toHaveLength(1);
  expect(converts[0]!.identity.claims).toMatchObject({
    appId: call.identity.claims.appId,
    platform: 'pdd',
    promotionSlot: call.identity.claims.promotionSlot,
    userId: call.identity.claims.userId,
  });
  expect(customOf(converts[0]!.identity)).toEqual(customOf(call.identity));
}, 60_000);

it('[AC-B1-06zf#10] 点击才生成：注册设备、搜索、授权管理页不调用；未备案 open 调一次；已备案（active）的 open 不再调用、不写 state', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  await u.bindings();
  expect(h.authorityUrlCalls(t.appId)).toEqual([]);

  await refused(await u.open(linkId), 422, 30111);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(await t.sessions()).toHaveLength(1);

  // Filed now: the query activates the binding and the open converts, no link generated.
  h.fileUsers();
  await opened(await u.open(linkId));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(await t.bindings()).toEqual([
    expect.objectContaining({ user_id: u.uid, platform: 'pdd', status: 'active' }),
  ]);

  // Active: neither the query nor the link generation is asked again.
  const asked = h.queryCalls(t.appId).length;
  await opened(await u.open(linkId));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(h.queryCalls(t.appId)).toHaveLength(asked);
  expect(await t.sessions()).toHaveLength(1);
}, 60_000);

it('[AC-B1-06zf#11] 每次未备案 open 各生成一次（不预生成、不缓存），每次各一个新 state，链接都是当次返回的', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const first = await refused(await u.open(linkId), 422, 30111);
  const second = await refused(await u.open(linkId), 422, 30111);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(2);
  expect(first.data).toEqual({ auth_jump: planOver(expectedLink(calls[0]!.result)) });
  expect(second.data).toEqual({ auth_jump: planOver(expectedLink(calls[1]!.result)) });
  const rows = await t.sessions();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.state)).size).toBe(2);
  expect(rows.every((row) => row.link_id === linkId)).toBe(true);
}, 60_000);

it('[AC-B1-06zf#12] pddAuthorityUrl 抛错：未备案 open 返回 HTTP 503 / 50303，不下发 auth_jump，union_auth_sessions 没有新行，绑定与转链都不动', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  h.failAuthorityUrl(new UnionError('upstream_rejected', 'synthetic filing link refusal', 'pdd'));
  const response = await u.open(linkId);
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  expect(h.queryCalls(t.appId)).toHaveLength(1);
  const body = await refused(response, 503, 50303);
  expect(body.data ?? {}).not.toHaveProperty('auth_jump');
  expect(await t.sessions()).toEqual([]);
  expect(await t.bindings()).toEqual([]);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);

// Own share links reopen as self-buy detail (BR-ATTR-11, rules.ts decideOpenOwner) and another
// user's share link never issues a jump (sharer_auth_invalid), so the non-self_buy scene an own
// open keeps is agent: the link generated must be for that scene's slot, the one just queried.
it('[AC-B1-06zf#23] 自己的 agent 场景 link 未备案（该场景有推广位）：pddAuthorityUrl 用 agent 推广位、sc=agent，与本次 open 的备案查询同一身份，不用 self_buy 位；session 绑这个 link', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.agentLink();
  const body = await refused(await u.open(linkId), 422, 30111);
  const queries = h.queryCalls(t.appId);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.identity.claims.promotionSlot).toBe(t.pid('agent'));
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expectAuthorityIdentity(call, {
    appId: t.appId,
    pid: t.pid('agent'),
    attrCode: u.attrCode,
    scene: 'agent',
    privateValues: [u.uid, u.deviceId],
  });
  expect(call.identity.claims).toEqual(queries[0]!.identity.claims);
  expect(customOf(call.identity)).toEqual(customOf(queries[0]!.identity));
  expect(call.identity.claims.promotionSlot).not.toBe(t.pid('self_buy'));
  expect(body.data).toEqual({ auth_jump: planOver(expectedLink(call.result)) });
  expect((await t.sessions()).map((row) => [row.user_id, row.device_id, row.link_id])).toEqual([
    [u.uid, u.deviceId, linkId],
  ]);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#25] 绑定（pending_auth / invalid）在第二个拼多多账户：未备案 open 调 pddAuthorityUrl 用第二个账户的 self_buy 推广位，与本次备案查询同一身份，从不用第一个账户的', async () => {
  const t = await h.tenant({ secondAccount: true });
  expect(t.pid('self_buy', 'second')).not.toBe(t.pid('self_buy'));
  for (const status of ['pending_auth', 'invalid'] as const) {
    const u = await t.user();
    await t.bind(u.uid, status, 'second');
    const linkId = await u.searchLink();
    const askedBefore = h.queryCalls(t.appId).length;
    const issuedBefore = h.authorityUrlCalls(t.appId).length;
    const body = await refused(await u.open(linkId), 422, 30111);
    const queries = h.queryCalls(t.appId).slice(askedBefore);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.identity.claims.promotionSlot).toBe(t.pid('self_buy', 'second'));
    const calls = h.authorityUrlCalls(t.appId).slice(issuedBefore);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expectAuthorityIdentity(call, {
      appId: t.appId,
      pid: t.pid('self_buy', 'second'),
      attrCode: u.attrCode,
      scene: 'self_buy',
      privateValues: [u.uid, u.deviceId],
    });
    expect(call.identity.claims).toEqual(queries[0]!.identity.claims);
    expect(customOf(call.identity)).toEqual(customOf(queries[0]!.identity));
    expect(call.identity.claims.promotionSlot).not.toBe(t.pid('self_buy'));
    expect(body.data).toEqual({ auth_jump: planOver(expectedLink(call.result)) });
  }
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 120_000);

/** D10-654: the open stopped for maintenance before any union call, nothing written. */
async function expectMaintenance(
  t: Tenant,
  response: InjectResponse,
  bindingsBefore: unknown,
): Promise<void> {
  const body = await refused(response, 503, 50301);
  expect(body.data).toEqual({ reason: 'maintenance' });
  expect(response.payload).not.toContain('auth_jump');
  expect(response.payload).not.toContain('example.test');
  expect(await t.sessions()).toEqual([]);
  expect(await t.bindings()).toEqual(bindingsBefore);
  expect(h.queryCalls(t.appId)).toEqual([]);
  expect(h.authorityUrlCalls(t.appId)).toEqual([]);
  expect(h.convertCalls(t.appId)).toEqual([]);
}

it('[AC-B1-06zf#26] D10-654：所用账户没有该场景 active 推广位（自己的 agent link，agent 位已停用）→ HTTP 503 / 50301 data.reason=maintenance，不回 30111 / auth_jump、不写 session、不调备案查询与 pddAuthorityUrl、不转链', async () => {
  const t = await h.tenant({ retired: [{ scene: 'agent' }] });
  const u = await t.user();
  const linkId = await u.agentLink();
  await expectMaintenance(t, await u.open(linkId), []);
}, 60_000);

it('[AC-B1-06zf#27] D10-654：绑定（pending_auth）在第二个账户、该账户没有 self_buy active 推广位（第一个账户有）→ 50301 maintenance，不借第一个账户的位、不写 session、不调联盟', async () => {
  const t = await h.tenant({
    secondAccount: true,
    retired: [{ scene: 'self_buy', account: 'second' }],
  });
  const u = await t.user();
  await t.bind(u.uid, 'pending_auth', 'second');
  const linkId = await u.searchLink();
  const before = await t.bindings();
  await expectMaintenance(t, await u.open(linkId), before);
}, 60_000);

it('[AC-B1-06zf#29] D10-662：上游给了 scheme、installed=false 的未备案 open：30111 auth_jump 的 primary 是 HTTPS 网页地址（mobile_short_url），scheme 不被二次包装、不进任何一步', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const answer = {
    url: 'https://demo.invalid/authority/b1-06zf-29',
    mobile_short_url: 'https://demo.invalid/m/b1-06zf-29',
    schema_url: 'couli-demo://pdd/authority/b1-06zf-29',
  };
  h.answerAuthorityUrl(answer);
  const response = await u.open(linkId);
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.result).toEqual(answer);
  const body = await refused(response, 422, 30111);
  expect(body.data).toEqual({ auth_jump: planOver(answer.mobile_short_url) });
  const plan = body.data?.['auth_jump'] as { primary: { type: string; value: string } };
  expect(plan.primary.type).toBe('h5');
  expect(new URL(plan.primary.value).protocol).toBe('https:');
  expectAuthSteps(plan, answer);
  // installed=false has no scheme step; the scheme is neither handed out nor wrapped anywhere.
  for (const value of planValues(plan)) {
    expect(value).not.toContain('couli-demo');
    expect(value).not.toContain(encodeURIComponent(answer.schema_url));
  }
  expect(response.payload).not.toContain('couli-demo');
  const rows = await t.sessions();
  expect(rows).toHaveLength(1);
  expectNoState(planValues(plan), rows[0]!.state);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);
