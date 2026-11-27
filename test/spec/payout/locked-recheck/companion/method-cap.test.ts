import { expect, it } from 'vitest';
import { validateLockedWithdrawal } from '../../../../../apps/api/src/modules/payout/domain/withdraw-locked.ts';
import { input } from '../../rules/fixtures.ts';

it('[AC-B2-05va#1] 锁内复核跳过支付宝单笔上限，仍检查可用余额', (): void => {
  const value = input();
  value.payout_method = 'alipay';
  value.limits.method_max_amount_fen = { ...value.limits.method_max_amount_fen, alipay: 500n };
  expect(validateLockedWithdrawal(value, 1000n)).toBeNull();

  value.available_fen = 900n;
  expect(validateLockedWithdrawal(value, 1000n)).toEqual({ code: 30301, data: {} });
});
