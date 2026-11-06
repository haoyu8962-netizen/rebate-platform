// B1-04zzi: unit checks of the Taobao site OAuth provider beyond the rule tests — the token request
// is never archived (rule-test review S2) and a refusal never quotes upstream text.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { UnionTransportRequest, UnionTransportResponse } from '../replay.ts';
import { createTaobaoSiteOAuth, TaobaoSiteOAuthError } from './site-oauth.ts';

const SECRET = 'unit-unit-unit-unit';
const CODE = 'unit-once-code';
const REDIRECT = 'https://console.fake-unit.test/unions/oauth-callback';

function setup(answer: () => UnionTransportResponse | Promise<UnionTransportResponse>) {
  const requests: UnionTransportRequest[] = [];
  const oauth = createTaobaoSiteOAuth({
    credentials: () => Promise.resolve({ appKey: 'unit-app-key', appSecret: SECRET }),
    transport: async (request) => {
      requests.push(request);
      return answer();
    },
    clock: new FixedClock('2032-01-01T00:00:00.000Z'),
    redirectUri: REDIRECT,
  });
  return { oauth, requests };
}

const input = { appId: 'unit-app', unionAccountId: 'unit-account', code: CODE };

it('[B1-04zzi] token 请求不带 archive 上下文（不进 union 原始报文归档）', async () => {
  const { oauth, requests } = setup(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ access_token: 'unit-access', expires_in: 60 }),
  }));
  await expect(oauth.exchange(input)).resolves.toMatchObject({ accessToken: 'unit-access' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty('archive');
  expect(requests[0]!.archive).toBeUndefined();
});

it('[B1-04zzi] 授权地址同样不调传输', async () => {
  const { oauth, requests } = setup(() => Promise.reject(new Error('unused')));
  const url = await oauth.authorizeUrl({
    appId: 'unit-app',
    unionAccountId: 'unit-account',
    state: 'unit state',
    expiresAt: new Date('2032-01-01T00:10:00.000Z'),
  });
  expect(new URL(url).searchParams.get('state')).toBe('unit state');
  expect(requests).toEqual([]);
});

it('[B1-04zzi] error 码只在形如标识符时引用，其余记 unknown', async () => {
  const quoted = setup(() => ({
    status: 400,
    headers: {},
    body: JSON.stringify({ error: 'invalid_grant', error_description: 'unit description' }),
  }));
  const first = await quoted.oauth.exchange(input).catch((error: unknown) => error);
  expect(first).toBeInstanceOf(TaobaoSiteOAuthError);
  expect((first as Error).message).toContain('invalid_grant');
  expect((first as Error).message).not.toContain('unit description');

  const odd = setup(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ error: `bad ${SECRET} ${CODE}` }),
  }));
  const second = await odd.oauth.exchange(input).catch((error: unknown) => error);
  expect(second).toBeInstanceOf(TaobaoSiteOAuthError);
  expect((second as Error).message).toContain('unknown');
  expect((second as Error).message).not.toContain(SECRET);
  expect((second as Error).message).not.toContain(CODE);
});

it('[B1-04zzi] expires_in 超出 Date 范围按无到期处理', async () => {
  const { oauth } = setup(() => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ access_token: 'unit-access', expires_in: 1e300 }),
  }));
  await expect(oauth.exchange(input)).resolves.toEqual({
    accessToken: 'unit-access',
    refreshToken: null,
    expiresAt: null,
  });
});
