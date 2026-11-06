// B2-11c: the automatic payout decision of 规划/08 BR-WDR-30 as the worker's withdrawal.created
// consumer (consumer payout-auto-payout, queue evt.payout-auto-payout; events/types.ts and
// queue/catalog.ts register them). Each withdrawal is judged once:
//   review_mode already set      nothing (B2-05d: switch off at W1 → manual; a decision was made).
//   locks                        identity's users row → ledger.lockBalances → the advisory lock
//                                pg_advisory_xact_lock('auto_payout_daily'), inside which ⑦ (review_mode
//                                auto, status ∉ {REJECTED, FAILED}, reviewed_at in the current +08:00
//                                day / month; payee by payee_hmac across members, member by user_id)
//                                and ⑨ (Σ amount_fen of the same rows today, this one included) are read.
//   config                       withdraw.auto_payout.* and ⑪'s payout.channel_enabled.<channel> as
//                                one saved state (readAutoPayoutConfigSnapshot); rule_version is the
//                                Σ of that snapshot's group versions.
//   inputs                       ⑤ active withdraw_holds or risk_state ∈ {frozen, appealing} or
//                                frozen_fen > amount_fen; ⑥ ⑧ with t = created_at (B2-11a's facts
//                                reader); ⑩ adult; ⑪ payout.channel_enabled.<channel of the snapshot>;
//                                ⑫ risk_flags ∩ risk_block_flags and the live blacklist_hit (one
//                                check: match() when the reader has it, else hit()); ⑬ no
//                                withdrawal block, available_fen ≥ 0, blocked_reason null; then
//                                decideAutoPayout (B2-11b) compares.
//   write                        auto_decision {result, failed_conditions, warn_values, rule_version,
//                                decided_at} and review_mode.
//   hit record                   B2-05q (BR-ID-36, BR-WDR-29 ⑨): a decision that lists
//                                risk_flag:blacklist_hit writes one risk_hits row through risk's
//                                writer (blacklistHits) on this transaction — ref_type withdrawal,
//                                risk_action manual_review, the matched dimension / digest / rule.
//                                A withdrawal is judged once, so it has at most one; the digest
//                                never enters auto_decision or a log.
//   hit log                      B2-05r (BR-WDR-29 ⑨, BR-ID-33): once that hit is recorded, one info
//                                line auto_payout_blacklist_hit with app_id, withdrawal_id, the
//                                dimension and the rule code — never the member id, a phone or any
//                                digest. Only a decision that recorded a hit logs it; a logger
//                                without info (older hand-written ones) logs nothing. The line is
//                                not part of the transaction: a decision rolled back and redelivered
//                                may log it again; risk_hits is the record.
//   manual                       review_deadline = created_at + 24 working hours (BR-WDR-26).
//   auto                         system W2 through B2-05e's approve (CAS status = PENDING_REVIEW,
//                                reviewer_id null) → executeBatch with executor 'system:auto_payout'
//                                (one kind=auto batch of this withdrawal, B2-06c); EXECUTE refused or
//                                the withdrawal left out → stays APPROVED, auto_decision gets
//                                execute_blocked with the reason. The CAS matching nothing (a human
//                                reviewed first) ends the consumer: only auto_decision is written.
//   alert                        today's automatic total reaching 80% of platform_daily_max_fen
//                                (BR-WDR-24): logger.warn(…, 'auto_payout_daily_near_cap'), the
//                                fixed-message warn of the repository's event alerts
//                                (config_change_alert, sms_daily_budget_alert).
// TODO(规划/11 §2.3): a /metrics gauge of today's automatic total against platform_daily_max_fen and
// its fund rule in infra/monitoring/rules/couli-fund.yaml (规划/02 §13 夜间资金类「自动到账日合计触顶」)
// — blocked on B1-01zzp (D10-389: log-type fund alerts to metrics and couli-fund rules; it must be
// merged before the automatic payout switch is turned on in a real-money environment).
// processed_events claim and every effect commit in one transaction (consume), as went-negative.ts.
// Rule tests: test/spec/payout/auto-payout/**, test/properties/domain/payout/auto-payout-once.ts.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
import { addFen, fenToJsonNumber, mulDivCeil, parseFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ReceivedEvent } from '../../platform/index.ts';
import type {
  AppealPrevStateReader,
  BlockedHitTarget,
  RiskStateBatchReader,
  WithdrawalReviewHits,
} from '../../risk/index.ts';
import {
  computeAutoPayoutWarnValues,
  decideAutoPayout,
  type AutoPayoutConfig,
  type AutoPayoutDecision,
  type AutoPayoutRiskFlag,
} from '../domain/auto-decision.ts';
import { reviewDeadline } from '../domain/review-deadline.ts';
import { commissionRateBp } from '../domain/risk-flags.ts';
import { createWithdrawHoldsReader } from '../infra/withdraw-holds.ts';
import {
  PAYOUT_EXECUTE_CONFIG_KEYS,
  PAYOUT_EXECUTE_DEFAULTS,
  SYSTEM_AUTO_PAYOUT,
  type PayoutBatchRejectReason,
  type PayoutExecute,
  type PayoutLeftReason,
} from './payout-execute.ts';
import { readReviewCalendars } from './withdraw-apply.ts';
import type { WithdrawRiskFactsReader, WithdrawRiskSubject } from './withdraw-risk-port.ts';
import { holdActive, type PayoutConfigPort } from './withdraw-rules.ts';
import {
  WithdrawalConflictError,
  createWithdrawalCommands,
  type WithdrawalCommandsOptions,
} from './withdrawal-commands.ts';

