// B2-09zn (D10-3308, D10-3360): settlement's read-only port behind the worker's
// couli_settle_bill_amount_mismatch and couli_settle_bill_generated_timestamp_seconds gauges.
// Per app_id, among the bills already generated (generated_at IS NOT NULL; there is no status column),
// the one with the greatest bill_id (YYYY-MM, compared byte-wise): its amount_mismatch_count as it is
// (the count the bill-day job wrote; never recomputed, supplements never write it) and its
// generated_at in whole Unix seconds (rounded down). A bill still being generated takes no part in
// "greatest". When that latest bill's amount_mismatch_count is NULL (a bill from before the column),
// the app has no key: it does not fall back to an older bill and is not made up as 0. A count of 0
// is kept. An app without a generated bill has no key.
//
// Only a SELECT on the handle it is given: no transaction of its own, no lock, no database clock. A
// failed read rejects with its own error.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface SettleBillMismatch {
  /** app_id → the latest generated bill's mismatch count and generation time (Unix seconds). */
  readonly bills: Readonly<
    Record<string, { readonly amountMismatch: number; readonly generatedAtSeconds: number }>
  >;
}

interface LatestBillRow {
  readonly app_id: string;
  readonly amount_mismatch_count: unknown;
  readonly generated_at_seconds: unknown;
}

export async function readSettleBillMismatch(db: Kysely<DB>): Promise<SettleBillMismatch> {
  // The latest generated bill is picked first and only then its NULL count dropped, so a NULL on
  // the latest bill never lets an older bill's count through.
  const { rows } = await sql<LatestBillRow>`
    SELECT latest.app_id,
      latest.amount_mismatch_count,
      floor(extract(epoch FROM latest.generated_at))::bigint AS generated_at_seconds
    FROM (
      SELECT DISTINCT ON (b.app_id) b.app_id, b.amount_mismatch_count, b.generated_at
      FROM app.settle_bills b
      WHERE b.generated_at IS NOT NULL
      ORDER BY b.app_id, b.bill_id COLLATE "C" DESC
    ) latest
    WHERE latest.amount_mismatch_count IS NOT NULL
  `.execute(db);
  const bills: Record<string, { amountMismatch: number; generatedAtSeconds: number }> = {};
  for (const row of rows) {
    if (row.amount_mismatch_count === null || row.amount_mismatch_count === undefined) continue;
    bills[row.app_id] = {
      amountMismatch: Number(row.amount_mismatch_count),
      generatedAtSeconds: Number(row.generated_at_seconds),
    };
  }
  return { bills };
}
