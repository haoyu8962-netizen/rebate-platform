// B1-04zzi (FU-TB-AUTH-SESSION, D10-680), SPEC_REF b144fc0: Taobao station-owner OAuth provider.
// Official facts as excerpted by the orchestrator from rebate-private/docs-mirror/taobao/guides/118
// (淘宝 OAuth2.0 服务, server-side flow). Every value here is synthetic and low entropy; the token
// endpoint is a recording stub transport, nothing goes on the network.
import { inspect } from 'node:util';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { TaobaoAppCredentials } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  createTaobaoSiteOAuth,
  type TaobaoSiteOAuthOptions,
} from '../../../../apps/api/src/modules/union/infra/taobao/site-oauth.ts';

export const AUTHORIZE_ENDPOINT = 'https://oauth.taobao.com/authorize';
export const TOKEN_ENDPOINT = 'https://oauth.taobao.com/token';
export const APP_KEY = 'fake-taobao-oauth-app-key';
export const SECRET = 'plain-plain-plain-plain';
export const REDIRECT = 'https://console.fake-site-oauth.test/unions/oauth-callback';
export const CODE = 'fixture-once-only-code';
export const ACCESS = 'fixture-access-access-access';
export const REFRESH = 'fixture-refresh-refresh-refresh';
/** Marker inside error_description / raw answers: must never surface in a thrown error. */
export const DESCRIPTION = 'fixture-upstream-description-text';
export const APP_ID = 'syn-app-id-0417';
export const UNION_ACCOUNT_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
export const NOW = '2032-03-01T04:05:06.000Z';
/** Time the stub token endpoint takes to answer (the clock is moved inside the transport). */
export const ROUND_TRIP_MS = 7_000;
export const DAY_S = 86_400;

/** The official success answer (all documented fields, values synthetic). */
export function tokenAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: ACCESS,
    token_type: 'Bearer',
    expires_in: DAY_S,
    refresh_token: REFRESH,
    re_expires_in: 0,
    r1_expires_in: DAY_S,
    r2_expires_in: 300,
    w1_expires_in: DAY_S,
    w2_expires_in: 300,
    taobao_user_id: '2200000000001',
    taobao_user_nick: encodeURIComponent('合成站长'),
    ...overrides,
  };
}

export function jsonAnswer(status: number, body: unknown): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(body),
  };
}

/** A recording transport; `answer` may move the clock to model the round trip. */
export function stubTransport(
  answer: (
    request: UnionTransportRequest,
  ) => UnionTransportResponse | Promise<UnionTransportResponse>,
) {
  const requests: UnionTransportRequest[] = [];
  const transport: UnionTransport = async (request) => {
    requests.push(request);
    return answer(request);
  };
  return { requests, transport };
}

/** Credentials whose secret read is counted (authorizeUrl must not read it). */
export function trackedCredentials(appKey = APP_KEY, appSecret = SECRET) {
  const reads = { calls: 0, secret: 0 };
  const value = {
    appKey,
    get appSecret() {
      reads.secret += 1;
      return appSecret;
    },
  } as TaobaoAppCredentials;
  const credentials = () => {
    reads.calls += 1;
    return Promise.resolve(value);
  };
  return { reads, credentials };
}

/** The provider over a stub token endpoint answering `answer` after ROUND_TRIP_MS. */
export function provider(
  answer: (
    request: UnionTransportRequest,
  ) => UnionTransportResponse | Promise<UnionTransportResponse>,
  overrides: Partial<TaobaoSiteOAuthOptions> = {},
) {
  const clock = new FixedClock(NOW);
  const tracked = trackedCredentials();
  const stub = stubTransport(async (request) => {
    clock.advanceMs(ROUND_TRIP_MS);
    return answer(request);
  });
  const oauth = createTaobaoSiteOAuth({
    credentials: tracked.credentials,
    transport: stub.transport,
    clock,
    redirectUri: REDIRECT,
    ...overrides,
  });
  return { clock, reads: tracked.reads, requests: stub.requests, oauth };
}

export function header(request: UnionTransportRequest, name: string): string | undefined {
  const found = Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
}

export function visible(value: unknown): string {
  let json = '';
  try {
    json = JSON.stringify(value, Object.getOwnPropertyNames(value ?? {}));
  } catch {
    json = '';
  }
  return `${String(value)}\n${json}\n${inspect(value, { depth: null, showHidden: true })}`;
}

/**
 * The rejection of `run`, which must be a plain refusal: a harness/programming error or the
 * skeleton's NotImplemented stays a red of its own and never passes as a refusal.
 */
export async function refusal(run: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  let resolved = false;
  try {
    await run();
    resolved = true;
  } catch (error) {
    if (
      error instanceof Error &&
      (['AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(
        error.name,
      ) ||
        /\bNotImplemented\b/.test(error.message))
    ) {
      throw error;
    }
    caught = error;
  }
  expect(resolved, 'the exchange must be refused').toBe(false);
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

export function expectHidden(text: string, secrets: readonly string[]) {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
  }
}

/** Environments for loadConfig (same baseline as the B1-04k wiring tests). */
export function environment(appEnv: AppEnv): Record<string, string> {
  return {
    APP_ENV: appEnv,
    ...(appEnv === 'staging' || appEnv === 'prod'
      ? {
          FIELD_KEY_PROVIDER: 'kms',
          FIELD_KEYRING_FILE: '/FAKE_TAOBAO_OAUTH/unused-keyring.json',
          PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
          PRIOR_IDENTITY_KEYRING_FILE: '/FAKE_TAOBAO_OAUTH/unused-prior-identity-keyring.json',
        }
      : {}),
    // B3-09j: prod requires AGENT_USER_HASH_KEY; synthetic test-only value.
    ...(appEnv === 'prod'
      ? { AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-taobao-site-oauth' }
      : {}),
  };
}

export const APP_ENVS = ['local', 'test', 'staging', 'prod'] as const;
