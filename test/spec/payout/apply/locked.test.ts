import { expect, it } from 'vitest';
import { validateLockedWithdrawal } from '../../../../apps/api/src/modules/payout/domain/withdraw-locked.ts';
import { input } from '../rules/fixtures.ts';

it('[AC-B2-05d#30] 锁内复核 ⑤⑥（实名失效按 30304）与 ⑦⑧⑩⑪⑫，不把步骤 ①–③b/⑥a/⑨/⑬ 重插到锁内链', () => {
  const value = input();
  value.limits.enabled = false;
  value.step_up_valid = false;
  value.risk_state = 'banned';
  value.blocklist_risk_msg_code = 'SYNTHETIC';
  value.labor_agreement_signed = false;
  value.limits.min_amount_fen = 2000n;
  value.limits.self_purchase_enabled = true;
  value.limits.self_purchase_min_fen = 10000n;
  expect(validateLockedWithdrawal(value, 1000n)).toBeNull();
});

it('[AC-B2-05d#31] 锁内多项失败以 ⑦冻结 → ⑧负余额 → ⑩余额不足 → ⑪次数 → ⑫月额度 返回', () => {
  const value = input();
  value.active_hold = true;
  value.available_fen = -1n;
  value.usage.daily_count = 1;
  value.minor = true;
  value.usage.monthly_amount_fen = 20000n;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({
    code: 30303,
    data: { reason: 'account_frozen' },
  });
  value.active_hold = false;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30302, data: {} });
  value.available_fen = 999n;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30301, data: {} });
  value.available_fen = 1000n;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({
    code: 30303,
    data: { reason: 'daily_count' },
  });
  value.usage.daily_count = 0;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({
    code: 30309,
    data: { remaining_fen: 0n },
  });
});

it('[AC-B2-05d#32] 锁内次数依次 daily/monthly/payee_count/payee_users，含 appealing over frozen', () => {
  const value = input();
  value.risk_state = 'appealing';
  value.prev_risk_state = 'frozen';
  value.usage = {
    daily_count: 1,
    monthly_count: 10,
    payee_daily_count: 2,
    payee_daily_other_users: 1,
    monthly_amount_fen: 0n,
  };
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({
    code: 30303,
    data: { reason: 'account_frozen' },
  });
  value.risk_state = 'normal';
  for (const [reason, field] of [
    ['daily_count', 'daily_count'],
    ['monthly_count', 'monthly_count'],
    ['payee_daily_count', 'payee_daily_count'],
    ['payee_daily_users', 'payee_daily_other_users'],
  ] as const) {
    expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30303, data: { reason } });
    value.usage[field] = 0;
  }
  expect(validateLockedWithdrawal(value, 1000n)).toBeNull();
});

it('[AC-B2-05d#33] 锁内未成年月剩余额度精确到分，等于剩余额度可取、超过一分拒绝', () => {
  const value = input();
  value.minor = true;
  value.usage.monthly_amount_fen = 19000n;
  expect(validateLockedWithdrawal(value, 1000n)).toBeNull();
  expect(validateLockedWithdrawal(value, 1001n)).toEqual({
    code: 30309,
    data: { remaining_fen: 1000n },
  });
});
