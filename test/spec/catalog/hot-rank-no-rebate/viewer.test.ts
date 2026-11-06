// B1-28o: the no_rebate filter runs when cards are assembled for the current viewer (08
// BR-PRICE-08: 缓存只存频道原始结果，过滤在按当前用户组装卡片时做（同 BR-PRICE-11）). The same channel
// page gives each viewer its own filtered list, while the page asked from and answered by the
// upstream (cached or not) stays the channel's whole page.
import { expect, it } from 'vitest';
import { pageRows } from '../hot-rank-gap/kit.ts';
import { APP, PAGE_SIZE, TB_CHANNEL, series } from '../hot-rank/kit.ts';
import { listed, noRebateFixture, rows, user } from './kit.ts';

const WHOLE_PAGE = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5'].map((name) => `synthetic-${name}`);

it.each([false, true])(
  '[AC-B1-28o#7][BR-PRICE-08] 同一上游页对两个用户各自过滤（组卡一个 normal、一个 no_rebate）；上游与缓存收到、返回的仍是原始整页（cached=%s）',
  async (cached) => {
    const f = noRebateFixture({ cached });
    f.setPage(1, series('c', 5));
    const withRebate = user('alpha');
    const without = user('beta');
    f.noRebateFor(without, 'c-2', 'c-3');

    f.as(without);
    const filtered = await f.run();
    f.as(withRebate);
    const whole = await f.run();

    expect(rows(filtered)).toEqual(listed('c', [1, 4, 5]));
    expect(rows(whole)).toEqual(listed('c', [1, 2, 3, 4, 5]));
    expect(whole.items.map((item) => item.product_card.rebate_basis)).toEqual(
      Array.from({ length: 5 }, () => 'normal'),
    );

    expect(f.seen).toHaveLength(2);
    for (const { input, page, titlesAtReturn } of f.seen) {
      expect(input).toEqual({
        appId: APP,
        platform: 'taobao',
        channelId: TB_CHANNEL,
        categoryId: null,
        pageNo: 1,
        pageSize: PAGE_SIZE,
      });
      expect(titlesAtReturn).toEqual(WHOLE_PAGE);
      expect(page.items.map((entry) => entry.item.title)).toEqual(WHOLE_PAGE);
    }
    if (cached) {
      const stored = pageRows(f.memory.rows);
      expect(stored).toHaveLength(1);
      const items = stored[0]?.entry.data['items'] as readonly { item: { title: string } }[];
      expect(items.map((entry) => entry.item.title)).toEqual(WHOLE_PAGE);
    }
  },
);

it('[AC-B1-28o#7][BR-PRICE-08] 先看全的用户再看被过滤的用户：后者照样滤掉自己无返利的卡，前者的结果不影响后者', async () => {
  const f = noRebateFixture({ cached: true });
  f.setPage(1, series('c', 5));
  const withRebate = user('alpha');
  const without = user('beta');
  f.noRebateFor(without, 'c-1', 'c-5');

  f.as(withRebate);
  const whole = await f.run();
  f.as(without);
  const filtered = await f.run();

  expect(rows(whole)).toEqual(listed('c', [1, 2, 3, 4, 5]));
  expect(rows(filtered)).toEqual(listed('c', [2, 3, 4]));
});