/** ⑩ identity's BR-ID-26 adult_at: the member is 18 or older at `at`. */
export interface AutoPayoutAdultReader {
  isAdult(handle: Kysely<DB>, input: { appId: string; userId: string; at: Date }): Promise<boolean>;
}

/** ⑫ BR-WDR-29 ⑨ blacklist_hit, checked live at the decision (never from the W1 snapshot). */
export interface AutoPayoutBlacklistReader {
  hit(
    handle: Kysely<DB>,
    input: {
      appId: string;
      userId: string;
      payeeHmac: string;
      /** The snapshot payout method: the blocklist dimension of the payee HMAC. */
      payoutMethod: string;
    },
  ): Promise<boolean>;
  /** A decided target from the same live check; legacy readers keep their boolean hit(). */
  match?(
    handle: Kysely<DB>,
    input: Parameters<AutoPayoutBlacklistReader['hit']>[1],
  ): Promise<{ risk_msg_code: string; hit: BlockedHitTarget } | null>;
}

/** Why an automatic withdrawal stayed APPROVED: the batch refusal or the member's left reason. */
export type AutoPayoutExecuteBlocked = PayoutBatchRejectReason | PayoutLeftReason;

/** withdrawals.auto_decision (BR-WDR-30 可追溯). */
export interface AutoPayoutDecisionRecord extends AutoPayoutDecision {
  /** The configuration group's version, increased on every save. */
  rule_version: number;
  /** The Clock instant of the decision, ISO 8601. */
  decided_at: string;
  execute_blocked?: AutoPayoutExecuteBlocked;
}

export interface AutoPayoutOptions extends WithdrawalCommandsOptions {
  db: Kysely<DB>;
  /** `info` is optional: without it the blacklist-hit line (B2-05r) is not written. */
  logger: {
    warn(fields: Record<string, unknown>, message: string): void;
    info?(fields: Record<string, unknown>, message: string): void;
  };
  /**
   * content's configuration reader: withdraw.auto_payout.* with payout.channel_enabled.<channel>
   * as one snapshot (readAutoPayoutConfigSnapshot), calendar.* for the review deadline.
   */
  config: AutoPayoutConfigPort;
  /** ⑤ ⑬ risk_state. */
  risk: RiskStateBatchReader;
  /** ⑬ appealing over frozen / banned. */
  appeal: AppealPrevStateReader;
  /** ④ ⑥ ⑧ (B2-11a's reader), read with t = created_at. */
  facts: WithdrawRiskFactsReader;
  adult: AutoPayoutAdultReader;
  blacklist: AutoPayoutBlacklistReader;
  /**
   * B2-05q (BR-ID-36): risk's writer of the ⑨ hit, on the decision's transaction. Without it, or
   * with a reader that has no match(), the decision is the same and no hit is recorded.
   */
  blacklistHits?: WithdrawalReviewHits;
  /** B2-06c's EXECUTE. */
  execute: Pick<PayoutExecute, 'executeBatch'>;
}

