// CT-07f (D10-1986; 规划/01 F-ADM-10, 04 §3.2): the product_pool data source's `tags` on the read
// side, getSectionItems over the real pool reader and tables (the B1-05r kit). A source with tags
// sends only the rows whose stored tags meet them, any one of them, by exact equality (stored and
// configured tags are both normalized when written, so nothing is folded here), on top of every
// other pool rule (online, window, age, commission rate); paging walks that list without repeats or
// gaps. A source without tags, or with [], is not filtered. The feed's union fall-back
// (feed.fallback_pool_id) is never filtered, whatever another section asks of the same pool. A card
// carries no tag field.
//
// Before the change the reader ignores `tags` and sends every eligible row, so each case that pins
// "no filter" first pins the filter on the same pool.
import { createTestDatabase } from '@couli/db/testing';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { assertSchema } from '../hot-rank/kit.ts';
import { JD, TB, materialSource, title, titlesOf } from '../section-items/kit.ts';
import {
  AD_LABEL,
  FALLBACK_KEY,
  MAX_AGE_SEC,
  TIMEOUT,
  sectionCase,
  secondsAgo,
  usePoolDatabase,
} from '../product-pool-read/kit.ts';
import { poolSource, tagsOf } from './kit.ts';

const h = usePoolDatabase(createTestDatabase);

type Case = Awaited<ReturnType<typeof sectionCase>>;

/** The section's data source becomes this pool, with these tags (undefined: no tags key). */
function showTagged(f: Case, poolId: string, tags: readonly string[] | undefined, limit = 20) {
  f.setSection({ dataSource: poolSource(poolId, tags, limit) });
}

/** Every title the list sends over all its pages, with the page sizes. */
async function walked(f: Case) {
  const pages = await f.walk();
  return {
    pages,
    titles: pages.flatMap((page) => page.items.map((card) => card.title)),
  };
}

it(
  '[CT-07f][D10-1986] 带 tags 的数据源只出 tags 与之有交集的行（命中任一），顺序同 sort、product_key，每行只出一次，只给出的卡登记，卡上不带标签字段',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-both', { sort: 1, tags: ['甲', '乙'] });
    await f.item(pool, 'b-jia', { sort: 2, tags: ['甲'] });
    await f.item(pool, 'c-yi', { sort: 3, tags: ['丙', '乙'] });
    await f.item(pool, 'd-bing', { sort: 4, tags: ['丙'] });
    await f.item(pool, 'e-empty', { sort: 5, tags: [] });
    await f.item(pool, 'f-default', { sort: 6 });
    showTagged(f, pool, ['甲', '乙']);

    const data = await f.run();

    await assertSchema(data, 'PageSectionItemsData');
    const want = ['a-both', 'b-jia', 'c-yi'].map(title);
    expect(titlesOf(data)).toEqual(want);
    expect(data).toMatchObject({ has_more: false, next_cursor: null });
    expect(f.registered()).toEqual(want);
    for (const card of data.items) {
      expect(card).toMatchObject({ ad_label: AD_LABEL, stale: false });
      expect(Object.keys(card)).not.toContain('tags');
      expect(tagsOf(card)).toBeUndefined();
    }
  },
  TIMEOUT,
);

it(
  '[CT-07f][D10-1986] 完全相等匹配：包含、被包含、大小写不同、中间多空格都不算命中',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-longer', { tags: ['新品上架'] });
    await f.item(pool, 'b-shorter', { tags: ['新'] });
    await f.item(pool, 'c-case', { tags: ['ab'] });
    await f.item(pool, 'd-spaced', { tags: ['新 品'] });
    await f.item(pool, 'e-hit', { tags: ['其他', 'AB'] });
    await f.item(pool, 'f-hit', { tags: ['新品'] });
    showTagged(f, pool, ['新品', 'AB']);

    const { titles } = await walked(f);

    expect(titles).toEqual(['e-hit', 'f-hit'].map(title));
  },
  TIMEOUT,
);

it(
  '[CT-07f][D10-1986] 标签命中与其他池规则同时成立：命中但下线、未开始、已结束、超龄、佣金率为空的行都不出，没命中的合格行也不出',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const later = new Date(f.clock.now().getTime() + 3_600_000);
    const earlier = secondsAgo(f.clock, 3600);
    const tags = ['新品'];
    await f.item(pool, 'a-good', { tags });
    await f.item(pool, 'b-offline', { tags, status: 'offline', invalid_reason: '联盟返回下架' });
    await f.item(pool, 'c-future', { tags, start_at: later });
    await f.item(pool, 'd-past', { tags, end_at: earlier });
    await f.item(pool, 'e-aged', { tags, quoted_at: secondsAgo(f.clock, MAX_AGE_SEC + 1) });
    await f.item(pool, 'f-null-rate', { tags, commission_rate_bp: null });
    await f.item(pool, 'g-window', { tags, start_at: earlier, end_at: later });
    await f.item(pool, 'h-untagged', { tags: ['别的'] });
    showTagged(f, pool, tags);

    const { titles } = await walked(f);

    expect(titles).toEqual(['a-good', 'g-window'].map(title));
    expect(f.registered()).toEqual(['a-good', 'g-window'].map(title));
  },
  TIMEOUT,
);

