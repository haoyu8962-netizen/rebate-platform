// B3-05n · BR-AI-14 细则「无模型降级」⑥: the keyword search's conditions taken by code rules from
// the redacted free text (MessageText.free): price (BR-AI-08 phrase table), named platforms, sort
// (BR-AI-09's four phrases) and 「不要 X」; what is left after removing those words, fillers
// (帮我找、有没有、想买、推荐、哪里有卖 …) and pointer / question words (这个、哪个、它、多少钱、
// 怎么样 …), trimmed, cut to 30 code points, is q. No spec, no follow-up question, no relaxation.
// Amounts are integer fen through @couli/money only.
import {
  addFen,
  fenToJsonNumber,
  mulDivCeil,
  mulDivFloor,
  subFen,
  yuanStrToFen,
} from '@couli/money';
import { sortOf, withoutGreetings } from './classify.ts';

export type DegradedSort = 'relevance' | 'rebate_desc' | 'final_price_asc' | 'sales_desc';

export interface DegradedSearchTerms {
  /** Empty when nothing is left: no search. */
  readonly q: string;
  /** Platforms named in the message (enum values), in first-named order; empty: all enabled. */
  readonly named: readonly string[];
  readonly sort: DegradedSort;
  readonly priceMinFen?: number;
  readonly priceMaxFen?: number;
  readonly exclude: readonly string[];
}

/** BR-AI-14 细则 ⑥: q is cut to this many code points after cleaning. */
export function maxKeywordChars(): number {
  return 30;
}

/** search_products' own bounds (tools/search/schema.ts): exclude_keywords count and length. */
const MAX_EXCLUDES = 5;
const MAX_EXCLUDE_CHARS = 20;
/** BR-AI-08: 0 < value ≤ 10,000,000 fen. */
const MAX_PRICE_FEN = 10_000_000n;

// ------------------------------------------------------------------------------------------------
// Price (BR-AI-08 说法表). A number is a price only when 元 / 块 follows it, or no other measure
// word does: 「超过 15 天」「不到 3 单」 are not prices.

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const UNIT = String.raw`(元|块钱|块|rmb)?`;

type Bound = (fen: bigint) => { readonly min?: bigint; readonly max?: bigint };

interface PricePattern {
  readonly pattern: RegExp;
  /** True when the pattern itself ends with a condition word (以内、左右 …). */
  readonly closed: boolean;
  readonly bound: (values: readonly bigint[]) => { readonly min?: bigint; readonly max?: bigint };
}

function single(bound: Bound): PricePattern['bound'] {
  return (values) => bound(values[0]!);
}

const PRICE_PATTERNS: readonly PricePattern[] = [
  {
    // N 到 M / N-M / N 至 M 之间
    pattern: new RegExp(
      String.raw`(?<![\d.])${NUM}\s*(?:元|块钱|块|rmb)?\s*(?:到|至|-|~|～|—|－)\s*${NUM}\s*${UNIT}(\s*之间)?`,
      'giu',
    ),
    closed: false,
    bound: (values) => ({ min: values[0]!, max: values[1]! }),
  },
  {
    // N 左右: [floor(N×90), ceil(N×110)] in fen
    pattern: new RegExp(String.raw`(?<![\d.])${NUM}\s*${UNIT}\s*左右`, 'giu'),
    closed: true,
    bound: single((fen) => ({
      min: mulDivFloor(fen, 9_000n, 10_000n),
      max: addFen(fen, mulDivCeil(fen, 1_000n, 10_000n)),
    })),
  },
  {
    pattern: new RegExp(String.raw`(?<![\d.])${NUM}\s*${UNIT}\s*(?:以内|以下|之内)`, 'giu'),
    closed: true,
    bound: single((fen) => ({ max: fen })),
  },
  {
    pattern: new RegExp(String.raw`(?<![\d.])${NUM}\s*${UNIT}\s*以上`, 'giu'),
    closed: true,
    bound: single((fen) => ({ min: fen })),
  },
  {
    pattern: new RegExp(String.raw`(?:不超过|最多)\s*${NUM}(?![\d.])\s*${UNIT}`, 'giu'),
    closed: false,
    bound: single((fen) => ({ max: fen })),
  },
  {
    pattern: new RegExp(String.raw`(?:低于|少于|不到)\s*${NUM}(?![\d.])\s*${UNIT}`, 'giu'),
    closed: false,
    bound: single((fen) => ({ max: subFen(fen, 1n) })),
  },
  {
    pattern: new RegExp(String.raw`至少\s*${NUM}(?![\d.])\s*${UNIT}`, 'giu'),
    closed: false,
    bound: single((fen) => ({ min: fen })),
  },
  {
    pattern: new RegExp(String.raw`(?:高于|超过)\s*${NUM}(?![\d.])\s*${UNIT}`, 'giu'),
    closed: false,
    bound: single((fen) => ({ min: addFen(fen, 1n) })),
  },
];

/** Without a currency unit, the next word must not be another measure (天、单、ml …). */
function measureFollows(text: string, end: number): boolean {
  const next = text.slice(end).replace(/^\s+/u, '').codePointAt(0);
  if (next === undefined) return false;
  const char = String.fromCodePoint(next);
  return char !== '的' && /[\p{L}\d]/u.test(char);
}

function fenOf(yuan: string): bigint | null {
  try {
    return yuanStrToFen(yuan);
  } catch {
    return null;
  }
}

function validFen(value: bigint | undefined): value is bigint {
  return value !== undefined && value > 0n && value <= MAX_PRICE_FEN;
}

