import { expect, it } from 'vitest';
import { withdrawStepUpDigest } from './withdraw-apply.ts';

it('[AC-B1-02zzzb#2] the withdraw digest payout compares is w:<payout_account_id>:<amount_fen> (contract CT-26c)', () => {
  const id = '019a0000-0000-7000-8000-0000000000bb';
  expect(withdrawStepUpDigest(id, 10000n)).toBe(`w:${id}:10000`);
  expect(withdrawStepUpDigest(id, 20000n)).not.toBe(withdrawStepUpDigest(id, 10000n));
});
