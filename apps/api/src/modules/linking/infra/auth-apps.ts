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
// sdk_token 在真实淘宝适配器支持前不签发（union-auth-state.ts issuableTaobaoMethods），这里也不给它引用。

const TAOBAO_USER_OAUTH_REF_PREFIX = 'taobao-user-oauth/v1/';

/** The OAuth application a Taobao state was issued with (what the exchange must use). */
export interface IssuedTaobaoOAuthApp {
  readonly appKey: string;
  readonly redirectUri: string;
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
  const payload = JSON.stringify({ app_key: app.appKey, redirect_uri: app.redirectUri });
  return `${TAOBAO_USER_OAUTH_REF_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

/**
 * The OAuth application a recorded reference names, or null when it is not one this resolver
 * issued (another format, damaged, empty app key, a redirect URI that could never be issued).
 */
export function parseTaobaoUserOAuthRef(ref: unknown): IssuedTaobaoOAuthApp | null {
  if (typeof ref !== 'string' || !ref.startsWith(TAOBAO_USER_OAUTH_REF_PREFIX)) return null;
  const encoded = ref.slice(TAOBAO_USER_OAUTH_REF_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { app_key: appKey, redirect_uri: redirectUri } = parsed as Record<string, unknown>;
  if (typeof appKey !== 'string' || appKey.trim() === '' || appKey !== appKey.trim()) return null;
  if (typeof redirectUri !== 'string' || !isIssuableRedirectUri(redirectUri)) return null;
  return { appKey, redirectUri };
}

/**
 * The staging / prod resolver: the user-level Taobao OAuth of this process (the Taobao app key,
 * TAOBAO_USER_OAUTH_REDIRECT_URI) for the auth address, and per issued method the reference above.
 * Only web_code gets one; an incomplete configuration resolves nothing (auth-url has already
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
 * state recorded for the method; null (refused, nothing exchanged) for anything but a web_code
 * reference this resolver issued.
 */
export function resolveIssuedTaobaoOAuthApp(
  ref: string,
  method: UnionAuthMethod,
): IssuedTaobaoOAuthApp | null {
  if (method !== 'web_code') return null;
  return parseTaobaoUserOAuthRef(ref);
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
