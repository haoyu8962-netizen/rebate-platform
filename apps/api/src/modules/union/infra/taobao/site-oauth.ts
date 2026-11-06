// Taobao station-owner OAuth (B1-04zzi; FU-TB-AUTH-SESSION, D10-680): the real SiteOAuthProvider
// of B1-22c's re-authorization sessions, over the Taobao open platform OAuth2.0 server-side flow
// (rebate-private/docs-mirror/taobao/guides/118). The session flow itself (state hash, claim,
// exchange outside the transaction, FieldCrypto, audit) stays in ../../auth-expiry/reauth.ts.
//
// The rule tests in test/spec/union/taobao-site-oauth/** rely on this convention:
//
// - authorizeUrl → `https://oauth.taobao.com/authorize?` with exactly the official parameters
//   response_type=code, client_id=<appKey>, redirect_uri=<redirectUri> (URL encoded),
//   state=<state as handed in>, view=web. None of our own values (appId, unionAccountId,
//   expiresAt) and never the secret; the transport is not called and appSecret is not read.
// - exchange → one POST through `transport` (platform taobao) to `https://oauth.taobao.com/token`,
//   content-type application/x-www-form-urlencoded, body with exactly grant_type=authorization_code,
//   client_id, client_secret, code, redirect_uri. A 2xx JSON answer with a non-empty string
//   access_token and no `error` gives { accessToken: access_token, refreshToken: refresh_token
//   (missing or empty → null), expiresAt: clock.now() read after the answer arrived + expires_in
//   seconds (missing or not a positive number → null) }.
//   Anything else (non-2xx, not JSON, `error` present, access_token missing, transport error) →
//   rejects with an Error whose text and properties carry no code, token, secret or answer text
//   (the `error` code may appear) and no `cause`.
// - Credentials come only from the injected provider (B1-04k openTaobaoCredentials: staging file,
//   prod KMS); this module reads no environment variable or file, logs nothing, and reads time only
//   from the injected Clock. The sandbox host oauth.tbsandbox.com is never used.
import type { Clock, TaobaoAppCredentials } from '../../../platform/index.ts';
import type { SiteOAuthProvider } from '../../auth-expiry/reauth.ts';
import type { UnionTransport, UnionTransportResponse } from '../replay.ts';

export interface TaobaoSiteOAuthOptions {
  /** The Taobao app key and secret (B1-04k); asked for when needed, never cached here. */
  readonly credentials: () => Promise<TaobaoAppCredentials>;
  /** HTTPS transport of the token request; not an archiving one (the answer carries tokens). */
  readonly transport: UnionTransport;
  readonly clock: Clock;
  /** TAOBAO_OAUTH_REDIRECT_URI: the console's /unions/oauth-callback page (https). */
  readonly redirectUri: string;
}

export const TAOBAO_OAUTH_AUTHORIZE_URL = 'https://oauth.taobao.com/authorize';
export const TAOBAO_OAUTH_TOKEN_URL = 'https://oauth.taobao.com/token';

/** Only an `error` code of this shape is quoted in a refusal (anything else may carry text). */
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A refused token exchange. The message holds a fixed text, the HTTP status or the upstream
 * `error` code at most; never the code, a token, the secret or the answer; no `cause`.
 */
export class TaobaoSiteOAuthError extends Error {
  constructor(reason: string) {
    super(`taobao site oauth: ${reason}`);
    this.name = 'TaobaoSiteOAuthError';
  }
}

/** `instant` plus `ms` as a new Date (the Clock's instant is never modified). */
function later(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAnswer(response: UnionTransportResponse): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    body = undefined;
  }
  const status = response.status;
  if (isRecord(body) && body['error'] !== undefined && body['error'] !== null) {
    const code = body['error'];
    const quoted = typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'unknown';
    throw new TaobaoSiteOAuthError(`token request refused (status ${status}, error ${quoted})`);
  }
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new TaobaoSiteOAuthError(`token request refused (status ${status})`);
  }
  if (!isRecord(body)) throw new TaobaoSiteOAuthError('token answer is not a JSON object');
  return body;
}

export function createTaobaoSiteOAuth(options: TaobaoSiteOAuthOptions): SiteOAuthProvider {
  const { credentials, transport, clock, redirectUri } = options;
  return {
    async authorizeUrl(input) {
      // Only the app key: the secret is not read for the authorize address.
      const { appKey } = await credentials();
      const params: readonly (readonly [string, string])[] = [
        ['response_type', 'code'],
        ['client_id', appKey],
        ['redirect_uri', redirectUri],
        ['state', input.state],
        ['view', 'web'],
      ];
      const query = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
      return `${TAOBAO_OAUTH_AUTHORIZE_URL}?${query}`;
    },
    async exchange(input) {
      const app = await credentials();
      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('client_id', app.appKey);
      form.set('client_secret', app.appSecret);
      form.set('code', input.code);
      form.set('redirect_uri', redirectUri);
      let response: UnionTransportResponse;
      try {
        // No `archive` context: the request carries the secret and the code, the answer tokens
        // (B1-04zzi review S2: never written to union_raw_payloads).
        response = await transport({
          platform: 'taobao',
          url: TAOBAO_OAUTH_TOKEN_URL,
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            accept: 'application/json',
          },
          body: form.toString(),
        });
      } catch {
        // The transport's error may quote the request: only a fixed text, no cause.
        throw new TaobaoSiteOAuthError('token request failed');
      }
      const answer = parseAnswer(response);
      const accessToken = answer['access_token'];
      if (typeof accessToken !== 'string' || accessToken === '') {
        throw new TaobaoSiteOAuthError('token answer has no access_token');
      }
      const refresh = answer['refresh_token'];
      const expiresIn = answer['expires_in'];
      // Read after the answer arrived: the expiry counts from receipt.
      const now = clock.now();
      const expiresAt =
        typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
          ? later(now, expiresIn * 1000)
          : null;
      return {
        accessToken,
        refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
        // An expiry beyond the Date range counts as none (reauth estimates it).
        expiresAt: expiresAt !== null && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
      };
    },
  };
}
