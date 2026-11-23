import { expect, it } from 'vitest';
import { UnionBindingExchanger } from '../../../../apps/api/src/modules/linking/application/union-binding-exchanger.ts';
import {
  ctx,
  endpoint,
  expectRedacted,
  formFields,
  response,
  sent,
  setup,
} from '../../union/taobao-core/kit.ts';
import {
  ACCESS,
  APP_KEY,
  CODE,
  REFRESH,
  SECRET,
  TOKEN_ENDPOINT,
  refusal,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const SAVE = 'taobao.tbk.sc.publisher.info.save';
const GET = 'taobao.tbk.sc.publisher.info.get';
const MARKERS = [CODE, ACCESS, REFRESH, INVITER_CODE, SECRET];

function publisher(inviterCode: string | null = INVITER_CODE) {
  const { adapter, transport, warn } = setup({
    credentials: async () => ({
      appKey: APP_KEY,
      appSecret: SECRET,
      userOAuth: { redirectUri: USER_REDIRECT, inviterCode },
    }),
  });
  transport.mockReset().mockRejectedValue(new Error('合成传输收到未预期的上游请求'));
  const exchanger = new UnionBindingExchanger(() => adapter.bindPublisher.bind(adapter));
  const exchange = (code = CODE) =>
    exchanger.exchange({
      appId: ctx.appId,
      traceId: ctx.requestId,
      method: 'web_code',
      credential: { code },
      appRef: 'synthetic-app-ref',
    });
  return { adapter, exchange, transport, warn };
}

function duplicateSave() {
  return response({ tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } } });
}

function expectPublisherRequest(
  transport: ReturnType<typeof publisher>['transport'],
  index: number,
  method: string,
) {
  const request = sent(transport, index);
  expect(request).toMatchObject({ platform: 'taobao', url: endpoint.baseUrl, method: 'POST' });
  expect(request.archive).toBeUndefined();
  const form = formFields(request);
  expect(form).toMatchObject({ method, session: ACCESS, info_type: '1' });
  expect(form).not.toHaveProperty('code');
  return form;
}

