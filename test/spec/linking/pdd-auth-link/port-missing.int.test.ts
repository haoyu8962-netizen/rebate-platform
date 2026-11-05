import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { authorityHarness, issued, refused } from './kit.ts';

// B1-06zf (FU-PDD-AUTH-LINK, D10-647 ③): the entry starts with demo adapters that have no
// pddAuthorityUrl port. Both exits answer 50303 and write no state; Taobao is untouched.
const h = authorityHarness({ createTestDatabase, acquireTestRedis }, { authorityUrl: 'missing' });

it('[AC-B1-06zf#13] 端口缺失：拼多多 auth-url 返回 HTTP 503 / 50303，不下发 auth_url / state / auth_jump，union_auth_sessions 没有新行', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const body = await refused(await u.authUrl('pdd'), 503, 50303);
  for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
    expect(body.data ?? {}).not.toHaveProperty(field);
  }
  expect(await t.sessions()).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#14] 端口缺失：未备案的拼多多 open 返回 HTTP 503 / 50303，不下发 auth_jump，union_auth_sessions 没有新行，绑定与转链都不动', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const linkId = await u.searchLink();
  const response = await u.open(linkId);
  // Filing is still decided by the authority query (BR-ID-22): it was asked and said "not filed".
  expect(h.queryCalls(t.appId)).toHaveLength(1);
  const body = await refused(response, 503, 50303);
  expect(body.data ?? {}).not.toHaveProperty('auth_jump');
  expect(await t.sessions()).toEqual([]);
  expect(await t.bindings()).toEqual([]);
  expect(h.convertCalls(t.appId)).toEqual([]);
}, 60_000);

it('[AC-B1-06zf#15] 端口缺失只影响拼多多：同一用户的淘宝 auth-url 照常签发；拼多多 auth-url 为 50303 且不留 state', async () => {
  const t = await h.tenant();
  const u = await t.user();
  const taobao = await issued(await u.authUrl('taobao'));
  expect(taobao.auth_methods).toEqual(['web_code']);
  await refused(await u.authUrl('pdd'), 503, 50303);
  expect((await t.sessions()).map((row) => [row.platform, row.state])).toEqual([
    ['taobao', taobao.state],
  ]);
}, 60_000);
