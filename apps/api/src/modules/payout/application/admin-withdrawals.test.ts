// Unit tests of the user.lookup decisions of the withdrawal reads (B2-09zg); the two reads over
// PostgreSQL and the real admin entry are the rule tests (test/spec/payout/admin-withdrawals-lookup).
import { expect, it } from 'vitest';
import {
  AdminWithdrawalFieldsError,
  getAdminWithdrawal,
  isLookupOnly,
  type AdminWithdrawalReadDeps,
} from './admin-withdrawals.ts';

const USER = '0199aaaa-0000-7000-8000-000000000001';
const WITHDRAWAL = '0199aaaa-0000-7000-8000-000000000002';

it('[AC-B2-09zg-UNIT#2] lookup-only: user.lookup without either read point, or a non-super actor without permissions; not a super, not either point', () => {
  const cases = [
    [{ isSuper: false, permissions: ['user.lookup'] }, true],
    [{ isSuper: false, permissions: ['user.lookup', 'fund.recon'] }, true],
    [{ isSuper: true, permissions: [] }, false],
    [{ isSuper: true, permissions: ['user.lookup'] }, false],
    [{ isSuper: false, permissions: ['withdraw.review'] }, false],
    [{ isSuper: false, permissions: ['fund.view'] }, false],
    [{ isSuper: false, permissions: ['user.lookup', 'withdraw.review'] }, false],
    [{ isSuper: false, permissions: ['user.lookup', 'fund.view'] }, false],
    [{ isSuper: false, permissions: ['user.lookup', 'withdraw.review', 'fund.view'] }, false],
    [{ isSuper: false }, true],
    [{ isSuper: true }, false],
  ] as const;
  for (const [actor, expected] of cases) expect(isLookupOnly(actor)).toBe(expected);
});

it('[AC-B2-09zg-UNIT#4] a user_id that is not UUID-shaped is 20001 [user_id] before any read', async () => {
  // Any touch of the handle or the ports throws something other than the expected refusal.
  const deps = new Proxy({} as AdminWithdrawalReadDeps, {
    get() {
      throw new Error('the detail read something');
    },
  });
  for (const userId of ['not-a-uuid', USER.replaceAll('-', '')]) {
    const error = await getAdminWithdrawal(deps, 'couli', WITHDRAWAL, {
      userId,
      blankInternal: true,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AdminWithdrawalFieldsError);
    expect((error as AdminWithdrawalFieldsError).fields).toEqual(['user_id']);
  }
});
