// The one-time authorization state (BR-ID-17: bound to uid + device_id (+ link_id), 10 minutes,
// single use, consumed by the bindings submission) as one issuing logic shared by
// GET /v1/unions/{platform}/auth-url (B1-06g, link_id empty) and the Taobao open's 30101 / 30102
// (B1-06f, link_id = the link the open serves). The client recorded is the DEVICE RECORD's, never a
// declaration (BR-ID-17 细则「授权方式」). This module writes only union_auth_sessions.
import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AppEnv } from '../../platform/index.ts';
import { AuthConfigError, type AuthClient, type UnionAuthMethod } from './union-auth-reads.ts';

/** BR-ID-17: a state lives 10 minutes. */
export const AUTH_STATE_TTL_MS = 600_000;

const CLIENTS: ReadonlySet<string> = new Set<AuthClient>(['ios', 'android', 'harmony']);

/**
 * Server-owned application configuration references, scoped to the issuing environment.
 * B1-04zzzzm: `taobaoUserOAuth` is the user-level Taobao OAuth (app key, TAOBAO_USER_OAUTH_REDIRECT_URI)
 * the staging / prod wiring always passes; absent (hand-built ports, rule tests of B1-06g) the
 * synthetic address stays as before.
 */
export interface UnionAuthAppsPort {
  readonly taobaoUserOAuth?: {
    readonly appKey: string | null;
    readonly redirectUri: string | null;
  };
  resolve(
    appId: string,
    environment: AppEnv,
    client: AuthClient,
    method: UnionAuthMethod,
  ): Promise<{ readonly ref: string }>;
}

/**
 * 128+ random bits from the CSPRNG, base64url; it carries no identity in clear (BR-ID-17: the
 * binding to uid / device lives in the row, not in the state string).
 */
export function newAuthState(): string {
  return `st_${randomBytes(32).toString('base64url')}`;
}

/**
 * The synthetic address on example.test carrying only the issued state: what a Taobao authorization
 * gets when no user OAuth port is wired (hand-built ports), and in local / test when that port lacks
 * the app key or redirect URI. Taobao only: Pinduoduo's link comes from UnionAdapter.pddAuthorityUrl
 * (B1-06zf, pdd-authority.ts).
 */
export function syntheticAuthUrl(platform: 'taobao', state: string): string {
  return `https://oauth.example.test/${platform}/authorize?state=${encodeURIComponent(state)}`;
}

/** The Taobao OAuth2.0 authorize endpoint (docs-mirror taobao/guides/118, 105590). */
const TAOBAO_AUTHORIZE_URL = 'https://oauth.taobao.com/authorize';

/**
 * B1-04zzzzm (D10-2713): how a Taobao authorization address is made for this environment.
 * - no `taobaoUserOAuth` port → 'synthetic' (unchanged behaviour of hand-built ports);
 * - the port with both a non-empty app key and redirect URI → 'oauth';
 * - the port missing either → 'unavailable' in staging / prod (the caller answers auth_unavailable
 *   and issues no state; never a synthetic address there), 'synthetic' in local / test.
 */
export type TaobaoAuthUrlPlan =
  | { readonly kind: 'synthetic' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'oauth'; readonly appKey: string; readonly redirectUri: string };

export function taobaoAuthUrlPlan(authApps: UnionAuthAppsPort, appEnv: AppEnv): TaobaoAuthUrlPlan {
  const oauth = authApps.taobaoUserOAuth;
  if (oauth === undefined) return { kind: 'synthetic' };
  const { appKey, redirectUri } = oauth;
  if (
    typeof appKey === 'string' &&
    appKey !== '' &&
    typeof redirectUri === 'string' &&
    redirectUri !== ''
  ) {
    return { kind: 'oauth', appKey, redirectUri };
  }
  return appEnv === 'staging' || appEnv === 'prod'
    ? { kind: 'unavailable' }
    : { kind: 'synthetic' };
}

/**
 * The address of an issuable plan: the real Taobao OAuth authorize address (response_type=code,
 * client_id, redirect_uri as configured, the issued state as is, view=wap for the mobile page;
 * docs-mirror taobao/guides/105590) or the synthetic one. Shared by GET auth-url and the open's
 * 30101 / 30102 so both hand out the same address.
 */
export function taobaoAuthUrl(
  plan: Exclude<TaobaoAuthUrlPlan, { readonly kind: 'unavailable' }>,
  state: string,
): string {
  if (plan.kind === 'synthetic') return syntheticAuthUrl('taobao', state);
  const params: readonly (readonly [string, string])[] = [
    ['response_type', 'code'],
    ['client_id', plan.appKey],
    ['redirect_uri', plan.redirectUri],
    ['state', state],
    ['view', 'wap'],
  ];
  const query = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  return `${TAOBAO_AUTHORIZE_URL}?${query}`;
}

/**
 * The client of the device record: 'missing' when the device is unknown or revoked (the caller
 * answers 10001); a record without a supported client is a configuration fault.
 */
export async function deviceClientOf(
  executor: Kysely<DB>,
  appId: string,
  deviceId: string,
): Promise<AuthClient | 'missing'> {
  const device = await executor
    .selectFrom('devices')
    .select(['platform', 'revoked_at'])
    .where('app_id', '=', appId)
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (device === undefined || device.revoked_at !== null) return 'missing';
  if (!CLIENTS.has(device.platform)) {
    throw new AuthConfigError('linking: device record carries no supported client');
  }
  return device.platform as AuthClient;
}

/** Each method's application reference; only the reference leaves the resolver. */
export async function authAppRefs(
  authApps: UnionAuthAppsPort,
  appEnv: AppEnv,
  appId: string,
  client: AuthClient,
  methods: readonly UnionAuthMethod[],
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const method of methods) {
    const { ref } = await authApps.resolve(appId, appEnv, client, method);
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw new AuthConfigError('linking: no application reference for an auth method');
    }
    refs[method] = ref;
  }
  return refs;
}

export interface AuthSessionValues {
  readonly state: string;
  readonly appId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly platform: 'taobao' | 'pdd';
  readonly client: AuthClient;
  /** The link the state is bound to (an open's 30101 / 30102); null for auth-url. */
  readonly linkId: string | null;
  readonly now: Date;
  readonly expireAt: Date;
  /** Taobao only: the issued methods and their application references. */
  readonly methods: readonly UnionAuthMethod[] | null;
  readonly refs: Readonly<Record<string, string>> | null;
}

/** The union_auth_sessions row of a freshly issued state (mode bind). */
export async function insertAuthSession(
  executor: Kysely<DB>,
  values: AuthSessionValues,
): Promise<void> {
  await executor
    .insertInto('union_auth_sessions')
    .values({
      state: values.state,
      app_id: values.appId,
      user_id: values.userId,
      device_id: values.deviceId,
      platform: values.platform,
      mode: 'bind',
      link_id: values.linkId,
      expire_at: values.expireAt,
      used_at: null,
      created_at: values.now,
      client: values.client,
      auth_methods: values.methods === null ? null : [...values.methods],
      auth_app_refs:
        values.refs === null
          ? null
          : sql<DB['union_auth_sessions']['auth_app_refs']>`${JSON.stringify(values.refs)}::jsonb`,
    })
    .execute();
}
