// CT-26zm: constants shared by the unit and integration rule tests (no database imports here).
// 口径（编排 D10-1330）：未配置时生效版本为 1，GET /v1/config 总是下发 legal.ai_third_party { version }，
// 值取生效版本；配置了但不合法（非整数、小于 1、大于 2147483647）按未配置处理、取 1。
import { createRequire } from 'node:module';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

/** The key the agent consent gate already reads (agent/stream/access createConsentVersionSource). */
export const KEY = 'legal.ai_third_party.version';
export const H5 = 'https://h5.example.test/';
export type Config = Schema<'Config'>;

/** int32 upper bound: the largest version that is delivered as configured. */
export const INT32_MAX = 2147483647;
/** The effective version when the key is missing or invalid. */
export const DEFAULT_VERSION = 1;

/** The required keys of GET /v1/config, with values distinct from any ai_third_party fixture. */
export const REQUIRED: Readonly<Record<string, unknown>> = Object.freeze({
  h5_base_url: H5,
  'h5_release.stable': 'stable',
  kf: { url: 'https://kf.example.test/' },
  'legal.privacy.version': 7,
  'legal.privacy.min_version': 3,
  'legal.agreement.version': 5,
});

/** The privacy / agreement part of legal every fixture app gets (unchanged by this task). */
export const LEGAL_WITHOUT_AI: Readonly<Record<string, unknown>> = Object.freeze({
  privacy: { version: 7, min_version: 3 },
  agreement: { version: 5 },
});

/** legal of an app whose effective AI consent version is `version`. */
export function legalWith(version: number): Record<string, unknown> {
  return { ...LEGAL_WITHOUT_AI, ai_third_party: { version } };
}

/** legal of an app without the key (or with an invalid value): the effective version 1. */
export const LEGAL_DEFAULT: Readonly<Record<string, unknown>> = Object.freeze(
  legalWith(DEFAULT_VERSION),
);

/** Valid values: int32 >= 1 (contract ConfigLegal.ai_third_party.version). 1 equals the default. */
export const VALID: readonly number[] = [1, 2, 6, INT32_MAX];

/** A marker that must never reach a log line (only the key name is logged). */
export const MARKER = 'ai_consent_fixture_value';

/** Wrong shapes: each must be treated as absent (version 1) and reported (warn) once per read. */
export const MALFORMED: readonly (readonly [string, unknown])[] = [
  ['零', 0],
  ['负数', -1],
  ['小数', 1.5],
  ['数字字符串', '2'],
  ['null', null],
  ['布尔 true', true],
  ['布尔 false', false],
  ['超出 int32（2^31）', 2147483648],
  ['超出 int32 的最大安全整数（2^53−1）', Number.MAX_SAFE_INTEGER],
  ['对象', { version: 2, marker: MARKER }],
  ['数组', [2]],
];

/** legal as plain data: the generated type does not know ai_third_party before the contract. */
export function legalOf(config: Config | undefined): Record<string, unknown> | undefined {
  return config === undefined ? undefined : (config.legal as Record<string, unknown>);
}
