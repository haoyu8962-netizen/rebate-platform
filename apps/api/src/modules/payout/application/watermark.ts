// B2-06c: the reads behind the watermark check of EXECUTE (规划/08 BR-WDR-18, D10-223 水位表), all on
// the caller's transaction, scoped to the app; the decision itself is domain/watermark.ts.
//   latest     W and t_W: the payout_watermarks row of (app_id, channel) with the latest measured_at;
//              null when there is none.
//   forecast   P: withdrawals.amount_fen of the 7 complete natural days (+08:00) before the day of
//              `now`, REJECTED excluded, through forecastWindow / forecastFen.
//   committed  Σ net_fen of status = PAYING, and Σ net_fen of PAID_API / PAID_MANUAL with
//              paid_at after `since` (t_W).
// Per channel (the withdrawal's payout_channel), as the watermark rows are kept per channel
// (D10-223); whether several channels share one W is pending the orchestrator's ruling.
import type { DB } from '@couli/db';
import { parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  forecastFen,
  forecastWindow,
  judgeWaterLevel,
  type WatermarkReading,
} from '../domain/watermark.ts';

export type PayoutChannelName = 'alipay' | 'bank_card' | 'wechat';

export interface WatermarkCommitted {
  readonly payingNetFen: bigint;
  readonly paidSinceNetFen: bigint;
}

export interface WatermarkReader {
  latest(
    trx: Kysely<DB>,
    input: { appId: string; channel: PayoutChannelName },
  ): Promise<WatermarkReading | null>;
  forecast(
    trx: Kysely<DB>,
    input: { appId: string; channel: PayoutChannelName; now: Date },
  ): Promise<bigint>;
  committed(
    trx: Transaction<DB>,
    input: { appId: string; channel: PayoutChannelName; since: Date },
  ): Promise<WatermarkCommitted>;
}

/** PostgreSQL sums bigint into numeric (text on the wire); an empty set sums to 0. */
function sumFen(value: string | number | bigint | null): bigint {
  return value === null ? 0n : parseFen(typeof value === 'bigint' ? value : String(value));
}

/**
 * The channel's lock, held to the end of the transaction: EXECUTE takes it before it reads W and the
 * Σ PAYING of ③, and the W entry before it judges the channel's latest reading.
 */
export async function lockWatermarkChannel(
  trx: Transaction<DB>,
  appId: string,
  channel: PayoutChannelName,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`${appId}:payout-watermark:${channel}`})::bigint)`.execute(
    trx,
  );
}

/** W, P and the conclusion of one channel, for the fund ledger page. */
export interface PayoutWaterLevel {
  readonly reading: (WatermarkReading & { readonly enteredBy: string }) | null;
  readonly forecastFen: bigint;
  readonly level: 'low' | 'normal' | null;
}

/** The enterprise Alipay channel's water level at `now`, on the caller's transaction. */
export async function readAlipayWaterLevel(
  trx: Transaction<DB>,
  input: { appId: string; now: Date },
): Promise<PayoutWaterLevel> {
  const { appId, now } = input;
  const channel: PayoutChannelName = 'alipay';
  const reader = createWatermarkReader();
  const latest = await reader.latest(trx, { appId, channel });
  const forecast = await reader.forecast(trx, { appId, channel, now });
  const level = judgeWaterLevel({ now, reading: latest, forecastFen: forecast });
  if (latest === null) return { reading: null, forecastFen: forecast, level };
  // The same row as latest(): the same order, on the same transaction.
  const row = await trx
    .withSchema('app')
    .selectFrom('payout_watermarks')
    .select('entered_by')
    .where('app_id', '=', appId)
    .where('channel', '=', channel)
    .orderBy('measured_at', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return { reading: { ...latest, enteredBy: row.entered_by }, forecastFen: forecast, level };
}

export function createWatermarkReader(): WatermarkReader {
  return {
    async latest(trx, input) {
      const row = await trx
        .withSchema('app')
        .selectFrom('payout_watermarks')
        .select(['available_fen', 'measured_at'])
        .where('app_id', '=', input.appId)
        .where('channel', '=', input.channel)
        .orderBy('measured_at', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { availableFen: row.available_fen, measuredAt: row.measured_at };
    },
    async forecast(trx, input) {
      const window = forecastWindow(input.now);
      const row = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(sql<string | null>`sum(amount_fen)::text`.as('total'))
        .where('app_id', '=', input.appId)
        .where('payout_channel', '=', input.channel)
        .where('status', '<>', 'REJECTED')
        .where('created_at', '>=', window.from)
        .where('created_at', '<', window.to)
        .executeTakeFirst();
      return forecastFen(sumFen(row?.total ?? null));
    },
    async committed(trx, input) {
      const paying = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(sql<string | null>`sum(net_fen)::text`.as('total'))
        .where('app_id', '=', input.appId)
        .where('payout_channel', '=', input.channel)
        .where('status', '=', 'PAYING')
        .executeTakeFirst();
      const paid = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(sql<string | null>`sum(net_fen)::text`.as('total'))
        .where('app_id', '=', input.appId)
        .where('payout_channel', '=', input.channel)
        .where('status', 'in', ['PAID_API', 'PAID_MANUAL'])
        .where('paid_at', '>', input.since)
        .executeTakeFirst();
      return {
        payingNetFen: sumFen(paying?.total ?? null),
        paidSinceNetFen: sumFen(paid?.total ?? null),
      };
    },
  };
}
