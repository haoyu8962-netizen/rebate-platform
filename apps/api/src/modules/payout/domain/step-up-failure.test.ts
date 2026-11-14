import { expect, it } from 'vitest';
import { STEP_UP_FAILURE as IDENTITY_STEP_UP_FAILURE } from '../../identity/index.ts';
import { STEP_UP_FAILURE } from './step-up-failure.ts';

it("[AC-B1-02zzzb#6] payout's STEP_UP_FAILURE is identity's, field for field (10003, HTTP 403, stage ⑫ text)", () => {
  expect(STEP_UP_FAILURE).toStrictEqual(IDENTITY_STEP_UP_FAILURE);
  expect(JSON.stringify(STEP_UP_FAILURE)).toBe(JSON.stringify(IDENTITY_STEP_UP_FAILURE));
  expect(Object.isFrozen(STEP_UP_FAILURE)).toBe(true);
});
