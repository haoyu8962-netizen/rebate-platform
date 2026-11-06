// B1-04zzi / D10-680: TAOBAO_OAUTH_REDIRECT_URI is a non-secret setting of platform/config. It may
// be left unset; when set it must be an absolute https: URL, otherwise loadConfig refuses with a
// problem that names the variable only.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  findCredentialLikeEnvNames,
  looksLikeRealCredentialEnvName,
} from '../../../../apps/api/src/modules/platform/config/credential-env.ts';
import { APP_ENVS, REDIRECT, environment, visible } from './kit.ts';

const NAME = 'TAOBAO_OAUTH_REDIRECT_URI';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function refused(env: Readonly<Record<string, string | undefined>>): ConfigError {
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

it.each(APP_ENVS)(
  '[AC-B1-04zzi#14] %s 接受 https 绝对地址并原样放进 AppConfig.taobaoOAuthRedirectUri',
  (appEnv) => {
    const config = loadConfig({ ...environment(appEnv), [NAME]: REDIRECT });
    expect(config.taobaoOAuthRedirectUri).toBe(REDIRECT);
  },
);

it.each(APP_ENVS)(
  '[AC-B1-04zzi#14] %s 不设或设为空串照常启动，回调地址为缺省；它不算真实凭据变量',
  (appEnv) => {
    // Set: kept (the field exists); unset or empty: no redirect URI.
    expect(loadConfig({ ...environment(appEnv), [NAME]: REDIRECT }).taobaoOAuthRedirectUri).toBe(
      REDIRECT,
    );
    expect(loadConfig(environment(appEnv)).taobaoOAuthRedirectUri ?? null).toBeNull();
    expect(
      loadConfig({ ...environment(appEnv), [NAME]: '' }).taobaoOAuthRedirectUri ?? null,
    ).toBeNull();
    expect(looksLikeRealCredentialEnvName(NAME)).toBe(false);
    expect(findCredentialLikeEnvNames({ [NAME]: REDIRECT })).toEqual([]);
  },
);

const INVALID = [
  'http://console.fake-site-oauth.test/unions/oauth-callback',
  'ftp://console.fake-site-oauth.test/unions/oauth-callback',
  '//console.fake-site-oauth.test/unions/oauth-callback',
  '/unions/oauth-callback',
  'console.fake-site-oauth.test/unions/oauth-callback',
  'not a url at all',
];

for (const appEnv of APP_ENVS) {
  it.each(INVALID)(
    `[AC-B1-04zzi#15] ${appEnv} 非 https 绝对地址 %s 拒绝启动，问题只写变量名`,
    (value) => {
      const error = refused({ ...environment(appEnv), [NAME]: value });
      expect(error.problems.join('\n')).toContain(NAME);
      expect(visible(error)).not.toContain(value);
    },
  );
}

it('[AC-B1-04zzi#15] 其他配置也无效时照样汇总回调地址问题，不泄漏原值', () => {
  const value = 'http://console.fake-site-oauth.test/unions/oauth-callback';
  for (const appEnv of APP_ENVS) {
    const error = refused({
      ...environment(appEnv),
      API_PORT: 'FAKE_INVALID_PORT',
      [NAME]: value,
    });
    expect(error.problems.join('\n')).toContain('API_PORT');
    expect(error.problems.join('\n')).toContain(NAME);
    expect(visible(error)).not.toContain(value);
  }
});

it('[AC-B1-04zzi#16] 环境示例列出注释掉的 TAOBAO_OAUTH_REDIRECT_URI，不给值', async () => {
  const example = await readFile(`${ROOT}.env.example`, 'utf8');
  const declarations = example
    .split('\n')
    .filter((line) => new RegExp(`^\\s*#?\\s*${NAME}(?:\\s|=|$)`).test(line));
  expect(declarations.length).toBeGreaterThan(0);
  for (const line of declarations) {
    expect(line).toMatch(/^\s*#/);
    expect(line).not.toMatch(new RegExp(`${NAME}\\s*=\\s*[^\\s#]`));
  }
});
