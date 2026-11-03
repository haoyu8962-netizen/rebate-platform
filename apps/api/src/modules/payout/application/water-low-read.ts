// B2-09j: payout's read-only port behind the worker's couli_payout_water_low gauge (BR-WDR-18「W <
// 1.5P 时告警财务」; D10-592). Only the enterprise Alipay channel, whose W and P are what EXECUTE
// judges today. An app with no fresh reading has no conclusion and no key: 0 means "checked, not
// low". The judgement itself is payout's judgeWaterLevel, the same as the fund ledger page.
//
// Reads every app with an Alipay reading, on the handle it is given and with the injected Clock only.
// No cache here and no transaction of its own. A failed read rejects with its own error, it is never
// turned into 0 (the scrape fails visibly).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { judgeWaterLevel } from '../domain/watermark.ts';
import { createWatermarkReader, type PayoutChannelName } from './watermark.ts';

const CHANNEL: PayoutChannelName = 'alipay';

export interface PayoutWaterLow {
  /**
   * app_id → 1 (W < 1.5P) or 0 (not low), enterprise Alipay channel only. An app_id without a
   * conclusion (no W, or W older than 2 hours) has no key at all.
   */
  readonly waterLow: Readonly<Record<string, number>>;
}

export async function readPayoutWaterLow(db: Kysely<DB>, clock: Clock): Promise<PayoutWaterLow> {
  const now = clock.now();
  const apps = await db
    .withSchema('app')
    .selectFrom('payout_watermarks')
    .select('app_id')
    .distinct()
    .where('channel', '=', CHANNEL)
    .execute();
  const reader = createWatermarkReader();
  const waterLow: Record<string, number> = {};
  for (const { app_id: appId } of apps) {
    const reading = await reader.latest(db, { appId, channel: CHANNEL });
    const forecastFen = await reader.forecast(db, { appId, channel: CHANNEL, now });
    const level = judgeWaterLevel({ now, reading, forecastFen });
    if (level !== null) waterLow[appId] = level === 'low' ? 1 : 0;
  }
  return { waterLow };
}
