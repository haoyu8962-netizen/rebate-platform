// B2-09l: GET /admin/v1/payout-overview (adminGetPayoutOverview, CT-24zq; 08 BR-WDR-11, BR-WDR-17,
// BR-WDR-18; 编排裁定 D10-595). The status cards of the payout console, read fresh on one snapshot
// with the keys, parsers and defaults EXECUTE and the pre-transfer review use, so the page cannot
// say something they would not do. Read only: no audit record, no step-up.
//
// daily_sent_fen counts as transfer-job's dailySentFen (BR-WDR-13 ③, jobs/transfer-job.ts): today's
// (+08:00) kind=transfer attempts with result pending, success or unknown, net_fen of their
// withdrawal, across channels.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { fenToJsonNumber, parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import { readPayoutChannelConfig } from './judgement.ts';
import {
  PAYOUT_EXECUTE_CONFIG_KEYS,
  PAYOUT_EXECUTE_DEFAULTS,
  parsePayoutBp,
  parsePayoutSwitch,
  readPayoutSetting,
  type PayoutSettingParsed,
} from './payout-execute.ts';
import { instant } from './payout-landing.ts';
import {
  readChannelWaterLevel,
  type PayoutChannelName,
  type PayoutWaterLevel,
} from './watermark.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

const CHANNELS: readonly PayoutChannelName[] = ['alipay', 'bank_card', 'wechat'];
const SENT_RESULTS = ['pending', 'success', 'unknown'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminPayoutOverviewDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly config: PayoutConfigPort;
  readonly logger: Pick<Logger, 'warn'>;
  /** admin's createAdminDisplayNameReader: unknown ids are left out. */
  readonly adminNames: (db: Kysely<DB>) => {
    displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  };
}

async function readDailySentFen(trx: Transaction<DB>, appId: string, now: Date): Promise<bigint> {
  const day = chinaDayRange(accountingDate(now));
  const row = await trx
    .withSchema('app')
    .selectFrom('payout_attempts as a')
    .innerJoin('withdrawals as w', (join) =>
      join.onRef('w.id', '=', 'a.withdrawal_id').onRef('w.app_id', '=', 'a.app_id'),
    )
    .select(sql<string | null>`sum(w.net_fen)::text`.as('total'))
    .where('a.app_id', '=', appId)
    .where('a.kind', '=', 'transfer')
    .where('a.result', 'in', [...SENT_RESULTS])
    .where('a.at', '>=', instant(now, Date.parse(day.start)))
    .where('a.at', '<', instant(now, Date.parse(day.end)))
    .executeTakeFirst();
  return row?.total === null || row?.total === undefined ? 0n : parseFen(row.total);
}

/** The overview of the console's app at this moment. */
export function getAdminPayoutOverview(
  deps: AdminPayoutOverviewDeps,
  appId: string,
): Promise<Schema<'AdminPayoutOverview'>> {
  const { config, logger } = deps;
  return deps.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const now = deps.clock.now();
      const keys = PAYOUT_EXECUTE_CONFIG_KEYS;
      const defaults = PAYOUT_EXECUTE_DEFAULTS;
      const read = <T>(
        key: string,
        parse: (value: unknown) => PayoutSettingParsed<T>,
        fallback: T,
      ): Promise<T> => readPayoutSetting({ config, logger }, trx, appId, key, parse, fallback);

      const limits = await readPayoutChannelConfig(appId, trx, config, logger);
      const levels: PayoutWaterLevel[] = [];
      for (const channel of CHANNELS) {
        levels.push(await readChannelWaterLevel(trx, { appId, channel, now }));
      }
      const enteredBy = levels.flatMap((level) => {
        const id = level.reading?.enteredBy;
        return id !== undefined && UUID.test(id) ? [id.toLowerCase()] : [];
      });
      const names =
        enteredBy.length === 0
          ? new Map<string, string>()
          : await deps.adminNames(trx).displayNames(appId, [...new Set(enteredBy)]);

      const channels: Schema<'AdminPayoutOverviewChannel'>[] = [];
      for (const [index, channel] of CHANNELS.entries()) {
        const level = levels[index]!;
        const id = level.reading?.enteredBy.toLowerCase() ?? null;
        const name = id === null ? undefined : names.get(id);
        channels.push({
          channel,
          enabled: await read(
            keys.channelEnabled(channel),
            parsePayoutSwitch,
            defaults.channelEnabled[channel],
          ),
          paused: await read(
            keys.channelPaused(channel),
            parsePayoutSwitch,
            defaults.channelPaused,
          ),
          watermark:
            level.reading === null
              ? null
              : {
                  available_fen: fenToJsonNumber(level.reading.availableFen),
                  measured_at: level.reading.measuredAt.toISOString(),
                  entered_by: name === undefined ? null : id,
                  entered_by_name: name ?? null,
                },
          forecast_withdrawal_fen: fenToJsonNumber(level.forecastFen),
          water_level: level.level,
        });
      }
      return {
        as_of: now.toISOString(),
        payout_enabled: await read(keys.enabled, parsePayoutSwitch, defaults.enabled),
        queue_paused: await read(keys.queuePaused, parsePayoutSwitch, defaults.queuePaused),
        single_cap_fen: limits.singleCapFen,
        daily_cap_fen: limits.dailyCapFen,
        daily_sent_fen: fenToJsonNumber(await readDailySentFen(trx, appId, now)),
        watermark_usable_bp: await read(
          keys.watermarkUsableBp,
          parsePayoutBp,
          defaults.watermarkUsableBp,
        ),
        channels,
      };
    });
}