export interface AutoPayoutConsumer {
  /** Own transaction; processed_events claim and the decision's effects commit together. */
  consume(event: ReceivedEvent): Promise<void>;
  /** The handler registerEventConsumer runs inside its claim transaction (worker wiring). */
  handle(event: ReceivedEvent, trx: Transaction<DB>): Promise<void>;
}

export const AUTO_PAYOUT_CONSUMER = 'payout-auto-payout';
/** BR-WDR-24 / BR-WDR-30 告警: today's automatic total reached 80% of platform_daily_max_fen. */
export const AUTO_PAYOUT_NEAR_CAP = 'auto_payout_daily_near_cap';
/** BR-WDR-30 判定时点与并发: ⑦ and ⑨ are read under this one transaction-scoped advisory lock. */
const DAILY_LOCK = 'auto_payout_daily';
const PREFIX = 'withdraw.auto_payout.';
const NOT_COUNTED: readonly string[] = ['REJECTED', 'FAILED'];
const PENDING_REVIEW = 'PENDING_REVIEW';
/** B2-05r: the info line of a decision that recorded a BR-WDR-29 ⑨ hit (ids and category only). */
export const AUTO_PAYOUT_BLACKLIST_HIT = 'auto_payout_blacklist_hit';
/** auto_decision.failed_conditions entry of the live BR-WDR-29 ⑨ check (domain/auto-decision.ts). */
const BLACKLIST_HIT_CONDITION = 'risk_flag:blacklist_hit';
/** The alert line: total × 10000 ≥ max × 8000 (no rounding of 80% first). */
const NEAR_CAP_BP = 8000n;
const BP = 10000n;
const HMS = /^\d{2}:\d{2}:\d{2}$/;

/** The 08 defaults of the group (BR-WDR-30 细则 table; ① off until the owner switches it on). */
export const AUTO_PAYOUT_DEFAULTS: AutoPayoutConfig = {
  enabled: 'off',
  max_amount_fen: 30_000n,
  window_start: '09:00:00',
  window_end: '22:59:59',
  window_limit_enabled: 'off',
  first_withdrawal_limit_enabled: 'off',
  frozen_balance_policy: 'no_auto',
  same_day_policy: 'no_auto',
  payee_daily_max_count: 1,
  payee_monthly_max_count: 2,
  user_daily_max_count: 1,
  user_monthly_max_count: 1,
  warn: {
    high_commission_rate_bp: 10000,
    high_commission_order_ratio_bp: 10000,
    invalid_ratio_bp: 10000,
    withdraw_received_ratio_bp: 0,
  },
  platform_daily_max_fen: 200_000n,
  risk_block_flags: [
    'same_device_multi_account',
    'had_negative',
    'recon_diff',
    'payee_prev_other_user',
    'risk_calc_failed',
  ],
};

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseSwitch(value: unknown): Parsed<'on' | 'off'> {
  if (value === true || value === 'on' || value === 'true') return { ok: true, value: 'on' };
  if (value === false || value === 'off' || value === 'false') return { ok: true, value: 'off' };
  return { ok: false };
}

function parseCount(value: unknown): Parsed<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : { ok: false };
}

function parseBp(value: unknown): Parsed<number> {
  const parsed = parseCount(value);
  return parsed.ok && parsed.value <= 10_000 ? parsed : { ok: false };
}

function parseFenValue(value: unknown): Parsed<bigint> {
  const parsed = parseCount(value);
  return parsed.ok ? { ok: true, value: BigInt(parsed.value) } : { ok: false };
}

function parseHms(value: unknown): Parsed<string> {
  return typeof value === 'string' && HMS.test(value) ? { ok: true, value } : { ok: false };
}

function parseNoAuto(value: unknown): Parsed<'no_auto'> {
  return value === 'no_auto' ? { ok: true, value } : { ok: false };
}

function parseFlags(value: unknown): Parsed<readonly string[]> {
  return Array.isArray(value) && value.every((code) => typeof code === 'string')
    ? { ok: true, value: [...(value as string[])] }
    : { ok: false };
}

