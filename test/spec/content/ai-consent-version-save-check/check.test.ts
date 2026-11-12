// B1-22zb 规则测试（规划/08 BR-AI-13 细则「当前版本的取值」② ③，D10-1329 (a)，SPEC_REF ea7850e2f45f）：
// legal.ai_third_party.version 只增不减。aiConsentVersionSaveCheck() 是 content 的一项
// ConfigItemSaveCheck（照 B2-03x labor-agreement-save-check）：keys 只有这一个键；
// refusals(stored, written) 在写入该键且新值低于现值时返回 [该键]，等于或高于现值放行。
// 现值取存储行；缺行、或存储值不是 1..2147483647 的整数时按 1（② 配置了但不合法按未配置，
// 生效版本取 1）。写入值本身的范围由登记表校验（configValueFits），不在本校验里断言。
// 三条写入路（单值改、批量、回滚）真的经过本校验：save.int.test.ts。
import { expect, it } from 'vitest';
import { aiConsentVersionSaveCheck } from '../../../../apps/api/src/modules/content/application/ai-consent-version-save-check.ts';
import { combineConfigItemSaveChecks } from '../../../../apps/api/src/modules/content/application/config-item-admin.ts';

const KEY = 'legal.ai_third_party.version';
const MAX = 2_147_483_647;

const map = (entries: ReadonlyArray<readonly [string, unknown]> = []) =>
  new Map<string, unknown>(entries);
const stored = (value: unknown) => map([[KEY, value]]);
const write = (value: unknown) => map([[KEY, value]]);

it('[AC-B1-22zb#1] 只读、只校验 legal.ai_third_party.version 一个键', () => {
  expect([...aiConsentVersionSaveCheck().keys]).toStrictEqual([KEY]);
});

it('[AC-B1-22zb#2] ③ 现值 3：写 2、写 1 拒绝 [该键]；写 3、写 4、写 2147483647 放行', () => {
  const check = aiConsentVersionSaveCheck();
  expect(check.refusals(stored(3), write(2))).toStrictEqual([KEY]);
  expect(check.refusals(stored(3), write(1))).toStrictEqual([KEY]);
  expect(check.refusals(stored(3), write(3))).toStrictEqual([]);
  expect(check.refusals(stored(3), write(4))).toStrictEqual([]);
  expect(check.refusals(stored(3), write(MAX))).toStrictEqual([]);
});

it('[AC-B1-22zb#3] ③ 边界逐一比较：现值 s 时写 w，w < s 拒绝、w ≥ s 放行（含 1 与 2147483647 两端）', () => {
  const check = aiConsentVersionSaveCheck();
  const samples = [1, 2, 3, 7, 100, 65_535, MAX - 1, MAX];
  for (const s of samples) {
    for (const w of samples) {
      expect(check.refusals(stored(s), write(w)), `现值 ${s} 写 ${w}`).toStrictEqual(
        w < s ? [KEY] : [],
      );
    }
    if (s > 1) {
      expect(check.refusals(stored(s), write(s - 1)), `现值 ${s} 写 ${s - 1}`).toStrictEqual([KEY]);
    }
    if (s < MAX) {
      expect(check.refusals(stored(s), write(s + 1)), `现值 ${s} 写 ${s + 1}`).toStrictEqual([]);
    }
  }
});

it('[AC-B1-22zb#4] ①② 没有存储行时现值按 1：写 1 放行、写更高放行；有行 5 时写 1 拒绝', () => {
  const check = aiConsentVersionSaveCheck();
  expect(check.refusals(map(), write(1))).toStrictEqual([]);
  expect(check.refusals(map(), write(2))).toStrictEqual([]);
  expect(check.refusals(map(), write(MAX))).toStrictEqual([]);
  expect(check.refusals(stored(5), write(1))).toStrictEqual([KEY]);
});

// ② 配置了但值不合法（不是整数、小于 1、大于 2147483647）按未配置，生效版本 1：这时写 1 放行。
// '3' 不当成 3、2147483648 与 1.5 不拿来直接比较。
const INVALID_STORED: ReadonlyArray<readonly [string, unknown]> = [
  ['0', 0],
  ['负数', -4],
  ['小数', 1.5],
  ['小数 3.5', 3.5],
  ['超过 int32', MAX + 1],
  ['很大的整数', 1e12],
  ['数字字符串', '3'],
  ['普通字符串', 'v2'],
  ['布尔', true],
  ['null', null],
  ['数组', [4]],
  ['对象', { version: 4 }],
];

it.each(INVALID_STORED)(
  '[AC-B1-22zb#5] ② 存储值不合法（%s）按 1：写 1、写 2 放行；同一校验在现值 2 时写 1 拒绝',
  (_label, value) => {
    const check = aiConsentVersionSaveCheck();
    expect(check.refusals(stored(value), write(1))).toStrictEqual([]);
    expect(check.refusals(stored(value), write(2))).toStrictEqual([]);
    expect(check.refusals(stored(2), write(1))).toStrictEqual([KEY]);
  },
);

it('[AC-B1-22zb#6] 写入不含该键时不拒绝（不改其他键的保存行为）；现值 9 时只写别的键仍放行', () => {
  const check = aiConsentVersionSaveCheck();
  expect(check.refusals(stored(9), map([['agent.member_daily_quota', 1]]))).toStrictEqual([]);
  expect(check.refusals(stored(9), map([['legal.labor_agreement.version', 1]]))).toStrictEqual([]);
  expect(check.refusals(stored(9), write(8))).toStrictEqual([KEY]);
});

it('[AC-B1-22zb#7] 与其他保存校验合并后照样生效：批量里降该键只把该键列入拒绝，其他键不受牵连', () => {
  const check = combineConfigItemSaveChecks(aiConsentVersionSaveCheck());
  expect(check.keys).toContain(KEY);
  const storedRows = map([
    [KEY, 4],
    ['agent.member_daily_quota', 50],
  ]);
  expect(
    check.refusals(
      storedRows,
      map([
        [KEY, 3],
        ['agent.member_daily_quota', 10],
      ]),
    ),
  ).toStrictEqual([KEY]);
  expect(
    check.refusals(
      storedRows,
      map([
        [KEY, 4],
        ['agent.member_daily_quota', 10],
      ]),
    ),
  ).toStrictEqual([]);
});

it('[AC-B1-22zb#8] 校验不改调用方传入的 Map', () => {
  const check = aiConsentVersionSaveCheck();
  const s = stored(6);
  const w = write(5);
  expect(check.refusals(s, w)).toStrictEqual([KEY]);
  expect([...s.entries()]).toStrictEqual([[KEY, 6]]);
  expect([...w.entries()]).toStrictEqual([[KEY, 5]]);
});
