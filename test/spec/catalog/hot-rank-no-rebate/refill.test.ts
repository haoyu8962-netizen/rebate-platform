// B1-28o: refill after the no_rebate filter (08 BR-PRICE-08: 过滤后不足 page_size 时，最多向上游补拉
// 1 页补足，仍不足就按实际数量返回；has_more 以上游返回为准；分页游标记录上游页码，不记录过滤后的偏移量;
// 分页例「page_size=20，上游第 1 页过滤掉 6 个 → 补拉上游第 2 页，过滤后补足 20 个返回，游标记为上游第
// 3 页；补拉后仍只有 17 个 → 返回 17 个」). Refilled items keep the rank of their own channel position.
// The cursor's page cap (HOT_RANK_MAX_PAGE_NO) is the one the use case already applies.
import { expect, it } from 'vitest';
import { HOT_RANK_MAX_PAGE_NO } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { PAGE_SIZE, TB_CHANNEL, assertSchema, series } from '../hot-rank/kit.ts';
import { claimsFor, claimsOf, cursorFor, listed, noRebateFixture, rows, span } from './kit.ts';

/** Page 1 of the 分页例: six of 20 without rebate, 14 left. */
const PAGE_1_DROPPED = [2, 5, 9, 10, 15, 20];
const PAGE_1_KEPT = [1, 3, 4, 6, 7, 8, 11, 12, 13, 14, 16, 17, 18, 19];

function names(prefix: string, numbers: readonly number[]): string[] {
  return numbers.map((n) => `${prefix}-${String(n)}`);
}

it('[AC-B1-28o#2][BR-PRICE-08] 分页例：第 1 页滤掉 6 个且上游有更多 → 只补拉第 2 页一次，返回恰 20 条，第 2 页条目按自己的位次编名次，游标 page_no=3', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', PAGE_SIZE, 21), true);
  f.setPage(3, series('p3', PAGE_SIZE, 41), false);
  f.noRebate(...names('p1', PAGE_1_DROPPED));
  f.noRebate(...names('p2', [22, 24]));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1, 2]);
  expect(f.unionRequests()[1]).toMatchObject({
    platform: 'taobao',
    channelId: TB_CHANNEL,
    categoryId: null,
    pageNo: 2,
    pageSize: PAGE_SIZE,
  });
  expect(data.items).toHaveLength(PAGE_SIZE);
  expect(rows(data)).toEqual([
    ...listed('p1', PAGE_1_KEPT),
    ...listed('p2', [21, 23, 25, 26, 27, 28]),
  ]);
  expect(claimsOf(data.next_cursor)).toEqual(claimsFor(3));
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28o#2][BR-PRICE-08] 第 1 页 20 件对当前用户全是无返利、上游有更多：过滤后为空也要补拉第 2 页，返回第 2 页 20 条（名次 21–40），游标 page_no=3', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', PAGE_SIZE, 21), true);
  f.setPage(3, series('p3', PAGE_SIZE, 41), false);
  f.noRebate(...names('p1', span(1, 20)));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1, 2]);
  expect(data.items).toHaveLength(PAGE_SIZE);
  expect(rows(data)).toEqual(listed('p2', span(21, 40)));
  expect(claimsOf(data.next_cursor)).toEqual(claimsFor(3));
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28o#2][AC-B1-28o#8][BR-PRICE-08] 补拉页带 positions：补拉条目的名次 = (2-1)*20 + 补拉页自己的位次 + 1，不按数组下标编号', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', 6, 21), true, [0, 2, 4, 6, 8, 10]);
  f.setPage(3, series('p3', PAGE_SIZE, 41), false);
  f.noRebate(...names('p1', PAGE_1_DROPPED));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1, 2]);
  expect(data.items).toHaveLength(PAGE_SIZE);
  expect(rows(data)).toEqual([
    ...listed('p1', PAGE_1_KEPT),
    [21, 'synthetic-p2-21', '21件'],
    [23, 'synthetic-p2-22', '22件'],
    [25, 'synthetic-p2-23', '23件'],
    [27, 'synthetic-p2-24', '24件'],
    [29, 'synthetic-p2-25', '25件'],
    [31, 'synthetic-p2-26', '26件'],
  ]);
  expect(claimsOf(data.next_cursor)).toEqual(claimsFor(3));
});

it('[AC-B1-28o#2][AC-B1-28o#8][BR-PRICE-08] 补拉页带 positions 且自身也有被滤掉的：按原顺序取前几条有返利的，名次仍按补拉页的位次', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', 10, 21), false, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  f.noRebate(...names('p1', PAGE_1_DROPPED));
  f.noRebate(...names('p2', [22, 25]));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1, 2]);
  expect(rows(data)).toEqual([
    ...listed('p1', PAGE_1_KEPT),
    [22, 'synthetic-p2-21', '21件'],
    [26, 'synthetic-p2-23', '23件'],
    [28, 'synthetic-p2-24', '24件'],
    [32, 'synthetic-p2-26', '26件'],
    [34, 'synthetic-p2-27', '27件'],
    [36, 'synthetic-p2-28', '28件'],
  ]);
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-28o#2][BR-PRICE-08] 游标只记上游页码：接着取的是上游第 3 页（名次 41 起），补拉页没下发的条目不再出现', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', PAGE_SIZE, 21), true);
  f.setPage(3, series('p3', PAGE_SIZE, 41), false);
  f.noRebate(...names('p1', PAGE_1_DROPPED));

  const first = await f.run();
  const second = await f.run({ cursor: first.next_cursor! });

  expect(rows(first)).toEqual([...listed('p1', PAGE_1_KEPT), ...listed('p2', span(21, 26))]);
  expect(rows(second)).toEqual(listed('p3', span(41, 60)));
  expect(f.pageNos()).toEqual([1, 2, 3]);
  expect(second.next_cursor).toBeNull();
});

