import { expect, it } from 'vitest';
import { TAOBAO_OAUTH_REDIRECT_URI_ENV as NAME, readTaobaoOAuthConfig } from './taobao-oauth.ts';

const GOOD = 'https://console.fake-unit.test/unions/oauth-callback';

it('[B1-04zzi] TAOBAO_OAUTH_REDIRECT_URI：https 绝对地址原样保留，未设或空串为 null', () => {
  expect(readTaobaoOAuthConfig({ [NAME]: GOOD })).toEqual({
    taobaoOAuthRedirectUri: GOOD,
    problems: [],
  });
  expect(readTaobaoOAuthConfig({})).toEqual({ taobaoOAuthRedirectUri: null, problems: [] });
  expect(readTaobaoOAuthConfig({ [NAME]: '' })).toEqual({
    taobaoOAuthRedirectUri: null,
    problems: [],
  });
});

it.each([
  'http://console.fake-unit.test/cb',
  '//console.fake-unit.test/cb',
  '/unions/oauth-callback',
  'https://user:pw@console.fake-unit.test/cb',
  'https://console.fake-unit.test/cb#frag',
  'https://console.fake-unit.test/c b',
  'HTTPS-ish nonsense',
])('[B1-04zzi] 不合格的回调地址 %s 记一条只写变量名的问题', (value) => {
  const result = readTaobaoOAuthConfig({ [NAME]: value });
  expect(result.taobaoOAuthRedirectUri).toBeNull();
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain(NAME);
  expect(result.problems[0]).not.toContain(value);
});
