// B1-04zzzza (FU-SEARCH-QUERY-BLOCKWORDS, D10-860 ⑥ / D10-1064 口径 A): the search tab's prohibited
// query words. Catalog keeps its own copy of the `prohibited` group of
// specs/agent-input-keywords.yaml (catalog cannot import agent); a rule test compares the two item
// by item, so change both together. Matching follows the Agent's normalizeForKeywords: NFKC,
// lower-cased, every whitespace removed, then substring; a hit right after 「非」 does not count.

/** The optional port of searchProducts; CatalogModule wires isProhibitedQuery by default. */
export interface QueryBlockwords {
  isProhibited(query: string): boolean;
}

// F-PROD-08 禁售黑名单逐类：处方药、烟草电子烟、成人用品、二类及以上医疗器械、彩票、虚拟币、枪械刀具。
// 「刀具」按清单原文整词拦截（「厨房刀具」「刀具架」也拦）；与 yaml 的 prohibited 组逐项一致。
const PROHIBITED_QUERY_WORDS: readonly string[] = [
  '处方药',
  '烟草',
  '香烟',
  '卷烟',
  '雪茄',
  '烟丝',
  '烟油',
  '电子烟',
  '烟弹',
  '成人用品',
  '情趣用品',
  '情趣内衣',
  '二类医疗器械',
  '三类医疗器械',
  '第二类医疗器械',
  '第三类医疗器械',
  'Ⅱ类医疗器械',
  'Ⅲ类医疗器械',
  '彩票',
  '双色球',
  '大乐透',
  '虚拟币',
  '虚拟货币',
  '加密货币',
  '数字货币',
  '比特币',
  '以太坊',
  '泰达币',
  'usdt',
  '枪械',
  '枪支',
  '仿真枪',
  '猎枪',
  '弹药',
  '刀具',
  '管制刀具',
  '匕首',
  '弹簧刀',
  '军刺',
];

/** A hit right after 「非」 is a negation (「非处方药」 is a product search, not 「处方药」). */
const NEGATION = '非';

/** A fresh copy of the prohibited query words, exactly as listed in the yaml's prohibited group. */
export function prohibitedQueryWords(): string[] {
  return [...PROHIBITED_QUERY_WORDS];
}

/** NFKC, lower-cased, every whitespace removed (the Agent's normalizeForKeywords). */
export function normalizeQueryForBlockwords(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

const NORMALIZED_WORDS: readonly string[] = PROHIBITED_QUERY_WORDS.map(
  normalizeQueryForBlockwords,
).filter((word) => word.length > 0);

function containsUnnegated(text: string, word: string): boolean {
  let at = text.indexOf(word);
  while (at !== -1) {
    if (at === 0 || text[at - 1] !== NEGATION) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

/** True when the normalized query contains a prohibited word not right after 「非」. */
export function isProhibitedQuery(query: string): boolean {
  const text = normalizeQueryForBlockwords(query);
  return NORMALIZED_WORDS.some((word) => containsUnnegated(text, word));
}
