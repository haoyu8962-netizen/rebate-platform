import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { expectRedacted, formFields, response, sent, setup } from '../../union/taobao-core/kit.ts';
import {
  ACCESS,
  APP_KEY,
  SECRET,
  TOKEN_ENDPOINT,
  tokenAnswer,
} from '../../union/taobao-site-oauth/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import { INVITER_CODE } from '../taobao-user-auth/kit.ts';
import { CREDENTIAL_INVALID, RELATION, SAVE, SDK_TOKEN, UNAVAILABLE, fixture } from './kit.ts';

const database = databaseFixture(createTestDatabase);
const LOG_METADATA = new Set(['event', 'msg', 'level', 'time', 'pid', 'entry', 'env']);

it.each([
  { method: 'sdk_token', code: 27, label: '会话已失效' },
  { method: 'sdk_token', code: 29, label: '应用标识无效' },
  { method: 'sdk_token', code: 12, label: '用户权限不足' },
  { method: 'web_code', code: 27, label: '会话已失效' },
  { method: 'web_code', code: 29, label: '应用标识无效' },
  { method: 'web_code', code: 12, label: '用户权限不足' },
] as const)(
  '[AC-B1-04zzzzq#8] $method 收到 TOP $code（$label）返回 30104 并写一条平铺告警',
  async ({ method, code }) => {
    const f = await fixture(database());
    const isSdk = method === 'sdk_token';
    const { state } = isSdk ? await f.issueSdk() : await f.issue();
    const token = isSdk ? SDK_TOKEN : ACCESS;
    // 用无分类含义的合成子码，验证主码本身足以识别这三类拒绝。
    const subCode = 'isv.synthetic-detail';
    const detail = `合成上游描述 ${token} ${RELATION}`;
    if (!isSdk) f.transport.mockResolvedValueOnce(response(tokenAnswer()));
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
    if (isSdk) {
      f.expectSdkCalls(SAVE);
    } else {
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(sent(f.transport).url).toBe(TOKEN_ENDPOINT);
      expect(formFields(sent(f.transport, 1))).toMatchObject({ method: SAVE, session: ACCESS });
    }
    expect(f.adapterErrors).toEqual([expect.objectContaining({ code: 'invalid_identity' })]);
    expect(f.topLogs).toHaveLength(1);
    const log = JSON.parse(f.topLogs[0]!) as Record<string, unknown>;
    expect(log['level']).toBe(40);
    const fields = Object.entries(log).filter(([key]) => !LOG_METADATA.has(key));
    expect(Object.fromEntries(fields)).toEqual({
      code: String(code),
      sub_code: subCode,
      auth_method: method,
    });
    expectRedacted(
      [result, f.adapterErrors, f.logs()],
      [token, encodeURIComponent(token), RELATION, '合成上游描述'],
    );
    expect(await f.archive()).toEqual([]);
    expect(await f.bindings()).toEqual([]);
    expect((await f.session(state)).used_at).toEqual(f.clock.now());
    expect(await f.attempts(state)).toEqual([
      { state, union_account_id: f.account, outcome: 'rejected', finished_at: f.clock.now() },
    ]);
  },
);

it.each([
  { label: '绑定归属另一联盟账号', reason: 'inviter_account_mismatch' },
  { label: '缺少邀请码', reason: 'inviter_code_missing' },
] as const)(
  '[AC-B1-04zzzzq#9] SDK 备案遇到$label时拒绝，零请求、零尝试记录且绑定原样保留',
  async ({ reason }) => {
    const db = database();
    const f = await fixture(db);
    const mismatch = reason === 'inviter_account_mismatch';
    const bindingAccount = mismatch ? await f.addAccount() : f.account;
    await f.bind('invalid', f.a, RELATION, bindingAccount);
    const { state } = await f.issueSdk();
    const bindings = () =>
      db.selectFrom('union_bindings').selectAll().where('app_id', '=', f.appId).execute();
    const before = await bindings();
    const { adapter, warn } = setup({
      clock: f.clock,
      transport: f.transport,
      credentials: async () => ({
        appKey: APP_KEY,
        appSecret: SECRET,
        userOAuth: {
          redirectUri: null,
          inviterCode: mismatch ? INVITER_CODE : null,
          inviterAccountId: f.account,
        },
      }),
    });
    f.publisher.mockImplementationOnce((request, context) =>
      adapter.bindPublisher(request, context),
    );

    const result = await f.submit(state);
    expect(result).toMatchObject(UNAVAILABLE);
    expect(f.publisher).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ credentialType: 'sdk_token', unionAccountId: bindingAccount }),
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: reason }));
    expect(f.transport).not.toHaveBeenCalled();
    const attempts = await db
      .selectFrom('union_filing_attempts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
    expect(attempts).toEqual([]);
    expect(await bindings()).toEqual(before);
  },
);
