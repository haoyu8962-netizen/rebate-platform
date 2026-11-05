import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import {
  STATE_TTL_MS,
  authorityHarness,
  expectAuthSteps,
  expectAuthorityIdentity,
  expectNoState,
  expectedLink,
  issued,
  planOver,
  planValues,
  refused,
} from './kit.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ①②③④): GET /v1/unions/pdd/auth-url hands out the link the
// governed union adapter's pddAuthorityUrl generated for the conversion's identity, generated only
// when asked; the state stays in union_auth_sessions. Taobao keeps its current address.
const h = authorityHarness({ createTestDatabase, acquireTestRedis });

it('[AC-B1-06zf#1] 拼多多 auth-url：auth_url 与 h5 步是 pddAuthorityUrl 返回的网页地址（mobile_short_url → url，https），scheme 步若有就是上游 schema_url 原样；不是 example.test 占位', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const response = await u.authUrl('pdd');
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  const link = expectedLink(calls[0]!.result);
  // The demo answers schema_url, mobile_short_url and url, all distinct: the web address is
  // mobile_short_url, and schema_url (the demo scheme) never stands in for it.
  const answer = calls[0]!.result!;
  expect(link).toBe(answer.mobile_short_url);
  expect(link).not.toBe(answer.url);
  expect(link).not.toBe(answer.schema_url);
  const data = await issued(response);
  expect(data.auth_url).toBe(link);
  expect(data.auth_jump).toEqual(planOver(link));
  expectAuthSteps(data.auth_jump, answer);
  expect(data).not.toHaveProperty('auth_methods');
  expectNoState([data.auth_url, ...planValues(data.auth_jump)], data.state);
}, 60_000);

it('[AC-B1-06zf#2] 拼多多 auth-url：state 只进 union_auth_sessions，一行绑 uid、设备记录、link 为空、10 分钟一次性，链接里不带它', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const data = await issued(await u.authUrl('pdd'));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  const rows = await t.sessions();
  expect(rows).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: t.appId,
      user_id: u.uid,
      device_id: u.deviceId,
      platform: 'pdd',
      mode: 'bind',
      link_id: null,
      used_at: null,
      client: 'ios',
      auth_methods: null,
      auth_app_refs: null,
    }),
  ]);
  expect(rows[0]!.expire_at.getTime() - rows[0]!.created_at.getTime()).toBe(STATE_TTL_MS);
  expectNoState([data.auth_url, ...planValues(data.auth_jump)], data.state);
}, 60_000);

it('[AC-B1-06zf#3] 拼多多 auth-url 调 pddAuthorityUrl 的身份与转链相同：该 App、所用账户 self_buy 推广位、custom_parameters {app, uid=attr_code, sc}，不含 user_id', async () => {
  const t = await h.tenant();
  const u = await t.user();
  await issued(await u.authUrl('pdd'));
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  expectAuthorityIdentity(calls[0]!, {
    appId: t.appId,
    pid: t.pid('self_buy'),
    attrCode: u.attrCode,
    scene: 'self_buy',
    privateValues: [u.uid, u.deviceId],
  });
  // Filing is per slot: never another scene's slot of the same account.
  expect(calls[0]!.identity.claims.promotionSlot).not.toBe(t.pid('query'));
  expect(calls[0]!.identity.claims.promotionSlot).not.toBe(t.pid('share'));
}, 60_000);

it('[AC-B1-06zf#4] 点击才生成、不缓存：注册设备、搜索、授权管理页都不调用 pddAuthorityUrl；每次 auth-url 各调一次、各一个新 state', async () => {
  const t = await h.tenant();
  const u = await t.user();
  await u.searchLink();
  await u.bindings();
  expect(h.authorityUrlCalls(t.appId)).toEqual([]);
  const first = await issued(await u.authUrl('pdd'));
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  const second = await issued(await u.authUrl('pdd'));
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(2);
  expect(second.state).not.toBe(first.state);
  expect(first.auth_url).toBe(expectedLink(calls[0]!.result));
  expect(second.auth_url).toBe(expectedLink(calls[1]!.result));
  expect((await t.sessions()).map((row) => row.state).sort()).toEqual(
    [first.state, second.state].sort(),
  );
}, 60_000);

