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

/** Server-owned application configuration references, scoped to the issuing environment. */
export interface UnionAuthAppsPort {
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
 * TODO(规划/11 §4.5): real Taobao authorization link generation — blocked on FU-TB-AUTH-SESSION.
 * Until then a synthetic address on example.test carrying only the issued state. Taobao only:
 * Pinduoduo's link comes from UnionAdapter.pddAuthorityUrl (B1-06zf, pdd-authority.ts).
 */
export function syntheticAuthUrl(platform: 'taobao', state: string): string {
  return `https://oauth.example.test/${platform}/authorize?state=${encodeURIComponent(state)}`;
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