interface PriceResult {
  readonly text: string;
  readonly min?: number;
  readonly max?: number;
}

function takePrice(source: string): PriceResult {
  let text = source;
  let min: bigint | undefined;
  let max: bigint | undefined;
  for (const { pattern, closed, bound } of PRICE_PATTERNS) {
    text = text.replace(pattern, (...parts: unknown[]) => {
      // (match, ...groups, offset, whole): no named groups in these patterns.
      const match = parts[0] as string;
      const offset = parts[parts.length - 2] as number;
      const whole = parts[parts.length - 1] as string;
      const groups = parts.slice(1, -2) as (string | undefined)[];
      const numbers = groups.filter((g): g is string => g !== undefined && /^\d/u.test(g));
      const unit = groups.at(numbers.length === 2 ? 2 : 1);
      const tail = groups.at(3);
      if (!closed && unit === undefined && tail === undefined) {
        if (measureFollows(whole, offset + match.length)) return match;
      }
      const values = numbers.map(fenOf);
      if (values.length === 0 || values.some((v) => v === null)) return match;
      let found: { readonly min?: bigint; readonly max?: bigint };
      try {
        found = bound(values as bigint[]);
      } catch {
        return match;
      }
      min ??= found.min;
      max ??= found.max;
      return ' ';
    });
  }
  const minOk = validFen(min) ? min : undefined;
  const maxOk = validFen(max) ? max : undefined;
  // BR-AI-08: min > max is not a usable condition; the no-model path never asks back.
  if (minOk !== undefined && maxOk !== undefined && minOk > maxOk) return { text };
  return {
    text,
    ...(minOk === undefined ? {} : { min: fenToJsonNumber(minOk) }),
    ...(maxOk === undefined ? {} : { max: fenToJsonNumber(maxOk) }),
  };
}

// ------------------------------------------------------------------------------------------------
// Platforms, sort, 「不要 X」, fillers.

const PLATFORM_WORDS: readonly (readonly [RegExp, string])[] = [
  [/淘宝|天猫/giu, 'taobao'],
  [/京东/giu, 'jd'],
  [/拼多多|pdd/giu, 'pdd'],
];
const PLATFORM_AROUND = /在?(淘宝|天猫|京东|拼多多|pdd)(上面|上|里面|里)?(的)?/giu;

const SORT_WORDS = /返利最高|返得最多|佣金最高|最便宜|价格最低|销量最高|卖得最多|最划算/gu;

const EXCLUDE = /(?:不要|不想要|别要|不含)\s*([^\s\p{P}\p{S}]+)/gu;

/** Fillers and pointer / question words, longest first. */
const FILLERS = new RegExp(
  [
    '帮我找找',
    '帮我找一下',
    '帮我找',
    '帮我搜一下',
    '帮我搜',
    '帮我看看',
    '帮我推荐',
    '帮忙找',
    '给我找',
    '给我推荐',
    '帮我',
    '帮忙',
    '给我',
    '我想买',
    '我要买',
    '想买',
    '有没有',
    '有木有',
    '求推荐',
    '推荐一下',
    '推荐',
    '哪里能买到',
    '哪里能买',
    '哪里可以买',
    '哪里有卖',
    '哪儿有卖',
    '哪里买',
    '在哪买',
    '找一下',
    '搜一下',
    '这个',
    '那个',
    '哪个',
    '哪一个',
    '这款',
    '那款',
    '哪款',
    '多少钱',
    '怎么样',
    '好不好',
  ].join('|'),
  'gu',
);
/** Single-character pointers and sentence particles only at the edges. */
const EDGE_LEAD = /^(?:[\s\p{P}的它]|找|搜|(?:和|与|或|跟)(?=\s))+/u;
const EDGE_TAIL = /[\s\p{P}的它吗呢吧啊呀]+$/u;

/** Platform enum values named in the text, in first-named order. */
export function platformsIn(text: string): string[] {
  const found: { readonly at: number; readonly platform: string }[] = [];
  for (const [pattern, platform] of PLATFORM_WORDS) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, platform });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((entry) => entry.platform))];
}

function excludesIn(text: string): { readonly text: string; readonly words: string[] } {
  const words: string[] = [];
  const rest = text.replace(EXCLUDE, (_match, word: string) => {
    const trimmed = word.replace(/的$/u, '');
    if (trimmed !== '' && [...trimmed].length <= MAX_EXCLUDE_CHARS && words.length < MAX_EXCLUDES) {
      if (!words.includes(trimmed)) words.push(trimmed);
    }
    return ' ';
  });
  return { text: rest, words };
}

function trimEdges(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(EDGE_LEAD, '').replace(EDGE_TAIL, '');
    if (next === current) return current;
    current = next;
  }
}

/** BR-AI-14 细则 ⑥ on MessageText.free (already without tags and placeholders). */
export function extractSearchTerms(free: string): DegradedSearchTerms {
  const sort = sortOf(free) ?? 'relevance';
  const price = takePrice(free);
  const named = platformsIn(price.text);
  let text = price.text.replace(SORT_WORDS, ' ');
  const excluded = excludesIn(text);
  text = excluded.text.replace(PLATFORM_AROUND, ' ');
  text = withoutGreetings(text).replace(FILLERS, ' ');
  text = trimEdges(text).replace(/\s+/gu, ' ');
  const q = trimEdges([...text].slice(0, maxKeywordChars()).join(''));
  return {
    q,
    named,
    sort,
    ...(price.min === undefined ? {} : { priceMinFen: price.min }),
    ...(price.max === undefined ? {} : { priceMaxFen: price.max }),
    exclude: excluded.words,
  };
}