it('[AC-B1-06zf#5] pddAuthorityUrl 抛错：auth-url 返回 HTTP 503 / 50303，不下发 auth_url / state / auth_jump，union_auth_sessions 没有新行', async () => {
  const t = await h.tenant();
  const u = await t.user();
  h.failAuthorityUrl(new UnionError('upstream_rejected', 'synthetic filing link refusal', 'pdd'));
  const response = await u.authUrl('pdd');
  expect(h.authorityUrlCalls(t.appId)).toHaveLength(1);
  const body = await refused(response, 503, 50303);
  for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
    expect(body.data ?? {}).not.toHaveProperty(field);
  }
  expect(await t.sessions()).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#6] 淘宝 auth-url 仍是现有行为（占位地址只给淘宝、web_code、不调 pddAuthorityUrl）；同一用户的拼多多 auth-url 才调用', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const taobao = await issued(await u.authUrl('taobao'));
  expect(taobao.auth_url).toBe(
    `https://oauth.example.test/taobao/authorize?state=${encodeURIComponent(taobao.state)}`,
  );
  expect(taobao.auth_methods).toEqual(['web_code']);
  expect(taobao).not.toHaveProperty('auth_jump');
  expect(await t.sessions()).toEqual([
    expect.objectContaining({
      state: taobao.state,
      user_id: u.uid,
      device_id: u.deviceId,
      platform: 'taobao',
      link_id: null,
      auth_methods: ['web_code'],
    }),
  ]);
  expect(h.authorityUrlCalls(t.appId)).toEqual([]);

  const pdd = await issued(await u.authUrl('pdd'));
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  expect(pdd.auth_url).toBe(expectedLink(calls[0]!.result));
  expect(pdd.auth_url).not.toContain('example.test');
}, 60_000);

it('[AC-B1-06zf#24] 绑定（pending_auth / invalid）在第二个拼多多账户：auth-url 调 pddAuthorityUrl 用第二个账户（本次授权所用）的 self_buy 推广位，从不用第一个账户的；下发的就是这次返回的链接', async () => {
  const t = await h.tenant({ secondAccount: true });
  expect(t.pid('self_buy', 'second')).not.toBe(t.pid('self_buy'));
  for (const status of ['pending_auth', 'invalid'] as const) {
    const u = await t.user();
    await t.bind(u.uid, status, 'second');
    const before = h.authorityUrlCalls(t.appId).length;
    const data = await issued(await u.authUrl('pdd'));
    const calls = h.authorityUrlCalls(t.appId).slice(before);
    expect(calls).toHaveLength(1);
    expectAuthorityIdentity(calls[0]!, {
      appId: t.appId,
      pid: t.pid('self_buy', 'second'),
      attrCode: u.attrCode,
      scene: 'self_buy',
      privateValues: [u.uid, u.deviceId],
    });
    expect(calls[0]!.identity.claims.promotionSlot).not.toBe(t.pid('self_buy'));
    expect(data.auth_url).toBe(expectedLink(calls[0]!.result));
    expect(data.auth_jump).toEqual(planOver(data.auth_url));
  }
}, 120_000);

it('[AC-B1-06zf#28] D10-662：上游给了 scheme、installed=false：auth_url 与 primary 是 HTTPS 网页地址（mobile_short_url），scheme 不被二次包装、不进任何一步', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const answer = {
    url: 'https://demo.invalid/authority/b1-06zf-28',
    mobile_short_url: 'https://demo.invalid/m/b1-06zf-28',
    schema_url: 'couli-demo://pdd/authority/b1-06zf-28',
  };
  h.answerAuthorityUrl(answer);
  const response = await u.authUrl('pdd');
  const calls = h.authorityUrlCalls(t.appId);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.result).toEqual(answer);
  const data = await issued(response);
  expect(data.auth_url).toBe(answer.mobile_short_url);
  expect(data.auth_jump).toEqual(planOver(answer.mobile_short_url));
  const plan = data.auth_jump!;
  expect(plan.primary.type).toBe('h5');
  expect(new URL(plan.primary.value).protocol).toBe('https:');
  expectAuthSteps(plan, answer);
  // installed=false has no scheme step; the scheme is neither handed out nor wrapped anywhere.
  for (const value of [data.auth_url, ...planValues(plan)]) {
    expect(value).not.toContain('couli-demo');
    expect(value).not.toContain(encodeURIComponent(answer.schema_url));
  }
  expect(response.payload).not.toContain('couli-demo');
  expectNoState([data.auth_url, ...planValues(plan)], data.state);
}, 60_000);
