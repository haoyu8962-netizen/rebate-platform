// B2-06e: the T + manual_after decision shared by the query job and the recovery scan (规划/08
// BR-WDR-14, BR-WDR-15): needs_manual = true by CAS on (status PAYING, needs_manual false,
// row_version) through the couli_payout handle (the only role granted that column), row_version + 1,
// status and amounts untouched, then the alert logger.warn({ withdrawal_id, out_biz_no, point },
// 'payout_needs_manual'). A CAS that moves no row (the withdrawal changed meanwhile) only warns.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** jobs/query-job.ts: 【立即查询】 of the disposal page. Ask once, record only, never move the withdrawal. */
export const PAYOUT_MANUAL_QUERY_SOURCE = 'manual';

export const NEEDS_MANUAL_ALERT = 'payout_needs_manual';

export interface ManualRow {
  readonly id: string;
  readonly app_id: string;
  readonly row_version: number;
  readonly out_biz_no: string;
}

export interface ManualLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

/** True when this call set needs_manual (and alerted); false when the row had moved. */
export async function markNeedsManual(
  attemptsDb: Kysely<DB>,
  row: ManualRow,
  point: number,
  now: Date,
  logger: ManualLogger,
): Promise<boolean> {
  const result = await attemptsDb
    .withSchema('app')
    .updateTable('withdrawals')
    .set({ needs_manual: true, row_version: row.row_version + 1, updated_at: now })
    .where('app_id', '=', row.app_id)
    .where('id', '=', row.id)
    .where('status', '=', 'PAYING')
    .where('needs_manual', '=', false)
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    logger.warn(
      { withdrawal_id: row.id, out_biz_no: row.out_biz_no, point },
      'payout_query_cas_conflict',
    );
    return false;
  }
  logger.warn({ withdrawal_id: row.id, out_biz_no: row.out_biz_no, point }, NEEDS_MANUAL_ALERT);
  return true;
}
