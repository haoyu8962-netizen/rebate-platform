// 淘宝站长授权的回调地址（B1-04zzi，D10-680）：TAOBAO_OAUTH_REDIRECT_URI 是后台控制台
// /unions/oauth-callback 页的公网 https 地址，即淘宝 OAuth2.0 的 redirect_uri。不是密钥，不登记进
// ./credential-env.ts，任何 APP_ENV 都可设（local / test 设了也只给假实现，由 union 装配决定）。
// 纯函数：只看传入对象，问题文本只写变量名，不回显取值。
//
// - 未设或空串 → null（staging / prod 不注入淘宝真实 provider，发起即 fail closed）。
// - 须是带主机名的 https 绝对地址，不带用户名 / 密码、片段与空白；否则问题项。
// Erasable syntax only (this directory is also compiled by the `test` project).

export const TAOBAO_OAUTH_REDIRECT_URI_ENV = 'TAOBAO_OAUTH_REDIRECT_URI';

const PROBLEM = `${TAOBAO_OAUTH_REDIRECT_URI_ENV}: must be an absolute https URL with a host (no credentials, fragment or whitespace)`;

function isRedirectUri(raw: string): boolean {
  if (!raw.startsWith('https://')) return false;
  if (/[\s#\\]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  );
}

/** The configured redirect URI as given, or null when unset or invalid (invalid adds a problem). */
export function readTaobaoOAuthConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly taobaoOAuthRedirectUri: string | null;
  readonly problems: readonly string[];
} {
  const raw = env[TAOBAO_OAUTH_REDIRECT_URI_ENV];
  if (raw === undefined || raw === '') return { taobaoOAuthRedirectUri: null, problems: [] };
  return isRedirectUri(raw)
    ? { taobaoOAuthRedirectUri: raw, problems: [] }
    : { taobaoOAuthRedirectUri: null, problems: [PROBLEM] };
}
