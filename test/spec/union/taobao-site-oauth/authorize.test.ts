// B1-04zzi / D10-680: the authorize URL is the official server-side flow address with only the
// official parameters (guides/118): response_type=code, client_id=appKey, redirect_uri, state, view.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  APP_ID,
  APP_KEY,
  AUTHORIZE_ENDPOINT,
  REDIRECT,
  SECRET,
  UNION_ACCOUNT_ID,
  jsonAnswer,
  provider,
  tokenAnswer,
} from './kit.ts';

const EXPIRES_AT = new Date('2032-03-01T04:15:06.000Z');
const STATE = 'Zm9vYmFyLXN0YXRlLWZpeHR1cmUtMDEyMzQ1Njc4OWFi';

function authorize(state: string) {
  const p = provider(() => jsonAnswer(200, tokenAnswer()));
  return {
    ...p,
    url: p.oauth.authorizeUrl({
      appId: APP_ID,
      unionAccountId: UNION_ACCOUNT_ID,
      state,
      expiresAt: EXPIRES_AT,
    }),
  };
}

it('[AC-B1-04zzi#1] 授权地址是 https://oauth.taobao.com/authorize，只带五个官方参数且取值正确', async () => {
  const { url } = authorize(STATE);
  const text = await url;
  expect(text.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
  const parsed = new URL(text);
  expect(parsed.origin + parsed.pathname).toBe(AUTHORIZE_ENDPOINT);
  expect(parsed.hash).toBe('');
  expect([...parsed.searchParams.keys()].sort()).toEqual([
    'client_id',
    'redirect_uri',
    'response_type',
    'state',
    'view',
  ]);
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    response_type: 'code',
    client_id: APP_KEY,
    redirect_uri: REDIRECT,
    state: STATE,
    view: 'web',
  });
  // redirect_uri travels URL encoded, not as a raw nested URL.
  expect(parsed.search).toContain(`redirect_uri=${encodeURIComponent(REDIRECT)}`);
});

it('[AC-B1-04zzi#2] 授权地址不带我方参数、不取 secret、不调换令牌端点', async () => {
  const { url, reads, requests } = authorize(STATE);
  const text = await url;
  expect(text.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
  for (const own of [APP_ID, UNION_ACCOUNT_ID, EXPIRES_AT.toISOString(), SECRET]) {
    expect(text).not.toContain(own);
    expect(text).not.toContain(encodeURIComponent(own));
  }
  expect(text).not.toContain(String(EXPIRES_AT.getTime()));
  expect(reads.secret).toBe(0);
  expect(requests).toEqual([]);
});

it('[AC-B1-04zzi#3] 任意 state（32 字节 base64url 及其他可打印文本）原样带回', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc
          .uint8Array({ minLength: 32, maxLength: 32 })
          .map((bytes) => Buffer.from(bytes).toString('base64url')),
        fc.string({ minLength: 1, maxLength: 64, unit: 'grapheme-ascii' }),
      ),
      async (state) => {
        const text = await authorize(state).url;
        expect(text.startsWith(`${AUTHORIZE_ENDPOINT}?`)).toBe(true);
        const parsed = new URL(text);
        expect(parsed.searchParams.getAll('state')).toEqual([state]);
        expect(parsed.searchParams.get('client_id')).toBe(APP_KEY);
      },
    ),
    propParams(),
  );
});
