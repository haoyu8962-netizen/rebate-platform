// B2-05c: the withdrawal rules use case over ports (every read on the caller's handle, never a
// second pooled connection; identity, risk and ledger only through their index.ts ports; the
// withdraw.* configuration through content's reader assembled by app.module). getRules is
// GET /v1/withdrawals/rules (BR-WDR-03 细则「rules 接口」: the chain without ② and the amount
// comparisons, max_withdrawable_fen, the remaining counts and the fee / tax estimate); validate is
// the submission-side chain POST /v1/withdrawals runs twice (outside and inside the locks,
// B2-05d). Rule values come from 规划/08 BR-WDR-03 / 04 / 05 / 06 / 31 through the pure functions of
// domain/withdraw-rules.ts; this file only gathers inputs and projects the answer to the contract.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { isAtLeastAge, samePersonName } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock } from '../../platform/index.ts';
import type {
  AppealPrevStateReader,
  BlocklistMatchReader,
  RiskStateBatchReader,
} from '../../risk/index.ts';
import {
  validateWithdrawal,
  withdrawalRules,
  type WithdrawBlock,
  type WithdrawLimits,
  type WithdrawReverifyBlock,
  type WithdrawRuleInput,
  type WithdrawUsage,
} from '../domain/withdraw-rules.ts';

export interface WithdrawActor {
  appId: string;
  userId: string;
  deviceId: string;
}

export interface PayoutConfigPort {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ value: unknown; version: number } | null>;
}

/**
 * BR-WDR-03 ③b (BR-WDR-01 细则「旧手机号被二次放号时的提现加验」): identity's verdict for the
 * account on this device, passed through unchanged, data.providers and data.fail_limit included;
 * null = nothing pending. The error code and its data belong to identity, never assigned here.
 */
export interface ReverifyGatePort {
  check(handle: Kysely<DB>, subject: WithdrawActor): Promise<WithdrawReverifyBlock | null>;
}

export interface WithdrawHold {
  reason: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
  released_at: Date | null;
  hold_until: Date | null;
}

export interface WithdrawUsageReader {
  read(
    handle: Kysely<DB>,
    input: WithdrawActor & { payeeHmac: string | null; now: Date },
  ): Promise<WithdrawUsage>;
}

export interface FeeTaxCalculator {
  calculate(
    handle: Kysely<DB>,
    input: WithdrawActor & { amountFen: bigint; now: Date },
  ): Promise<{
    fee_fen: bigint;
    tax_fen: bigint;
    net_fen: bigint;
    fee_rule_id?: string | null;
    tax_rule_version?: string | null;
  }>;
}

export interface WithdrawRulesOptions {
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
  config: PayoutConfigPort;
  risk: RiskStateBatchReader;
  appeal: AppealPrevStateReader;
  blocklist: BlocklistMatchReader;
  reverify: ReverifyGatePort;
  /** Structural ports keep Nest's decorated identity controllers out of pure consumers. */
  realname: {
    read(
      handle: Kysely<DB>,
      subject: { app_id: string; user_id: string },
    ): Promise<'none' | 'verified' | 'failed'>;
    verified(
      handle: Kysely<DB>,
      subject: { app_id: string; user_id: string },
    ): Promise<{
      name: string;
      birth_date: string;
      provider: string;
      verified_at: Date;
    } | null>;
  };
  subject: {
    read(
      handle: Kysely<DB>,
      subject: { appId: string; userId: string },
    ): Promise<{
      payout_method: 'alipay' | 'bank_card' | 'wechat';
      payee_name: string;
      payee_hmac: string;
    } | null>;
  };
  laborAgreementSigned(
    handle: Kysely<DB>,
    subject: { app_id: string; user_id: string },
  ): Promise<boolean>;
  ledger: Pick<Ledger, 'getBalances'>;
  holds: { read(handle: Kysely<DB>, subject: WithdrawActor): Promise<readonly WithdrawHold[]> };
  usage: WithdrawUsageReader;
  selfPurchase: {
    read(
      handle: Kysely<DB>,
      input: WithdrawActor & { now: Date },
    ): Promise<{ count: number; amount_fen: bigint }>;
  };
  feeTax: FeeTaxCalculator;
}

