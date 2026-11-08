// B1-04zzzzb (FU-ADMIN-HOTWORDS-PROHIBITED-CHECK, D10-1064 / D10-1070): the prohibited-word part of
// searchConfigSaveCheck().refusals, the configuration center's one save check of these two keys.
// The word list is read from specs/agent-input-keywords.yaml (the prohibited group), so the
// expected refusals come from the spec and not from the implementation. The prohibited check runs
// only after the shape check and stays out of the two Fit functions: read.ts also calls
// searchHotWordsFit, and a stored list with a prohibited word must keep being served.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  searchConfigSaveCheck,
  searchHotWordsFit,
  searchKeywordRoutesFit,
} from '../../../../apps/api/src/modules/catalog/hot-words/index.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  BLOCK_ON,
  HOT_WORDS,
  KEYWORD_ROUTES,
  LINK_PATTERNS,
  UNION_HOST_BLOCK,
  shortcut,
  validHotWords,
  validRoutes,
} from '../hot-words/kit.ts';

const check = searchConfigSaveCheck(() => LINK_PATTERNS);
const HOT_RANK = { route: 'HotRankList', params: {} };

type Rows = ReadonlyMap<string, unknown>;

function refusalsOf(written: Rows, stored: Rows = new Map<string, unknown>()): string[] {
  return check.refusals(stored, written);
}

/** The refusals of a hot word list holding valid words and `text`. */
const ofText = (text: string): string[] =>
  refusalsOf(new Map([[HOT_WORDS, [...validHotWords(), { text }]]]));

/** The refusals of a shortcut list holding valid shortcuts and `keyword`. */
const ofKeyword = (keyword: string): string[] =>
  refusalsOf(new Map([[KEYWORD_ROUTES, [...validRoutes(), shortcut(keyword, HOT_RANK)]]]));

/** The prohibited group of specs/agent-input-keywords.yaml, as written there. */
function specProhibited(): string[] {
  const file = new URL('../../../../specs/agent-input-keywords.yaml', import.meta.url);
  const spec = parseYamlLite(readFileSync(file, 'utf8')) as { readonly prohibited?: unknown };
  const list = spec.prohibited;
  return Array.isArray(list) ? list.map((word) => String(word)) : [];
}

/** Full width form of the printable ASCII characters of `text` (U+FF01..U+FF5E). */
function fullWidth(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char;
    })
    .join('');
}

/** The spellings the matching rule folds together; each stays within the 20 character limit. */
function spellings(word: string): string[] {
  return [word, `买${word}送券`, [...word].join(' '), word.toUpperCase(), fullWidth(word)];
}

it('[AC-B1-04zzzzb#8] yaml prohibited 组的每个词，原样、在词中间、夹空白、大写、全角，在热词与直达里都被拒', () => {
  const words = specProhibited();
  expect(words.length).toBeGreaterThan(0);
  for (const word of words) {
    for (const spelling of spellings(word)) {
      expect(ofText(spelling), `text ${spelling}`).toEqual([HOT_WORDS]);
      expect(ofKeyword(spelling), `keyword ${spelling}`).toEqual([KEYWORD_ROUTES]);
    }
  }
});

it.each([
  '彩 票',
  '彩\t票',
  'ＵＳＤＴ',
  'UsDt',
  '买彩票送券',
  '厨房刀具',
  '刀具架',
  'Ⅱ类医疗器械',
  'ⅱ类医疗器械',
  'II类医疗器械',
  'ii类医疗器械',
  '非处方药彩票',
  '处方药非处方药',
])('[AC-B1-04zzzzb#9] %j 命中禁词，两个键都拒', (spelling) => {
  expect(ofText(spelling)).toEqual([HOT_WORDS]);
  expect(ofKeyword(spelling)).toEqual([KEYWORD_ROUTES]);
});

it('[AC-B1-04zzzzb#10] 「非处方药」两个键都放行，同样的写法去掉「非」即拒', () => {
  expect(ofText('处方药')).toEqual([HOT_WORDS]);
  expect(ofKeyword('处方药')).toEqual([KEYWORD_ROUTES]);
  expect(ofText('非处方药')).toEqual([]);
  expect(ofKeyword('非处方药')).toEqual([]);
  expect(ofText('非 处方药')).toEqual([]);
  expect(ofKeyword('非 处方药')).toEqual([]);
});

it('[AC-B1-04zzzzb#11] 无禁词的列表不被拒，同一列表加一个禁词即拒', () => {
  expect(ofText('彩票')).toEqual([HOT_WORDS]);
  expect(refusalsOf(new Map([[HOT_WORDS, validHotWords()]]))).toEqual([]);
  expect(ofKeyword('彩票')).toEqual([KEYWORD_ROUTES]);
  expect(refusalsOf(new Map([[KEYWORD_ROUTES, validRoutes()]]))).toEqual([]);
});

it('[AC-B1-04zzzzb#12] 禁词判定不进 Fit：保存被拒的值，searchHotWordsFit / searchKeywordRoutesFit 仍为真（读接口靠它，存量不被置空）', () => {
  expect(ofText('彩票')).toEqual([HOT_WORDS]);
  expect(ofKeyword('彩票')).toEqual([KEYWORD_ROUTES]);
  expect(searchHotWordsFit([{ text: '彩票' }])).toBe(true);
  expect(searchKeywordRoutesFit([shortcut('彩票', HOT_RANK)], BLOCK_ON)).toBe(true);
});

it('[AC-B1-04zzzzb#13] 形状不合法的值不进禁词判定（text 非字符串不抛错），只报一次该键', () => {
  expect(ofText('彩票')).toEqual([HOT_WORDS]);
  expect(refusalsOf(new Map([[HOT_WORDS, [{ text: 1 }]]]))).toEqual([HOT_WORDS]);
  expect(refusalsOf(new Map([[HOT_WORDS, [{ text: '彩票' }, { text: '' }]]]))).toEqual([HOT_WORDS]);
  expect(refusalsOf(new Map([[KEYWORD_ROUTES, [{ keyword: 1, target: HOT_RANK }]]]))).toEqual([
    KEYWORD_ROUTES,
  ]);
});

it('[AC-B1-04zzzzb#14] 联盟域开关关闭时，禁词 keyword 照样拒', () => {
  const stored = new Map<string, unknown>([[UNION_HOST_BLOCK, false]]);
  expect(refusalsOf(new Map([[KEYWORD_ROUTES, [shortcut('彩票', HOT_RANK)]]]), stored)).toEqual([
    KEYWORD_ROUTES,
  ]);
});

it('[AC-B1-04zzzzb#15] 只看本次写入的值：stored 里的禁词不让无关写入被拒，写入禁词才拒', () => {
  const stored = new Map<string, unknown>([
    [HOT_WORDS, [{ text: '彩票' }]],
    [KEYWORD_ROUTES, [shortcut('彩票', HOT_RANK)]],
  ]);
  expect(refusalsOf(new Map([[HOT_WORDS, [{ text: '彩票' }]]]), stored)).toEqual([HOT_WORDS]);
  expect(refusalsOf(new Map([[UNION_HOST_BLOCK, false]]), stored)).toEqual([]);
  expect(refusalsOf(new Map([[HOT_WORDS, validHotWords()]]), stored)).toEqual([]);
  expect(refusalsOf(new Map([[KEYWORD_ROUTES, validRoutes()]]), stored)).toEqual([]);
});
