// Fake station-owner OAuth providers for the admin re-authorization (B1-22d; BR-ID-24 ③, 细则
// 「后台告警手机号与重新授权会话」). No union's site OAuth adapter exists yet, so the admin entry
// assembles these in local / test only (as identity's fake third-party identity and fake SMS);
// elsewhere it gets no provider (an oauth-mode start then fails closed).
//
// The rule tests in test/spec/union/admin-accounts/** rely on this convention:
//
// - createFakeSiteOAuth(appEnv, clock): local / test only, any other APP_ENV throws. It answers a
//   provider for every registered platform (taobao, jd, pdd); whether one is used depends on the
//   account's reauth_mode.
//   - authorizeUrl: an https address on the host `site-oauth.example.test` whose query parameter
//     `state` is exactly the state handed in (the console test reads it back from `auth_url`);
//     nothing else secret is in it.
//   - exchange, by the grant `code`:
//     `fake-site:ok:<label>` → accessToken `fake-site-access:<label>`, refreshToken
//     `fake-site-refresh:<label>`, expiresAt null (the union returned no expiry);
//     `fake-site:days:<n>:<label>` (n a whole number 1–3650) → the same tokens, expiresAt =
//     clock.now() + n days;
//     anything else → rejects with an Error whose message quotes the code (so a leak of the
//     provider's error text is visible to the tests).
// - createSiteOAuthProviders(appEnv, clock, logger, wiring?): what the admin entry injects: the
//   fake in local / test (wiring ignored); in staging / prod (B1-04zzi, D10-680) the real Taobao
//   provider (./taobao/site-oauth.ts) only when the wiring has a non-empty appKey, a non-empty
//   appSecret and a non-empty redirect URI, jd and pdd never; otherwise no provider, announced once
//   with a warn `union_site_oauth_unconfigured` (no code, state, secret or token is ever logged).
import type { Clock, RootLogger, TaobaoAppCredentials } from '../../platform/index.ts';
import type { SiteOAuthProvider } from '../auth-expiry/reauth.ts';
import { REGISTERED_PLATFORMS, type RegisteredPlatform } from '../domain/types.ts';
import type { UnionTransport } from './replay.ts';
import { createTaobaoSiteOAuth } from './taobao/site-oauth.ts';

export type SiteOAuthProviders = Partial<Readonly<Record<RegisteredPlatform, SiteOAuthProvider>>>;

/** What the admin entry hands over for the real providers (B1-04zzi). */
export interface SiteOAuthWiring {
  /** The B1-04k Taobao app credentials as opened at startup; null when the entry has none. */
  readonly taobaoCredentials: TaobaoAppCredentials | null;
  /** AppConfig.taobaoOAuthRedirectUri (TAOBAO_OAUTH_REDIRECT_URI); null when unset. */
  readonly taobaoRedirectUri: string | null;
  /** HTTPS transport of the token request (createUnionHttpTransport; not archived). */
  readonly transport: UnionTransport;
}

const HOST = 'https://site-oauth.example.test';
const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;
const OK = /^fake-site:ok:(.+)$/s;
const DAYS = /^fake-site:days:([1-9][0-9]{0,3}):(.+)$/s;

function isFakeEnv(appEnv: string): boolean {
  return appEnv === 'local' || appEnv === 'test';
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

function fakeProvider(platform: RegisteredPlatform, clock: Clock): SiteOAuthProvider {
  return {
    authorizeUrl(input) {
      const url = new URL('/authorize', HOST);
      url.searchParams.set('platform', platform);
      url.searchParams.set('state', input.state);
      return Promise.resolve(url.toString());
    },
    exchange(input) {
      const ok = OK.exec(input.code);
      if (ok !== null) {
        const label = ok[1]!;
        return Promise.resolve({
          accessToken: `fake-site-access:${label}`,
          refreshToken: `fake-site-refresh:${label}`,
          expiresAt: null,
        });
      }
      const dated = DAYS.exec(input.code);
      const days = dated === null ? NaN : Number(dated[1]);
      if (dated !== null && days >= 1 && days <= MAX_DAYS) {
        const label = dated[2]!;
        return Promise.resolve({
          accessToken: `fake-site-access:${label}`,
          refreshToken: `fake-site-refresh:${label}`,
          expiresAt: later(clock.now(), days * DAY_MS),
        });
      }
      // Quotes the code on purpose: a leak of the provider's error text must be visible in tests.
      return Promise.reject(new Error(`fake site oauth: grant refused (${input.code})`));
    },
  };
}

/** Only local / test may construct these providers. */
export function createFakeSiteOAuth(appEnv: string, clock: Clock): SiteOAuthProviders {
  if (!isFakeEnv(appEnv)) throw new Error('union: fake site OAuth is local/test only');
  return Object.freeze(
    Object.fromEntries(
      REGISTERED_PLATFORMS.map((platform) => [platform, fakeProvider(platform, clock)]),
    ) as Record<RegisteredPlatform, SiteOAuthProvider>,
  );
}

/**
 * The admin entry's providers: the fake in local / test; elsewhere the real Taobao provider when the
 * wiring is complete, none otherwise (one warn).
 */
export function createSiteOAuthProviders(
  appEnv: string,
  clock: Clock,
  logger: Pick<RootLogger, 'warn'>,
  wiring?: SiteOAuthWiring,
): SiteOAuthProviders {
  if (isFakeEnv(appEnv)) return createFakeSiteOAuth(appEnv, clock);
  const credentials = wiring?.taobaoCredentials ?? null;
  const redirectUri = wiring?.taobaoRedirectUri ?? null;
  if (
    wiring === undefined ||
    credentials === null ||
    credentials.appKey === '' ||
    credentials.appSecret === '' ||
    redirectUri === null ||
    redirectUri === ''
  ) {
    logger.warn({ app_env: appEnv }, 'union_site_oauth_unconfigured');
    return Object.freeze({});
  }
  return Object.freeze({
    taobao: createTaobaoSiteOAuth({
      credentials: () => Promise.resolve(credentials),
      // The plain HTTPS transport as handed in: never wrapped in the archiving transport.
      transport: wiring.transport,
      clock,
      redirectUri,
    }),
  });
}