/** The W1 snapshot; anything but an array of {code} (never computed) blocks as risk_calc_failed. */
function riskFlagsOf(value: unknown): AutoPayoutRiskFlag[] {
  if (!Array.isArray(value)) return [{ code: 'risk_calc_failed', value: null, threshold: null }];
  const flags: AutoPayoutRiskFlag[] = [];
  for (const item of value as unknown[]) {
    const code = (item as { code?: unknown } | null)?.code;
    if (typeof code !== 'string') {
      return [{ code: 'risk_calc_failed', value: null, threshold: null }];
    }
    const flag = item as { value?: unknown; threshold?: unknown };
    flags.push({ code, value: flag.value ?? null, threshold: flag.threshold ?? null });
  }
  return flags;
}

function withdrawalIdOf(event: ReceivedEvent): string {
  const value = (event.payload as Record<string, unknown>)['withdrawal_id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('payout: withdrawal.created without withdrawal_id');
  }
  return value;
}

function count(value: string | number | bigint | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** One config_items row as read: its value and business version. */
export interface AutoPayoutConfigEntry {
  value: unknown;
  version: number;
}

/** Keys present in one snapshot; an absent key has no entry. */
export type AutoPayoutConfigSnapshot = ReadonlyMap<string, AutoPayoutConfigEntry>;

/**
 * content's configuration reader. `configValues`, when given, reads all `keys` in one statement
 * (one snapshot of config_items); without it the consumer reads key by key twice (below).
 */
export interface AutoPayoutConfigPort extends PayoutConfigPort {
  configValues?(
    appId: string,
    keys: readonly string[],
    handle: Kysely<DB>,
  ): Promise<AutoPayoutConfigSnapshot>;
}

/** The group's names under withdraw.auto_payout. (BR-WDR-30 细则). */
const GROUP_NAMES: readonly string[] = [
  'enabled',
  'max_amount_fen',
  'window_start',
  'window_end',
  'window_limit_enabled',
  'first_withdrawal_limit_enabled',
  'frozen_balance_policy',
  'same_day_policy',
  'payee_daily_max_count',
  'payee_monthly_max_count',
  'user_daily_max_count',
  'user_monthly_max_count',
  'warn.high_commission_rate_bp',
  'warn.high_commission_order_ratio_bp',
  'warn.invalid_ratio_bp',
  'warn.withdraw_received_ratio_bp',
  'platform_daily_max_fen',
  'risk_block_flags',
];
/** Per-key reads that keep differing between two passes this many times end the attempt. */
const SNAPSHOT_ATTEMPTS = 5;

function sameEntry(a: AutoPayoutConfigEntry | undefined, b: AutoPayoutConfigEntry | undefined) {
  if (a === undefined || b === undefined) return a === b;
  return a.version === b.version && JSON.stringify(a.value) === JSON.stringify(b.value);
}

/**
 * BR-WDR-30 可追溯: `keys` as one saved state, never old values of some keys with new values of
 * others (a batch save committing between two per-key reads). With the port's `configValues` that
 * is one statement. Otherwise every key is read twice; when both passes agree on every key
 * (presence, version, value), each value held from its first read to its second read, so all of
 * them held together at the instant between the passes. Passes that differ are read again; still
 * differing after SNAPSHOT_ATTEMPTS, it throws and the event is retried.
 */
export async function readAutoPayoutConfigSnapshot(
  port: AutoPayoutConfigPort,
  handle: Kysely<DB>,
  appId: string,
  keys: readonly string[],
): Promise<AutoPayoutConfigSnapshot> {
  if (port.configValues !== undefined) return port.configValues(appId, keys, handle);
  async function pass(): Promise<Map<string, AutoPayoutConfigEntry>> {
    const entries = new Map<string, AutoPayoutConfigEntry>();
    for (const key of keys) {
      const row = await port.configValue(appId, key, handle);
      if (row !== null) entries.set(key, { value: row.value, version: row.version });
    }
    return entries;
  }
  let previous = await pass();
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await pass();
    if (keys.every((key) => sameEntry(previous.get(key), current.get(key)))) return current;
    previous = current;
  }
  throw new Error('payout: withdraw.auto_payout.* kept changing while it was read');
}

