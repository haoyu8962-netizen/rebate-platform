import { expect, it } from 'vitest';
import {
  bannedWords,
  earningsTitle,
  fundTermPageTitleKeys,
  hits,
  normalizeForMatch,
  ordinaryPageTitleKeys,
  pageTitleKeys,
  segment,
  text,
  texts,
} from './kit.ts';

// AC-CT-26w#n 是 D10-745 验收点的本地分组，不新增业务 AC / BR。

it.each(pageTitleKeys)(
  '[AC-CT-26w#1] %s 在 texts.default.json 里，值是去首尾空白后非空的字符串',
  (key) => {
    expect(text(key).trim(), `${key} 去首尾空白后不能为空`).not.toBe('');
  },
);

it.each(pageTitleKeys)('[AC-CT-26w#2] %s 的默认文案不含数字（0–9 与全角数字）', (key) => {
  const value = text(key);
  expect(value, `${key} 不能含数字`).not.toMatch(/[0-9０-９]/u);
});

it.each(pageTitleKeys)('[AC-CT-26w#3] %s 的默认文案按 08 BR-TEXT-13 归一化后不含禁用词', (key) => {
  const normalized = normalizeForMatch(text(key));
  const found = bannedWords.filter((word) => normalized.includes(normalizeForMatch(word)));
  expect(found, `${key} 命中禁用词`).toEqual([]);
});

it.each(pageTitleKeys)(
  '[AC-CT-26w#4] texts.default.json 的 %s 在 fund-term-keys.yaml 里恰好归一段',
  (key) => {
    text(key);
    const fund = hits(segment('fund_terms'), key);
    const ordinary = hits(segment('ordinary'), key);
    expect([fund, ordinary].filter(Boolean).length, `${key} 必须恰好落在一段`).toBe(1);
  },
);

it.each(ordinaryPageTitleKeys)(
  '[AC-CT-26w#5] %s 是页面名、无资金术语前缀覆盖，归 ordinary，不在 fund_terms',
  (key) => {
    text(key);
    expect(hits(segment('ordinary'), key), `${key} 应在 ordinary`).toBe(true);
    expect(hits(segment('fund_terms'), key), `${key} 不应在 fund_terms`).toBe(false);
  },
);

it.each(fundTermPageTitleKeys)(
  '[AC-CT-26w#5] %s 照 08 BR-TEXT-12 已有前缀 ledger. 归 fund_terms，不在 ordinary',
  (key) => {
    text(key);
    expect(hits(segment('fund_terms'), key), `${key} 应在 fund_terms`).toBe(true);
    expect(hits(segment('ordinary'), key), `${key} 不应在 ordinary`).toBe(false);
  },
);

it('[AC-CT-26w#6] 八个页面标题键齐全，earnings.title 照旧是「收益看板」', () => {
  const dictionary = texts();
  const missing = pageTitleKeys.filter((key) => !Object.hasOwn(dictionary, key));
  expect(missing, 'texts.default.json 缺少页面标题键').toEqual([]);
  expect(dictionary[earningsTitle.key]).toBe(earningsTitle.value);
});
