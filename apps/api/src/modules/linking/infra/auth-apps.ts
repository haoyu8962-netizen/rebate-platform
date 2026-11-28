// Application configuration references of the Taobao auth methods (BR-ID-17 细则「授权方式」: the
// state records which application each issued method uses; only server configuration, never a
// client-reported identifier). Only a reference is returned, never a secret (the real resolver's
// reference names the public app key and redirect URI the authorize address carries).
import { Buffer } from 'node:buffer';
import type { AppEnv } from '../../platform/index.ts';
import type { UnionAdapter } from '../../union/index.ts';
import type {
  AuthClient,
  UnionAuthMethod,
  UnionAuthUrlOptions,
} from '../application/union-auth-url.ts';

export type UnionAuthApps = UnionAuthUrlOptions['authApps'];

/**
 * Synthetic references per environment for non-production environments. In prod there is no
 * union application yet: resolution fails, so auth-url answers 50001 and issues no state.
 * TODO(规划/11 §4.5): the real per-environment union application registry — blocked on 推广位 /
 * siteId 与联盟应用.
 */
export function createDemoUnionAuthApps(): UnionAuthApps {
  return {
    resolve(
      appId: string,
      environment: AppEnv,
      client: AuthClient,
      method: UnionAuthMethod,
    ): Promise<{ readonly ref: string }> {
      void appId;
      if (environment === 'prod') {
        return Promise.reject(new Error('linking: no union application configured for prod'));
      }
      return Promise.resolve({ ref: `demo/${environment}/taobao/${client}/${method}` });
    },
  };
}

// B1-04zzzzm 补丁 2（D10-2755；BR-ID-17 细则「state 记录本次下发的内容」）：staging / prod 的真实解析器。
// 签发时为 web_code 记下本次用的淘宝用户 OAuth 配置引用（appKey + redirect_uri，都是授权地址里公开出现的
// 值，不含 secret），写进 state 的 auth_app_refs；兑换时按这条引用取回 appKey 与 redirect_uri，不按实例
// 当前配置（滚动更新期间回调地址变了，已签发的 state 仍按签发时的地址兑换）。secret 只在适配器里按 appKey
// 取：引用的 appKey 与当前应用不同 → 适配器拒绝，不兑换。引用解析不了 → 交换器拒绝，不兑换。
// B1-04zzzzq（D10-3709 ②；BR-ID-17）：sdk_token 的引用另一种格式，只含联盟应用的 appKey（SDK 授权不走回调，
// 没有 redirect_uri）；兑换时按引用取回 appKey，适配器照旧核对它必须是自己的应用，不一致即拒、不发请求。
// 两种引用互不通用：web_code 的引用按 sdk_token 解析、或反过来，一律解析不了。

const TAOBAO_USER_OAUTH_REF_PREFIX = 'taobao-user-oauth/v1/';
const TAOBAO_SDK_APP_REF_PREFIX = 'taobao-sdk-app/v1/';

/** The OAuth application a Taobao state was issued with (what the exchange must use). */
export interface IssuedTaobaoOAuthApp {
  readonly appKey: string;
  readonly redirectUri: string;
}

/** B1-04zzzzq: the union application a Taobao sdk_token state was issued with (app key only). */
export interface IssuedTaobaoSdkApp {
  readonly appKey: string;
}

function isIssuableAppKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

