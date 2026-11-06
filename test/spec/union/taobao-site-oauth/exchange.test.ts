// B1-04zzi / D10-680: code → token over POST https://oauth.taobao.com/token (form encoded,
// guides/118). Success maps access_token / refresh_token / expires_in; every failure is refused
// without echoing the code, a token, the secret or the answer text.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  ACCESS,
  APP_ID,
  APP_KEY,
  CODE,
  DAY_S,
  DESCRIPTION,
  NOW,
  REDIRECT,
  REFRESH,
  ROUND_TRIP_MS,
  SECRET,
  TOKEN_ENDPOINT,
  UNION_ACCOUNT_ID,
  expectHidden,
  header,
  jsonAnswer,
  provider,
  refusal,
  tokenAnswer,
  visible,
} from './kit.ts';

const INPUT = { appId: APP_ID, unionAccountId: UNION_ACCOUNT_ID };
const ANSWERED_AT_MS = new Date(NOW).getTime() + ROUND_TRIP_MS;

it('[AC-B1-04zzi#4] 换令牌：一次 POST 表单到 token 端点，五个字段正确且只有这五个', async () => {
  const { requests, oauth } = provider(() => jsonAnswer(200, tokenAnswer()));
  await oauth.exchange({ ...INPUT, code: CODE });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('POST');
  expect(request.url).toBe(TOKEN_ENDPOINT);
  // Nothing in the query string: the secret and the code travel in the body only.
  expect(new URL(request.url).search).toBe('');
  expect(header(request, 'content-type')).toMatch(/^application\/x-www-form-urlencoded\b/i);
  expect(typeof request.body).toBe('string');
  const form = new URLSearchParams(request.body);
  expect([...form.keys()].sort()).toEqual([
    'client_id',
    'client_secret',
    'code',
    'grant_type',
    'redirect_uri',
  ]);
  expect(Object.fromEntries(form)).toEqual({
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    client_secret: SECRET,
    code: CODE,
    redirect_uri: REDIRECT,
  });
  for (const key of form.keys()) expect(form.getAll(key)).toHaveLength(1);
});

it('[AC-B1-04zzi#5] 任意授权码按表单编码原样送达（含 + / = & 空格与中文）', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.constant('fixture+code/with=chars&more 中文'),
        fc.string({ minLength: 1, maxLength: 64, unit: 'grapheme' }),
      ),
      async (code) => {
        const { requests, oauth } = provider(() => jsonAnswer(200, tokenAnswer()));
        await oauth.exchange({ ...INPUT, code });
        expect(requests).toHaveLength(1);
        const form = new URLSearchParams(requests[0]!.body);
        expect(form.getAll('code')).toEqual([code]);
        expect(form.get('grant_type')).toBe('authorization_code');
      },
    ),
    propParams(),
  );
});

it('[AC-B1-04zzi#6] 成功应答：令牌原样，expiresAt = 收到应答时 Clock 时刻 + expires_in 秒', async () => {
  const { oauth, clock } = provider(() => jsonAnswer(200, tokenAnswer()));
  const before = clock.now().getTime();
  const token = await oauth.exchange({ ...INPUT, code: CODE });
  expect(clock.now().getTime()).toBe(before + ROUND_TRIP_MS);
  expect(token).toEqual({
    accessToken: ACCESS,
    refreshToken: REFRESH,
    expiresAt: new Date(ANSWERED_AT_MS + DAY_S * 1000),
  });
  expect(token.expiresAt).toBeInstanceOf(Date);
});

it.each([1, 3600, 30 * DAY_S, 365 * DAY_S])(
  '[AC-B1-04zzi#6] expires_in=%i 秒按注入时钟换算到期时刻',
  async (seconds) => {
    const { oauth } = provider(() => jsonAnswer(200, tokenAnswer({ expires_in: seconds })));
    const token = await oauth.exchange({ ...INPUT, code: CODE });
    expect(token.expiresAt?.getTime()).toBe(ANSWERED_AT_MS + seconds * 1000);
  },
);

