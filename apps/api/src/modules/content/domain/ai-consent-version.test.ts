import { expect, it } from 'vitest';
import { effectiveAiConsentVersion } from './ai-consent-version.ts';

it('[AC-CT-26zm] no row gives 1 from missing', () => {
  expect(effectiveAiConsentVersion(null)).toEqual({ version: 1, source: 'missing' });
  expect(effectiveAiConsentVersion(undefined)).toEqual({ version: 1, source: 'missing' });
});

it('[AC-CT-26zm] an integer in [1, 2147483647] is configured as it is', () => {
  for (const value of [1, 2, 2_147_483_647]) {
    expect(effectiveAiConsentVersion({ value })).toEqual({ version: value, source: 'configured' });
  }
});

it('[AC-CT-26zm] any other value gives 1 from invalid', () => {
  for (const value of [
    0,
    -1,
    1.5,
    2_147_483_648,
    Number.MAX_SAFE_INTEGER,
    '2',
    null,
    true,
    [2],
    {},
  ]) {
    expect(effectiveAiConsentVersion({ value })).toEqual({ version: 1, source: 'invalid' });
  }
});
