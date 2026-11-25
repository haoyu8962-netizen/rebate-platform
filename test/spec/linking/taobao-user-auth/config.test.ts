import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import { environment, REDIRECT as SITE_REDIRECT } from '../../union/taobao-site-oauth/kit.ts';
import { INVITER_CODE, USER_REDIRECT } from './kit.ts';

const REDIRECT_ENV = 'TAOBAO_USER_OAUTH_REDIRECT_URI';

it('[AC-B1-04zzzzm#2] 启动配置分别保留用户回调、站长回调和备案邀请码', () => {
  const env = environment('staging');
  const config = loadConfig({
    ...env,
    TAOBAO_OAUTH_REDIRECT_URI: SITE_REDIRECT,
    [REDIRECT_ENV]: USER_REDIRECT,
    TAOBAO_INVITER_CODE: INVITER_CODE,
  });
  expect(config.taobaoUserOAuthRedirectUri).toBe(USER_REDIRECT);
  expect(config.taobaoOAuthRedirectUri).toBe(SITE_REDIRECT);
  expect(config.taobaoInviterCode).toBe(INVITER_CODE);
  expect(loadConfig(env).taobaoUserOAuthRedirectUri ?? null).toBeNull();
  expect(loadConfig(env).taobaoInviterCode ?? null).toBeNull();
});

it.each([
  ['http', 'http://user-auth.example.test/callback'],
  ['缺主机', 'https://'],
  ['含用户信息', 'https://fake-user:fake-password@user-auth.example.test/callback'],
  ['含片段', 'https://user-auth.example.test/callback#fake-fragment'],
])('[AC-B1-04zzzzm#2] 用户回调地址%s时拒绝启动且只报告变量名', (_, redirect) => {
  const load = () => loadConfig({ ...environment('staging'), [REDIRECT_ENV]: redirect });
  expect(load).toThrow(ConfigError);
  expect(load).toThrow(REDIRECT_ENV);
  expect(load).not.toThrow(redirect);
});

it.each([
  ['空串', ''],
  ['纯空白', '  '],
])('[AC-B1-04zzzzm#2] 备案邀请码为%s时按缺省读取', (_, inviterCode) => {
  const config = loadConfig({ ...environment('staging'), TAOBAO_INVITER_CODE: inviterCode });
  expect(config.taobaoInviterCode).toBeNull();
});
