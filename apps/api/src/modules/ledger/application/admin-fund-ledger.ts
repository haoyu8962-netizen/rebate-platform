// B2-04zs: GET /admin/v1/fund-ledger (adminGetFundLedger, CT-24zh; 08 BR-FUND-20, BR-WDR-18;
// 编排裁定 D10-538, D10-589, D10-592). The overview cards of the fund ledger page, computed when
// read from all the entries posted so far: unlike the asset snapshot there is no accounting-day cut,
// so a collection entered just now shows at once. One repeatable-read transaction, so the cards
// agree with each other. Reading writes no audit record.
//
// payout decides W, P and the water level (its domain holds the 1.5 P line and the staleness limit);
// app.module hands that port in, as admin's names. Without a reading, or with a stale one, the
// conclusion is null: no field is ever filled with a default.
//
// entered_by: the W entry writes an admin_users id (B2-09i). Anything else in that free-text column,
// or an id of no account of this app, shows as null in both fields (D10-592 ③).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { addFen, fenToJsonNumber } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { sumAllNegativeBalances, sumAllReceivables } from '../infra/fund-ledger-store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminFundLedgerWaterLevel {
  readonly reading: {
    readonly availableFen: bigint;
    readonly measuredAt: Date;
    readonly enteredBy: string;
  } | null;
  readonly forecastFen: bigint;
  readonly level: 'low' | 'normal' | null;
}

export interface AdminFundLedgerDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** payout's readAlipayWaterLevel. */
  readonly waterLevel: (
    trx: Transaction<DB>,
    input: { appId: string; now: Date },
  ) => Promise<AdminFundLedgerWaterLevel>;
  /** admin's createAdminDisplayNameReader: unknown ids are left out. */
  readonly adminNames: (db: Kysely<DB>) => {
    displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  };
}

/** The overview of the console's app. */
export function getAdminFundLedger(
  deps: AdminFundLedgerDeps,
  appId: string,
): Promise<Schema<'AdminFundLedger'>> {
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const now = deps.clock.now();
      const receivables = await sumAllReceivables(trx, appId);
      const negative = await sumAllNegativeBalances(trx, appId);
      const water = await deps.waterLevel(trx, { appId, now });
      let total = 0n;
      for (const row of receivables) total = addFen(total, row.union_receivable_fen);

      let watermark: Schema<'AdminFundLedger'>['watermark'] = null;
      if (water.reading !== null) {
        const { enteredBy } = water.reading;
        const id = UUID.test(enteredBy) ? enteredBy.toLowerCase() : null;
        const names = id === null ? null : await deps.adminNames(trx).displayNames(appId, [id]);
        const name = id === null ? undefined : names?.get(id);
        watermark = {
          available_fen: fenToJsonNumber(water.reading.availableFen),
          measured_at: water.reading.measuredAt.toISOString(),
          entered_by: name === undefined ? null : id,
          entered_by_name: name ?? null,
        };
      }
      return {
        as_of: now.toISOString(),
        receivables: receivables.map((row) => ({
          platform: row.platform as Schema<'AdminFundLedgerReceivable'>['platform'],
          union_receivable_fen: fenToJsonNumber(row.union_receivable_fen),
        })),
        union_receivable_total_fen: fenToJsonNumber(total),
        negative_total_fen: fenToJsonNumber(negative.negative_total_fen),
        negative_user_count: negative.negative_user_count,
        watermark,
        forecast_withdrawal_fen: fenToJsonNumber(water.forecastFen),
        water_level: water.level,
      };
    });
}
