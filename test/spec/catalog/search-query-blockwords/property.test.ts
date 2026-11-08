// B1-04zzzza (D10-1064 口径 A) properties. Queries are joined from fragments: prohibited words of
// the yaml (as written, upper case, full width, or split by whitespace), 「非」, whitespace and
// ordinary synthetic words, so hits across fragments, negations and near misses all occur.
// The reference is the Agent's own matcher (harness.ts agentProhibits).
// Run count as the category blocklist property (orchestrator D10-902 ②): PROP_RUNS scaled by
// 1/100 with a floor of 50; the seed is PROP_SEED as it is. The search property shares one fixture
// across all runs (no vi.fn per run) and compares call counts before and after each request.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import { isProhibitedQuery } from '../../../../apps/api/src/modules/catalog/domain/query-blockwords.ts';
import { feedChannels } from '../category-blocklist-search/kit.ts';
import {
  EMPTY,
  EVENT,
  IDEO_SPACE,
  SPACES,
  agentProhibits,
  fullWidth,
  setup,
  sideEffects,
  specProhibited,
  warnsOf,
} from './harness.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ORDINARY = [
  '合成纸巾',
  '正品',
  '推荐',
  '烟灰缸',
  '电子',
  '烟',
  '刀',
  '具',
  '架',
  'us',
  'dt',
  'Ｕ',
];

function fragment(words: readonly string[]) {
  const word = fc.constantFrom(...words);
  return fc.oneof(
    word,
    word.map((w) => w.toUpperCase()),
    word.map((w) => fullWidth(w)),
    fc.tuple(word, fc.constantFrom(...SPACES)).map(([w, space]) => [...w].join(space)),
    fc.constant('非'),
    fc.constantFrom(...SPACES),
    fc.constantFrom(...ORDINARY),
  );
}

function queries(words: readonly string[]) {
  return fc.array(fragment(words), { minLength: 1, maxLength: 6 }).map((parts) => parts.join(''));
}

const EXAMPLES: [string][] = [
  ['正品电子烟推荐'],
  ['非处方药'],
  ['烟灰缸'],
  ['ＵＳＤＴ'],
  [`电\t子${IDEO_SPACE}烟`],
  ['厨房刀具'],
];

it('[AC-B1-04zzzza#13] 任意查询词：catalog 的判定与 Agent 的 prohibited 判定逐个一致', () => {
  const words = specProhibited();
  expect(words.length).toBeGreaterThan(0);
  let checked = 0;
  fc.assert(
    fc.property(queries(words), (q) => {
      expect(isProhibitedQuery(q)).toBe(agentProhibits(q));
      checked += 1;
    }),
    {
      numRuns: Math.max(50, Math.floor(propRuns() / 100)),
      seed: propSeed(),
      examples: EXAMPLES,
    },
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-04zzzza#14] 任意查询词：命中即 200 空结果、无任何上游与会话副作用、恰好一条事件日志；不命中则照常调联盟一次、关键词就是原文、不记事件日志', async () => {
  feedChannels();
  const words = specProhibited();
  expect(words.length).toBeGreaterThan(0);
  const f = setup();
  let hits = 0;
  let misses = 0;
  await fc.assert(
    fc.asyncProperty(queries(words), async (q) => {
      const before = sideEffects(f);
      const eventsBefore = warnsOf(f.warn, EVENT).length;
      const outcome = await f.attempt({ q });
      if (agentProhibits(q)) {
        hits += 1;
        expect(outcome).toStrictEqual({ kind: 'returned', value: EMPTY });
        expect(sideEffects(f)).toStrictEqual(before);
        expect(warnsOf(f.warn, EVENT).length).toBe(eventsBefore + 1);
      } else {
        misses += 1;
        expect(outcome).toMatchObject({ kind: 'returned' });
        expect(f.search.mock.calls.length).toBe(before.search + 1);
        expect(f.search.mock.calls[before.search]?.[0]).toMatchObject({ keyword: q, pageNo: 1 });
        expect(warnsOf(f.warn, EVENT).length).toBe(eventsBefore);
      }
    }),
    {
      numRuns: Math.max(50, Math.floor(propRuns() / 100)),
      seed: propSeed(),
      examples: EXAMPLES,
    },
  );
  expect(hits).toBeGreaterThan(0);
  expect(misses).toBeGreaterThan(0);
}, 900_000);
