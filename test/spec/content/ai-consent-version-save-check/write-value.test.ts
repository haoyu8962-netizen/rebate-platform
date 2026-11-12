// B1-22zb 规则测试第 2 轮（编排 D10-1349 ③；规划/08 BR-AI-13 细则「当前版本的取值」② ③，
// SPEC_REF ea7850e2f45f）：本校验自己拒绝不合法的写入值，不再只靠登记表的范围校验。
// legal.ai_third_party.version 的取值是 1..2147483647 的整数（同意记录的 version 是 int32）；
// 写入值不是这样的整数（0、负数、超过 2147483647、小数、字符串、布尔、null、数组、对象）时，
// refusals(stored, written) 返回 [该键]——不论现值是多少、有没有存储行，也不论这个值按数值
// 比较是高于还是低于现值（2147483648 高于任何现值，没有存储行时 0 也不算「降」）。
// 与 check.test.ts 的「写入值本身的范围由登记表校验」那句不同，这里按第 2 轮的裁定钉住。
import { expect, it } from 'vitest';
import { aiConsentVersionSaveCheck } from '../../../../apps/api/src/modules/content/application/ai-consent-version-save-check.ts';
import { combineConfigItemSaveChecks } from '../../../../apps/api/src/modules/content/application/config-item-admin.ts';

const KEY = 'legal.ai_third_party.version';
const MAX = 2_147_483_647;

const map = (entries: ReadonlyArray<readonly [string, unknown]> = []) =>
  new Map<string, unknown>(entries);

/** Stored states the refusal must not depend on: no row, the lowest, a middle and the top value. */
const STORED: ReadonlyArray<readonly [string, ReadonlyMap<string, unknown>]> = [
  ['没有存储行', map()],
  ['现值 1', map([[KEY, 1]])],
  ['现值 3', map([[KEY, 3]])],
  ['现值 2147483647', map([[KEY, MAX]])],
  ['存储值不合法 "v2"', map([[KEY, 'v2']])],
];

const INVALID_WRITTEN: ReadonlyArray<readonly [string, unknown]> = [
  ['0', 0],
  ['负数 -1', -1],
  ['2147483648', MAX + 1],
  ['很大的整数 1e12', 1e12],
  ['小数 1.5', 1.5],
  ['小数 3.5', 3.5],
  ['小数 2147483646.5', MAX - 0.5],
  ['数字字符串 "3"', '3'],
  ['数字字符串 "4"', '4'],
  ['普通字符串', 'v9'],
  ['空串', ''],
  ['布尔 true', true],
  ['null', null],
  ['数组 [4]', [4]],
  ['对象 {version: 4}', { version: 4 }],
];

it.each(INVALID_WRITTEN)(
  '[AC-B1-22zb#17] ③ 写入值不合法（%s）一律拒绝 [该键]：没有存储行、现值 1 / 3 / 2147483647、存储值不合法时都一样',
  (_label, value) => {
    const check = aiConsentVersionSaveCheck();
    for (const [state, stored] of STORED) {
      expect(check.refusals(stored, map([[KEY, value]])), state).toStrictEqual([KEY]);
    }
    // Merged with content's other checks the refusal is the same, the other written key untouched.
    const combined = combineConfigItemSaveChecks(aiConsentVersionSaveCheck());
    expect(
      combined.refusals(
        map([[KEY, 1]]),
        map([
          ['agent.guest_daily_quota', 10],
          [KEY, value],
        ]),
      ),
    ).toStrictEqual([KEY]);
    // A valid write of the same state passes, so the refusal above is about the value itself.
    expect(check.refusals(map([[KEY, 1]]), map([[KEY, 1]]))).toStrictEqual([]);
    expect(check.refusals(map(), map([[KEY, MAX]]))).toStrictEqual([]);
  },
);