export interface WithdrawRulesService {
  getRules(
    handle: Kysely<DB>,
    actor: WithdrawActor,
    amountFen?: bigint,
  ): Promise<components['schemas']['WithdrawRules']>;
  validate(
    handle: Kysely<DB>,
    actor: WithdrawActor,
    amountFen: bigint,
    stepUpValid: boolean,
  ): Promise<WithdrawBlock | null>;
}

/** The withdraw.* configuration keys (规划/04 §10; defaults BR-WDR-04 / BR-WDR-06 占位值). */
export const WITHDRAW_CONFIG_KEYS = {
  enabled: 'withdraw.enabled',
  min: 'withdraw.min_amount_fen',
  step: 'withdraw.amount_step_fen',
  max: 'withdraw.max_amount_fen',
  daily: 'withdraw.daily_count_per_user',
  monthly: 'withdraw.monthly_count_per_user',
  payeeDaily: 'withdraw.payee_daily_count',
  payeeUsers: 'withdraw.payee_daily_distinct_users',
  methodAlipay: 'withdraw.method_max_amount_fen.alipay',
  methodBankCard: 'withdraw.method_max_amount_fen.bank_card',
  methodWechat: 'withdraw.method_max_amount_fen.wechat',
  minorCap: 'withdraw.minor_monthly_cap_fen',
  selfPurchaseEnabled: 'withdraw.self_purchase_90d.enabled',
  selfPurchaseMin: 'withdraw.self_purchase_90d.min_fen',
  memberLevels: 'withdraw.allowed_member_levels',
} as const;

/** 08 defaults (development placeholders; the console overwrites them before launch, ADD-03). */
export const DEFAULT_WITHDRAW_LIMITS: Readonly<WithdrawLimits> = Object.freeze({
  // withdraw.enabled is a kill switch; a missing row means the default state "on" (D-W02).
  enabled: true,
  min_amount_fen: 100n,
  amount_step_fen: 100n,
  max_amount_fen: 500000n,
  daily_count_per_user: 1,
  monthly_count_per_user: 10,
  payee_daily_count: 2,
  payee_daily_distinct_users: 1,
  method_max_amount_fen: Object.freeze({ alipay: 0n, bank_card: 0n, wechat: 20000n }),
  minor_monthly_cap_fen: 20000n,
  self_purchase_enabled: false,
  self_purchase_min_fen: 0n,
  allowed_member_levels: Object.freeze([]) as readonly string[],
});

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseSwitch(value: unknown): Parsed<boolean> {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'on' || value === 'true') return { ok: true, value: true };
  if (value === 'off' || value === 'false') return { ok: true, value: false };
  return { ok: false };
}

function parseBoolean(value: unknown): Parsed<boolean> {
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

/** A whole JSON number >= min, as bigint fen (strings and fractions are refused: warn + default). */
function parseFen(value: unknown, min: bigint): Parsed<bigint> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { ok: false };
  const parsed = BigInt(value);
  return parsed >= min ? { ok: true, value: parsed } : { ok: false };
}

function parseCount(value: unknown): Parsed<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { ok: true, value }
    : { ok: false };
}

/** The member level system is undefined in the MVP: only the empty list is accepted (BR-WDR-04). */
function parseLevels(value: unknown): Parsed<readonly string[]> {
  return Array.isArray(value) && value.length === 0 ? { ok: true, value: [] } : { ok: false };
}

