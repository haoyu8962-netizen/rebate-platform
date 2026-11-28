// Unit tests of the staging / prod Taobao auth apps resolver (B1-04zzzzm 补丁 2): the state records
// the issuing OAuth application (web_code: app key + redirect URI; B1-04zzzzq sdk_token: app key
// only), and the exchange side resolves exactly what was recorded for that method, nothing else. No database, no network; synthetic values.
import { describe, expect, it } from 'vitest';
import {
  createDemoUnionAuthApps,
  createTaobaoUnionAuthApps,
  parseTaobaoSdkAppRef,
  parseTaobaoUserOAuthRef,
  resolveIssuedTaobaoOAuthApp,
  taobaoFilingConfigured,
  taobaoLiveFilingReady,
  taobaoSdkAppRef,
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
    const issued = resolveIssuedTaobaoOAuthApp(ref, 'web_code');
    expect(issued !== null && 'redirectUri' in issued ? issued.redirectUri : undefined).toBe(
      APP.redirectUri,
    );
  });

  it('[AC-B1-04zzzzq-UNIT#8] sdk_token 的引用只含签发时的 appKey，与 web_code 引用互不通用', async () => {
    const { ref } = await createTaobaoUnionAuthApps(APP).resolve(
      'synthetic_app',
      'staging',
      'android',
      'sdk_token',
    );
    expect(ref).toBe(taobaoSdkAppRef({ appKey: APP.appKey }));
    expect(ref).not.toContain('secret');
    expect(parseTaobaoSdkAppRef(ref)).toEqual({ appKey: APP.appKey });
    expect(resolveIssuedTaobaoOAuthApp(ref, 'sdk_token')).toEqual({ appKey: APP.appKey });
    expect(resolveIssuedTaobaoOAuthApp(ref, 'web_code')).toBeNull();
    // Only the app key is needed: no redirect URI configured still records the SDK reference.
    const sdkOnly = createTaobaoUnionAuthApps({ appKey: APP.appKey, redirectUri: null });
    await expect(
      sdkOnly.resolve('synthetic_app', 'staging', 'android', 'sdk_token'),
    ).resolves.toEqual({ ref });
    for (const appKey of [null, '']) {
      await expect(
        createTaobaoUnionAuthApps({ appKey, redirectUri: APP.redirectUri }).resolve(
          'synthetic_app',
          'staging',
          'android',
          'sdk_token',
        ),
      ).rejects.toThrow(Error);
    }
    const encode = (value: unknown) =>
      `taobao-sdk-app/v1/${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
    for (const damaged of [
      'taobao-sdk-app/v1/',
      'taobao-sdk-app/v1/!!!',
      encode(['x']),
      encode({ app_key: '' }),
      encode({ app_key: ' padded ' }),
      encode({ app_key: APP.appKey, redirect_uri: APP.redirectUri }),
      taobaoUserOAuthRef(APP),
    ]) {
      expect(parseTaobaoSdkAppRef(damaged)).toBeNull();
      expect(resolveIssuedTaobaoOAuthApp(damaged, 'sdk_token')).toBeNull();
    }
  });

  it('[AC-B1-04zzzzm#7] 配置不全时 web_code 不给引用', async () => {
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

  it('[AC-B1-04zzzzn#11] staging / prod 的 web_code 缺用户 OAuth、邀请码或其所属联盟账号任一项即不就绪', () => {
    for (const env of ['staging', 'prod'] as const) {
      expect(taobaoFilingConfigured(env, complete, 'web_code')).toBe(true);
      for (const name of Object.keys(complete) as (keyof typeof complete)[]) {
        for (const missing of [undefined, null, '', '  ']) {
          const settings = { ...complete, [name]: missing };
          expect(taobaoFilingConfigured(env, settings, 'web_code'), name).toBe(false);
        }
      }
    }
  });

  it('[AC-B1-04zzzzq-UNIT#9] sdk_token 与不分方式的共用门槛不要网页回调地址，其余三项任缺一项仍不就绪', () => {
    for (const env of ['staging', 'prod'] as const) {
      for (const method of ['sdk_token', undefined] as const) {
        for (const missing of [undefined, null, '', '  ']) {
          const noCallback = { ...complete, userRedirectUri: missing };
          expect(taobaoFilingConfigured(env, noCallback, method)).toBe(true);
        }
        for (const name of ['appKey', 'inviterCode', 'inviterAccountId'] as const) {
          for (const missing of [undefined, null, '', '  ']) {
            const settings = { ...complete, [name]: missing };
            expect(taobaoFilingConfigured(env, settings, method), name).toBe(false);
          }
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
