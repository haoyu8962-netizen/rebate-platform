import { expect, it } from 'vitest';
import {
  businessFields,
  convertToDetail,
  ctx,
  detailIdLists,
  expectNothingSent,
  identities,
  KEYWORD,
  query,
  rowsFrom,
  search,
  searchBody,
  searchNumber,
  searchRequests,
  searchRow,
  setup,
  unionFailure,
  type SetupOptions,
} from './official-harness.ts';

// 游标与下一页：前缀 taobao-search:<页码>；本页原始条数满 20 且（已取条数 < total_results，缺失时只看满页）
// 才有下一页；空页 { items: [], nextCursor: null }，不调换算。

const PAGE_SIZE = 20;

/** The rows of page `page` when every page holds PAGE_SIZE rows (numbered from 1). */
function pageRows(page: number, count: number) {
  return rowsFrom((page - 1) * PAGE_SIZE + 1, count);
}

/** One search of page `page` (the first page carries no cursor). */
function searchPage(options: SetupOptions, page: number) {
  const h = setup(options);
  const q = page === 1 ? query : { keyword: KEYWORD, cursor: `taobao-search:${page}` };
  return { h, result: search(h, q) };
}

it('[AC-B1-04zx#7] 首页满 20 条且 total_results 更大 → nextCursor = taobao-search:2', async () => {
  const { result } = searchPage({ page: () => searchBody(pageRows(1, 20), 165) }, 1);
  const page = await result;
  expect(identities(page)).toHaveLength(20);
  expect(page.nextCursor).toBe('taobao-search:2');
});

it('[AC-B1-04zx#8] 续传：page_no 递增、q 照旧、结果连续；最后一页 nextCursor = null', async () => {
  // total_results 45：第 1、2 页各 20 条，第 3 页 5 条。
  const h = setup({
    page: (pageNo) => searchBody(pageRows(pageNo, pageNo < 3 ? 20 : 5), 45),
  });
  const seen: number[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 6; round += 1) {
    const page = await search(h, cursor === undefined ? query : { keyword: KEYWORD, cursor });
    seen.push(...identities(page));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const fields = searchRequests(h).map(businessFields);
  expect(fields.map((field) => field['page_no'])).toEqual(['1', '2', '3']);
  expect(fields.map((field) => field['q'])).toEqual([KEYWORD, KEYWORD, KEYWORD]);
  expect(seen).toEqual(Array.from({ length: 45 }, (_unused, i) => i + 1));
});

it.each([
  ['首页满页且恰好取完', 1, 20, 20, null],
  ['第 2 页满页且恰好取完', 2, 20, 40, null],
  ['第 2 页满页还差 1 条', 2, 20, 41, 'taobao-search:3'],
  ['不满页但 total_results 更大', 1, 19, 165, null],
] as [string, number, number, number, string | null][])(
  '[AC-B1-04zx#9] %s（第 %s 页 %s 条，total_results %s）→ nextCursor %s',
  async (_label, pageNo, count, total, expected) => {
    const { h, result } = searchPage(
      { page: () => searchBody(pageRows(pageNo, count), total) },
      pageNo,
    );
    const page = await result;
    expect(businessFields(searchRequests(h)[0]!)['page_no']).toBe(String(pageNo));
    expect(page.nextCursor).toBe(expected);
  },
);

it.each([
  ['满页', 20, 'taobao-search:2'],
  ['不满页', 19, null],
] as [string, number, string | null][])(
  '[AC-B1-04zx#10] total_results 缺失时只看满页：%s（%s 条）→ nextCursor %s',
  async (_label, count, expected) => {
    const { result } = searchPage({ page: () => searchBody(pageRows(1, count)) }, 1);
    const page = await result;
    expect(page.items).toHaveLength(count);
    expect(page.nextCursor).toBe(expected);
  },
);

it('[AC-B1-04zx#11] 有行被跳过或换不到时，下一页仍按原始条数判断（满页照给 nextCursor）', async () => {
  const rows = pageRows(1, 20);
  rows[3] = searchRow(4, { basic: { title: undefined } }); // 缺标题 → 跳过
  const h = setup({
    page: () => searchBody(rows, 165),
    available: (id) => (searchNumber(id) === 7 ? undefined : convertToDetail(id)),
  });
  const page = await search(h);
  const numbers = identities(page);
  expect(numbers).toHaveLength(18);
  expect(numbers).not.toContain(4);
  expect(numbers).not.toContain(7);
  expect(page.nextCursor).toBe('taobao-search:2');
});

it.each([
  'garbage',
  '',
  '2',
  'tb-dtk-search:2',
  'pdd-search:2:',
  'pdd-feed:20',
  'taobao-search:',
  'taobao-search:abc',
  'taobao-search:0',
  'taobao-search:-1',
  'taobao-search:1.5',
  ' taobao-search:2',
])('[AC-B1-04zx#12] 非法或别的接口的游标 %j → invalid_dto，不取凭据、不发请求', async (cursor) => {
  const h = setup();
  await unionFailure(() => h.adapter.searchItems({ keyword: KEYWORD, cursor }, ctx), 'invalid_dto');
  expectNothingSent(h);
});

it('[AC-B1-04zx#13] 空页 → { items: [], nextCursor: null }，不调换算', async () => {
  const h = setup({ page: () => searchBody([], 0) });
  const page = await search(h);
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(detailIdLists(h)).toEqual([]);
  expect(h.transport).toHaveBeenCalledTimes(1);
});
