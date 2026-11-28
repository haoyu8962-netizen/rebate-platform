import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { findBannedWords } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import type { BannedWord } from '../../../../apps/api/src/modules/content/domain/text-guard/index.ts';
import { FUND_TERM_KEYS } from '../../../../apps/api/src/modules/content/specs/fund-term-keys.gen.ts';
import {
  loadFundTermKeys,
  segmentsOfKey,
  type FundTermKeys,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

const dictionaryFile = new URL('../../../../contracts/texts.default.json', import.meta.url);
const bannedWordsFile = new URL('../../../../specs/banned-words.yaml', import.meta.url);
const authTexts = [
  ['auth.confirming', '正在确认授权结果'],
  ['auth.taobao.completed_tap_again', '淘宝授权已完成，请再点一次购买'],
] as const;

it('[AC-CT-17l#2] 两个授权键的定稿文案与禁用词', () => {
  // 漏键、改字、加入占位符或命中禁用词均会失败，扫描时不套用字段白名单。
  const { texts } = JSON.parse(readFileSync(dictionaryFile, 'utf8')) as {
    texts: Record<string, string | undefined>;
  };
  const wordList = readFileSync(bannedWordsFile, 'utf8');
  const { words } = parseYamlLite(wordList) as { words: BannedWord[] };
  for (const [key, expected] of authTexts) {
    const value = texts[key];
    expect(value, key).toBe(expected);
    const input = { fragments: [{ text: value ?? '' }] };
    expect(findBannedWords(input, words, 'user_visible'), key).toEqual([]);
    expect(findBannedWords(input, words, 'admin_report'), key).toEqual([]);
  }
});

it('[AC-CT-17l#3] 两个授权键逐键归 ordinary，content 生成物与源一致', () => {
  // 漏键、重复、用整组前缀替代单键、双重分类、加入例外表或漏重新生成均会失败。
  const spec = loadFundTermKeys() as FundTermKeys;
  const exemptions = spec.exempt.map(({ key }) => key);
  for (const [key] of authTexts) {
    const entries = spec.ordinary.keys.filter((entry) => entry === key);
    const coveredByPrefix = spec.ordinary.prefixes.some((prefix) => key.startsWith(prefix));
    expect(entries, key).toHaveLength(1);
    expect(coveredByPrefix, key).toBe(false);
    expect(segmentsOfKey(spec, key), key).toEqual(['ordinary']);
    expect(exemptions, key).not.toContain(key);
  }
  expect(FUND_TERM_KEYS).toEqual(spec);
});