it(
  '[CT-07f][D10-1986] 分页：limit=2 时 9 行里命中的 5 行翻完不重不漏、顺序对，每页不超过 limit，最后一页 has_more=false',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const hits: string[] = [];
    for (let index = 1; index <= 9; index += 1) {
      const name = `p${String(index).padStart(2, '0')}`;
      const hit = index % 2 === 1;
      if (hit) hits.push(name);
      await f.item(pool, name, { sort: index, tags: hit ? ['新品'] : ['旧品'] });
    }
    showTagged(f, pool, ['新品'], 2);

    const { pages, titles } = await walked(f);

    expect(titles).toEqual(hits.map(title));
    expect(new Set(titles).size).toBe(titles.length);
    for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(2);
    expect(pages[pages.length - 1]).toMatchObject({ has_more: false, next_cursor: null });
  },
  TIMEOUT,
);

it.each([
  { label: '不带 tags', tags: undefined },
  { label: 'tags=[]', tags: [] },
])(
  '[CT-07f][D10-1986] 数据源$label = 不筛：同一个池带 tags 时只出命中的行，去掉后出全部合格行',
  async ({ tags }) => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-tagged', { sort: 1, tags: ['新品'] });
    await f.item(pool, 'b-other', { sort: 2, tags: ['旧品'] });
    await f.item(pool, 'c-plain', { sort: 3 });

    showTagged(f, pool, ['新品']);
    expect((await walked(f)).titles).toEqual([title('a-tagged')]);

    showTagged(f, pool, tags);
    expect((await walked(f)).titles).toEqual(['a-tagged', 'b-other', 'c-plain'].map(title));
  },
  TIMEOUT,
);

it(
  '[CT-07f][D10-1986] 兜底池 feed.fallback_pool_id 不受标签筛选：同一个池在带 tags 的数据源里只出命中的行，信息流频道全挂回退到它时出全部合格行，stale=true',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'a-tagged', { sort: 1, tags: ['新品'] });
    await f.item(pool, 'b-other', { sort: 2, tags: ['旧品'] });
    await f.item(pool, 'c-plain', { sort: 3 });
    f.settings.set(FALLBACK_KEY, pool);
    f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'));
    f.failChannel(JD, new UnionError('upstream_unavailable', 'synthetic unavailable', 'jd'));

    showTagged(f, pool, ['新品']);
    expect((await walked(f)).titles).toEqual([title('a-tagged')]);

    f.setSection({ dataSource: materialSource([TB, JD]) });
    const fallback = await f.run();

    expect(titlesOf(fallback)).toEqual(['a-tagged', 'b-other', 'c-plain'].map(title));
    for (const card of fallback.items) {
      expect(card).toMatchObject({ ad_label: AD_LABEL, stale: true });
      expect(Object.keys(card)).not.toContain('tags');
    }
  },
  TIMEOUT,
);

const ALPHABET: string[] = ['甲', '乙', '丙'];
const ROW = fc.record({
  sort: fc.integer({ min: 0, max: 3 }),
  online: fc.constantFrom(true, true, true, false),
  tags: fc.subarray(ALPHABET),
});
const SOURCE_TAGS = fc.option(fc.subarray(ALPHABET, { minLength: 1 }), { nil: undefined });
/** Each sample writes its rows and walks its list over the real tables. */
const LIST_RUNS = Math.max(8, Math.floor(propRuns() / 1000));

it(
  '[CT-07f][D10-1986] 任意一池、任意 tags：翻完所有页，出的正好是合格且（不带 tags 时全部、带时与之有交集）的行，顺序对，每页不超过 limit',
  async () => {
    const f = await sectionCase(h);
    let sample = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(ROW, { maxLength: 8 }),
        SOURCE_TAGS,
        fc.integer({ min: 1, max: 4 }),
        async (rows, sourceTags, limit) => {
          sample += 1;
          const pool = await f.pool();
          const expected: { sort: number; name: string }[] = [];
          for (const [index, row] of rows.entries()) {
            const name = `t${String(sample)}-${String(index).padStart(2, '0')}`;
            await f.item(pool, name, {
              sort: row.sort,
              status: row.online ? 'online' : 'offline',
              tags: row.tags,
            });
            const meets =
              sourceTags === undefined || row.tags.some((tag) => sourceTags.includes(tag));
            if (row.online && meets) expected.push({ sort: row.sort, name });
          }
          showTagged(f, pool, sourceTags, limit);

          const { pages, titles } = await walked(f);

          const want = expected
            .sort((a, b) => a.sort - b.sort || (a.name < b.name ? -1 : 1))
            .map(({ name }) => title(name));
          expect(titles).toEqual(want);
          for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(limit);
        },
      ),
      {
        numRuns: LIST_RUNS,
        seed: propSeed(),
        // A sample with a row outside the tags is always among the runs.
        examples: [
          [
            [
              { sort: 0, online: true, tags: ['甲'] },
              { sort: 1, online: true, tags: ['乙'] },
              { sort: 2, online: true, tags: [] },
            ],
            ['甲'],
            2,
          ],
        ],
      },
    );
  },
  60_000 + LIST_RUNS * 1000,
);