function expectSafeWarning(warn: ReturnType<typeof publisher>['warn']) {
  expect(warn).toHaveBeenCalledTimes(1);
  const fields = warn.mock.calls[0]?.[0];
  expect(fields).toEqual(expect.any(Object));
  for (const value of Object.values(fields ?? {})) {
    expect(value === null || ['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
  }
  expectRedacted(warn.mock.calls, MARKERS);
}

it.each([
  ['数字', '9007199254740993', '9007199254740993'],
  ['字符串', '"000811796"', '000811796'],
])('[AC-B1-04zzzzm#3] 用用户令牌备案，保留%s relation_id', async (_, wireId, expectedId) => {
  const { exchange, transport, warn } = publisher();
  const saved = response({});
  transport.mockResolvedValueOnce(response(tokenAnswer())).mockResolvedValueOnce({
    ...saved,
    body: `{"tbk_sc_publisher_info_save_response":{"data":{"relation_id":${wireId},"account_name":"合成昵称"}}}`,
  });

  expect(await exchange()).toEqual({ kind: 'bound', relationId: expectedId });
  expect(transport).toHaveBeenCalledTimes(2);
  const oauth = sent(transport);
  expect(oauth).toMatchObject({ platform: 'taobao', method: 'POST', url: TOKEN_ENDPOINT });
  const contentType = Object.entries(oauth.headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  );
  expect(contentType?.[1]).toMatch(/^application\/x-www-form-urlencoded(?:\s*;|$)/i);
  expect(formFields(oauth)).toEqual({
    grant_type: 'authorization_code',
    client_id: APP_KEY,
    client_secret: SECRET,
    code: CODE,
    redirect_uri: USER_REDIRECT,
  });
  expect(oauth.archive).toBeUndefined();
  expect(expectPublisherRequest(transport, 1, SAVE)).toHaveProperty('inviter_code', INVITER_CODE);
  expectRedacted(warn.mock.calls, MARKERS);
});

it('[AC-B1-04zzzzm#4] 重复备案时用同一用户令牌查回编号', async () => {
  const { exchange, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockResolvedValueOnce(duplicateSave())
    .mockResolvedValueOnce(
      response({
        tbk_sc_publisher_info_get_response: {
          data: {
            total_count: 1,
            inviter_list: { map_data: [{ relation_app: 'common', relation_id: 731082 }] },
          },
        },
      }),
    );

  expect(await exchange()).toEqual({ kind: 'bound', relationId: '731082' });
  expect(transport).toHaveBeenCalledTimes(3);
  expectPublisherRequest(transport, 1, SAVE);
  expectPublisherRequest(transport, 2, GET);
  expectRedacted(warn.mock.calls, MARKERS);
});

it('[AC-B1-04zzzzm#4] 保存和查询均无编号时备案失败并告警', async () => {
  const { exchange, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockResolvedValueOnce(duplicateSave())
    .mockResolvedValueOnce(
      response({
        tbk_sc_publisher_info_get_response: {
          data: { total_count: 0, inviter_list: { map_data: [] } },
        },
      }),
    );

  const [result] = await Promise.allSettled([exchange()]);
  expect(transport).toHaveBeenCalledTimes(3);
  expectPublisherRequest(transport, 1, SAVE);
  expectPublisherRequest(transport, 2, GET);
  if (result?.status === 'fulfilled') {
    expect(result.value).toEqual({ kind: 'credential_invalid' });
  } else {
    expect(result?.reason).toBeInstanceOf(Error);
  }
  expectRedacted(result, MARKERS);
  expectSafeWarning(warn);
});

it('[AC-B1-04zzzzm#5] 缺备案邀请码时失败并告警，不向淘宝发请求', async () => {
  const { exchange, transport, warn } = publisher(null);
  await expect(exchange()).rejects.toBeInstanceOf(Error);
  expect(transport).not.toHaveBeenCalled();
  expectSafeWarning(warn);
});

it('[AC-B1-04zzzzm#5] 无效授权码返回 credential_invalid，隐藏凭据', async () => {
  const { exchange, transport, warn } = publisher();
  transport.mockResolvedValueOnce(
    response({ error: 'invalid_grant', error_description: MARKERS.join(' ') }, 400),
  );

  expect(await exchange()).toEqual({ kind: 'credential_invalid' });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(sent(transport).archive).toBeUndefined();
  expectRedacted(warn.mock.calls, MARKERS);
});

it('[AC-B1-04zzzzm#5] 备案传输失败时，错误与告警不泄漏凭据', async () => {
  const { exchange, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockRejectedValue(new Error(MARKERS.join(' ')));

  const [result] = await Promise.allSettled([exchange()]);
  expect(transport.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(result).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
  expectRedacted(result, MARKERS);
  expectRedacted(warn.mock.calls, MARKERS);
  expectPublisherRequest(transport, 1, SAVE);
});

it('[AC-B1-04zzzzm#5] 同一适配器的后续备案使用本次授权换得的令牌', async () => {
  const { exchange, transport, warn } = publisher();
  const nextCode = 'synthetic-next-user-code';
  const nextAccess = 'synthetic-next-user-access';
  const saved = (relation_id: number) =>
    response({ tbk_sc_publisher_info_save_response: { data: { relation_id } } });
  transport
    .mockResolvedValueOnce(response(tokenAnswer()))
    .mockResolvedValueOnce(saved(111178))
    .mockResolvedValueOnce(response(tokenAnswer({ access_token: nextAccess })))
    .mockResolvedValueOnce(saved(222279));

  expect(await exchange()).toEqual({ kind: 'bound', relationId: '111178' });
  expect(await exchange(nextCode)).toEqual({ kind: 'bound', relationId: '222279' });
  expect(transport).toHaveBeenCalledTimes(4);
  expect(formFields(sent(transport, 0))).toHaveProperty('code', CODE);
  expect(formFields(sent(transport, 1))).toMatchObject({ method: SAVE, session: ACCESS });
  expect(formFields(sent(transport, 2))).toHaveProperty('code', nextCode);
  expect(formFields(sent(transport, 3))).toMatchObject({ method: SAVE, session: nextAccess });
  expectRedacted(warn.mock.calls, [...MARKERS, nextCode, nextAccess]);
});

const USER_ID = '2200000000042';
const USER_NICK = '合成授权用户+昵称';
const SAVE_ACCOUNT_NAME = '合成保存账号';
const GET_ACCOUNT_NAME = '合成查询账号';
const PERSONAL_MARKERS = [USER_ID, USER_NICK, SAVE_ACCOUNT_NAME, GET_ACCOUNT_NAME];
const PRIVATE_MARKERS = [
  ...MARKERS,
  ...PERSONAL_MARKERS,
  ...PERSONAL_MARKERS.map(encodeURIComponent),
];
const TOKEN_USER = { taobao_user_id: USER_ID, taobao_user_nick: encodeURIComponent(USER_NICK) };

function duplicateSaveWithAccount() {
  return response({
    tbk_sc_publisher_info_save_response: {
      data: { desc: '重复绑定渠道', account_name: SAVE_ACCOUNT_NAME },
    },
  });
}

function publisherRejection(accountName: string) {
  return response({
    error_response: { code: 15, msg: PRIVATE_MARKERS.join(' '), account_name: accountName },
  });
}

it('[AC-B1-04zzzzm#5] 保存备案成功时，个人信息不出现在返回值或日志', async () => {
  const { adapter, transport, warn } = publisher();
  transport.mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)));
  transport.mockResolvedValueOnce(
    response({
      tbk_sc_publisher_info_save_response: {
        data: { relation_id: '811796', account_name: SAVE_ACCOUNT_NAME },
      },
    }),
  );

  const result = await adapter.bindPublisher({ authorizationCode: CODE }, ctx);
  expect(result).toEqual({ relationId: '811796' });
  expect(transport).toHaveBeenCalledTimes(2);
  expectPublisherRequest(transport, 1, SAVE);
  expectRedacted([result, warn.mock.calls], PRIVATE_MARKERS);
});

it.each([
  ['大整数', '9007199254740993', '9007199254740993'],
  ['前导零字符串', '"000811796"', '000811796'],
])('[AC-B1-04zzzzm#4] 重复备案查询保留%s编号且隐藏个人信息', async (_, wireId, expectedId) => {
  const { adapter, transport, warn } = publisher();
  transport
    .mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)))
    .mockResolvedValueOnce(duplicateSaveWithAccount())
    .mockResolvedValueOnce({
      ...response({}),
      body: `{"tbk_sc_publisher_info_get_response":{"data":{"total_count":1,"inviter_list":{"map_data":[{"relation_app":"common","relation_id":${wireId},"account_name":${JSON.stringify(GET_ACCOUNT_NAME)}}]}}}}`,
    });

  const result = await adapter.bindPublisher({ authorizationCode: CODE }, ctx);
  expect(result).toEqual({ relationId: expectedId });
  expect(transport).toHaveBeenCalledTimes(3);
  expectPublisherRequest(transport, 1, SAVE);
  expectPublisherRequest(transport, 2, GET);
  expectRedacted([result, warn.mock.calls], PRIVATE_MARKERS);
});

