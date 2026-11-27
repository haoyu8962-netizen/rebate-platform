// B2-05d / BR-WDR-07 ④: inside the locks (users row → balance row → payee advisory lock) only
// steps ⑤ ⑥ ⑦ ⑧ ⑩ ⑪ ⑫ of BR-WDR-03 are judged again, in that order, over freshly read input; the
// steps already passed outside the locks (① – ④, ⑥a, ⑨, ⑬) are not repeated here.
// B2-05v (D10-3590 / D10-3594): ⑤ and ⑥ re-read the payee account and the real name under the
// locks. ④ is not a step of its own here: ⑥ compares the payee name with the current real name,
// so without a current real name it cannot pass and answers 30304; a mismatch is 30307.
import { subFen } from '@couli/money';
import type { WithdrawBlock, WithdrawRuleInput } from './withdraw-rules.ts';

const CONDITION = 30303;

function condition(reason: string): WithdrawBlock {
  return { code: CONDITION, data: { reason } };
}

function frozenEffect(input: WithdrawRuleInput): boolean {
  return (
    input.risk_state === 'frozen' ||
    (input.risk_state === 'appealing' && input.prev_risk_state === 'frozen')
  );
}

function countExceeded(cap: number, used: number): boolean {
  return cap > 0 && used >= cap;
}

/** BR-WDR-07 ④: only BR-WDR-03 ⑤⑥⑦⑧⑩⑪⑫, in that order, using fresh locked reads. */
export function validateLockedWithdrawal(
  input: WithdrawRuleInput,
  amountFen: bigint,
): WithdrawBlock | null {
  const { limits, usage } = input;
  // ⑤ payout account: none usable under the locks (unbound, or its method closed since)
  if (input.payout_method === null) return { code: 30305, data: {} };
  // ⑥ payee name = real name: no current real name to compare with → 30304, a mismatch → 30307
  if (!input.realname_verified) return { code: 30304, data: {} };
  if (!input.names_match) return { code: 30307, data: {} };
  // ⑦ frozen: risk state or an effective withdraw hold
  if (frozenEffect(input) || input.active_hold) return condition('account_frozen');
  // ⑧ negative balance
  if (input.available_fen < 0n) return { code: 30302, data: {} };
  // ⑩ balance
  if (input.available_fen < amountFen) return { code: 30301, data: {} };
  // ⑪ counts
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
  // ⑫ minor monthly cap (BR-WDR-06)
  if (input.minor) {
    const left = subFen(limits.minor_monthly_cap_fen, usage.monthly_amount_fen);
    const remaining = left < 0n ? 0n : left;
    if (limits.minor_monthly_cap_fen === 0n || amountFen > remaining) {
      return { code: 30309, data: { remaining_fen: remaining } };
    }
  }
  return null;
}