/**
 * The group from one snapshot; absent or malformed keys take the 08 defaults (`onDefault`).
 * rule_version: Σ of the snapshot's withdraw.auto_payout.* versions — every save of any key raises
 * it, and with the decision time it names the config_item_versions rows the values came from.
 */
export function autoPayoutConfigOf(
  snapshot: AutoPayoutConfigSnapshot,
  onDefault: (key: string) => void,
): { config: AutoPayoutConfig; ruleVersion: number } {
  let ruleVersion = 0;
  function read<T>(name: string, parse: (v: unknown) => Parsed<T>, fallback: T): T {
    const key = `${PREFIX}${name}`;
    const row = snapshot.get(key);
    if (row === undefined) return fallback;
    ruleVersion += row.version;
    const parsed = parse(row.value);
    if (parsed.ok) return parsed.value;
    onDefault(key);
    return fallback;
  }
  const d = AUTO_PAYOUT_DEFAULTS;
  const config: AutoPayoutConfig = {
    enabled: read('enabled', parseSwitch, d.enabled),
    max_amount_fen: read('max_amount_fen', parseFenValue, d.max_amount_fen),
    window_start: read('window_start', parseHms, d.window_start),
    window_end: read('window_end', parseHms, d.window_end),
    window_limit_enabled: read('window_limit_enabled', parseSwitch, d.window_limit_enabled),
    first_withdrawal_limit_enabled: read(
      'first_withdrawal_limit_enabled',
      parseSwitch,
      d.first_withdrawal_limit_enabled,
    ),
    frozen_balance_policy: read('frozen_balance_policy', parseNoAuto, d.frozen_balance_policy),
    same_day_policy: read('same_day_policy', parseNoAuto, d.same_day_policy),
    payee_daily_max_count: read('payee_daily_max_count', parseCount, d.payee_daily_max_count),
    payee_monthly_max_count: read('payee_monthly_max_count', parseCount, d.payee_monthly_max_count),
    user_daily_max_count: read('user_daily_max_count', parseCount, d.user_daily_max_count),
    user_monthly_max_count: read('user_monthly_max_count', parseCount, d.user_monthly_max_count),
    warn: {
      high_commission_rate_bp: read(
        'warn.high_commission_rate_bp',
        parseBp,
        d.warn.high_commission_rate_bp,
      ),
      high_commission_order_ratio_bp: read(
        'warn.high_commission_order_ratio_bp',
        parseBp,
        d.warn.high_commission_order_ratio_bp,
      ),
      invalid_ratio_bp: read('warn.invalid_ratio_bp', parseBp, d.warn.invalid_ratio_bp),
      withdraw_received_ratio_bp: read(
        'warn.withdraw_received_ratio_bp',
        parseBp,
        d.warn.withdraw_received_ratio_bp,
      ),
    },
    platform_daily_max_fen: read('platform_daily_max_fen', parseFenValue, d.platform_daily_max_fen),
    risk_block_flags: read('risk_block_flags', parseFlags, d.risk_block_flags),
  };
  return { config, ruleVersion };
}

type PayoutChannelName = 'alipay' | 'bank_card' | 'wechat';

function channelOf(channel: string): PayoutChannelName | null {
  return channel === 'alipay' || channel === 'bank_card' || channel === 'wechat' ? channel : null;
}