export async function readWithdrawLimits(
  handle: Kysely<DB>,
  actor: WithdrawActor,
  options: Pick<WithdrawRulesOptions, 'config' | 'logger'>,
): Promise<WithdrawLimits> {
  const { config, logger } = options;
  async function read<T>(
    key: string,
    fallback: T,
    parse: (value: unknown) => Parsed<T>,
  ): Promise<T> {
    const row = await config.configValue(actor.appId, key, handle);
    if (row === null) return fallback;
    const parsed = parse(row.value);
    if (parsed.ok) return parsed.value;
    logger.warn({ app_id: actor.appId, config_key: key }, 'withdraw_config_default');
    return fallback;
  }
  const d = DEFAULT_WITHDRAW_LIMITS;
  const keys = WITHDRAW_CONFIG_KEYS;
  return {
    enabled: await read(keys.enabled, d.enabled, parseSwitch),
    min_amount_fen: await read(keys.min, d.min_amount_fen, (v) => parseFen(v, 1n)),
    amount_step_fen: await read(keys.step, d.amount_step_fen, (v) => parseFen(v, 1n)),
    max_amount_fen: await read(keys.max, d.max_amount_fen, (v) => parseFen(v, 1n)),
    daily_count_per_user: await read(keys.daily, d.daily_count_per_user, parseCount),
    monthly_count_per_user: await read(keys.monthly, d.monthly_count_per_user, parseCount),
    payee_daily_count: await read(keys.payeeDaily, d.payee_daily_count, parseCount),
    payee_daily_distinct_users: await read(
      keys.payeeUsers,
      d.payee_daily_distinct_users,
      parseCount,
    ),
    method_max_amount_fen: {
      alipay: await read(keys.methodAlipay, d.method_max_amount_fen.alipay, (v) => parseFen(v, 0n)),
      bank_card: await read(keys.methodBankCard, d.method_max_amount_fen.bank_card, (v) =>
        parseFen(v, 0n),
      ),
      wechat: await read(keys.methodWechat, d.method_max_amount_fen.wechat, (v) => parseFen(v, 0n)),
    },
    minor_monthly_cap_fen: await read(keys.minorCap, d.minor_monthly_cap_fen, (v) =>
      parseFen(v, 0n),
    ),
    self_purchase_enabled: await read(
      keys.selfPurchaseEnabled,
      d.self_purchase_enabled,
      parseBoolean,
    ),
    self_purchase_min_fen: await read(keys.selfPurchaseMin, d.self_purchase_min_fen, (v) =>
      parseFen(v, 0n),
    ),
    allowed_member_levels: await read(keys.memberLevels, d.allowed_member_levels, parseLevels),
  };
}

/** BR-WDR-03 ① alone (the post-miss switch check): missing row = on, invalid value = default. */
export async function readWithdrawEnabled(
  handle: Kysely<DB>,
  appId: string,
  options: {
    config: PayoutConfigPort;
    logger: { warn(fields: Record<string, unknown>, message: string): void };
  },
): Promise<boolean> {
  const row = await options.config.configValue(appId, WITHDRAW_CONFIG_KEYS.enabled, handle);
  if (row === null) return DEFAULT_WITHDRAW_LIMITS.enabled;
  const parsed = parseSwitch(row.value);
  if (parsed.ok) return parsed.value;
  options.logger.warn(
    { app_id: appId, config_key: WITHDRAW_CONFIG_KEYS.enabled },
    'withdraw_config_default',
  );
  return DEFAULT_WITHDRAW_LIMITS.enabled;
}

/** A hold is in effect while not released and either open-ended or not yet due (BR-WDR-05). */
export function holdActive(hold: WithdrawHold, now: Date): boolean {
  if (hold.released_at !== null) return false;
  return hold.hold_until === null || hold.hold_until.getTime() > now.getTime();
}

/** The minor rule stops at the 18th birthday's next midnight +08:00 (BR-ID-26, BR-WDR-06). */
function isMinor(birthDate: string, now: Date): boolean {
  return !isAtLeastAge(birthDate, 18, now);
}

/**
 * The chain's input gathered from the ports on `handle` (B2-05d reads it twice: outside the locks
 * and again under them, so every read goes to the handle given, never to a second connection).
 */
