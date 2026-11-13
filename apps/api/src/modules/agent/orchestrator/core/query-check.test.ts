import { expect, it, vi } from 'vitest';
import type { ReviewVerdict, SentenceReviewPort } from '../../guard/index.ts';
import { bindQueryCheck, checkQuery, queryCheckOf } from './query-check.ts';

// Synthetic only. B3-05s · BR-AI-06 / BR-AI-18 (C-32): a model-supplied term (q_short) through a
// fresh OutputGuard of its own: filter hits and a blocking review reject it and count as filtered.

function review(verdict: ReviewVerdict | ((text: string) => ReviewVerdict)): SentenceReviewPort {
  return {
    review: vi.fn(async (text: string) =>
      typeof verdict === 'function' ? verdict(text) : verdict,
    ),
  };
}

it('[AC-B3-05s#8][BR-AI-06] a plain term passes: allowed, nothing filtered, reviewed as it is', async () => {
  const port = review('pass');
  expect(await checkQuery(port, '合成保温杯')).toEqual({
    allowed: true,
    hits: [],
    filtered: false,
  });
  expect(port.review).toHaveBeenCalledWith('合成保温杯');
});

it.each([
  { ac: 1, term: '99元耳机', hit: 'amount' },
  { ac: 2, term: '¥30水杯', hit: 'amount' },
  { ac: 3, term: 'http://a', hit: 'url' },
  { ac: 4, term: 'tb://a', hit: 'url' },
  { ac: 5, term: 'x.cn/a', hit: 'url' },
  { ac: 6, term: '复制打开淘宝', hit: 'tpwd' },
])('[AC-B3-05s#$ac][BR-AI-06] $term: rejected with the $hit hit', async ({ term, hit }) => {
  const verdict = await checkQuery(review('pass'), term);
  expect(verdict.allowed).toBe(false);
  expect(verdict.filtered).toBe(true);
  expect(verdict.hits).toContain(hit);
});

it('[AC-B3-05s#7][BR-AI-18] a blocking review rejects the term and counts as filtered without a hit', async () => {
  const verdict = await checkQuery(review('block'), '合成审核拦截词');
  expect(verdict).toEqual({ allowed: false, hits: [], filtered: true });
});

it('[AC-B3-05s#7][BR-AI-18] a review that never passes (timeout) rejects the term, not recorded as filtered', async () => {
  const verdict = await checkQuery(review('timeout'), '合成保温杯');
  expect(verdict).toEqual({ allowed: false, hits: [], filtered: false });
});

it('[AC-B3-05s#7][BR-AI-18] a review that throws rejects the term (fail-close)', async () => {
  const port: SentenceReviewPort = {
    review: async () => {
      throw new Error('synthetic review failure');
    },
  };
  expect((await checkQuery(port, '合成保温杯')).allowed).toBe(false);
});

it('[AC-B3-05s#8][BR-AI-06] the checker is found by the run signal and run id only', () => {
  const signal = new AbortController().signal;
  const check = { allows: async () => true };
  expect(queryCheckOf({ signal, runId: 'synthetic-run' })).toBeNull();
  bindQueryCheck(signal, 'synthetic-run', check);
  expect(queryCheckOf({ signal, runId: 'synthetic-run' })).toBe(check);
  expect(queryCheckOf({ signal, runId: 'synthetic-other-run' })).toBeNull();
  expect(queryCheckOf({ signal: new AbortController().signal, runId: 'synthetic-run' })).toBeNull();
});