export function createAutoPayoutConsumer(options: AutoPayoutOptions): AutoPayoutConsumer {
  const { db, logger, clock, ledger, config } = options;
  const commands = createWithdrawalCommands(options);
  const holds = createWithdrawHoldsReader();

  /** The decision of one withdrawal on `trx` (the claim, when any, is the caller's). */
  async function decide(trx: Transaction<DB>, appId: string, id: string): Promise<void> {
    const head = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select(['user_id', 'review_mode', 'auto_decision'])
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (head === undefined) {
      logger.warn({ app_id: appId, withdrawal_id: id }, 'auto_payout_withdrawal_missing');
      return;
    }
    // Judged once: switch off at W1 (manual) or an earlier decision ends it.
    if (head.review_mode !== null || head.auto_decision !== null) return;
    const userId = head.user_id;
    const selection = { appId, userIds: [userId] };
    // BR-WDR-07 lock order, then the serialising lock of ⑦ / ⑨.
    await options.lockUsersForUpdate(trx, selection);
    const balances = await ledger.lockBalances(trx, selection);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${DAILY_LOCK})::bigint)`.execute(trx);
    const row = await trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select([
        'id',
        'user_id',
        'amount_fen',
        'status',
        'row_version',
        'review_mode',
        'auto_decision',
        'payee_hmac',
        'payout_method',
        'payout_channel',
        'blocked_reason',
        'risk_flags',
        'created_at',
      ])
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (row.review_mode !== null || row.auto_decision !== null) return;

    const now = clock.now();
    const amount = row.amount_fen;
    const createdAt = row.created_at;
    // ① – ⑫'s configuration and ⑪'s channel switch from one saved state (BR-WDR-30 可追溯).
    const channel = channelOf(row.payout_channel);
    const channelKey = channel === null ? null : PAYOUT_EXECUTE_CONFIG_KEYS.channelEnabled(channel);
    const snapshot = await readAutoPayoutConfigSnapshot(config, trx, appId, [
      ...GROUP_NAMES.map((name) => `${PREFIX}${name}`),
      ...(channelKey === null ? [] : [channelKey]),
    ]);
    const onDefault = (key: string) =>
      logger.warn({ app_id: appId, config_key: key }, 'auto_payout_config_default');
    const { config: group, ruleVersion } = autoPayoutConfigOf(snapshot, onDefault);
    let channelOn = false;
    if (channel !== null && channelKey !== null) {
      const fallback = PAYOUT_EXECUTE_DEFAULTS.channelEnabled[channel];
      const entry = snapshot.get(channelKey);
      const parsed = entry === undefined ? null : parseSwitch(entry.value);
      if (parsed !== null && !parsed.ok) onDefault(channelKey);
      channelOn = parsed === null || !parsed.ok ? fallback : parsed.value === 'on';
    }
    const own = balances.find((balance) => balance.user_id === userId);
    const available = own === undefined ? 0n : own.available_fen;
    const frozen = own === undefined ? 0n : own.frozen_fen;

    // ⑤(a) / ⑬ BR-WDR-05: risk state (an expired freeze is over), appeal, holds.
    const states = await options.risk.read(trx, selection);
    const risk = states.get(userId) ?? { state: 'normal' as const, frozen_until: null };
    const expired =
      risk.state === 'frozen' &&
      risk.frozen_until !== null &&
      risk.frozen_until.getTime() <= now.getTime();
    const riskState = expired ? 'normal' : risk.state;
    const prev =
      riskState === 'appealing' ? await options.appeal.read(trx, { appId, userId }) : null;
    const activeHold = (await holds.read(trx, { appId, userId, deviceId: '' })).some((hold) =>
      holdActive(hold, now),
    );
    const memberBlocked =
      riskState === 'frozen' ||
      riskState === 'banned' ||
      (riskState === 'appealing' && (prev === 'frozen' || prev === 'banned')) ||
      activeHold;

    // ④ ⑥ ⑧ at t = created_at (BR-WDR-30 ⑧; ⑥ the day of created_at up to it).
    const subject: WithdrawRiskSubject = {
      appId,
      userId,
      withdrawalId: id,
      amountFen: amount,
      payeeHmac: row.payee_hmac,
      now: createdAt,
    };
    const { facts } = options;
    const firstWithdrawal = !(await facts.hasPaidWithdrawal(trx, subject));
    const creditedToday = await facts.creditedToday(trx, subject);
    const orders = await facts.selfOrders60d(trx, subject);
    // The reader counts this withdrawal (created at t) unless it is no longer counted; it is
    // counted exactly once either way (BR-WDR-29 ⑥ 含本单).
    const withdrawnOthers = await facts.withdrawn30dFen(trx, subject);
    const withdrawn = NOT_COUNTED.includes(row.status)
      ? addFen(withdrawnOthers, amount)
      : withdrawnOthers;
    const received = await facts.received60dFen(trx, subject);
    const warnActuals = computeAutoPayoutWarnValues(
      {
        orders_60d: orders.map((order) => ({
          // An undefined rate (no base) is never above X.
          commission_rate_bp:
            order.est_commission_fen === null || order.commission_base_fen === null
              ? -1
              : (commissionRateBp(order.est_commission_fen, order.commission_base_fen) ?? -1),
          invalid: order.invalid,
        })),
        withdrawn_30d_fen: withdrawn,
        received_60d_fen: received,
      },
      group.warn,
    );

    // ⑦ ⑨ under the advisory lock: auto, still counted, reviewed in the current +08:00 day / month.
    const day = chinaDayRange(accountingDate(now));
    const month = chinaMonthRange(chinaMonth(now));
    const dayStart = sql<Date>`${day.start}::timestamptz`;
    const dayEnd = sql<Date>`${day.end}::timestamptz`;
    const monthStart = sql<Date>`${month.start}::timestamptz`;
    const monthEnd = sql<Date>`${month.end}::timestamptz`;
    const counted = trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .where('app_id', '=', appId)
      .where('review_mode', '=', 'auto')
      .where('status', 'not in', [...NOT_COUNTED])
      .where('id', '<>', id);
    const byUser = await counted
      .select((eb) => [
        eb.fn
          .count<string>('id')
          .filterWhere('reviewed_at', '>=', dayStart)
          .filterWhere('reviewed_at', '<', dayEnd)
          .as('daily'),
        eb.fn.count<string>('id').as('monthly'),
      ])
      .where('user_id', '=', userId)
      .where('reviewed_at', '>=', monthStart)
      .where('reviewed_at', '<', monthEnd)
      .executeTakeFirstOrThrow();
    const byPayee = await counted
      .select((eb) => [
        eb.fn
          .count<string>('id')
          .filterWhere('reviewed_at', '>=', dayStart)
          .filterWhere('reviewed_at', '<', dayEnd)
          .as('daily'),
        eb.fn.count<string>('id').as('monthly'),
      ])
      .where('payee_hmac', '=', row.payee_hmac)
      .where('reviewed_at', '>=', monthStart)
      .where('reviewed_at', '<', monthEnd)
      .executeTakeFirstOrThrow();
    const platform = await counted
      .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('amount_fen'), sql<string>`0`).as('total'))
      .where('reviewed_at', '>=', dayStart)
      .where('reviewed_at', '<', dayEnd)
      .executeTakeFirstOrThrow();
    const platformToday = parseFen(platform.total);

    const adult = await options.adult.isAdult(trx, { appId, userId, at: now });
    // ⑫ the live BR-WDR-29 ⑨ check, once: match() also names the target for the hit record.
    const blacklistSubject = {
      appId,
      userId,
      payeeHmac: row.payee_hmac,
      payoutMethod: row.payout_method,
    };
    const { blacklist } = options;
    const blacklistMatch =
      blacklist.match === undefined ? null : await blacklist.match(trx, blacklistSubject);
    const blacklistHit =
      blacklist.match === undefined
        ? await blacklist.hit(trx, blacklistSubject)
        : blacklistMatch !== null;
    const decision: AutoPayoutDecision = decideAutoPayout({
      config: group,
      amount_fen: amount,
      created_at: createdAt,
      first_withdrawal: firstWithdrawal,
      active_hold: activeHold,
      risk_state: riskState,
      frozen_fen: frozen,
      credited_today: creditedToday,
      counts: {
        payee_daily: count(byPayee.daily),
        payee_monthly: count(byPayee.monthly),
        user_daily: count(byUser.daily),
        user_monthly: count(byUser.monthly),
      },
      warn_actuals: warnActuals,
      platform_daily_auto_fen: platformToday,
      adult,
      channel_enabled: channelOn,
      risk_flags: riskFlagsOf(row.risk_flags),
      blacklist_hit: blacklistHit,
      w2_guard_passed: !memberBlocked && available >= 0n && row.blocked_reason === null,
    });
    const record: AutoPayoutDecisionRecord = {
      ...decision,
      rule_version: ruleVersion,
      decided_at: now.toISOString(),
    };

    /** auto_decision only (a human reviewed first: nothing else moves). */
    async function writeDecisionOnly(value: AutoPayoutDecisionRecord): Promise<void> {
      await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({
          auto_decision: sql<
            DB['withdrawals']['auto_decision']
          >`CAST(${JSON.stringify(value)} AS jsonb)`,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .execute();
    }

    /** review_mode, auto_decision and the BR-WDR-26 deadline from created_at. */
    async function writeReview(mode: 'auto' | 'manual'): Promise<void> {
      const deadline = reviewDeadline(
        createdAt,
        await readReviewCalendars({ config, logger }, trx, appId, createdAt),
      );
      await trx
        .withSchema('app')
        .updateTable('withdrawals')
        .set({
          review_mode: mode,
          review_deadline: deadline,
          auto_decision: sql<
            DB['withdrawals']['auto_decision']
          >`CAST(${JSON.stringify(record)} AS jsonb)`,
          updated_at: now,
        })
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .execute();
    }

    // B2-05q (BR-ID-36): the hit of a decision that lists the blacklist flag, with the decision.
    if (
      blacklistMatch !== null &&
      options.blacklistHits !== undefined &&
      decision.failed_conditions.includes(BLACKLIST_HIT_CONDITION)
    ) {
      await options.blacklistHits.record(trx, {
        app_id: appId,
        user_id: userId,
        withdrawal_id: id,
        dimension: blacklistMatch.hit.dimension,
        value_hmac: blacklistMatch.hit.value_hmac,
        rule_id: blacklistMatch.hit.rule_id,
      });
      // B2-05r (BR-ID-33): which withdrawal went to a reviewer and for which kind of hit; no
      // member id, phone or digest.
      logger.info?.(
        {
          app_id: appId,
          withdrawal_id: id,
          dimension: blacklistMatch.hit.dimension,
          rule_id: blacklistMatch.hit.rule_id,
        },
        AUTO_PAYOUT_BLACKLIST_HIT,
      );
    }

    if (row.status !== PENDING_REVIEW) {
      await writeDecisionOnly(record);
      return;
    }
    if (decision.result === 'manual') {
      await writeReview('manual');
      return;
    }
    // System W2 through B2-05e (CAS status = PENDING_REVIEW at the row version read under the locks).
    let approved = false;
    try {
      const result = await commands.approve(trx, {
        appId,
        withdrawalId: id,
        expectedStatus: PENDING_REVIEW,
        expectedRowVersion: row.row_version,
        reviewerId: null,
      });
      approved = result.kind === 'changed';
    } catch (error) {
      if (!(error instanceof WithdrawalConflictError)) throw error;
    }
    if (!approved) {
      await writeDecisionOnly(record);
      return;
    }
    await writeReview('auto');
    // BR-WDR-24: today's automatic total (this one included) at or above 80% of the cap.
    // total × 10000 ≥ max × 8000 ⇔ total ≥ ⌈max × 8000 / 10000⌉ (total is whole fen).
    const total = addFen(platformToday, amount);
    const line = mulDivCeil(group.platform_daily_max_fen, NEAR_CAP_BP, BP);
    if (total >= line) {
      logger.warn(
        {
          app_id: appId,
          withdrawal_id: id,
          daily_auto_total_fen: fenToJsonNumber(total),
          platform_daily_max_fen: fenToJsonNumber(group.platform_daily_max_fen),
          near_cap_line_fen: fenToJsonNumber(line),
        },
        AUTO_PAYOUT_NEAR_CAP,
      );
    }
    // W4 by the system: one kind=auto batch of this withdrawal (B2-06c); never retried.
    const executed = await options.execute.executeBatch(trx, {
      appId,
      members: [id],
      executorId: SYSTEM_AUTO_PAYOUT,
      now,
    });
    let blocked: AutoPayoutExecuteBlocked | null = null;
    if (executed.kind === 'rejected') {
      blocked = executed.reason;
    } else if (!executed.paying.includes(id)) {
      blocked = executed.left.find((item) => item.id === id)?.reason ?? 'not_approved';
    }
    if (blocked !== null) await writeDecisionOnly({ ...record, execute_blocked: blocked });
  }

  return {
    async handle(event, trx) {
      await decide(trx, event.appId, withdrawalIdOf(event));
    },
    async consume(event) {
      const id = withdrawalIdOf(event);
      await db.transaction().execute(async (trx) => {
        const claimed = await trx
          .withSchema('app')
          .insertInto('processed_events')
          .values({ consumer: AUTO_PAYOUT_CONSUMER, event_id: event.eventId })
          .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
          .returning('event_id')
          .executeTakeFirst();
        if (claimed === undefined) return;
        await decide(trx, event.appId, id);
      });
    },
  };
}
