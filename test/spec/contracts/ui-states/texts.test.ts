import { expect, it } from 'vitest';
import { fundTermsFile, list, object, stateTexts, texts, yaml } from './kit.ts';

it.each(Object.entries(stateTexts))(
  '[AC-CT-09s#4] %s 的默认文案与 08 BR-TEXT-14 表 C 逐字相同',
  (key, expected) => {
    const dictionary = texts();
    expect(Object.hasOwn(dictionary, key), `texts.default.json 缺少 ${key}`).toBe(true);
    expect(dictionary[key]).toBe(expected);
  },
);

it('[AC-CT-09s#4] texts.default.json 收录的 state.* 键恰好是表 C 的七个', () => {
  const stateKeys = Object.keys(texts()).filter((key) => key.startsWith('state.'));
  expect(stateKeys.toSorted()).toEqual(Object.keys(stateTexts).toSorted());
});

type Segment = { prefixes: string[]; keys: string[] };

function segment(doc: Record<string, unknown>, name: string): Segment {
  const part = object(doc[name], `${fundTermsFile} 的 ${name}`);
  const prefixes = list(part['prefixes'], `${name}.prefixes`).map(String);
  const keys = list(part['keys'], `${name}.keys`).map(String);
  return { prefixes, keys };
}

function hits(part: Segment, key: string): boolean {
  return part.keys.includes(key) || part.prefixes.some((prefix) => key.startsWith(prefix));
}

it('[AC-CT-09s#5] state.value_missing.a11y 归资金术语键（BR-TEXT-12 细则，按 ③），不归普通', () => {
  const doc = yaml(fundTermsFile);
  const fund = segment(doc, 'fund_terms');
  const ordinary = segment(doc, 'ordinary');
  expect(hits(fund, 'state.value_missing.a11y'), '应在 fund_terms').toBe(true);
  expect(hits(ordinary, 'state.value_missing.a11y'), '不应在 ordinary').toBe(false);
});

it.each(Object.keys(stateTexts).filter((key) => key !== 'state.value_missing.a11y'))(
  '[AC-CT-09s#5] %s 归普通（BR-TEXT-12 细则），不在资金术语键里',
  (key) => {
    const doc = yaml(fundTermsFile);
    const fund = segment(doc, 'fund_terms');
    const ordinary = segment(doc, 'ordinary');
    expect(hits(ordinary, key), `${key} 应在 ordinary`).toBe(true);
    expect(hits(fund, key), `${key} 不应在 fund_terms`).toBe(false);
  },
);
