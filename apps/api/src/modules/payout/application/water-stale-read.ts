// B2-09ze: payout's read-only port behind the worker's couli_payout_water_stale gauge (BR-WDR-18 ②
// and 细则「多通道的 W」; D10-805 ④, D10-807). Only the enterprise Alipay channel, the one EXECUTE
// pays through today: an app with Alipay withdrawals waiting to be executed (APPROVED,
// payout_channel alipay; other channels' waiting withdrawals are not judged against Alipay's W) is 1
// when EXECUTE would refuse them as watermark_stale (no W row, or the latest one past the limit), 0
// when its W is fresh. An app without such withdrawals has no key: it is never 1.
//
// "Fresh" has one source (D10-807 ①): EXECUTE's own judgeWatermark, asked with nothing else that
// could refuse (P 0, no amounts committed, the whole of W usable), so only its staleness check can
// answer watermark_stale. The latest reading is EXECUTE's own reader too.
//
// Reads on the handle it is given and with the injected Clock only. No cache here and no transaction
// of its own. A failed read rejects with its own error, it is never turned into 0 (the scrape fails
// visibly).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { judgeWatermark, type WatermarkReading } from '../domain/watermark.ts';
import { createWatermarkReader, type PayoutChannelName } from './watermark.ts';

const CHANNEL: PayoutChannelName = 'alipay';

export interface PayoutWaterStale {
  /**
   * app_id → 1 when the app has withdrawals waiting to be executed (APPROVED) and the enterprise
   * Alipay channel has no fresh W; 0 when it has a fresh W. An app without such withdrawals is never 1.
   */
  readonly waterStale: Readonly<Record<string, number>>;
}

/** Whether EXECUTE would refuse this reading as stale at `now` (its own judgement, nothing else). */
function isStale(now: Date, reading: WatermarkReading | null): boolean {
  const verdict = judgeWatermark({
    now,
    reading,
    forecastFen: 0n,
    batchNetFen: 0n,
    payingNetFen: 0n,
    paidSinceNetFen: 0n,
    usableBp: 10_000,
  });
  return !verdict.ok && verdict.reason === 'watermark_stale';
}

export async function readPayoutWaterStale(
  db: Kysely<DB>,
  clock: Clock,
): Promise<PayoutWaterStale> {
  const now = clock.now();
  const apps = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select('app_id')
    .distinct()
    .where('status', '=', 'APPROVED')
    .where('payout_channel', '=', CHANNEL)
    .execute();
  const reader = createWatermarkReader();
  const waterStale: Record<string, number> = {};
  for (const { app_id: appId } of apps) {
    const reading = await reader.latest(db, { appId, channel: CHANNEL });
    waterStale[appId] = isStale(now, reading) ? 1 : 0;
  }
  return { waterStale };
}
