// B2-05c: the withdrawal check order of 规划/08 BR-WDR-03 ①–⑬ as a pure function over normalised
// input (money as bigint fen; the ports that read the inputs live in application/withdraw-rules.ts).
// Two entry points share the chain: validateWithdrawal (POST /v1/withdrawals: every step, the
// requested amount included) and withdrawalRules (GET /v1/withdrawals/rules: skips ② step-up and
// the amount comparisons of ⑨ ⑩ ⑫, then derives max_withdrawable_fen and the remaining counts,
// BR-WDR-03 细则). Step order and the in-step reason priorities are fixed by 08; the configured
// values come from BR-WDR-04 / BR-WDR-06 through WithdrawLimits (0 = unlimited for the four
// counts). No clock, no I/O, no floating point.
import { floorToStepFen, subFen } from '@couli/money';

/** BR-WDR-03: normalized input for steps ①–⑬. Money remains bigint fen. */
export interface WithdrawLimits {
  enabled: boolean;
  min_amount_fen: bigint;
  amount_step_fen: bigint;
  max_amount_fen: bigint;
  daily_count_per_user: number;
  monthly_count_per_user: number;
  payee_daily_count: number;
  payee_daily_distinct_users: number;
  method_max_amount_fen: Readonly<Record<'alipay' | 'bank_card' | 'wechat', bigint>>;
  minor_monthly_cap_fen: bigint;
  self_purchase_enabled: boolean;
  self_purchase_min_fen: bigint;
  allowed_member_levels: readonly string[];
}

export interface WithdrawUsage {
  daily_count: number;
  monthly_count: number;
  payee_daily_count: number;
  /** Distinct OTHER members using the snapshot payee HMAC today. */
  payee_daily_other_users: number;
  monthly_amount_fen: bigint;
}

export interface WithdrawBlock {
  code: number;
  data: Readonly<Record<string, string | bigint | number | readonly string[]>>;
}

/** ③b: identity's answer (BR-WDR-01 细则「位置与返回码」), its data as the contract's 10010. */
export interface WithdrawReverifyBlock {
  code: number;
  data: {
    readonly method: string;
    readonly providers?: readonly string[];
    readonly fail_limit?: number;
  };
}

export interface WithdrawRuleInput {
  limits: WithdrawLimits;
  step_up_valid: boolean;
  risk_state: 'normal' | 'frozen' | 'banned' | 'appealing';
  prev_risk_state: 'frozen' | 'banned' | null;
  blocklist_risk_msg_code: string | null;
  reverify: WithdrawReverifyBlock | null;
  realname_verified: boolean;
  payout_method: 'alipay' | 'bank_card' | 'wechat' | null;
  names_match: boolean;
  labor_agreement_signed: boolean;
  active_hold: boolean;
  available_fen: bigint;
  usage: WithdrawUsage;
  minor: boolean;
  self_purchase_count: number;
  self_purchase_fen: bigint;
}

export interface WithdrawRuleSummary {
  can_withdraw: boolean;
  block_code: number | null;
  block_reason: string | null;
  max_withdrawable_fen: bigint;
  withdrawable_fen: bigint;
  daily_remaining: number;
  monthly_remaining: number;
}

/** The remaining count the rules answer shows when a count limit is configured as 0 (unlimited). */
export const UNLIMITED_REMAINING = 9999;

const CONDITION = 30303;

function condition(reason: string): WithdrawBlock {
  return { code: CONDITION, data: { reason } };
}

function plain(code: number): WithdrawBlock {
  return { code, data: {} };
}

/** Steps ⑦ and ⑧ aside, the frozen effect of BR-WDR-05: frozen, or appealing over frozen. */
function frozenEffect(input: WithdrawRuleInput): boolean {
  return (
    input.risk_state === 'frozen' ||
    (input.risk_state === 'appealing' && input.prev_risk_state === 'frozen')
  );
}

/** The banned effect of BR-WDR-05: banned, or appealing over banned. */
function bannedEffect(input: WithdrawRuleInput): boolean {
  return (
    input.risk_state === 'banned' ||
    (input.risk_state === 'appealing' && input.prev_risk_state === 'banned')
  );
}

/** A count limit of 0 means unlimited (BR-WDR-04); otherwise `used + 1 <= cap`. */
function countExceeded(cap: number, used: number): boolean {
  return cap > 0 && used >= cap;
}

/** The single-withdrawal cap of the current payout method; 0 or no method means none. */
function methodCap(input: WithdrawRuleInput): bigint | null {
  if (input.payout_method === null) return null;
  const cap = input.limits.method_max_amount_fen[input.payout_method];
  return cap > 0n ? cap : null;
}

/** BR-WDR-06 ①: what the minor may still apply for this month (never negative). */
function minorRemaining(input: WithdrawRuleInput): bigint {
  const left = subFen(input.limits.minor_monthly_cap_fen, input.usage.monthly_amount_fen);
  return left < 0n ? 0n : left;
}

/**
 * Steps ① and ③–⑧, ⑪, ⑬ (the ones both entry points judge) plus, when `amount` is given, ② ⑨ ⑩
 * and ⑫ at their places. `null` when every step passes.
 */