it.each([true, false])(
  '[AC-B1-28o#3][BR-PRICE-08] 补拉后仍不足 20：返回实际 17 条，不补拉第 3 页；补拉页 hasMore=%s 决定游标',
  async (hasMore) => {
    const f = noRebateFixture();
    f.setPage(1, series('p1', PAGE_SIZE, 1), true);
    f.setPage(2, series('p2', 5, 21), hasMore);
    f.setPage(3, series('p3', PAGE_SIZE, 41), false);
    f.noRebate(...names('p1', PAGE_1_DROPPED));
    f.noRebate(...names('p2', [22, 25]));

    const data = await f.run();

    expect(f.pageNos()).toEqual([1, 2]);
    expect(data.items).toHaveLength(17);
    expect(rows(data)).toEqual([...listed('p1', PAGE_1_KEPT), ...listed('p2', [21, 23, 24])]);
    expect(claimsOf(data.next_cursor)).toEqual(hasMore ? claimsFor(3) : null);
  },
);

it('[AC-B1-28o#3][BR-PRICE-08] 补拉页全是无返利、上游还有更多：只返回第 1 页剩下的，不补第 3 页，游标 page_no=3', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', 3, 21), true);
  f.setPage(3, series('p3', PAGE_SIZE, 41), true);
  f.noRebate(...names('p1', PAGE_1_DROPPED));
  f.noRebate(...names('p2', [21, 22, 23]));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1, 2]);
  expect(rows(data)).toEqual(listed('p1', PAGE_1_KEPT));
  expect(claimsOf(data.next_cursor)).toEqual(claimsFor(3));
});

it('[AC-B1-28o#4] 第 1 页一个都没滤掉：不补拉、游标 page_no=2（同现状）；同一页只滤掉 1 条就补拉第 2 页、游标 page_no=3', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), true);
  f.setPage(2, series('p2', PAGE_SIZE, 21), true);

  const whole = await f.run();

  expect(f.pageNos()).toEqual([1]);
  expect(rows(whole)).toEqual(listed('p1', span(1, 20)));
  expect(claimsOf(whole.next_cursor)).toEqual(claimsFor(2));

  f.noRebate('p1-7');
  const filtered = await f.run();

  expect(f.pageNos()).toEqual([1, 1, 2]);
  expect(rows(filtered)).toEqual([
    ...listed('p1', [...span(1, 6), ...span(8, 20)]),
    ...listed('p2', [21]),
  ]);
  expect(claimsOf(filtered.next_cursor)).toEqual(claimsFor(3));
});

it('[AC-B1-28o#5][BR-PRICE-08] 第 1 页有被滤掉但上游 hasMore=false：不补拉，返回剩余条目，next_cursor=null', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('p1', PAGE_SIZE, 1), false);
  f.setPage(2, series('p2', PAGE_SIZE, 21), false);
  f.noRebate(...names('p1', PAGE_1_DROPPED));

  const data = await f.run();

  expect(f.pageNos()).toEqual([1]);
  expect(rows(data)).toEqual(listed('p1', PAGE_1_KEPT));
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-28o#6] 当前页已是 HOT_RANK_MAX_PAGE_NO：有被滤掉、上游还有更多也不补拉，不发游标', async () => {
  const last = HOT_RANK_MAX_PAGE_NO;
  const first = (last - 1) * PAGE_SIZE;
  const f = noRebateFixture();
  f.setPage(last, series('m', PAGE_SIZE, first + 1), true);
  f.setPage(last + 1, series('over', PAGE_SIZE, first + PAGE_SIZE + 1), true);
  f.noRebate(...names('m', [first + 1, first + 4]));

  const data = await f.run({ cursor: cursorFor(last) });

  expect(f.pageNos()).toEqual([last]);
  expect(rows(data)).toEqual(listed('m', [first + 2, first + 3, ...span(first + 5, first + 20)]));
  expect(data.next_cursor).toBeNull();
});

it('[AC-B1-28o#6] 倒数第二页补拉到 HOT_RANK_MAX_PAGE_NO 就停：补拉页还有更多也不发游标', async () => {
  const last = HOT_RANK_MAX_PAGE_NO;
  const first = (last - 2) * PAGE_SIZE;
  const f = noRebateFixture();
  f.setPage(last - 1, series('m', PAGE_SIZE, first + 1), true);
  f.setPage(last, series('m', PAGE_SIZE, first + PAGE_SIZE + 1), true);
  f.noRebate(...names('m', [first + 1, first + 2]));

  const data = await f.run({ cursor: cursorFor(last - 1) });

  expect(f.pageNos()).toEqual([last - 1, last]);
  expect(rows(data)).toEqual(
    listed('m', [
      ...span(first + 3, first + PAGE_SIZE),
      first + PAGE_SIZE + 1,
      first + PAGE_SIZE + 2,
    ]),
  );
  expect(data.next_cursor).toBeNull();
});
