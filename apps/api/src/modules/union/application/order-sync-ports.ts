// B1-08n: union's side of the order-sync wiring (规划/02 §7.1、§7.3). orders reads union only
// through these exports (index.ts); every read is one SELECT on union's own tables, re-run on every
// call (no cache) and never a write.
// - createUnionSyncAccess: the scheduler / handler SyncAccessPort. listEnabledAccounts enumerates
//   union_accounts of every App on a registered platform (status has no on/off meaning yet, so it
//   is not filtered; 待裁定 2). siteAuthAvailable is linking's rule: the row of exactly
//   (app_id, platform, id) exists, auth_status ≠ 'expired' and auth_expires_at (when set) is after
//   the injected Clock (BR-ID-24 ④; B1-22b). offlineCircuitOpen
//   reads the worker's own offline governor of that platform (never the online one).
//   queryableAccount (D10-36, 待裁定 1): the adapter holds one credential set per platform and
//   union_accounts has no column tying it to a row, so only a live endpoint with exactly one
//   union_accounts row of that platform (all Apps) answers that row's id; demo / replay answer null
//   without a query; zero or several rows answer null and log one error per platform per instance.
// - createUnionOrderReaders: the attribution pipeline's raw-row readers (union_pids by its four
//   keys, any status; union_accounts.sync_start_at by App and id). Decisions stay in orders.
// - createGovernedSyncAdapter: createGovernedAdapter plus the offline breaker state, for the
//   worker's own governance set (its breakers and quota are per process, 待裁定 6).
// Logs carry flat fields only (platform, reason, rows); never credentials or order data.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { SystemClock, type Clock, type RootLogger } from '../../platform/index.ts';
import {
  REGISTERED_PLATFORMS,
  isRegisteredPlatform,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
} from '../domain/types.ts';
import { governAdapter, type GovernedAdapterOptions } from './governed-adapter.ts';

export interface UnionSyncAccount {
  readonly app_id: string;
  readonly platform: RegisteredPlatform;
  readonly union_account_id: string;
  readonly sync_start_at: string | null;
}

export interface UnionSyncAccess {
  listEnabledAccounts(): Promise<readonly UnionSyncAccount[]>;
  siteAuthAvailable(
    account: Pick<UnionSyncAccount, 'app_id' | 'platform' | 'union_account_id'>,
  ): Promise<boolean>;
  offlineCircuitOpen(platform: RegisteredPlatform): Promise<boolean>;
  queryableAccount(platform: RegisteredPlatform): Promise<string | null>;
}

export interface UnionSyncAccessOptions {
  readonly clock?: Clock;
  readonly db: Kysely<DB>;
  readonly endpoints: readonly UnionEndpoint[];
  readonly breaker: (platform: RegisteredPlatform) => 'closed' | 'open';
  readonly logger: Pick<RootLogger, 'error'>;
}

const PLATFORMS: RegisteredPlatform[] = [...REGISTERED_PLATFORMS];

export function createUnionSyncAccess(options: UnionSyncAccessOptions): UnionSyncAccess {
  const { db, endpoints, breaker, logger } = options;
  // B1-22b: the request-side time guard reads the injected Clock. The admin wiring
  // (orders-admin.module) and the worker runtime (orders/worker-runtime.ts, B1-04zzzx) pass it; the
  // SystemClock fallback only serves callers that build the access without one (some test kits).
  const clock = options.clock ?? new SystemClock();
  /** Platforms whose unresolved credential owner was already logged by this instance. */
  const reported = new Set<RegisteredPlatform>();
  return {
    async listEnabledAccounts() {
      const rows = await db
        .withSchema('app')
        .selectFrom('union_accounts')
        .select(['id', 'app_id', 'platform', 'sync_start_at'])
        .where('platform', 'in', PLATFORMS)
        .orderBy('app_id')
        .orderBy('platform')
        .orderBy('id')
        .execute();
      const accounts: UnionSyncAccount[] = [];
      for (const row of rows) {
        if (!isRegisteredPlatform(row.platform)) continue;
        accounts.push({
          app_id: row.app_id,
          platform: row.platform,
          union_account_id: row.id,
          sync_start_at: row.sync_start_at === null ? null : row.sync_start_at.toISOString(),
        });
      }
      return accounts;
    },

    async siteAuthAvailable(account) {
      const row = await db
        .withSchema('app')
        .selectFrom('union_accounts')
        .select(['auth_status', 'auth_expires_at'])
        .where('app_id', '=', account.app_id)
        .where('platform', '=', account.platform)
        .where('id', '=', account.union_account_id)
        .executeTakeFirst();
      // B1-22b (BR-ID-24 ④, 12 §7.2): auth_expires_at reached counts as expired at once.
      if (row === undefined || row.auth_status === 'expired') return false;
      return row.auth_expires_at === null || row.auth_expires_at > clock.now();
    },

    async offlineCircuitOpen(platform) {
      return breaker(platform) === 'open';
    },

    async queryableAccount(platform) {
      const endpoint = endpoints.find((entry) => entry.platform === platform);
      // Demo and replay adapters hold no real credentials: nothing is ever synced from them.
      if (endpoint?.mode !== 'live') return null;
      const rows = await db
        .withSchema('app')
        .selectFrom('union_accounts')
        .select('id')
        .where('platform', '=', platform)
        .orderBy('id')
        .limit(2)
        .execute();
      const [only] = rows;
      if (rows.length === 1 && only !== undefined) return only.id;
      if (!reported.has(platform)) {
        reported.add(platform);
        logger.error(
          {
            platform,
            reason: rows.length === 0 ? 'no_union_account' : 'ambiguous_union_account',
          },
          'order_sync_queryable_account_unresolved',
        );
      }
      return null;
    },
  };
}

export interface UnionOrderReaders {
  readonly pids: {
    find(input: {
      appId: string;
      platform: RegisteredPlatform;
      unionAccountId: string;
      pid: string;
    }): Promise<readonly { pid_scene: string; status: string; site_id: string | null }[]>;
  };
  readonly accounts: {
    syncStartAt(input: { appId: string; unionAccountId: string }): Promise<Date | null>;
  };
}

export function createUnionOrderReaders(db: Kysely<DB>): UnionOrderReaders {
  return {
    pids: {
      async find(input) {
        return await db
          .withSchema('app')
          .selectFrom('union_pids')
          .select(['pid_scene', 'status', 'site_id'])
          .where('app_id', '=', input.appId)
          .where('platform', '=', input.platform)
          .where('union_account_id', '=', input.unionAccountId)
          .where('pid', '=', input.pid)
          .orderBy('id')
          .execute();
      },
    },
    accounts: {
      async syncStartAt(input) {
        const row = await db
          .withSchema('app')
          .selectFrom('union_accounts')
          .select('sync_start_at')
          .where('app_id', '=', input.appId)
          .where('id', '=', input.unionAccountId)
          .executeTakeFirst();
        return row?.sync_start_at ?? null;
      },
    },
  };
}

export function createGovernedSyncAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): {
  readonly adapter: UnionAdapter;
  offlineBreakerState(): 'closed' | 'open';
} {
  const { adapter: governed, governors } = governAdapter(adapter, options);
  return Object.freeze({
    adapter: governed,
    offlineBreakerState: () => governors.offline.breakerState(),
  });
}