function firstBlock(
  input: WithdrawRuleInput,
  amount: { readonly amount_fen: bigint; readonly net_fen: bigint } | null,
): WithdrawBlock | null {
  const { limits, usage } = input;
  // ① switch
  if (!limits.enabled) return plain(30306);
  // ② step-up (submission only)
  if (amount !== null && !input.step_up_valid) return plain(10003);
  // ③ banned (appealing takes its previous state, BR-WDR-05)
  if (bannedEffect(input)) return plain(10006);
  // ③a blocklist (BR-ID-31)
  if (input.blocklist_risk_msg_code !== null) {
    return { code: 44001, data: { risk_msg_code: input.blocklist_risk_msg_code } };
  }
  // ③b pending re-verification: the identity port's answer is passed through unchanged
  if (input.reverify !== null) {
    return { code: input.reverify.code, data: { ...input.reverify.data } };
  }
  // ④ real name
  if (!input.realname_verified) return plain(30304);
  // ⑤ payout account
  if (input.payout_method === null) return plain(30305);
  // ⑥ payee name = real name
  if (!input.names_match) return plain(30307);
  // ⑥a labor agreement (BR-WDR-31)
  if (!input.labor_agreement_signed)
    return { code: 10004, data: { consent_type: 'labor_agreement' } };
  // ⑦ frozen: risk state or an effective withdraw hold
  if (frozenEffect(input) || input.active_hold) return condition('account_frozen');
  // ⑧ negative balance
  if (input.available_fen < 0n) return plain(30302);
  if (amount !== null) {
    // ⑨ amount: below_min → not_multiple → above_max → above_method_max → net_too_small
    if (amount.amount_fen < limits.min_amount_fen) return condition('below_min');
    if (amount.amount_fen % limits.amount_step_fen !== 0n) return condition('not_multiple');
    if (amount.amount_fen > limits.max_amount_fen) return condition('above_max');
    const cap = methodCap(input);
    if (cap !== null && amount.amount_fen > cap) return condition('above_method_max');
    if (amount.net_fen < 1n) return condition('net_too_small');
    // ⑩ balance
    if (input.available_fen < amount.amount_fen) return plain(30301);
  }
  // ⑪ counts: daily_count → monthly_count → payee_daily_count → payee_daily_users
  if (countExceeded(limits.daily_count_per_user, usage.daily_count))
    return condition('daily_count');
  if (countExceeded(limits.monthly_count_per_user, usage.monthly_count)) {
    return condition('monthly_count');
  }
  if (countExceeded(limits.payee_daily_count, usage.payee_daily_count)) {
    return condition('payee_daily_count');
  }
  if (countExceeded(limits.payee_daily_distinct_users, usage.payee_daily_other_users)) {
    return condition('payee_daily_users');
  }
  // ⑫ minor monthly cap (BR-WDR-06): a cap of 0 forbids outright; the amount comparison only on
  // submission, the rules answer judges the remaining allowance through max_withdrawable_fen
  if (input.minor) {
    const remaining = minorRemaining(input);
    if (limits.minor_monthly_cap_fen === 0n) return { code: 30309, data: { remaining_fen: 0n } };
    if (amount !== null && amount.amount_fen > remaining) {
      return { code: 30309, data: { remaining_fen: remaining } };
    }
  }
  // ⑬ 90-day self purchase (off by default)
  if (limits.self_purchase_enabled) {
    if (input.self_purchase_count < 1) return condition('self_purchase_required');
    if (
      limits.self_purchase_min_fen > 0n &&
      input.self_purchase_fen < limits.self_purchase_min_fen
    ) {
      return condition('self_purchase_required');
    }
  }
  return null;
}

/** No auth/idempotency/version work here. netFen comes from FeeTaxCalculator. */
export function validateWithdrawal(
  input: WithdrawRuleInput,
  amountFen: bigint,
  netFen: bigint,
): WithdrawBlock | null {
  return firstBlock(input, { amount_fen: amountFen, net_fen: netFen });
}

function remainingCount(cap: number, used: number): number {
  if (cap <= 0) return UNLIMITED_REMAINING;
  return Math.max(0, cap - used);
}

/**
 * BR-WDR-03 细则: max_withdrawable_fen = floor_to_step(min(available, max_amount_fen, the method's
 * cap when set, the minor's remaining allowance)); below min_amount_fen the answer is
 * can_withdraw=false / 30303 below_min / 0.
 */
function maximum(input: WithdrawRuleInput): bigint {
  const { limits } = input;
  let bound =
    input.available_fen < limits.max_amount_fen ? input.available_fen : limits.max_amount_fen;
  const cap = methodCap(input);
  if (cap !== null && cap < bound) bound = cap;
  if (input.minor) {
    const remaining = minorRemaining(input);
    if (remaining < bound) bound = remaining;
  }
  return floorToStepFen(bound, limits.amount_step_fen);
}

/** Read-only projection skips step-up and comparisons against the requested amount. */
export function withdrawalRules(input: WithdrawRuleInput): WithdrawRuleSummary {
  const { limits, usage } = input;
  const withdrawable = input.available_fen < 0n ? 0n : input.available_fen;
  const counts = {
    daily_remaining: remainingCount(limits.daily_count_per_user, usage.daily_count),
    monthly_remaining: remainingCount(limits.monthly_count_per_user, usage.monthly_count),
  };
  const block = firstBlock(input, null);
  if (block !== null) {
    return {
      can_withdraw: false,
      block_code: block.code,
      block_reason: block.code === CONDITION ? String(block.data['reason']) : null,
      max_withdrawable_fen: 0n,
      withdrawable_fen: withdrawable,
      ...counts,
    };
  }
  const max = maximum(input);
  if (max < limits.min_amount_fen) {
    return {
      can_withdraw: false,
      block_code: CONDITION,
      block_reason: 'below_min',
      max_withdrawable_fen: 0n,
      withdrawable_fen: withdrawable,
      ...counts,
    };
  }
  return {
    can_withdraw: true,
    block_code: null,
    block_reason: null,
    max_withdrawable_fen: max,
    withdrawable_fen: withdrawable,
    ...counts,
  };
}
