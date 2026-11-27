// B2-05v implementer unit tests of the locked re-check (BR-WDR-07 ④): ⑤ ⑥ are judged under the
// locks, ⑨ (the method's single-withdrawal cap) is not — it is judged by the first pass of the
// pass whose account the snapshot matches.
import { expect, it } from 'vitest';
import { validateLockedWithdrawal } from './withdraw-locked.ts';
import type { WithdrawRuleInput } from './withdraw-rules.ts';

function input(method: WithdrawRuleInput['payout_method'] = 'alipay'): WithdrawRuleInput {
  return {
    limits: {
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
    },
    step_up_valid: true,
    risk_state: 'normal',
    prev_risk_state: null,
    blocklist_risk_msg_code: null,
    reverify: null,
    realname_verified: true,
    payout_method: method,
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

it.each(['alipay', 'bank_card', 'wechat'] as const)(
  '[AC-B2-05v#5] 锁内不重判 ⑨：%s 的方式单笔上限低于申请额（非零）仍通过',
  (method: 'alipay' | 'bank_card' | 'wechat'): void => {
    const value = input(method);
    value.limits.method_max_amount_fen = { alipay: 500n, bank_card: 500n, wechat: 500n };
    expect(validateLockedWithdrawal(value, 1000n)).toBeNull();
    // ⑨'s other amount checks stay outside the locks too.
    value.limits.max_amount_fen = 500n;
    value.limits.min_amount_fen = 2000n;
    expect(validateLockedWithdrawal(value, 1000n)).toBeNull();
  },
);

it('[AC-B2-05v#1] 锁内 ⑤ 在 ⑥ 之前：无可用方式返回 30305', (): void => {
  const value = input(null);
  value.realname_verified = false;
  value.names_match = false;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30305, data: {} });
});

it('[AC-B2-05v#2] 锁内 ⑥ 无当前实名返回 30304（先于姓名不一致与 ⑦）', (): void => {
  const value = input();
  value.realname_verified = false;
  value.names_match = false;
  value.active_hold = true;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30304, data: {} });
});

it('[AC-B2-05v#3] 锁内 ⑥ 实名有效、姓名不一致返回 30307（先于 ⑦⑩）', (): void => {
  const value = input();
  value.names_match = false;
  value.active_hold = true;
  value.available_fen = 0n;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30307, data: {} });
});