it.each([
  {
    scenario: '保存和查询都没有编号',
    answers: [
      response(tokenAnswer(TOKEN_USER)),
      duplicateSaveWithAccount(),
      response({
        tbk_sc_publisher_info_get_response: {
          data: {
            total_count: 1,
            inviter_list: {
              map_data: [{ relation_app: 'common', account_name: GET_ACCOUNT_NAME }],
            },
          },
        },
      }),
    ],
  },
  {
    scenario: '淘宝拒绝保存备案',
    answers: [response(tokenAnswer(TOKEN_USER)), publisherRejection(SAVE_ACCOUNT_NAME)],
  },
  {
    scenario: '淘宝拒绝备案查询',
    answers: [
      response(tokenAnswer(TOKEN_USER)),
      duplicateSaveWithAccount(),
      publisherRejection(GET_ACCOUNT_NAME),
    ],
  },
  {
    scenario: '授权码换令牌失败',
    answers: [
      response(
        { ...TOKEN_USER, error: 'invalid_grant', error_description: PRIVATE_MARKERS.join(' ') },
        400,
      ),
    ],
  },
])('[AC-B1-04zzzzm#5] $scenario 时，原始异常和日志隐藏个人信息', async ({ answers }) => {
  const { adapter, transport, warn } = publisher();
  for (const answer of answers) transport.mockResolvedValueOnce(answer);

  const error = await refusal(() => adapter.bindPublisher({ authorizationCode: CODE }, ctx));
  expect(transport).toHaveBeenCalledTimes(answers.length);
  expectRedacted([error, warn.mock.calls], PRIVATE_MARKERS);
});

it.each([
  ['空串', ''],
  ['纯空白', '  '],
])('[AC-B1-04zzzzm#5] 备案邀请码为%s时失败并告警，不发保存请求', async (_, inviterCode) => {
  const { adapter, transport, warn } = publisher(inviterCode);
  transport.mockResolvedValueOnce(response(tokenAnswer(TOKEN_USER)));

  const error = await refusal(() => adapter.bindPublisher({ authorizationCode: CODE }, ctx));
  const methods = transport.mock.calls.map(([request]) =>
    new URLSearchParams(request.body ?? '').get('method'),
  );
  expect(methods).not.toContain(SAVE);
  expectSafeWarning(warn);
  const warningText = Object.values(warn.mock.calls[0]?.[0] ?? {}).join(' ');
  expect(warningText).toMatch(/invit(?:e|er)[_ -]?code|邀请码/i);
  expect(warningText).toMatch(
    /missing|unconfigured|required|empty|blank|unset|缺失|缺少|未配置|未设置|为空/i,
  );
  expectRedacted([error, warn.mock.calls], PRIVATE_MARKERS);
});
