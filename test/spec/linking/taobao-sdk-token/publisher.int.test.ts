import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { expectRedacted, response } from '../../union/taobao-core/kit.ts';
import { ACCESS, TOKEN_ENDPOINT, tokenAnswer } from '../../union/taobao-site-oauth/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  ACCEPTED,
  CREDENTIAL_INVALID,
  GET,
  RELATION,
  SAVE,
  SDK_TOKEN,
  UNAVAILABLE,
  fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);
const PRIVATE_MARKERS = [SDK_TOKEN, encodeURIComponent(SDK_TOKEN), RELATION];

it('[AC-B1-04zzzzq#1] 备案先落单，SDK 令牌原样进入 save 的 session，换令牌端点零请求', async () => {
  const f = await fixture(database());
  const { state } = await f.issueSdk();
  let atSave: Awaited<ReturnType<typeof f.attempts>> | undefined;
  f.transport.mockImplementationOnce(async () => {
    atSave = await f.attempts(state);
    return response({
      tbk_sc_publisher_info_save_response: {
        data: { relation_id: RELATION, session: SDK_TOKEN, account_name: '合成淘宝昵称' },
      },
    });
  });

  const result = await f.submit(state);
  expect(result).toMatchObject(ACCEPTED);
  f.expectSdkCalls(SAVE);
  expect(atSave).toEqual([
    { state, union_account_id: f.account, outcome: null, finished_at: null },
  ]);
  expect(await f.attempts(state)).toEqual([
    { state, union_account_id: f.account, outcome: 'saved', finished_at: f.clock.now() },
  ]);
  expect(await f.bindings()).toEqual([
    {
      id: expect.any(String),
      user_id: f.a,
      union_account_id: f.account,
      relation_id: RELATION,
      status: 'active',
    },
  ]);
  expect(await f.archive()).toEqual([]);
  expectRedacted([result, f.logs()], [SDK_TOKEN, encodeURIComponent(SDK_TOKEN), '合成淘宝昵称']);
});

it('[AC-B1-04zzzzq#2] 上游传输异常引述 SDK 令牌时，异常、响应、日志与归档隐藏令牌', async () => {
  const f = await fixture(database());
  const { state } = await f.issueSdk();
  f.transport.mockRejectedValueOnce(new Error(`合成传输故障 session=${SDK_TOKEN}`));

  const result = await f.submit(state);
  expect(result).toMatchObject(UNAVAILABLE);
  f.expectSdkCalls(SAVE);
  expect(f.adapterErrors).toEqual([expect.any(Error)]);
  expectRedacted([result, f.adapterErrors, f.logs()], PRIVATE_MARKERS);
  expect(await f.archive()).toEqual([]);
  expect(await f.bindings()).toEqual([]);
  expect(await f.attempts(state)).toEqual([
    { state, union_account_id: f.account, outcome: null, finished_at: null },
  ]);
});

it.each(['无历史', '其他用户', '其他联盟账号', '编号不同', '同归属同编号'] as const)(
  '[AC-B1-04zzzzq#4] SDK 重复备案用同一 session 查回编号，历史为%s时按归属决定是否激活',
  async (history) => {
    const f = await fixture(database());
    const { state } = await f.issueSdk();
    if (history === '其他用户') await f.bind('invalid', f.b, RELATION);
    if (history === '其他联盟账号') {
      await f.bind('released', f.a, RELATION, await f.addAccount());
    }
    if (history === '编号不同') await f.bind('invalid', f.a, '819712');
    if (history === '同归属同编号') await f.bind('invalid', f.a, RELATION);
    const before = await f.bindings();
    f.transport
      .mockResolvedValueOnce(
        response({
          tbk_sc_publisher_info_save_response: { data: { desc: '重复绑定渠道' } },
        }),
      )
      .mockResolvedValueOnce(
        response({
          tbk_sc_publisher_info_get_response: {
            data: {
              inviter_list: {
                map_data: [{ relation_id: RELATION, relation_app: 'common', session: SDK_TOKEN }],
              },
            },
          },
        }),
      );

    const result = await f.submit(state);
    f.expectSdkCalls(SAVE, GET);
    expect(await f.attempts(state)).toEqual([
      { state, union_account_id: f.account, outcome: 'duplicate', finished_at: f.clock.now() },
    ]);
    if (history === '同归属同编号') {
      expect(result).toMatchObject(ACCEPTED);
      expect(await f.bindings()).toEqual(before.map((row) => ({ ...row, status: 'active' })));
    } else {
      expect(result).toMatchObject(UNAVAILABLE);
      expect(await f.bindings()).toEqual(before);
    }
    expect(await f.archive()).toEqual([]);
    expectRedacted(f.logs(), PRIVATE_MARKERS);
  },
);

