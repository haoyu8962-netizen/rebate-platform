// B2-04zj (D10-583, FU-PROD-WIRING 第 13 项; BR-FUND-09): the settlement record port. order_settlements
// has this one writer; orders.settle_commission_fen stays with orders, which reads the latest
// STATEMENT amount here before it plans its columns. Both run on the caller's transaction, under the
// order lock orders already holds.
// Insert only: order_settlements' append-only trigger rejects anything else.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SettlementOrderRef {
  readonly appId: string;
  readonly orderId: string;
}

export interface ApiSettlementInput extends SettlementOrderRef {
  /** The union's settlement commission as reported; 0 and negatives are known values. */
  readonly commissionFen: bigint;
  /** The report's settlement time as given, null when absent: this value is the content. */
  readonly reportedSettledAt: Date | null;
  /** orders.settled_at; the settled_at column's fallback, never part of the content. */
  readonly orderSettledAt: Date | null;
}

export interface ApiSettlementResult {
  /** The order's greatest seq after this call. */
  readonly seq: number;
  /** false: the content equals the latest API record, nothing was written. */
  readonly inserted: boolean;
}

export interface SettlementRecords {
  /**
   * BR-FUND-09: under the order lock, compares with the order's latest API record (STATEMENT rows
   * take no part) and, only when the content differs, inserts source API at the greatest seq of any
   * source + 1. content_hash is stable over the amount and reportedSettledAt, null included. The
   * settled_at column is reportedSettledAt, then orderSettledAt, then the injected Clock; created_at
   * comes from the Clock.
   */
  recordApi(trx: Transaction<DB>, input: ApiSettlementInput): Promise<ApiSettlementResult>;
  /** The amount of the order's STATEMENT record with the greatest seq; null when it has none. */
  latestStatementFen(trx: Transaction<DB>, ref: SettlementOrderRef): Promise<bigint | null>;
  /**
   * created_at of the record that decides orders.settle_commission_fen (BR-FUND-09): the greatest-seq
   * STATEMENT when the order has one, otherwise the greatest-seq API; null when it has no record.
   * A later API record beside a STATEMENT decides nothing, so its time answers no rights record.
   */
  latestDecidingRecordAt(trx: Transaction<DB>, ref: SettlementOrderRef): Promise<Date | null>;
}

export interface SettlementRecordsDependencies {
  readonly clock: Clock;
}

/**
 * Stable over what the report gave: the amount and the settlement time as reported, null included.
 * The settled_at fallback stays out, or a report without a time would hash anew on every sync.
 */
function contentHash(commissionFen: bigint, reportedSettledAt: Date | null): string {
  const content = JSON.stringify([
    commissionFen.toString(10),
    reportedSettledAt === null ? null : reportedSettledAt.toISOString(),
  ]);
  return createHash('sha256').update(content).digest('hex');
}

export function createSettlementRecords(deps: SettlementRecordsDependencies): SettlementRecords {
  return {
    async recordApi(trx, input) {
      const rows = await trx
        .withSchema('app')
        .selectFrom('order_settlements')
        .select(['seq', 'source', 'content_hash'])
        .where('app_id', '=', input.appId)
        .where('order_id', '=', input.orderId)
        .orderBy('seq', 'desc')
        .execute();
      const greatest = rows[0]?.seq ?? 0;
      const hash = contentHash(input.commissionFen, input.reportedSettledAt);
      if (rows.find((row) => row.source === 'API')?.content_hash === hash) {
        return { seq: greatest, inserted: false };
      }
      const seq = greatest + 1;
      const now = deps.clock.now();
      await trx
        .withSchema('app')
        .insertInto('order_settlements')
        .values({
          app_id: input.appId,
          order_id: input.orderId,
          seq,
          source: 'API',
          settle_commission_fen: input.commissionFen,
          settled_at: input.reportedSettledAt ?? input.orderSettledAt ?? now,
          content_hash: hash,
          created_at: now,
        })
        .execute();
      return { seq, inserted: true };
    },

    async latestStatementFen(trx, ref) {
      const row = await trx
        .withSchema('app')
        .selectFrom('order_settlements')
        .select('settle_commission_fen')
        .where('app_id', '=', ref.appId)
        .where('order_id', '=', ref.orderId)
        .where('source', '=', 'STATEMENT')
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row?.settle_commission_fen ?? null;
    },

    async latestDecidingRecordAt(trx, ref) {
      const rows = await trx
        .withSchema('app')
        .selectFrom('order_settlements')
        .select(['source', 'created_at'])
        .where('app_id', '=', ref.appId)
        .where('order_id', '=', ref.orderId)
        .orderBy('seq', 'desc')
        .execute();
      const deciding = rows.find((row) => row.source === 'STATEMENT') ?? rows[0];
      return deciding?.created_at ?? null;
    },
  };
}
