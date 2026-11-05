import { expect, it } from 'vitest';
import { candidate, claims, fixture } from './kit.ts';

it.each([true, false])(
  '[AC-B1-05d#11] 无返利过滤后最多补一页，仍不足按实际数，has_more=%s 取末次上游',
  async (hasMore) => {
    const f = fixture();
    f.pages.set(1, { items: [candidate('zero-a'), candidate('first')], hasMore: true });
    f.pages.set(2, { items: [candidate('zero-b'), candidate('second')], hasMore });
    f.pages.set(3, { items: [candidate('must-not-fetch')], hasMore: false });
    for (const name of ['zero-a', 'zero-b'])
      f.quotes.set(`synthetic-${name}`, { min: 0n, max: 0n });
    const result = await f.run();
    expect(result.items.map((card) => card.title)).toEqual(['synthetic-first', 'synthetic-second']);
    expect(result.items.every((card) => card.rebate_basis !== 'no_rebate')).toBe(true);
    expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
    expect(result.has_more).toBe(hasMore);
    if (hasMore)
      expect(claims(f, result.next_cursor)).toEqual({
        search_session_id: expect.any(String),
        page_no: 3,
      });
    else expect(result.next_cursor).toBeNull();
  },
);

it('[AC-B1-05d#12] 全部无返利且联盟还有页时仍返回空、has_more=true，不无限补拉', async () => {
  const f = fixture();
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  for (const pageNo of [1, 2, 3])
    f.pages.set(pageNo, { items: [candidate('zero')], hasMore: true });
  const result = await f.run();
  expect(result).toMatchObject({ items: [], fallback_items: [], has_more: true });
  expect(claims(f, result.next_cursor)).toMatchObject({ page_no: 3 });
  expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2]);
});

it('[AC-B1-05d#13] 满页不补拉，has_more=false 的不足页也不补拉', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('a'), candidate('b'), candidate('c')], hasMore: true });
  const full = await f.run();
  expect(full.items).toHaveLength(3);
  expect(f.search).toHaveBeenCalledTimes(1);
  f.pages.set(1, { items: [candidate('d')], hasMore: false });
  const short = await f.run();
  expect(short.items).toHaveLength(1);
  expect(short).toMatchObject({ has_more: false, next_cursor: null });
  expect(f.search).toHaveBeenCalledTimes(2);
});

// B1-05zc (D10-641): a search card is one amount (normal, min = max), so an item whose old range
// had a zero lower bound now shows its single 1 fen; only max = 0 is still filtered.
it('[AC-B1-05d#14] 一分返利按单值保留（不出零下限区间），只有 max=0 的商品被过滤', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('range'), candidate('zero')], hasMore: false });
  f.quotes.set('synthetic-range', { min: 0n, max: 1n });
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  const result = await f.run();
  expect(result.items).toEqual([
    expect.objectContaining({
      title: 'synthetic-range',
      rebate_basis: 'normal',
      rebate_min_fen: 1,
      rebate_max_fen: 1,
    }),
  ]);
});

it('[AC-B1-05d#15] 补拉超出 limit 时仅下发 limit，游标记录上游页而非过滤偏移', async () => {
  const f = fixture();
  f.pages.set(1, { items: [candidate('first'), candidate('zero')], hasMore: true });
  f.pages.set(2, { items: [candidate('second'), candidate('not-yet-sent')], hasMore: true });
  f.pages.set(3, { items: [candidate('not-yet-sent'), candidate('third')], hasMore: false });
  f.quotes.set('synthetic-zero', { min: 0n, max: 0n });
  const first = await f.run({ limit: 2 });
  expect(first.items.map((card) => card.title)).toEqual(['synthetic-first', 'synthetic-second']);
  expect(claims(f, first.next_cursor)).toMatchObject({ page_no: 3 });
  const next = await f.run({ limit: 2, cursor: first.next_cursor! });
  expect(next.items.map((card) => card.title)).toEqual([
    'synthetic-not-yet-sent',
    'synthetic-third',
  ]);
  expect(f.search.mock.calls.map(([input]) => input.pageNo)).toEqual([1, 2, 3]);
});
