// Unit tests of the staging / prod Taobao auth apps resolver (B1-04zzzzm 补丁 2): the state records
// the issuing OAuth application (app key + redirect URI) for web_code only, and the exchange side
// resolves exactly what was recorded, nothing else. No database, no network; synthetic values.
import { describe, expect, it } from 'vitest';
import {
  createDemoUnionAuthApps,
  createTaobaoUnionAuthApps,
  parseTaobaoUserOAuthRef,
  resolveIssuedTaobaoOAuthApp,
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
