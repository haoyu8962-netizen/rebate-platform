import { expect, it } from 'vitest';
import { checkTextVariables } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  borrowedTexts,
  expectNewKeysPresent,
  expectedTexts,
  invalidKey,
  newKeys,
  placeholders,
  quoteExample,
  quoteKey,
  replaces,
  text,
  textMap,
  texts,
} from './kit.ts';

it('[AC-F1-11b#1] 两个分享页专用键在 texts.default.json 里，逐字是 08 的原句', () => {
  expectNewKeysPresent();
  for (const key of newKeys) {
    const value = text(key);
    expect(value.trim(), `${key} 不能为空`).not.toBe('');
    expect(value, `${key} 不能有首尾空白`).toBe(value.trim());
    expect(value, key).toBe(expectedTexts[key]);
  }
});

it('[AC-F1-11b#2] 新键加入后 texts 的键仍严格按字母序、不重复', () => {
  expectNewKeysPresent();
  const keys = Object.keys(texts());
  const problems: string[] = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1] ?? '';
    const b = keys[i] ?? '';
    if (a >= b) problems.push(`${b} 排在 ${a} 之后`);
  }
  expect(problems).toEqual([]);
});

it('[AC-F1-11b#3] 取价时间句恰好含一个 {time} 变量，没有别的变量与占位残留', () => {
  const value = text(quoteKey);
  expect(placeholders(value), `${quoteKey} 的变量`).toEqual(['time']);
  const rest = value.replace('{time}', '');
  expect(rest.includes('{') || rest.includes('}'), '去掉 {time} 后不能再有花括号').toBe(false);
  for (const leftover of ['HH:mm', 'hh:mm', 'MM-DD', 'TODO', 'XX', '待定']) {
    expect(value.includes(leftover), `${quoteKey} 不能残留「${leftover}」`).toBe(false);
  }
});

it('[AC-F1-11b#4] 取价时间句代入 formatQuoteTime 的两种格式，得到 BR-PRICE-11 的降级显示原句', () => {
  const value = text(quoteKey);
  expect(value.replace('{time}', '09:30')).toBe(quoteExample);
  expect(value.replace('{time}', '11-09 09:30')).toBe(
    '取价 11-09 09:30 · 价格可能已变化，以下单页为准',
  );
  // 后台改写这条文案时变量集合须与默认一致（BR-TEXT-12），{time} 是这句唯一要保留的变量。
  const defaults = textMap();
  expect(checkTextVariables(quoteKey, value, defaults)).toEqual({ ok: true });
  expect(checkTextVariables(quoteKey, '取价 · 价格可能已变化，以下单页为准', defaults)).toEqual({
    ok: false,
    reason: 'variables_mismatch',
    missing: ['time'],
    extra: [],
  });
});

it('[AC-F1-11b#5] 链接失效句不带任何变量、没有占位残留', () => {
  const value = text(invalidKey);
  expect(placeholders(value), `${invalidKey} 不带变量`).toEqual([]);
  expect(value.includes('{') || value.includes('}'), '不能有花括号').toBe(false);
  for (const leftover of ['TODO', 'XX', '待定']) {
    expect(value.includes(leftover), `${invalidKey} 不能残留「${leftover}」`).toBe(false);
  }
});

it('[AC-F1-11b#6] 两个新键是专用键：不同于暂借的 link_landing.invalid、earnings.as_of，暂借键原样保留', () => {
  expectNewKeysPresent();
  const dictionary = texts();
  for (const key of newKeys) {
    const borrowed = replaces[key] ?? '';
    expect(borrowed, `${key} 要替换的暂借键`).not.toBe('');
    expect(key, `${key} 不能就是暂借键`).not.toBe(borrowed);
    expect(key.startsWith('share_page.'), `${key} 用 share_page. 前缀`).toBe(true);
    expect(text(key), `${key} 的文案不能照搬 ${borrowed}`).not.toBe(text(borrowed));
  }
  // 暂借键仍是 App 内 LinkLanding 空态与钱包「截至」句，本单不改不删。
  for (const [key, value] of Object.entries(borrowedTexts)) {
    expect(dictionary[key], key).toBe(value);
  }
});
