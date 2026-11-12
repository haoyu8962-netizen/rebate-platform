// CT-26zm (BR-AI-13; 变更记录 20261112 §3.4 C4 第一项; 编排 D10-1330): /v1/config 的
// legal.ai_third_party.version。总是下发 legal.ai_third_party = { version }，值取生效版本：合法
// （int32 ≥ 1）原样；缺失取 1、不报告；形状不对按缺失取 1，并只报告该键（report.invalid → warn），
// 不拦截整个响应。
// Regression controls share a test with a new-behavior assertion so every case is initially red.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import {
  buildClientConfig,
  CLIENT_CONFIG_KEYS,
  REQUIRED_CONFIG_KEYS,
  type ClientConfigInput,
} from '../../../../apps/api/src/modules/content/domain/client-config.ts';
import {
  DEFAULT_VERSION,
  INT32_MAX,
  KEY,
  LEGAL_DEFAULT,
  MALFORMED,
  REQUIRED,
  VALID,
  legalOf,
  legalWith,
} from './fixtures.ts';

function assemble(extra: Record<string, unknown> = {}, userId: string | null = null) {
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const input: ClientConfigInput = {
    values: new Map(Object.entries({ ...REQUIRED, ...extra })),
    viewer: { appId: 'ct26zm_domain', userId },
    deviceId: userId === null ? '019a0000-0000-7000-8000-000000000001' : null,
    linkPatterns: { version: 'fixture', rules: [] },
    rankPlatforms: [],
    report,
  };
  return { data: buildClientConfig(input), report, input };
}

it('[AC-CT-26zm#1][BR-AI-13] /v1/config 读取 legal.ai_third_party.version，且它是可选键：缺失照常组装、下发生效版本 1、不报告', () => {
  expect(CLIENT_CONFIG_KEYS).toContain(KEY);
  expect(CLIENT_CONFIG_KEYS.filter((key) => key === KEY)).toHaveLength(1);
  expect(REQUIRED_CONFIG_KEYS as readonly string[]).not.toContain(KEY);
  const absent = assemble();
  expect(absent.data).toBeDefined();
  expect(legalOf(absent.data)).toEqual(LEGAL_DEFAULT);
  expect(legalOf(absent.data)?.['ai_third_party']).toEqual({ version: DEFAULT_VERSION });
  expect(absent.report.invalid).not.toHaveBeenCalled();
  expect(absent.report.missing).not.toHaveBeenCalled();
});

it.each(VALID)(
  '[AC-CT-26zm#2][BR-AI-13] 合法版本 %s 原样下发为 legal.ai_third_party.version，不与隐私 / 协议版本比较、不报告',
  (value) => {
    const present = assemble({ [KEY]: value });
    expect(present.data).toBeDefined();
    expect(legalOf(present.data)).toEqual(legalWith(value));
    // Exactly one field: nothing else is derived into the block.
    expect(Object.keys(legalOf(present.data)?.['ai_third_party'] as object)).toEqual(['version']);
    expect(present.report.invalid).not.toHaveBeenCalled();
    expect(present.report.missing).not.toHaveBeenCalled();
    // Deterministic: the same input assembles the same config.
    expect(buildClientConfig(present.input)).toEqual(present.data);
    // Everything outside legal is the same as without the key.
    const absent = assemble();
    expect(absent.data).toBeDefined();
    expect({ ...present.data!, legal: absent.data!.legal }).toEqual(absent.data);
  },
);

it('[AC-CT-26zm#3][BR-AI-13] 版本按 app 全局下发：游客与登录用户读到同一版本（含未配置时的 1）', () => {
  const guest = assemble({ [KEY]: 3 });
  const user = assemble({ [KEY]: 3 }, '019a0000-0000-7000-8000-0000000000aa');
  expect(legalOf(guest.data)?.['ai_third_party']).toEqual({ version: 3 });
  expect(legalOf(user.data)?.['ai_third_party']).toEqual({ version: 3 });
  expect(guest.report.invalid).not.toHaveBeenCalled();
  expect(user.report.invalid).not.toHaveBeenCalled();
  const guestDefault = assemble();
  const userDefault = assemble({}, '019a0000-0000-7000-8000-0000000000aa');
  expect(legalOf(guestDefault.data)?.['ai_third_party']).toEqual({ version: DEFAULT_VERSION });
  expect(legalOf(userDefault.data)?.['ai_third_party']).toEqual({ version: DEFAULT_VERSION });
});

