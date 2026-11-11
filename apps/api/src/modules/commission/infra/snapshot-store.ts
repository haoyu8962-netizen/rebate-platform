// B2-03g: Kysely access of the snapshot writer, always inside the caller's transaction. Reads this
// module's rule tables (published, unrevoked versions FOR SHARE so publishing / revoking waits for
// the caller's commit, BR-CALC-11) and writes the four snapshot tables of migration 0036
// (commission_splits, commission_split_amounts v1, commission_split_beneficiary_events,
// commission_split_totals v1). Inserts only; no SQL clock (created_at comes from the Clock).
import type { DB } from '@couli/db';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { RuleReserve, RuleRow, RuleVersion } from '../domain/rules.ts';
import type { SnapshotPlan } from '../domain/snapshot.ts';

export type SplitRow = Selectable<DB['commission_splits']>;

export async function findSplit(
  trx: Transaction<DB>,
  appId: string,
  orderId: string,
): Promise<SplitRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('commission_splits')
    .selectAll()
    .where('app_id', '=', appId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
}

/** Every published, unrevoked version of the app with all its rows; version rows FOR SHARE. */
export async function readPublishedVersionsForShare(
  trx: Transaction<DB>,
  appId: string,
): Promise<RuleVersion[]> {
  const app = trx.withSchema('app');
  const versions = await app
    .selectFrom('commission_rule_versions')
    .select(['rule_version_id', 'effective_from', 'indirect_enabled'])
    .where('app_id', '=', appId)
    .where('status', '=', 'published')
    .where('revoked_at', 'is', null)
    .orderBy('rule_version_id')
    .forShare()
    .execute();
  if (versions.length === 0) return [];
  const ids = versions.map((v) => v.rule_version_id);
  const ruleRows = await app
    .selectFrom('commission_rules')
    .select([
      'rule_version_id',
      'platform',
      'level',
      'order_type',
      'r_own_bp',
      'r_direct_bp',
      'r_indirect_bp',
    ])
    .where('app_id', '=', appId)
    .where('rule_version_id', 'in', ids)
    .execute();
  const reserveRows = await app
    .selectFrom('commission_rule_reserves')
    .select(['rule_version_id', 'platform', 'reserve_bp'])
    .where('app_id', '=', appId)
    .where('rule_version_id', 'in', ids)
    .execute();
  const rulesOf = new Map<string, RuleRow[]>(ids.map((id) => [id, []]));
  for (const r of ruleRows) {
    // Text columns hold contract codes (CHECK constraints); the domain checks levels again.
    rulesOf.get(r.rule_version_id)?.push({
      platform: r.platform as RuleRow['platform'],
      level: r.level as RuleRow['level'],
      order_type: r.order_type as RuleRow['order_type'],
      r_own_bp: r.r_own_bp,
      r_direct_bp: r.r_direct_bp,
      r_indirect_bp: r.r_indirect_bp,
    });
  }
  const reservesOf = new Map<string, RuleReserve[]>(ids.map((id) => [id, []]));
  for (const r of reserveRows) {
    reservesOf.get(r.rule_version_id)?.push({
      platform: r.platform as RuleReserve['platform'],
      reserve_bp: r.reserve_bp,
    });
  }
  return versions.map((v): RuleVersion => {
    if (!(v.effective_from instanceof Date)) {
      throw new Error(
        `commission: published rule version ${v.rule_version_id} has no effective_from`,
      );
    }
    return {
      rule_version_id: v.rule_version_id,
      effective_from: v.effective_from,
      indirect_enabled: v.indirect_enabled,
      rules: rulesOf.get(v.rule_version_id) ?? [],
      reserves: reservesOf.get(v.rule_version_id) ?? [],
    };
  });
}

