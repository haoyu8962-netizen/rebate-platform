// B1-04zzzzq r2 (money review S1): unit tests of the Taobao authorization plan — the web page
// callback is web_code's alone, so staging / prod without it still issue sdk_token. Values only.
import { expect, it } from 'vitest';
import {
  issuableTaobaoMethods,
  taobaoAuthUrl,
  taobaoAuthUrlPlan,
  type UnionAuthAppsPort,
} from './union-auth-state.ts';

const APP_KEY = 'unit-app-key';
const REDIRECT = 'https://user-auth.example.test/callback';
const STATE = 'st_unit-state';

const port = (appKey: string | null, redirectUri: string | null): UnionAuthAppsPort => ({
  taobaoUserOAuth: { appKey, redirectUri },
  resolve: async () => ({ ref: 'unit-ref' }),
});

it('[AC-B1-04zzzzq-UNIT#8] staging / prod 有应用标识、缺网页回调 → 只签 sdk_token；只配 web_code 时无可签方式', () => {
  for (const env of ['staging', 'prod'] as const) {
    for (const redirect of [null, '']) {
      const plan = taobaoAuthUrlPlan(port(APP_KEY, redirect), env);
      expect(plan).toEqual({ kind: 'sdk_only', appKey: APP_KEY });
      expect(issuableTaobaoMethods(plan, ['sdk_token'])).toEqual(['sdk_token']);
      expect(issuableTaobaoMethods(plan, ['sdk_token', 'web_code'])).toEqual(['sdk_token']);
      expect(issuableTaobaoMethods(plan, ['web_code', 'sdk_token'])).toEqual(['sdk_token']);
      expect(issuableTaobaoMethods(plan, ['web_code'])).toEqual([]);
    }
  }
});

it('[AC-B1-04zzzzq-UNIT#8] 缺应用标识照旧不可签；local / test 缺任一项照旧合成地址；配齐照旧真实 OAuth', () => {
  for (const env of ['staging', 'prod'] as const) {
    expect(taobaoAuthUrlPlan(port(null, REDIRECT), env)).toEqual({ kind: 'unavailable' });
    expect(taobaoAuthUrlPlan(port('', null), env)).toEqual({ kind: 'unavailable' });
    const plan = taobaoAuthUrlPlan(port(APP_KEY, REDIRECT), env);
    expect(plan).toEqual({ kind: 'oauth', appKey: APP_KEY, redirectUri: REDIRECT });
    expect(issuableTaobaoMethods(plan, ['sdk_token', 'web_code'])).toEqual([
      'sdk_token',
      'web_code',
    ]);
  }
  for (const env of ['local', 'test'] as const) {
    expect(taobaoAuthUrlPlan(port(APP_KEY, null), env)).toEqual({ kind: 'synthetic' });
    expect(taobaoAuthUrlPlan(port(null, REDIRECT), env)).toEqual({ kind: 'synthetic' });
  }
});

it('[AC-B1-04zzzzq-UNIT#8] sdk_only 的 auth_url 是合法 uri：真实授权地址，只带应用标识、state 与无线端样式', () => {
  const address = taobaoAuthUrl({ kind: 'sdk_only', appKey: APP_KEY }, STATE);
  expect(URL.canParse(address)).toBe(true);
  const url = new URL(address);
  expect(`${url.origin}${url.pathname}`).toBe('https://oauth.taobao.com/authorize');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: APP_KEY,
    state: STATE,
    view: 'wap',
  });
  expect(url.searchParams.has('redirect_uri')).toBe(false);
  expect(url.searchParams.has('response_type')).toBe(false);
});
