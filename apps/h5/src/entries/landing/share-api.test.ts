import { afterEach, expect, it, vi } from 'vitest';
import { buildAppVersion, semVerOrNull } from './app-version.ts';
import { createShareApi } from './share-api.ts';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

afterEach(() => vi.unstubAllGlobals());

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: 'ok', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

it('[AC-F1-11a-UNIT#5] 构建版本取自 apps/h5/package.json，只认 SemVer', () => {
  const version = buildAppVersion();
  expect(version).not.toBeNull();
  expect(version).toMatch(SEMVER);
  expect(semVerOrNull('1.2.3')).toBe('1.2.3');
  expect(semVerOrNull('1.2')).toBeNull();
  expect(semVerOrNull('1.2.3-beta')).toBeNull();
  expect(semVerOrNull(`1.2.${'3'.repeat(40)}`)).toBeNull();
  expect(semVerOrNull(undefined)).toBeNull();
});

it('[AC-F1-11a-UNIT#6] getSharePage 与 getShareTpwd 都带合法 SemVer 的 X-App-Version', async () => {
  const appVersion = buildAppVersion();
  expect(appVersion).not.toBeNull();
  const seen: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      return url.endsWith('/tpwd')
        ? ok({ tpwd: '￥AbCd1234￥' })
        : ok({ product_card: {}, tpwd_ticket: 't1' });
    }),
  );
  const api = createShareApi({
    apiBaseUrl: 'https://api.example.test/',
    appId: 'brand_a',
    appVersion: appVersion!,
  });
  await api.getSharePage('link-1');
  await api.getShareTpwd('link-1', 't1');
  expect(seen.map((call) => call.url)).toEqual([
    'https://api.example.test/v1/share-pages/link-1',
    'https://api.example.test/v1/share-pages/link-1/tpwd',
  ]);
  for (const call of seen) {
    expect(call.headers.get('X-App-Version')).toBe(appVersion);
    expect(call.headers.get('X-App-Version')).toMatch(SEMVER);
    expect(call.headers.get('X-App-Id')).toBe('brand_a');
    expect(call.headers.get('X-Platform')).toBe('h5');
    expect(call.headers.has('Authorization')).toBe(false);
  }
});