it.each(MALFORMED)(
  '[AC-CT-26zm#4][BR-AI-13] 版本为%s按未配置处理：下发生效版本 1、整份配置与缺行相同，每次组装只报告该键一次（invalid，不是 missing）',
  (_label, value) => {
    const invalid = assemble({ [KEY]: value });
    const absent = assemble();
    expect(invalid.data).toBeDefined();
    expect(legalOf(invalid.data)).toEqual(LEGAL_DEFAULT);
    expect(invalid.data).toEqual(absent.data);
    expect(invalid.report.invalid.mock.calls).toEqual([[KEY]]);
    expect(invalid.report.missing).not.toHaveBeenCalled();
    expect(buildClientConfig(invalid.input)).toEqual(invalid.data);
    expect(invalid.report.invalid.mock.calls).toEqual([[KEY], [KEY]]);
    expect(absent.report.invalid).not.toHaveBeenCalled();
  },
);

it('[AC-CT-26zm#5] 必填键缺失时整份失败的口径不变，且合法的 AI 版本不会掩盖必填键的报告', () => {
  const values = new Map(Object.entries({ ...REQUIRED, [KEY]: 2 }));
  values.delete('legal.privacy.version');
  const report = { invalid: vi.fn(), missing: vi.fn() };
  const data = buildClientConfig({
    values,
    viewer: { appId: 'ct26zm_domain', userId: null },
    deviceId: null,
    linkPatterns: { version: 'fixture', rules: [] },
    rankPlatforms: [],
    report,
  });
  expect(data).toBeUndefined();
  expect(report.missing.mock.calls).toEqual([['legal.privacy.version']]);
  expect(report.invalid).not.toHaveBeenCalled();
  // New behavior in the same case: with the required key restored the version is delivered.
  const restored = assemble({ [KEY]: 2 });
  expect(legalOf(restored.data)?.['ai_third_party']).toEqual({ version: 2 });
});

/** Integers in [1, INT32_MAX] (both bounds weighted in). */
const inRange = fc.oneof(
  fc.integer({ min: 1, max: INT32_MAX }),
  fc.constantFrom(1, 2, INT32_MAX - 1, INT32_MAX),
);
/** Any JSON value that is not an integer in [1, INT32_MAX]. */
const outOfRange: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: -INT32_MAX, max: 0 }),
  fc.maxSafeNat().map((n) => INT32_MAX + 1 + (n % (Number.MAX_SAFE_INTEGER - INT32_MAX))),
  fc.constantFrom<unknown>(2147483648, Number.MAX_SAFE_INTEGER, 0, -1),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
  fc.jsonValue({ maxDepth: 2 }).filter((v) => typeof v !== 'number'),
);

function isValidVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= INT32_MAX;
}

it('[AC-CT-26zm#12][BR-AI-13] 任意配置值：下发的 version 恰为（int32 ≥ 1 ? 原值 : 1），只有不合法时报告该键一次，其余 legal 不变', () => {
  fc.assert(
    fc.property(fc.oneof(inRange, outOfRange), (value) => {
      const valid = isValidVersion(value);
      const { data, report } = assemble({ [KEY]: value });
      expect(data).toBeDefined();
      expect(legalOf(data)).toEqual(legalWith(isValidVersion(value) ? value : DEFAULT_VERSION));
      expect(report.invalid.mock.calls).toEqual(valid ? [] : [[KEY]]);
      expect(report.missing).not.toHaveBeenCalled();
    }),
    propParams(),
  );
}, 900_000);
