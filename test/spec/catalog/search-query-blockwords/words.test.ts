// B1-04zzzza (D10-1064 口径 A): catalog's own prohibited query words and their matching rule.
// The list is the prohibited group of specs/agent-input-keywords.yaml, item by item (catalog cannot
// import agent); the matching is the Agent's (normalizeForKeywords: NFKC, lower case, every
// whitespace removed; substring; a hit right after 「非」 does not count; yaml head note: 「刀具」
// is blocked as a whole word, so 「厨房刀具」 and 「刀具架」 are too). All values are synthetic.
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  isProhibitedQuery,
  normalizeQueryForBlockwords,
  prohibitedQueryWords,
} from '../../../../apps/api/src/modules/catalog/domain/query-blockwords.ts';
import {
  IDEO_SPACE,
  NB_SPACE,
  agentProhibits,
  normalizeForKeywords,
  specProhibited,
} from './harness.ts';

it('[AC-B1-04zzzza#1] catalog 自带的禁售查询词与 specs/agent-input-keywords.yaml 的 prohibited 组逐项相等（顺序、写法都同），每次取得的是新副本', () => {
  // The skeleton is called before the file is read: the red comes from NotImplemented.
  const words = prohibitedQueryWords();
  const file = new URL('../../../../specs/agent-input-keywords.yaml', import.meta.url);
  expect(existsSync(file)).toBe(true);
  const spec = specProhibited();
  expect(spec.length).toBeGreaterThan(0);
  expect(words).toEqual(spec);
  words.push('synthetic-extra');
  words.splice(0, 1);
  expect(prohibitedQueryWords()).toEqual(spec);
});

it.each([
  ['ＵＳＤＴ', 'usdt'],
  ['Usdt', 'usdt'],
  ['电 子 烟', '电子烟'],
  ['电子\t烟', '电子烟'],
  [`${IDEO_SPACE}电子烟\r\n`, '电子烟'],
  [`电${NB_SPACE}子烟`, '电子烟'],
  ['Ⅱ类医疗器械', 'ii类医疗器械'],
  ['合成 纸巾 ＡＢＣ', '合成纸巾abc'],
])(
  '[AC-B1-04zzzza#2] 归一化照 Agent 的 normalizeForKeywords：%j → %j（NFKC、转小写、去全部空白）',
  (text, normalized) => {
    expect(normalizeQueryForBlockwords(text)).toBe(normalized);
    expect(normalizeQueryForBlockwords(text)).toBe(normalizeForKeywords(text));
  },
);

it.each([
  '电子烟',
  'ＵＳＤＴ',
  'Usdt',
  'us dt',
  '电 子 烟',
  '电子\t烟',
  '刀具架',
  '厨房刀具',
  '正品电子烟推荐',
  'Ⅱ类医疗器械',
  'II类医疗器械',
  '非处方药和处方药',
])('[AC-B1-04zzzza#3] 命中：%j', (query) => {
  expect(isProhibitedQuery(query)).toBe(true);
  expect(agentProhibits(query)).toBe(true);
});

it.each(['非处方药', '烟灰缸', '合成纸巾', '电子产品', '处方', '刀', ''])(
  '[AC-B1-04zzzza#4] 不命中：%j（「非」后的命中不算；不含整词不算）',
  (query) => {
    expect(isProhibitedQuery(query)).toBe(false);
    expect(agentProhibits(query)).toBe(false);
  },
);
