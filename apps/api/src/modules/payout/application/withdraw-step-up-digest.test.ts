import { expect, it } from 'vitest';
import { stepUpBindsWithdrawal, withdrawStepUpDigest } from './withdraw-apply.ts';

it('[AC-B1-02zzzb#2] the withdraw digest payout compares is w:<payout_account_id>:<amount_fen> (contract CT-26c)', () => {
  const id = '019a0000-0000-7000-8000-0000000000bb';
  expect(withdrawStepUpDigest(id, 10000n)).toBe(`w:${id}:10000`);
  expect(withdrawStepUpDigest(id, 20000n)).not.toBe(withdrawStepUpDigest(id, 10000n));
});

it('[AC-B1-02zzzb#6] stepUpBindsWithdrawal fails closed: only the exact digest of the snapshot row and amount binds', () => {
  const id = '019a0000-0000-7000-8000-0000000000bb';
  const snapshot = { payout_account_id: id };
  expect(stepUpBindsWithdrawal(`w:${id}:10000`, snapshot, 10000n)).toBe(true);
  expect(stepUpBindsWithdrawal(`w:${id}:10000`, snapshot, 20000n)).toBe(false);
  expect(stepUpBindsWithdrawal(`w:${id}:10000`, { payout_account_id: 'other' }, 10000n)).toBe(
    false,
  );
  expect(stepUpBindsWithdrawal(`w:${id}:10000`, {}, 10000n)).toBe(false);
  expect(stepUpBindsWithdrawal(null, snapshot, 10000n)).toBe(false);
  // An untyped caller passing nothing is no digest, never "compare nothing".
  expect(stepUpBindsWithdrawal(undefined as unknown as null, snapshot, 10000n)).toBe(false);
});
