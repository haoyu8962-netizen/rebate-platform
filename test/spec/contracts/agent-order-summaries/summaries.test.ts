import { expect, it } from 'vitest';
import { findBannedWords } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import {
  bannedWords,
  displayStatuses,
  enumValues,
  expected,
  fundTermKeys,
  newKeys,
  previousPriceCompareAllowKeys,
  previousSummaries,
  priceCompareKey,
  reasonCodes,
  reasonKey,
  statusKey,
  text,
  texts,
} from './kit.ts';

// CT-24zy：texts.default.json 补齐 Agent 订单模板 T5 的 summary 键（BR-AI-07、BR-TEXT-22、BR-TEXT-05、BR-TEXT-02）。
// order_reason.PRICE_COMPARE.summary 已由编排 D10-941 定（选 a）：照 BR-TEXT-22 :1677 拼法取「比价订单，详情见卡片。」，
// 并加进 specs/banned-words.yaml「比价」条目的 allow_keys（BR-TEXT-13 :810），禁用词检查对它照常执行。

const SUMMARY = /^(order_reason|order_status)\.([A-Z_]+)\.summary$/;

it('[AC-CT-24zy#1] 24 个新 summary 键全部存在，且 summary 键恰好覆盖契约的 16 个 order_reason 与 11 个 display_status', () => {
  // 期望表的码表与 SPEC_REF 时点的契约枚举一致（防止本表与契约漂移）。
  expect(enumValues('order_reason')).toEqual([...reasonCodes]);
  expect(enumValues('display_status')).toEqual([...displayStatuses]);
  expect(newKeys).toHaveLength(24);

  const dictionary = texts();
  const missing = newKeys.filter((key) => typeof dictionary[key] !== 'string');
  expect(missing, '缺少的 summary 键').toEqual([]);

  const summaryKeys = Object.keys(dictionary).filter((key) => SUMMARY.test(key));
  expect(summaryKeys.filter((key) => key.startsWith('order_reason.')).toSorted()).toEqual(
    reasonCodes.map(reasonKey).toSorted(),
  );
  expect(summaryKeys.filter((key) => key.startsWith('order_status.')).toSorted()).toEqual(
    displayStatuses.map(statusKey).toSorted(),
  );
});

it.each(Object.entries(expected).map(([key, [value, source]]) => [key, value, source]))(
  '[AC-CT-24zy#2] %s 逐字等于「%s」（%s）',
  (key, value) => {
    expect(text(key)).toBe(value);
  },
);

it('[AC-CT-24zy#3] 已有三条 order_status summary 一字不改，新增键后 11 个 display_status 都有 summary', () => {
  for (const [key, value] of Object.entries(previousSummaries)) {
    expect(text(key), key).toBe(value);
  }
  const dictionary = texts();
  const missing = displayStatuses
    .map(statusKey)
    .filter((key) => typeof dictionary[key] !== 'string');
  expect(missing, '缺少的 order_status summary').toEqual([]);
});

it.each(newKeys.map((key) => [key]))(
  '[AC-CT-24zy#4] %s 不含变量、金额与日期原值，不含 BR-TEXT-13 禁用词，归资金术语键',
  (key) => {
    const value = text(key);
    expect(value.trim().length, `${key} 不能为空`).toBeGreaterThan(0);
    // 金额、日期只在卡片显示（BR-AI-06 / BR-AI-07）：不带占位变量、货币符号与数字。
    expect(value, `${key} 不能带变量`).not.toMatch(/[{}]/);
    expect(value, `${key} 不能带金额`).not.toMatch(/[¥￥]/);
    expect(value, `${key} 不能带数字（金额 / 日期原值）`).not.toMatch(/[0-9０-９]/);

    const input = { fragments: [{ key, text: value }] };
    const hits = findBannedWords(input, bannedWords(), 'user_visible');
    expect(hits, `${key} 命中禁用词`).toEqual([]);

    // order_status. / order_reason. 整组归资金术语（BR-TEXT-12 细则），新键不能被 ordinary 覆盖。
    const segments = fundTermKeys();
    const covers = (segment: { keys: readonly string[]; prefixes: readonly string[] }): boolean =>
      segment.keys.includes(key) || segment.prefixes.some((prefix) => key.startsWith(prefix));
    expect(covers(segments.fund_terms), `${key} 应归 fund_terms`).toBe(true);
    expect(covers(segments.ordinary), `${key} 不应归 ordinary`).toBe(false);
  },
);

it('[AC-CT-24zy#5] CANCELLED 与 REFUND 的 summary 同值（D10-882 ②）', () => {
  const refund = text(reasonKey('REFUND'));
  expect(text(reasonKey('CANCELLED'))).toBe(refund);
  expect(refund).toBe('订单已退款或取消，详情见卡片。');
});

it('[AC-CT-24zy#6] banned-words.yaml「比价」条目恰好一条，allow_keys 含 order_reason.PRICE_COMPARE.summary，原有 7 个键仍在（D10-941）', () => {
  const entries = bannedWords().filter((word) => word.word === '比价');
  expect(entries, '「比价」条目数').toHaveLength(1);
  const allowKeys = entries[0]?.allow_keys ?? [];
  expect(allowKeys, `「比价」allow_keys 缺少 ${priceCompareKey}`).toContain(priceCompareKey);
  const lost = previousPriceCompareAllowKeys.filter((key) => !allowKeys.includes(key));
  expect(lost, '「比价」allow_keys 删掉的原有键').toEqual([]);
});
