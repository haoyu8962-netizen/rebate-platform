// B1-03zo / BR-ID-36 (D10-1401): the dashboard card appeal_pending, this app's processing appeals.
// The card's count equals the console list's status=processing total (and its counts.processing),
// so the "this app and status='processing'" judgement lives here once and admin-appeals-read.ts
// uses the same predicate for its filter and counts. Every target_type and every source counts;
// the deadline is not looked at. Read only. The dashboard caller checks risk.appeal.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type ExpressionBuilder, type Expression, type Kysely, type SqlBool } from 'kysely';

/**
 * The one "processing appeal of this app" predicate: `app_id = ? AND status = 'processing'`.
 * The status is a literal (not a bind parameter) so the partial index
 * appeals_processing_deadline_idx (app_id, deadline_at) WHERE status = 'processing' stays usable
 * under generic plans too.
 */
export function processingAppealOf(
  appId: string,
): (eb: ExpressionBuilder<DB, 'appeals'>) => Expression<SqlBool> {
  return (eb) => eb.and([eb('app_id', '=', appId), eb('status', '=', sql.lit('processing'))]);
}

/**
 * B1-03zo / BR-ID-36: this app's processing appeals, equal to the console list's
 * status=processing total. The dashboard caller checks risk.appeal.
 */
export async function countProcessingAppeals(db: Kysely<DB>, appId: string): Promise<number> {
  const row = await db
    .withSchema('app')
    .selectFrom('appeals')
    .where(processingAppealOf(appId))
    .select(sql<string>`count(*)`.as('n'))
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
