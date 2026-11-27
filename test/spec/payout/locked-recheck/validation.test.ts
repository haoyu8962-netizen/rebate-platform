import { expect, it } from 'vitest';
import { validateLockedWithdrawal } from '../../../../apps/api/src/modules/payout/domain/withdraw-locked.ts';
import { input } from '../rules/fixtures.ts';

it('[AC-B2-05v#1] 锁内 ⑤ 无可用收款方式返回 30305，先于实名、姓名和冻结', (): void => {
  const value = input();
  value.payout_method = null;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30305, data: {} });

  value.realname_verified = false;
  value.names_match = false;
  value.active_hold = true;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30305, data: {} });
});

it('[AC-B2-05v#2] 锁内 ⑥ 无当前实名返回 30304，先于姓名不一致和冻结', (): void => {
  const value = input();
  value.realname_verified = false;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30304, data: {} });

  value.names_match = false;
  value.active_hold = true;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30304, data: {} });
});

it('[AC-B2-05v#3] 锁内 ⑥ 实名有效但姓名不一致返回 30307，先于冻结', (): void => {
  const value = input();
  value.limits.enabled = false;
  value.step_up_valid = false;
  value.risk_state = 'banned';
  value.blocklist_risk_msg_code = 'SYNTHETIC';
  value.reverify = { code: 10010, data: { method: 'realname' } };
  value.labor_agreement_signed = false;
  value.limits.min_amount_fen = 2000n;
  value.limits.self_purchase_enabled = true;
  value.limits.self_purchase_min_fen = 10000n;
  expect(validateLockedWithdrawal(value, 1000n)).toBeNull();

  value.names_match = false;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30307, data: {} });

  value.active_hold = true;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30307, data: {} });
});
