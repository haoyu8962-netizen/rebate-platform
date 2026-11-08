// Unit test of the permission points chosen per request (B2-09zg); the guard's own 10403 over the
// real admin entry is the rule tests (test/spec/payout/admin-withdrawals-lookup).
import { expect, it } from 'vitest';
import { detailPermission, listPermission } from './withdrawals.controller.ts';

const USER = '0199aaaa-0000-7000-8000-000000000001';
const TWO = ['withdraw.review', 'fund.view'];
const THREE = [...TWO, 'user.lookup'];

it('[AC-B2-09zg-UNIT#3] the list opens user.lookup only with user_id and without risk_flag; the detail only with user_id', () => {
  expect(listPermission({})).toEqual(TWO);
  expect(listPermission({ risk_flag: 'first_withdrawal' })).toEqual(TWO);
  expect(listPermission({ user_id: USER, risk_flag: 'first_withdrawal' })).toEqual(TWO);
  expect(listPermission({ user_id: USER })).toEqual(THREE);
  expect(detailPermission(undefined)).toEqual(TWO);
  expect(detailPermission(USER)).toEqual(THREE);
});