export interface SnapshotWrite {
  readonly appId: string;
  readonly orderId: string;
  readonly ruleVersionId: string;
  readonly orderType: 'self' | 'share';
  readonly activityType: string | null;
  readonly rebateMode: 'none' | 'normal' | null;
  readonly paidAt: Date;
  readonly paidAtSource: 'platform' | 'platform_modified' | 'observed';
  readonly rawNFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly plan: SnapshotPlan;
  readonly createdAt: Date;
}

const SNAPSHOT_PKEY = 'commission_splits_pkey';
const SAVEPOINT = 'commission_snapshot_write';

/**
 * Inserts the four tables under a savepoint. Any failure rolls back to the savepoint so the
 * caller's transaction stays usable. A unique violation on the snapshot key returns 'conflict'
 * (a concurrent writer committed first); every other error is rethrown.
 */
export async function insertSnapshot(
  trx: Transaction<DB>,
  w: SnapshotWrite,
): Promise<{ kind: 'inserted'; split: SplitRow } | { kind: 'conflict' }> {
  const app = trx.withSchema('app');
  const { plan } = w;
  await sql`SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
  try {
    // The snapshot row first: a concurrent duplicate fails here before any other table is touched.
    const split = await app
      .insertInto('commission_splits')
      .values({
        order_id: w.orderId,
        app_id: w.appId,
        rule_version_id: w.ruleVersionId,
        order_type: w.orderType,
        activity_type: w.activityType,
        rebate_mode: w.rebateMode,
        paid_at: w.paidAt,
        paid_at_source: w.paidAtSource,
        raw_n_fen: w.rawNFen,
        subsidy_commission_fen: w.subsidyCommissionFen,
        reserve_bp: Number(plan.reserve_bp),
        reserve_fen: plan.reserve_fen,
        tlj_deduct_fen: w.tljDeductFen,
        base_fen: plan.base_fen,
        platform_retain_fen: plan.platform_retain_fen,
        // pg would send a JS array as a PG array literal; jsonb gets its JSON text.
        beneficiaries: JSON.stringify(
          plan.beneficiaries.map((b) => ({
            user_id: b.user_id,
            role: b.role,
            ratio_bp: Number(b.ratio_bp),
            level: b.level,
            initial_status: b.initial_status,
            forfeit_reason: b.forfeit_reason,
          })),
        ),
        created_at: w.createdAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await app
      .insertInto('commission_split_amounts')
      .values(
        plan.beneficiaries.map((b) => ({
          app_id: w.appId,
          order_id: w.orderId,
          commission_version: 1,
          user_id: b.user_id,
          role: b.role,
          base_fen: plan.base_fen,
          amount_fen: b.amount_fen,
          created_at: w.createdAt,
        })),
      )
      .execute();
    await app
      .insertInto('commission_split_beneficiary_events')
      .values(
        plan.beneficiaries.map((b) => ({
          app_id: w.appId,
          order_id: w.orderId,
          user_id: b.user_id,
          role: b.role,
          status: b.initial_status,
          reason: b.forfeit_reason,
          created_at: w.createdAt,
        })),
      )
      .execute();
    await app
      .insertInto('commission_split_totals')
      .values({
        app_id: w.appId,
        order_id: w.orderId,
        commission_version: 1,
        n_total_fen: plan.n_total_fen,
        pre_base_deduct_fen: plan.pre_base_deduct_fen,
        base_fen: plan.base_fen,
        user_share_total_fen: plan.user_share_total_fen,
        tlj_redpacket_fen: plan.tlj_redpacket_fen,
        platform_est_profit_fen: plan.platform_est_profit_fen,
        // BR-CALC-27 (B1-18f): version 1 is valued on the frozen subsidy.
        subsidy_commission_fen: w.subsidyCommissionFen,
        created_at: w.createdAt,
      })
      .execute();
    await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
    return { kind: 'inserted', split };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
    await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
    if (isSnapshotKeyConflict(error)) return { kind: 'conflict' };
    throw error;
  }
}

function isSnapshotKeyConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === SNAPSHOT_PKEY
  );
}
