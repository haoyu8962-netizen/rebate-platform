// Read-only judgements shared by the auth-url issue (B1-06g) and the bindings submission
// (B1-06h), so both use one definition of "the account this authorization uses" and of the site
// authorization judged on it (BR-ID-24 ④), one projection of the authorization page (BR-ID-17
// 细则「授权管理页」) and one reading of union.taobao.auth_methods.<client> (BR-ID-17 细则「授权方式」).
//
// Cross-module reads (user_risk_state, union_bindings, union_accounts) are read-only selects scoped
// by app_id, plus union's read-only active-pid port. Nothing here writes.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { SystemClock, type AppEnv, type Clock } from '../../platform/index.ts';
import type { UnionPidService } from '../../union/index.ts';
import type { LinkingConfigReader } from '../ports.ts';

export type AuthPlatform = 'taobao' | 'pdd';
export type AuthClient = 'ios' | 'android' | 'harmony';
export type UnionAuthMethod = components['schemas']['AuthMethod'];

/** BR-ID-19: at most one unreleased binding per user and platform. */
export const UNRELEASED: readonly string[] = Object.freeze([
  'pending_auth',
  'active',
  'invalid',
  'blocked',
]);

/** BR-ID-17 细则「授权方式」: the default when union.taobao.auth_methods.<client> is not set. */
const DEFAULT_METHODS: readonly UnionAuthMethod[] = Object.freeze(['web_code']);
const METHODS: ReadonlySet<string> = new Set<UnionAuthMethod>(['web_code', 'sdk_token']);

/** A configuration fault is a server fault: never guessed, never re-ordered or intersected. */
export class AuthConfigError extends Error {}

/**
 * union.taobao.auth_methods.<client>: an ordered list of one or two distinct known methods, kept
 * exactly in its configured order. Absent → the default. Anything else is a configuration fault.
 */
function parseMethods(value: unknown): readonly UnionAuthMethod[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    !value.every((m) => typeof m === 'string' && METHODS.has(m)) ||
    new Set(value).size !== value.length
  ) {
    throw new AuthConfigError('linking: union.taobao.auth_methods is not an ordered method list');
  }
  return value as UnionAuthMethod[];
}

export interface UnionAuthReadsOptions {
  readonly clock?: Clock;
  readonly db: Kysely<DB>;
  readonly config: LinkingConfigReader;
  readonly appEnv: AppEnv;
  readonly pids: Pick<UnionPidService, 'getActivePid'>;
}

export interface BindingProjection {
  readonly status: string;
  /** The unreleased binding's account; null when there is no unreleased binding. */
  readonly accountId: string | null;
}

export interface UnionAuthReads {
  binding(appId: string, userId: string, platform: AuthPlatform): Promise<BindingProjection>;
  userBanned(appId: string, userId: string): Promise<boolean>;
  authAccountId(
    appId: string,
    platform: AuthPlatform,
    bound: string | null,
  ): Promise<string | null>;
  siteAuthAvailable(
    appId: string,
    platform: AuthPlatform,
    accountId: string | null,
  ): Promise<boolean>;
  configuredMethods(appId: string, client: AuthClient): Promise<readonly UnionAuthMethod[]>;
}

export function createUnionAuthReads(options: UnionAuthReadsOptions): UnionAuthReads {
  const { db, config, appEnv, pids } = options;
  // B1-22b: the request-side time guard reads the injected Clock (app.module always passes it).
  const clock = options.clock ?? new SystemClock();

  return {
    async binding(appId, userId, platform) {
      const rows = await db
        .selectFrom('union_bindings')
        .select(['status', 'union_account_id'])
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('platform', '=', platform)
        .execute();
      // The projection of the authorization page (BR-ID-17 细则「授权管理页」): the unreleased
      // binding when there is one (its account is the one this authorization uses), else released
      // when a released row exists, else unbound.
      const unreleased = rows.find((row) => UNRELEASED.includes(row.status));
      if (unreleased !== undefined) {
        return { status: unreleased.status, accountId: unreleased.union_account_id };
      }
      return {
        status: rows.some((row) => row.status === 'released') ? 'released' : 'unbound',
        accountId: null,
      };
    },

    async userBanned(appId, userId) {
      const row = await db
        .selectFrom('user_risk_state')
        .select('state')
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row?.state === 'banned';
    },

    /**
     * The union account this authorization uses: the unreleased binding's; otherwise the account
     * of the platform's active self_buy pid (union's own selection of the current pid, purpose
     * convert); otherwise the platform's earliest registered account (union_accounts created_at, id
     * ascending — re-authorizing or registering a pid never moves it; D10-239). null: no account.
     */
    async authAccountId(appId, platform, bound) {
      if (bound !== null) return bound;
      const pid = await pids.getActivePid({
        appId,
        platform,
        pidScene: 'self_buy',
        purpose: 'convert',
      });
      if (pid !== null && pid.app_id === appId && pid.platform === platform) {
        return pid.union_account_id;
      }
      const first = await db
        .selectFrom('union_accounts')
        .select('id')
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .executeTakeFirst();
      return first?.id ?? null;
    },

    /**
     * BR-ID-24 ④: the site's authorization of exactly the account this authorization uses is
     * usable (not expired); another account of the platform being valid never masks it.
     */
    async siteAuthAvailable(appId, platform, accountId) {
      if (accountId === null) return false;
      const row = await db
        .selectFrom('union_accounts')
        .select(['auth_status', 'auth_expires_at'])
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .where('id', '=', accountId)
        .executeTakeFirst();
      // B1-22b (BR-ID-24 ④, 12 §7.2): from the instant auth_expires_at is reached the site
      // authorization counts as expired, before the expiry job writes the status column.
      if (row === undefined || row.auth_status === 'expired') return false;
      // A row without an expiry instant (null) has no time guard.
      return row.auth_expires_at == null || row.auth_expires_at > clock.now();
    },

    async configuredMethods(appId, client) {
      const item = await config.configValue(appId, `union.taobao.auth_methods.${client}`);
      let methods = item === null ? DEFAULT_METHODS : parseMethods(item.value);
      // sdk_token waits for CAP-TB-05 (f) and the owner's confirmation: in prod it is filtered
      // out, never issued nor accepted (B1-04k 口径; kept by B1-04zzzzq although the live adapter
      // now files SDK tokens — staging and the other non-prod environments follow the
      // configuration). Nothing left → the default.
      if (appEnv === 'prod') {
        methods = methods.filter((method) => method !== 'sdk_token');
        if (methods.length === 0) methods = DEFAULT_METHODS;
      }
      return methods;
    },
  };
}