export async function readWithdrawInput(
  handle: Kysely<DB>,
  actor: WithdrawActor,
  stepUpValid: boolean,
  options: WithdrawRulesOptions,
): Promise<WithdrawRuleInput> {
  const now = options.clock.now();
  const subjectKey = { app_id: actor.appId, user_id: actor.userId };
  const limits = await readWithdrawLimits(handle, actor, options);
  const riskRows = await options.risk.read(handle, {
    appId: actor.appId,
    userIds: [actor.userId],
  });
  const risk = riskRows.get(actor.userId) ?? { state: 'normal' as const, frozen_until: null };
  // A freeze with an expiry is over the moment the clock reaches it (B1-02zf: judged here).
  const expired =
    risk.state === 'frozen' &&
    risk.frozen_until !== null &&
    risk.frozen_until.getTime() <= now.getTime();
  const riskState = expired ? 'normal' : risk.state;
  const prev =
    riskState === 'appealing'
      ? await options.appeal.read(handle, { appId: actor.appId, userId: actor.userId })
      : null;
  const reverify = await options.reverify.check(handle, actor);
  const realnameStatus = await options.realname.read(handle, subjectKey);
  const realname = await options.realname.verified(handle, subjectKey);
  const subject = await options.subject.read(handle, {
    appId: actor.appId,
    userId: actor.userId,
  });
  const payeeHmac = subject === null ? null : subject.payee_hmac;
  const payoutMethod = subject === null ? null : subject.payout_method;
  // ③a: one judgement either way. B2-05q (BR-ID-36): a reader with match() also names what hit,
  // so that a refused application can be recorded without judging a second time.
  const blocklistSubject = { ...actor, payeeHmac, payoutMethod, now };
  const matched =
    options.blocklist.match === undefined
      ? null
      : await options.blocklist.match(handle, blocklistSubject);
  const blocked =
    options.blocklist.match === undefined
      ? await options.blocklist.read(handle, blocklistSubject)
      : matched;
  const signed = await options.laborAgreementSigned(handle, subjectKey);
  const balances = await options.ledger.getBalances(handle, {
    appId: actor.appId,
    userIds: [actor.userId],
  });
  const own = balances.find((row) => row.app_id === actor.appId && row.user_id === actor.userId);
  const holds = await options.holds.read(handle, actor);
  const usage = await options.usage.read(handle, { ...actor, now, payeeHmac });
  // ⑬ is judged only when the gate is on: the port's order reads are skipped otherwise.
  const selfPurchase = limits.self_purchase_enabled
    ? await options.selfPurchase.read(handle, { ...actor, now })
    : { count: 0, amount_fen: 0n };
  return {
    limits,
    step_up_valid: stepUpValid,
    risk_state: riskState,
    prev_risk_state: prev,
    blocklist_risk_msg_code: blocked === null ? null : blocked.risk_msg_code,
    blocklist_hit: matched === null ? null : matched.hit,
    reverify,
    realname_verified: realnameStatus === 'verified' && realname !== null,
    payout_method: payoutMethod,
    names_match:
      realname !== null && subject !== null && samePersonName(realname.name, subject.payee_name),
    labor_agreement_signed: signed,
    active_hold: holds.some((hold) => holdActive(hold, now)),
    available_fen: own === undefined ? 0n : own.available_fen,
    usage,
    minor: realname !== null && isMinor(realname.birth_date, now),
    self_purchase_count: selfPurchase.count,
    self_purchase_fen: selfPurchase.amount_fen,
  };
}

export function createWithdrawRules(options: WithdrawRulesOptions): WithdrawRulesService {
  const { clock } = options;
  const gather = (handle: Kysely<DB>, actor: WithdrawActor, stepUpValid: boolean) =>
    readWithdrawInput(handle, actor, stepUpValid, options);

  return {
    async getRules(handle, actor, amountFen) {
      const input = await gather(handle, actor, true);
      const summary = withdrawalRules(input);
      const base = {
        can_withdraw: summary.can_withdraw,
        block_code: summary.block_code,
        block_reason: summary.block_reason,
        max_withdrawable_fen: fenToJsonNumber(summary.max_withdrawable_fen),
        withdrawable_fen: fenToJsonNumber(summary.withdrawable_fen),
        daily_remaining: summary.daily_remaining,
        monthly_remaining: summary.monthly_remaining,
        quick_amounts_fen: [] as number[],
      };
      if (!summary.can_withdraw) {
        return { ...base, est_fee_fen: null, est_tax_fen: null, est_net_fen: null };
      }
      // The estimate takes the given amount or the maximum; it never validates the amount.
      const estimate = await options.feeTax.calculate(handle, {
        ...actor,
        amountFen: amountFen ?? summary.max_withdrawable_fen,
        now: clock.now(),
      });
      return {
        ...base,
        est_fee_fen: fenToJsonNumber(estimate.fee_fen),
        est_tax_fen: fenToJsonNumber(estimate.tax_fen),
        est_net_fen: fenToJsonNumber(estimate.net_fen),
      };
    },
    async validate(handle, actor, amountFen, stepUpValid) {
      const input = await gather(handle, actor, stepUpValid);
      const fees = await options.feeTax.calculate(handle, {
        ...actor,
        amountFen,
        now: clock.now(),
      });
      return validateWithdrawal(input, amountFen, fees.net_fen);
    },
  };
}

/** BR-WDR-19 (MVP fee 0) and BR-WDR-20 (tax 0 until the rate table arrives): net = amount. */
export function createDefaultFeeTaxCalculator(): FeeTaxCalculator {
  return {
    calculate: (_handle, input) =>
      Promise.resolve({ fee_fen: 0n, tax_fen: 0n, net_fen: input.amountFen }),
  };
}