it.each([
  ['缺 expires_in', { expires_in: undefined }],
  ['expires_in=0', { expires_in: 0 }],
  ['expires_in 为负', { expires_in: -60 }],
])('[AC-B1-04zzi#7] %s → expiresAt 为 null（由 reauth 按估算口径处理）', async (_label, patch) => {
  const { oauth } = provider(() => jsonAnswer(200, tokenAnswer(patch)));
  const token = await oauth.exchange({ ...INPUT, code: CODE });
  expect(token).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null });
});

it.each([
  ['缺 refresh_token', { refresh_token: undefined }],
  ['refresh_token 为空串', { refresh_token: '' }],
])('[AC-B1-04zzi#8] %s → refreshToken 为 null', async (_label, patch) => {
  const { oauth } = provider(() => jsonAnswer(200, tokenAnswer(patch)));
  const token = await oauth.exchange({ ...INPUT, code: CODE });
  expect(token).toEqual({
    accessToken: ACCESS,
    refreshToken: null,
    expiresAt: new Date(ANSWERED_AT_MS + DAY_S * 1000),
  });
});

const RAW = `<html>${DESCRIPTION}</html>`;
const FAILURES: [string, () => UnionTransportResponse | Promise<never>][] = [
  [
    'HTTP 400 带 error',
    () => jsonAnswer(400, { error: 'invalid_grant', error_description: DESCRIPTION }),
  ],
  [
    'HTTP 200 带 error',
    () => jsonAnswer(200, { error: 'invalid_client', error_description: DESCRIPTION }),
  ],
  [
    'HTTP 200 同时带 access_token 与 error',
    () =>
      jsonAnswer(200, tokenAnswer({ error: 'invalid_request', error_description: DESCRIPTION })),
  ],
  ['HTTP 500 即使正文像成功应答', () => jsonAnswer(500, tokenAnswer())],
  ['HTTP 401 带成功形状正文', () => jsonAnswer(401, tokenAnswer())],
  ['HTTP 302', () => ({ status: 302, headers: { location: REDIRECT }, body: '' })],
  [
    'HTTP 200 非 JSON',
    () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: RAW }),
  ],
  ['HTTP 200 JSON null', () => jsonAnswer(200, null)],
  ['HTTP 200 JSON 数组', () => jsonAnswer(200, [tokenAnswer()])],
  ['缺 access_token', () => jsonAnswer(200, tokenAnswer({ access_token: undefined }))],
  ['access_token 为空串', () => jsonAnswer(200, tokenAnswer({ access_token: '' }))],
  ['access_token 不是字符串', () => jsonAnswer(200, tokenAnswer({ access_token: 1234567 }))],
  [
    '传输抛错（错误里带 secret、code 与原文）',
    () => Promise.reject(new Error(`network down ${SECRET} ${CODE} ${DESCRIPTION} ${ACCESS}`)),
  ],
];

it.each(FAILURES)(
  '[AC-B1-04zzi#9] %s → 交换被拒，错误不含 code、令牌、secret、应答原文',
  async (_label, answer) => {
    const { oauth, requests } = provider(answer);
    const error = await refusal(() => oauth.exchange({ ...INPUT, code: CODE }));
    expect(requests).toHaveLength(1);
    expect(error).not.toHaveProperty('cause');
    expectHidden(visible(error), [CODE, SECRET, ACCESS, REFRESH, DESCRIPTION, RAW]);
  },
);

it('[AC-B1-04zzi#10] 换令牌时间只读注入 Clock：遥远未来的固定时钟照样得出对应到期', async () => {
  const { oauth, clock } = provider(() => jsonAnswer(200, tokenAnswer({ expires_in: 120 })));
  clock.set('2099-12-31T23:00:00.000Z');
  const token = await oauth.exchange({ ...INPUT, code: CODE });
  expect(token.expiresAt?.toISOString()).toBe(
    new Date(
      new Date('2099-12-31T23:00:00.000Z').getTime() + ROUND_TRIP_MS + 120_000,
    ).toISOString(),
  );
});