// 合成 TOP 响应。附带字段模拟上游把凭证或渠道编号拼进错误描述。
const TOP_AUTH_ERRORS = [
  { label: 'SDK session 无效', method: 'sdk_token', code: 26, subCode: 'isv.invalid-session' },
  { label: 'SDK 应用不匹配', method: 'sdk_token', code: 28, subCode: 'isv.invalid-app-key' },
  {
    label: 'SDK 权限不足',
    method: 'sdk_token',
    code: 11,
    subCode: 'isv.permission-api-package-limit',
  },
  {
    label: '网页授权权限不足',
    method: 'web_code',
    code: 11,
    subCode: 'isv.permission-api-package-limit',
  },
] as const;
const LOG_METADATA = new Set(['event', 'msg', 'level', 'time', 'pid', 'entry', 'env']);

it.each(TOP_AUTH_ERRORS)(
  '[AC-B1-04zzzzq#7] $label 返回 30104，实际日志中只有一条平铺 TOP 告警',
  async ({ method, code, subCode }) => {
    const f = await fixture(database());
    const { state } = method === 'sdk_token' ? await f.issueSdk() : await f.issue();
    const token = method === 'sdk_token' ? SDK_TOKEN : ACCESS;
    const detail = `合成上游描述 ${token} ${RELATION}`;
    if (method === 'web_code') f.transport.mockResolvedValueOnce(response(tokenAnswer()));
    f.transport.mockResolvedValueOnce(
      response({
        error_response: {
          code,
          sub_code: subCode,
          msg: detail,
          sub_msg: detail,
          session: token,
          relation_id: RELATION,
        },
      }),
    );

    const result = await f.submit(state, 'staging', method);
    expect(result).toMatchObject(CREDENTIAL_INVALID);
    if (method === 'sdk_token') {
      f.expectSdkCalls(SAVE);
    } else {
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(f.transport.mock.calls[0]?.[0].url).toBe(TOKEN_ENDPOINT);
    }
    expect(f.adapterErrors).toEqual([expect.objectContaining({ code: 'invalid_identity' })]);
    expect(f.topLogs).toHaveLength(1);
    const log = JSON.parse(f.topLogs[0]!) as Record<string, unknown>;
    expect(log['level']).toBe(40);
    const applicationFields = Object.entries(log).filter(([key]) => !LOG_METADATA.has(key));
    const fields = Object.fromEntries(applicationFields);
    expect(fields).toEqual({ code: String(code), sub_code: subCode, auth_method: method });
    const privateMarkers = [...PRIVATE_MARKERS, token, '合成上游描述'];
    expectRedacted([result, f.adapterErrors, f.logs()], privateMarkers);
    expect(await f.archive()).toEqual([]);
    expect(await f.bindings()).toEqual([]);
    expect((await f.session(state)).used_at).toEqual(f.clock.now());
    expect(await f.attempts(state)).toEqual([
      { state, union_account_id: f.account, outcome: 'rejected', finished_at: f.clock.now() },
    ]);
  },
);
