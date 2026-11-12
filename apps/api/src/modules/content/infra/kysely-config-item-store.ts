import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  ConfigItemRow,
  ConfigItemStore,
  ConfigItemTx,
} from '../application/config-item-admin.ts';
import { currentConfigValues, lockInviteReward } from './invite-reward-guard.ts';

/**
 * B1-22zb: namespace of the per-app transaction lock of legal.ai_third_party.version saves
 * (pg_advisory_xact_lock(hashtextextended(namespace || app_id, 0))). Distinct from the invite
 * reward campaign lock ('content.invite_reward:' || app_id) and every other text key in the code
 * base. Inlined as a literal so the lock statement names config_items, the table it guards.
 */
const AI_CONSENT_VERSION_LOCK = 'content.config_items.legal.ai_third_party.version:';

const COLUMNS = ['key', 'value', 'version', 'updated_by', 'updated_at'] as const;

// Only the matching current version establishes an admin author. Seed/system rows
// can have any updated_by label, and may have no history at all.
function currentAdminId(eb: ExpressionBuilder<DB, 'config_items'>) {
  return eb
    .selectFrom('config_item_versions')
    .select('updated_by_admin_id')
    .whereRef('config_item_versions.app_id', '=', 'config_items.app_id')
    .whereRef('config_item_versions.key', '=', 'config_items.key')
    .whereRef('config_item_versions.version', '=', 'config_items.version')
    .as('updated_by_admin_id');
}

function itemRow(
  row: {
    key: string;
    value: DB['config_items']['value'];
    version: number;
    updated_by: string;
    updated_at: Date;
  },
  adminId: string | null,
): ConfigItemRow {
  return {
    key: row.key,
    value: row.value,
    version: row.version,
    updatedBy: adminId === null ? null : row.updated_by,
    updatedAt: row.updated_at,
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): ConfigItemTx {
  const app = trx.withSchema('app');
  return {
    async lock(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select(COLUMNS)
        .select(currentAdminId)
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? undefined : itemRow(row, row.updated_by_admin_id);
    },

    version: (appId, key, version) =>
      app
        .selectFrom('config_item_versions')
        .select('value')
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .where('version', '=', version)
        .executeTakeFirst(),

    async change(input) {
      const values = {
        value: sql<DB['config_items']['value']>`${JSON.stringify(input.value)}::jsonb`,
        updated_by: input.actor.loginName,
        updated_at: input.at,
      };
      const row =
        input.expectedVersion === 0
          ? await app
              .insertInto('config_items')
              .values({
                app_id: input.actor.appId,
                key: input.key,
                ...values,
                version: 1,
                row_version: 0,
                created_at: input.at,
              })
              .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
              .returning(COLUMNS)
              .executeTakeFirst()
          : await app
              .updateTable('config_items')
              .set((eb) => ({
                ...values,
                version: eb('version', '+', 1),
                row_version: eb('row_version', '+', 1),
              }))
              .where('app_id', '=', input.actor.appId)
              .where('key', '=', input.key)
              .where('version', '=', input.expectedVersion)
              .returning(COLUMNS)
              .executeTakeFirst();
      return row === undefined ? undefined : itemRow(row, input.actor.adminId);
    },

    async history(input, version) {
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: input.actor.appId,
          key: input.key,
          version,
          value: sql`${JSON.stringify(input.value)}::jsonb`,
          updated_by: input.actor.loginName,
          updated_by_admin_id: input.actor.adminId,
          reason: input.reason,
          created_at: input.at,
        })
        .execute();
    },

    lockInviteReward: (appId) => lockInviteReward(trx, appId),

    async lockAiConsentVersion(appId) {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${sql.lit(AI_CONSENT_VERSION_LOCK)} || ${appId}::text, 0))`.execute(
        trx,
      );
    },

    values: (appId, keys) => currentConfigValues(trx, appId, keys),

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; config writes, history and admin's audit share one transaction. */
export function createKyselyConfigItemStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): ConfigItemStore {
  const app = db.withSchema('app');
  return {
    async rows(appId) {
      const rows = await app
        .selectFrom('config_items')
        .select(COLUMNS)
        .select(currentAdminId)
        .where('app_id', '=', appId)
        .execute();
      return rows.map((row) => itemRow(row, row.updated_by_admin_id));
    },

    async row(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select(COLUMNS)
        .select(currentAdminId)
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined ? undefined : itemRow(row, row.updated_by_admin_id);
    },

    async versions(appId, key, page, pageSize) {
      // Count and page must describe the same snapshot during concurrent writes.
      return db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const query = trx
            .withSchema('app')
            .selectFrom('config_item_versions')
            .where('app_id', '=', appId)
            .where('key', '=', key);
          const count = await query
            .select((eb) => eb.fn.countAll<string | number | bigint>().as('total'))
            .executeTakeFirstOrThrow();
          const rows = await query
            .select([
              'version',
              'value',
              'updated_by',
              'updated_by_admin_id',
              'reason',
              'created_at',
            ])
            .orderBy('version', 'desc')
            .offset((page - 1) * pageSize)
            .limit(pageSize)
            .execute();
          return {
            items: rows.map((row) => ({
              version: row.version,
              value: row.value,
              updated_by: row.updated_by_admin_id === null ? null : row.updated_by,
              reason: row.reason,
              created_at: row.created_at.toISOString(),
            })),
            page,
            page_size: pageSize,
            total: Number(count.total),
          };
        });
    },

    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
