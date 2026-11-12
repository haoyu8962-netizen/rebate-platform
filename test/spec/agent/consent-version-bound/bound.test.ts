// CT-26zm (BR-AI-13; 编排 D10-1330): the agent consent gate's version source
// (agent/stream/access createConsentVersionSource) gets the same upper bound as GET /v1/config:
// 2147483647. A configured value in (2^31 − 1, 2^53 − 1] is invalid: the source answers 1 and
// warns once per call (agent.consent_version_config_invalid, with config_key); 2147483647 itself
// is returned as it is, without a warn. Missing and other invalid values keep their frozen 口径
// (test/spec/agent/stream-access/version.test.ts, AC-B3-03i#11–#13).
// Regression controls share a test with a new-behavior assertion so every case is initially red.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { createConsentVersionSource } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { APP, FakeReader, INT32_MAX, KEY, expectInvalidWarn, warnLog } from './kit.ts';

it('[AC-CT-26zm#22][BR-AI-13] 上界 2147483647 原样返回、不告警；2147483648 → 1 并告警一次', async () => {
  const reader = new FakeReader().set(APP, KEY, INT32_MAX);
  const { warns, logger } = warnLog();
  const version = createConsentVersionSource({ reader, logger });
  expect(await version(APP)).toBe(INT32_MAX);
  expect(warns).toEqual([]);
  reader.set(APP, KEY, INT32_MAX + 1);
  expect(await version(APP)).toBe(1);
  expect(warns).toHaveLength(1);
  expectInvalidWarn(warns[0]);
});

it.each([
  { label: '2^31', value: 2147483648 },
  { label: '2^31 + 1', value: 2147483649 },
  { label: '2^40', value: 2 ** 40 },
  { label: '2^53 − 1', value: Number.MAX_SAFE_INTEGER },
])(
  '[AC-CT-26zm#23][BR-AI-13] 配置值 $label 超出 int32 → 1，每次调用各告警一次（带 config_key）',
  async ({ value }) => {
    const reader = new FakeReader().set(APP, KEY, value);
    const { warns, logger } = warnLog();
    const version = createConsentVersionSource({ reader, logger });
    expect(await version(APP)).toBe(1);
    expect(warns).toHaveLength(1);
    expectInvalidWarn(warns[0]);
    expect(await version(APP)).toBe(1);
    expect(warns).toHaveLength(2);
    expectInvalidWarn(warns[1]);
    expect(reader.asked.filter((asked) => asked === `${APP}|${KEY}`)).toHaveLength(2);
    // Without a logger the default still applies.
    expect(await createConsentVersionSource({ reader })(APP)).toBe(1);
  },
);

it('[AC-CT-26zm#24][BR-AI-13] 任意正安全整数：≤ 2147483647 原样返回不告警，> 2147483647 → 1 且恰告警一次', async () => {
  const values = fc.oneof(
    fc.integer({ min: 1, max: INT32_MAX }),
    fc.maxSafeNat().map((n) => INT32_MAX + 1 + (n % (Number.MAX_SAFE_INTEGER - INT32_MAX))),
    fc.constantFrom(INT32_MAX, INT32_MAX + 1, Number.MAX_SAFE_INTEGER),
  );
  await fc.assert(
    fc.asyncProperty(values, async (value) => {
      const reader = new FakeReader().set(APP, KEY, value);
      const { warns, logger } = warnLog();
      const answer = await createConsentVersionSource({ reader, logger })(APP);
      if (value <= INT32_MAX) {
        expect(answer).toBe(value);
        expect(warns).toEqual([]);
      } else {
        expect(answer).toBe(1);
        expect(warns).toHaveLength(1);
        expectInvalidWarn(warns[0]);
      }
    }),
    propParams(),
  );
}, 900_000);
