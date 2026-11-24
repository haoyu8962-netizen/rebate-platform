// Unit tests of the staging / prod Taobao auth apps resolver (B1-04zzzzm 补丁 2): the state records
// the issuing OAuth application (app key + redirect URI) for web_code only, and the exchange side
// resolves exactly what was recorded, nothing else. No database, no network; synthetic values.
import { describe, expect, it } from 'vitest';
import {
  createDemoUnionAuthApps,
  createTaobaoUnionAuthApps,
  parseTaobaoUserOAuthRef,
  resolveIssuedTaobaoOAuthApp,
  taobaoFilingConfigured,
  taobaoLiveFilingReady,
  taobaoUserOAuthRef,
} from './auth-apps.ts';

const APP = {
  appKey: 'synthetic-app-key',
  redirectUri: 'https://user-auth.example.test/Callback?next=%2Fme%3Fa%3D1&lang=zh',
};

describe('createTaobaoUnionAuthApps', () => {
  it('[AC-B1-04zzzzm#7] web_code 记下签发时的应用与回调，兑换按引用原样取回', async () => {
    const apps = createTaobaoUnionAuthApps(APP);
    expect(apps.taobaoUserOAuth).toEqual(APP);
    const { ref } = await apps.resolve('synthetic_app', 'prod', 'ios', 'web_code');
    expect(ref).not.toContain('secret');
    expect(resolveIssuedTaobaoOAuthApp(ref, 'web_code')).toEqual(APP);
    // The redirect URI recorded at issue wins over a later instance setting.
    const later = createTaobaoUnionAuthApps({
      ...APP,
      redirectUri: 'https://other.example.test/cb',
    });
    expect(later.taobaoUserOAuth?.redirectUri).not.toBe(APP.redirectUri);
    expect(resolveIssuedTaobaoOAuthApp(ref, 'web_code')?.redirectUri).toBe(APP.redirectUri);
  });

  it('[AC-B1-04zzzzm#7] sdk_token 与配置不全时不给引用', async () => {
    await expect(
      createTaobaoUnionAuthApps(APP).resolve('synthetic_app', 'staging', 'android', 'sdk_token'),
    ).rejects.toThrow(Error);
    for (const partial of [
      { appKey: null, redirectUri: APP.redirectUri },
      { appKey: APP.appKey, redirectUri: null },
      { appKey: '', redirectUri: APP.redirectUri },
    ]) {
      const apps = createTaobaoUnionAuthApps(partial);
      await expect(apps.resolve('synthetic_app', 'prod', 'ios', 'web_code')).rejects.toThrow(Error);
    }
  });
});

describe('resolveIssuedTaobaoOAuthApp', () => {
  it('[AC-B1-04zzzzm#7] 解析不了的引用一律拒绝', async () => {
    const { ref: demoRef } = await createDemoUnionAuthApps().resolve(
      'synthetic_app',
      'staging',
      'ios',
      'web_code',
    );
    const encode = (value: unknown) =>
      `taobao-user-oauth/v1/${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
    const refused = [
      demoRef,
      'synthetic-app-ref',
      '',
      'taobao-user-oauth/v1/',
      'taobao-user-oauth/v1/!!!',
      encode(['x']),
      encode({ app_key: '', redirect_uri: APP.redirectUri }),
      encode({ app_key: APP.appKey }),
      encode({ app_key: APP.appKey, redirect_uri: 'http://user-auth.example.test/cb' }),
      encode({ app_key: APP.appKey, redirect_uri: 'https://user-auth.example.test/cb#f' }),
      encode({ app_key: APP.appKey, redirect_uri: 'https://u:p@user-auth.example.test/cb' }),
    ];
    for (const ref of refused) {
      expect(parseTaobaoUserOAuthRef(ref)).toBeNull();
      expect(resolveIssuedTaobaoOAuthApp(ref, 'web_code')).toBeNull();
    }
    expect(resolveIssuedTaobaoOAuthApp(taobaoUserOAuthRef(APP), 'sdk_token')).toBeNull();
  });
});

describe('taobaoLiveFilingReady', () => {
  const bindPublisher = async () => ({ relationId: 'synthetic-relation' });

  it('[AC-B1-04zzzzm#8] staging / prod 只认受治理于 live 端点且能备案的淘宝适配器', () => {
    for (const env of ['staging', 'prod'] as const) {
      expect(taobaoLiveFilingReady(env, () => ({ bindPublisher, endpointMode: 'live' }))).toBe(
        true,
      );
      expect(taobaoLiveFilingReady(env, () => ({ bindPublisher, endpointMode: 'demo' }))).toBe(
        false,
      );
      expect(taobaoLiveFilingReady(env, () => ({ bindPublisher, endpointMode: 'replay' }))).toBe(
        false,
      );
      expect(taobaoLiveFilingReady(env, () => ({ bindPublisher }))).toBe(false);
      expect(taobaoLiveFilingReady(env, () => ({ endpointMode: 'live' }))).toBe(false);
      const noEndpoint = () => {
        throw new Error('union: no endpoint for taobao');
      };
      expect(taobaoLiveFilingReady(env, noEndpoint)).toBe(false);
    }
  });

  it('[AC-B1-04zzzzm#8] 没有联盟端口时 staging 不就绪、prod 就绪；local / test 不判', () => {
    expect(taobaoLiveFilingReady('staging', undefined)).toBe(false);
    expect(taobaoLiveFilingReady('prod', undefined)).toBe(true);
    expect(taobaoLiveFilingReady('local', () => ({ endpointMode: 'demo' }))).toBe(true);
    expect(taobaoLiveFilingReady('test', undefined)).toBe(true);
  });
});

describe('taobaoFilingConfigured', () => {
  const complete = {
    appKey: 'synthetic-app-key',
    userRedirectUri: 'https://user-auth.example.test/callback',
    inviterCode: 'synthetic-inviter',
    inviterAccountId: '0199a3b4-5c6d-7000-8000-0000000000a1',
  };

  it('[AC-B1-04zzzzn#11] staging / prod 缺用户 OAuth、邀请码或其所属联盟账号任一项即不就绪', () => {
    for (const env of ['staging', 'prod'] as const) {
      expect(taobaoFilingConfigured(env, complete)).toBe(true);
      for (const name of Object.keys(complete) as (keyof typeof complete)[]) {
        for (const missing of [undefined, null, '', '  ']) {
          expect(taobaoFilingConfigured(env, { ...complete, [name]: missing }), name).toBe(false);
        }
      }
    }
  });

  it('[AC-B1-04zzzzn#11] local / test 不判配置', () => {
    const empty = {
      appKey: null,
      userRedirectUri: null,
      inviterCode: null,
      inviterAccountId: null,
    };
    expect(taobaoFilingConfigured('local', empty)).toBe(true);
    expect(taobaoFilingConfigured('test', empty)).toBe(true);
  });
});
