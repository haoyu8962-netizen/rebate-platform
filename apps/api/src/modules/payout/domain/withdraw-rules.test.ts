import { expect, it } from 'vitest';
import {
  validateWithdrawal,
  withdrawalRules,
  type WithdrawLimits,
  type WithdrawRuleInput,
} from './withdraw-rules.ts';

const LIMITS: WithdrawLimits = {
  enabled: true,
  min_amount_fen: 100n,
  amount_step_fen: 100n,
  max_amount_fen: 500000n,
  daily_count_per_user: 0,
  monthly_count_per_user: 0,
  payee_daily_count: 0,
  payee_daily_distinct_users: 0,
  method_max_amount_fen: { alipay: 0n, bank_card: 0n, wechat: 0n },
  minor_monthly_cap_fen: 0n,
  self_purchase_enabled: false,
  self_purchase_min_fen: 0n,
  allowed_member_levels: [],
};

const PENDING = {
  code: 10010,
  data: { method: 'oauth', providers: ['wechat'], fail_limit: 5 },
};

function input(): WithdrawRuleInput {
  return {
    limits: LIMITS,
    step_up_valid: true,
    risk_state: 'normal',
    prev_risk_state: null,
    blocklist_risk_msg_code: null,
    reverify: PENDING,
    realname_verified: true,
    payout_method: 'alipay',
    names_match: true,
    labor_agreement_signed: true,
    active_hold: false,
    available_fen: 10000n,
    usage: {
      daily_count: 0,
      monthly_count: 0,
      payee_daily_count: 0,
      payee_daily_other_users: 0,
      monthly_amount_fen: 0n,
    },
    minor: false,
    self_purchase_count: 0,
    self_purchase_fen: 0n,
  };
}

it('[AC-B1-02zq#11] 提交的 ③b 带着 providers、fail_limit 原样返回', () => {
  expect(validateWithdrawal(input(), 1000n, 1000n)).toEqual(PENDING);
});

it('[AC-B1-02zq#7] rules 的 ③b：block_code 10010、block_reason null，不带别的字段', () => {
  const summary = withdrawalRules(input());
  expect(summary).toMatchObject({ can_withdraw: false, block_code: 10010, block_reason: null });
  expect(summary).not.toHaveProperty('providers');
  expect(summary).not.toHaveProperty('fail_limit');
});
