// CT-26zm (BR-AI-13; 编排 D10-1330): the one function that gives the effective AgentConsent
// version, exported by content's index for the agent consent gate and used by GET /v1/config.
// No row → 1 (missing); an integer in [1, 2147483647] → itself (configured); any other value → 1
// (invalid). Pure: the same entry gives the same answer and is never changed.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { effectiveAiConsentVersion } from '../../../../apps/api/src/modules/content/index.ts';
import { DEFAULT_VERSION, INT32_MAX, MALFORMED, MARKER, VALID } from './fixtures.ts';

it('[AC-CT-26zm#13][BR-AI-13] 未配置（无行）→ 生效版本 1，来源 missing', () => {
  expect(effectiveAiConsentVersion(null)).toEqual({ version: DEFAULT_VERSION, source: 'missing' });
  expect(effectiveAiConsentVersion(undefined)).toEqual({
    version: DEFAULT_VERSION,
    source: 'missing',
  });
});

it.each(VALID)(
  '[AC-CT-26zm#14][BR-AI-13] 合法版本 %s（int32 ≥ 1）原样生效，来源 configured',
  (value) => {
    expect(effectiveAiConsentVersion({ value })).toEqual({ version: value, source: 'configured' });
    // A ContentReader.configValue answer (with its business version) is accepted as it is.
    const row = { value, version: 9 };
    expect(effectiveAiConsentVersion(row)).toEqual({ version: value, source: 'configured' });
  },
);

it.each(MALFORMED)(
  '[AC-CT-26zm#15][BR-AI-13] 值为%s按未配置处理：生效版本 1，来源 invalid（不是 missing），不改动入参',
  (_label, value) => {
    const entry = Object.freeze({ value: structuredClone(value) });
    const before = JSON.stringify(entry);
    expect(effectiveAiConsentVersion(entry)).toEqual({
      version: DEFAULT_VERSION,
      source: 'invalid',
    });
    expect(JSON.stringify(entry)).toBe(before);
    expect(JSON.stringify(effectiveAiConsentVersion(entry))).not.toContain(MARKER);
  },
);

it('[AC-CT-26zm#16][BR-AI-13] 上界：2147483647 原样生效；2147483648 与 2^53−1 均为 invalid → 1', () => {
  expect(effectiveAiConsentVersion({ value: INT32_MAX })).toEqual({
    version: INT32_MAX,
    source: 'configured',
  });
  expect(effectiveAiConsentVersion({ value: INT32_MAX + 1 })).toEqual({
    version: DEFAULT_VERSION,
    source: 'invalid',
  });
  expect(effectiveAiConsentVersion({ value: Number.MAX_SAFE_INTEGER })).toEqual({
    version: DEFAULT_VERSION,
    source: 'invalid',
  });
});

it('[AC-CT-26zm#17][BR-AI-13] 任意配置值：version 恰为（int32 ≥ 1 ? 原值 : 1），source 与之一致；同一入参结果相同', () => {
  // Keep the skeleton's original NotImplemented visible (fast-check would wrap it).
  effectiveAiConsentVersion({ value: 2 });
  const values: fc.Arbitrary<unknown> = fc.oneof(
    fc.integer({ min: 1, max: INT32_MAX }),
    fc.integer({ min: -INT32_MAX, max: 0 }),
    fc.maxSafeNat().map((n) => INT32_MAX + 1 + (n % (Number.MAX_SAFE_INTEGER - INT32_MAX))),
    fc.constantFrom<unknown>(1, INT32_MAX, INT32_MAX + 1, Number.MAX_SAFE_INTEGER),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.jsonValue({ maxDepth: 2 }),
  );
  fc.assert(
    fc.property(values, (value) => {
      const valid =
        typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= INT32_MAX;
      const answer = effectiveAiConsentVersion({ value });
      expect(answer).toEqual(
        valid
          ? { version: value, source: 'configured' }
          : { version: DEFAULT_VERSION, source: 'invalid' },
      );
      expect(effectiveAiConsentVersion({ value })).toEqual(answer);
    }),
    propParams(),
  );
}, 900_000);