/** The JSON object a reference with `prefix` carries, or null (another format, damaged). */
function decodeRef(ref: unknown, prefix: string): Record<string, unknown> | null {
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return null;
  const encoded = ref.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function encodeRef(prefix: string, payload: Record<string, string>): string {
  return `${prefix}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function isIssuableRedirectUri(value: string): boolean {
  if (!URL.canParse(value) || /\s/.test(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.host !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    !value.includes('#')
  );
}

/** The reference recorded in the state for web_code under this OAuth application. */
export function taobaoUserOAuthRef(app: IssuedTaobaoOAuthApp): string {
  return encodeRef(TAOBAO_USER_OAUTH_REF_PREFIX, {
    app_key: app.appKey,
    redirect_uri: app.redirectUri,
  });
}

/**
 * The OAuth application a recorded reference names, or null when it is not one this resolver
 * issued (another format, damaged, empty app key, a redirect URI that could never be issued).
 */
export function parseTaobaoUserOAuthRef(ref: unknown): IssuedTaobaoOAuthApp | null {
  const parsed = decodeRef(ref, TAOBAO_USER_OAUTH_REF_PREFIX);
  if (parsed === null) return null;
  const { app_key: appKey, redirect_uri: redirectUri } = parsed;
  if (!isIssuableAppKey(appKey)) return null;
  if (typeof redirectUri !== 'string' || !isIssuableRedirectUri(redirectUri)) return null;
  return { appKey, redirectUri };
}

/** B1-04zzzzq: the reference recorded in the state for sdk_token (the union app key only). */
export function taobaoSdkAppRef(app: IssuedTaobaoSdkApp): string {
  return encodeRef(TAOBAO_SDK_APP_REF_PREFIX, { app_key: app.appKey });
}

/**
 * B1-04zzzzq: the union application a recorded sdk_token reference names, or null when it is not
 * one this resolver issued (another format, damaged, an empty app key, any field besides app_key).
 */
export function parseTaobaoSdkAppRef(ref: unknown): IssuedTaobaoSdkApp | null {
  const parsed = decodeRef(ref, TAOBAO_SDK_APP_REF_PREFIX);
  if (parsed === null) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'app_key') return null;
  const appKey = parsed['app_key'];
  return isIssuableAppKey(appKey) ? { appKey } : null;
}

/**
 * The staging / prod resolver: the user-level Taobao OAuth of this process (the Taobao app key,
 * TAOBAO_USER_OAUTH_REDIRECT_URI) for the auth address, and per issued method the reference above
 * (web_code: app key + redirect URI; sdk_token: app key only); an incomplete configuration resolves
 * nothing (auth-url has already
 * answered auth_unavailable through taobaoAuthUrlPlan by then).
 */
export function createTaobaoUnionAuthApps(oauth: {
  readonly appKey: string | null;
  readonly redirectUri: string | null;
}): UnionAuthApps {
  const appKey = oauth.appKey === '' ? null : oauth.appKey;
  const redirectUri = oauth.redirectUri === '' ? null : oauth.redirectUri;
  return {
    taobaoUserOAuth: { appKey, redirectUri },
    resolve(
      appId: string,
      environment: AppEnv,
      client: AuthClient,
      method: UnionAuthMethod,
    ): Promise<{ readonly ref: string }> {
      void appId;
      void environment;
      void client;
      if (method === 'sdk_token') {
        // B1-04zzzzq: the SDK authorization names the union application only (no callback).
        if (appKey === null) {
          return Promise.reject(
            new Error('linking: the taobao union application is not configured'),
          );
        }
        const ref = taobaoSdkAppRef({ appKey });
        if (parseTaobaoSdkAppRef(ref) === null) {
          return Promise.reject(
            new Error('linking: the taobao union application cannot be recorded'),
          );
        }
        return Promise.resolve({ ref });
      }
      if (method !== 'web_code') {
        return Promise.reject(new Error('linking: no taobao application for this auth method'));
      }
      if (appKey === null || redirectUri === null) {
        return Promise.reject(new Error('linking: the taobao user OAuth is not configured'));
      }
      const ref = taobaoUserOAuthRef({ appKey, redirectUri });
      // Never record a reference the exchange could not resolve again.
      if (parseTaobaoUserOAuthRef(ref) === null) {
        return Promise.reject(new Error('linking: the taobao user OAuth cannot be recorded'));
      }
      return Promise.resolve({ ref });
    },
  };
}

/**
 * The exchange side (UnionBindingExchanger's resolveApp in staging / prod): the application the
 * state recorded for the method — web_code: app key + redirect URI; B1-04zzzzq sdk_token: the app
 * key only; null (refused, nothing exchanged) for a reference this resolver did not issue for that
 * very method.
 */
export function resolveIssuedTaobaoOAuthApp(
  ref: string,
  method: UnionAuthMethod,
): IssuedTaobaoOAuthApp | IssuedTaobaoSdkApp | null {
  if (method === 'web_code') return parseTaobaoUserOAuthRef(ref);
  if (method === 'sdk_token') return parseTaobaoSdkAppRef(ref);
  return null;
}

/**
 * B1-04zzzzm 补丁 3 ② (D10-2826; BR-ID-17 / BR-ATTR-05): whether the real Taobao filing adapter is
 * ready, the one judgement GET auth-url / the opens issue a real Taobao authorization under and the
 * credential exchange hands a credential over under. Only staging / prod are judged (local / test
 * keep the demo exchange): the Taobao adapter of the process's union ports must have a channel
 * filing and be governed under a live endpoint (UnionAdapter.endpointMode); a demo (or replay)
 * endpoint, an adapter without filing, or no Taobao endpoint at all is not ready. Without union
 * ports (`adapter` undefined) staging is not ready; prod is judged ready, because its union boot
 * refuses non-live endpoints and such a process has no filing adapter for the exchange to reach.
 */
export function taobaoLiveFilingReady(
  appEnv: AppEnv,
  adapter: (() => Pick<UnionAdapter, 'bindPublisher' | 'endpointMode'>) | undefined,
): boolean {
  if (appEnv !== 'staging' && appEnv !== 'prod') return true;
  if (adapter === undefined) return appEnv === 'prod';
  let filing: Pick<UnionAdapter, 'bindPublisher' | 'endpointMode'>;
  try {
    filing = adapter();
  } catch {
    return false;
  }
  return typeof filing.bindPublisher === 'function' && filing.endpointMode === 'live';
}

/** B1-04zzzzn r2: the server settings one real Taobao channel filing needs (no secret). */
export interface TaobaoFilingSettings {
  /** TAOBAO_APP_KEY. */
  readonly appKey: string | null | undefined;
  /** TAOBAO_USER_OAUTH_REDIRECT_URI. */
  readonly userRedirectUri: string | null | undefined;
  /** TAOBAO_INVITER_CODE. */
  readonly inviterCode: string | null | undefined;
  /** TAOBAO_INVITER_ACCOUNT_ID. */
  readonly inviterAccountId: string | null | undefined;
}

/**
 * B1-04zzzzn r2 (money review S1; BR-ID-17): whether every setting the real filing needs is there
 * — the user OAuth (app key, user redirect URI), the inviter code and the union account it belongs
 * to. Only staging / prod are judged (local / test keep the demo exchange). Missing any one → not
 * ready, read together with taobaoLiveFilingReady by issuance and by the submission alike, so no
 * state is issued or consumed for a filing that would be refused for its configuration.
 */
export function taobaoFilingConfigured(appEnv: AppEnv, settings: TaobaoFilingSettings): boolean {
  if (appEnv !== 'staging' && appEnv !== 'prod') return true;
  const present = (value: string | null | undefined) =>
    typeof value === 'string' && value.trim() !== '';
  return (
    present(settings.appKey) &&
    present(settings.userRedirectUri) &&
    present(settings.inviterCode) &&
    present(settings.inviterAccountId)
  );
}
