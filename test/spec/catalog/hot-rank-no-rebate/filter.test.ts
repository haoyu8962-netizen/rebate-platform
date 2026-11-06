// B1-28o: the hot list leaves out cards that come out of the card entry as rebate_basis = no_rebate
// (08 BR-PRICE-08: 热销榜必须过滤掉 no_rebate 商品，2026-11-05 补入). A filtered position leaves its
// rank number unused; the other items keep the channel's own position as rank (按上游页码与页内序号
// 推出), are never renumbered, moved forward or reordered. These pages have no more upstream, so
// no refill is involved (refill.test.ts).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { anomalous } from '../hot-rank-gap/kit.ts';
import { PAGE_SIZE, TB_CHANNEL, assertSchema, candidate, series } from '../hot-rank/kit.ts';
import { cursorFor, listed, noRebateFixture, rows } from './kit.ts';

it('[AC-B1-28o#1][BR-PRICE-08] 组卡后 rebate_basis=no_rebate 的不出卡；其余名次沿用频道原位次，被滤掉的名次空缺、不前移', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('c', 8));
  f.noRebate('c-1', 'c-4', 'c-5', 'c-8');

  const data = await f.run();

  expect(rows(data)).toEqual(listed('c', [2, 3, 6, 7]));
  expect(data.items.map((item) => item.product_card.rebate_basis)).toEqual(
    Array.from({ length: 4 }, () => 'normal'),
  );
  expect(data.next_cursor).toBeNull();
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28o#1][BR-PRICE-08] 后续页同样过滤：第 3 页名次仍为 40 + 位次 + 1，滤掉的号空着', async () => {
  const f = noRebateFixture();
  f.setPage(3, series('p3', 6, 41));
  f.noRebate('p3-41', 'p3-44');

  const data = await f.run({ cursor: cursorFor(3) });

  expect(rows(data)).toEqual(listed('p3', [42, 43, 45, 46]));
  expect(f.pageNos()).toEqual([3]);
});

it('[AC-B1-28o#1][BR-PRICE-08] 整页都无返利：items 为空，不出任何 no_rebate 卡', async () => {
  const f = noRebateFixture();
  f.setPage(1, series('z', 3));
  f.noRebate('z-1', 'z-2', 'z-3');

  const data = await f.run();

  expect(data.items).toEqual([]);
  expect(data.next_cursor).toBeNull();
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28o#8][BR-PRICE-08] 上游丢位（positions）与无返利过滤同页：名次 = 原位次，两种空号并存', async () => {
  const f = noRebateFixture();
  f.setPage(
    1,
    [
      candidate('a', { salesText: '1件' }),
      candidate('b', { salesText: '2件' }),
      candidate('c', { salesText: '3件' }),
      candidate('d', { salesText: '4件' }),
      candidate('e', { salesText: '5件' }),
      candidate('f', { salesText: '6件' }),
    ],
    false,
    [0, 2, 3, 5, 7, 8],
  );
  f.noRebate('b', 'e');

  expect(rows(await f.run())).toEqual([
    [1, 'synthetic-a', '1件'],
    [4, 'synthetic-c', '3件'],
    [6, 'synthetic-d', '4件'],
    [9, 'synthetic-f', '6件'],
  ]);
});

it('[AC-B1-28o#8] 第 2 页带 positions 并过滤：名次 = 20 + 原位次 + 1', async () => {
  const f = noRebateFixture();
  f.setPage(2, series('p2', 4, 21), false, [1, 4, 6, 19]);
  f.noRebate('p2-23');

  expect(rows(await f.run({ cursor: cursorFor(2) }))).toEqual([
    [22, 'synthetic-p2-21', '21件'],
    [25, 'synthetic-p2-22', '22件'],
    [40, 'synthetic-p2-24', '24件'],
  ]);
});

it('[AC-B1-28o#9] notice_key 仍为 rank.notice；出卡入口跳过的（价格异常）照旧跳过，与无返利空号并存', async () => {
  const f = noRebateFixture();
  f.setPage(1, [
    candidate('a', { salesText: '1件' }),
    anomalous(candidate('odd')),
    candidate('b', { salesText: '3件' }),
    candidate('zero', { salesText: '4件' }),
    candidate('c', { salesText: '5件' }),
  ]);
  f.noRebate('zero');

  const data = await f.run();

  expect(data.channel).toBe(TB_CHANNEL);
  expect(data.notice_key).toBe('rank.notice');
  expect(rows(data)).toEqual([
    [1, 'synthetic-a', '1件'],
    [3, 'synthetic-b', '3件'],
    [5, 'synthetic-c', '5件'],
  ]);
  await assertSchema(data, 'HotRankData');
});

it('[AC-B1-28o#1][BR-PRICE-08] 属性：任意无返利模式与页号（上游无更多），下发的恰为有返利条目、名次 = first + 原下标 + 1', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), { minLength: 1, maxLength: PAGE_SIZE }),
      fc.integer({ min: 1, max: 5 }),
      async (dropped, pageNo) => {
        const f = noRebateFixture();
        const first = (pageNo - 1) * PAGE_SIZE;
        f.setPage(pageNo, series('c', dropped.length, first + 1));
        const numbers = dropped.map((_unused, index) => first + index + 1);
        f.noRebate(...numbers.filter((_n, index) => dropped[index]).map((n) => `c-${String(n)}`));

        const data = await f.run(pageNo === 1 ? {} : { cursor: cursorFor(pageNo) });

        const kept = numbers.filter((_n, index) => !dropped[index]);
        checked += 1;
        expect(rows(data)).toEqual(listed('c', kept));
        expect(f.pageNos()).toEqual([pageNo]);
        expect(data.next_cursor).toBeNull();
        return true;
      },
    ),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
