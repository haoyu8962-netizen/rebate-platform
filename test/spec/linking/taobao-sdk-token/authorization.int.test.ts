import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { resolveIssuedTaobaoOAuthApp } from '../../../../apps/api/src/modules/linking/infra/auth-apps.ts';
import { APP_KEY } from '../../union/taobao-site-oauth/kit.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  ACCEPTED,
  CREDENTIAL_INVALID,
  METHOD_NOT_ALLOWED,
  SAVE,
  UNAVAILABLE,
  fixture,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-04zzzzq#3] SDK 引用只含签发时的 appKey，拒绝其他应用且零请求', async () => {
  const f = await fixture(database());
  const otherAppKey = 'synthetic-former-taobao-app';
  const { state, row } = await f.issueSdk(otherAppKey);
  const refs = row.auth_app_refs as { sdk_token: string; web_code: string };
  expect(resolveIssuedTaobaoOAuthApp(refs.sdk_token, 'sdk_token')).toEqual({ appKey: otherAppKey });
  expect(resolveIssuedTaobaoOAuthApp(refs.sdk_token, 'web_code')).toBeNull();
  expect(resolveIssuedTaobaoOAuthApp(refs.web_code, 'sdk_token')).toBeNull();

  const result = await f.submit(state);
  expect(result).toMatchObject(result.envelope.code === 30104 ? CREDENTIAL_INVALID : UNAVAILABLE);
  expect(f.publisher).toHaveBeenCalledTimes(1);
  expect(f.transport).not.toHaveBeenCalled();
  expect(await f.attempts(state)).toEqual([]);
  expect(await f.bindings()).toEqual([]);

  const own = await f.issueSdk();
  const ownRefs = own.row.auth_app_refs as { sdk_token: string };
  expect(resolveIssuedTaobaoOAuthApp(ownRefs.sdk_token, 'sdk_token')).toEqual({ appKey: APP_KEY });
  expect(await f.submit(own.state)).toMatchObject(ACCEPTED);
  f.expectSdkCalls(SAVE);
});

it('[AC-B1-04zzzzq#5] 生产过滤实验方式且拒绝 SDK 提交，非生产按当前配置签发和放行', async () => {
  const f = await fixture(database());
  const prod = await f.issue('prod');
  expect(prod.issued.envelope.data).toMatchObject({ auth_methods: ['web_code'] });
  expect(prod.row).toMatchObject({ auth_methods: ['web_code'] });
  expect(prod.row.auth_app_refs).not.toHaveProperty('sdk_token');
  expect(await f.submit(prod.state, 'prod')).toMatchObject(METHOD_NOT_ALLOWED);
  expect((await f.session(prod.state)).used_at).toBeNull();
  expect(f.publisher).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();

  const staging = await f.issueSdk();
  // 共用测试数据库，让生产也能读到一条带 SDK 方式的记录，单独验证提交时的配置门禁。
  expect(await f.submit(staging.state, 'prod')).toMatchObject(METHOD_NOT_ALLOWED);
  expect((await f.session(staging.state)).used_at).toBeNull();

  f.config.set(f.configKey, ['web_code']);
  expect(await f.submit(staging.state)).toMatchObject(METHOD_NOT_ALLOWED);
  expect((await f.session(staging.state)).used_at).toBeNull();
  expect(f.publisher).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();

  f.config.set(f.configKey, ['sdk_token', 'web_code']);
  expect(await f.submit(staging.state)).toMatchObject(ACCEPTED);
  f.expectSdkCalls(SAVE);
});

it('[AC-B1-04zzzzq#6] 两个不同幂等键并发提交同一个 SDK state，只有一次进入备案', async () => {
  const f = await fixture(database());
  const { state } = await f.issueSdk();
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  f.configValue.mockImplementation(async (appId, key) => {
    if (appId !== f.appId || key !== f.configKey) return null;
    // 两个请求均已读到未消费的 state，到达当前配置检查后才一起进入消费步骤。
    arrivals += 1;
    if (arrivals === 2) ready.resolve();
    await ready.promise;
    return { value: ['sdk_token', 'web_code'], version: 1 };
  });

  const replies = await Promise.all([
    f.submit(state).finally(() => ready.resolve()),
    f.submit(state).finally(() => ready.resolve()),
  ]);
  expect(arrivals).toBe(2);
  expect(replies.map(({ envelope }) => envelope.code).sort()).toEqual([0, 30104]);
  expect(replies.find(({ envelope }) => envelope.code === 0)).toMatchObject(ACCEPTED);
  const expired = replies.find(({ envelope }) => envelope.code === 30104);
  expect(expired).toMatchObject({ status: 422 });
  expect(expired?.envelope.data).toBeUndefined();
  expect((await f.session(state)).used_at).toEqual(f.clock.now());
  expect(f.publisher).toHaveBeenCalledTimes(1);
  f.expectSdkCalls(SAVE);
  expect(await f.attempts(state)).toEqual([
    { state, union_account_id: f.account, outcome: 'saved', finished_at: f.clock.now() },
  ]);
});
