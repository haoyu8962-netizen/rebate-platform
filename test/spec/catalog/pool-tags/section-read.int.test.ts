// CT-07e (D10-1758 / D10-1761): the home page reads a product_pool section by its tags. With `tags`
// in the data source only the items whose tags share at least one value with it are delivered, by
// exact equality; without `tags` or with [] nothing is filtered. Everything else of 「Fetching
// product_pool」 stays (order, eligibility, pages, cursor, card shape: no tag field on a card). The
// feed's union fall-back pool (feed.fallback_pool_id) is never filtered by tags.
// getSectionItems over the real reader and tables (the B1-05r section kit); the stored tags go in by
// SQL after the column check.
import { createTestDatabase } from '@couli/db/testing';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { assertSchema } from '../hot-rank/kit.ts';
import { FALLBACK_KEY, sectionCase, usePoolDatabase } from '../product-pool-read/kit.ts';
import { JD, TB, materialSource, title } from '../section-items/kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { TIMEOUT, requireTags, seedTags } from './db-kit.ts';

const h = usePoolDatabase(createTestDatabase);

type Case = Awaited<ReturnType<typeof sectionCase>>;
type Pages = Awaited<ReturnType<Case['walk']>>;

function allTitles(pages: Pages): (string | null)[] {
  return pages.flatMap((page) => page.items.map((card) => card.title));
}

/** The section's data source becomes this pool with these extra fields. */
function showPool(f: Case, poolId: string, extra: Record<string, unknown>, limit = 20): void {
  f.setSection({ dataSource: { kind: 'product_pool', pool_id: poolId, limit, ...extra } });
}

/** One online, eligible row per entry, sort as listed, with its stored tags. */
async function seedRows(
  f: Case,
  poolId: string,
  rows: readonly (readonly [name: string, tags: readonly string[]])[],
): Promise<void> {
  for (const [index, [name, tags]] of rows.entries()) {
    await f.item(poolId, name, { sort: index });
    await seedTags(h.db, f.owner.appId, poolId, `tb:${name}`, tags);
  }
}

const ROWS = [
  ['a-both', ['新品', '爆款']],
  ['b-new', ['新品']],
  ['c-hot', ['爆款']],
  ['d-other', ['清仓']],
  ['e-none', []],
] as const;

it(
  '[CT-07e][D10-1758] 数据源带 tags：只下发 tags 与之有交集的条目（命中任一），顺序不变，只给下发的卡登记，卡片不带标签字段',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    await seedRows(f, pool, ROWS);

    showPool(f, pool, { tags: ['新品'] });
    const one = await f.walk();
    expect(allTitles(one)).toEqual(['a-both', 'b-new'].map(title));
    expect(f.registered()).toEqual(['a-both', 'b-new'].map(title));

    showPool(f, pool, { tags: ['新品', '爆款'] });
    const any = await f.walk();
    expect(allTitles(any)).toEqual(['a-both', 'b-new', 'c-hot'].map(title));

    for (const page of [...one, ...any]) {
      await assertSchema(page, 'PageSectionItemsData');
      for (const card of page.items) expect(card).not.toHaveProperty('tags');
      expect(JSON.stringify(page)).not.toContain('新品');
    }
  },
  TIMEOUT,
);

it.each([
  { label: '不带 tags', extra: {} },
  { label: 'tags=[]', extra: { tags: [] } },
])(
  '[CT-07e][D10-1758] 数据源$label：不筛，有标签和没标签的条目都下发',
  async ({ extra }) => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    await seedRows(f, pool, ROWS);

    showPool(f, pool, extra);

    expect(allTitles(await f.walk())).toEqual(ROWS.map(([name]) => title(name)));
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1758] 按值完全相等匹配：大小写不同、只是前缀或包含都不算命中',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    await seedRows(f, pool, [
      ['a-upper', ['AB']],
      ['b-lower', ['ab']],
      ['c-long', ['新品上架']],
    ]);

    showPool(f, pool, { tags: ['AB'] });
    expect(allTitles(await f.walk())).toEqual([title('a-upper')]);
    showPool(f, pool, { tags: ['新品'] });
    expect(allTitles(await f.walk())).toEqual([]);
    showPool(f, pool, { tags: ['新品上架', 'ab'] });
    expect(allTitles(await f.walk())).toEqual(['b-lower', 'c-long'].map(title));
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1758] 标签筛选与原有条件同时成立：下线或窗口外的命中条目照旧不下发',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    const later = new Date(f.clock.now().getTime() + 3_600_000);
    await f.item(pool, 'a-live', { sort: 1 });
    await f.item(pool, 'b-offline', { sort: 2, status: 'offline' });
    await f.item(pool, 'c-future', { sort: 3, start_at: later });
    await f.item(pool, 'd-untagged', { sort: 4 });
    for (const name of ['a-live', 'b-offline', 'c-future']) {
      await seedTags(h.db, f.owner.appId, pool, `tb:${name}`, ['新品']);
    }

    showPool(f, pool, { tags: ['新品'] });

    expect(allTitles(await f.walk())).toEqual([title('a-live')]);
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1758] 分页：limit=2 时 8 行里命中的 5 行，翻完所有页正好是这 5 行，不重不漏，每页不超过 limit',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    const rows = Array.from(
      { length: 8 },
      (_unused, index) =>
        [`p${String(index).padStart(2, '0')}`, index % 3 === 1 ? [] : ['新品']] as const,
    );
    await seedRows(f, pool, rows);
    const hits = rows.filter(([, tags]) => tags.length > 0).map(([name]) => title(name));
    expect(hits).toHaveLength(5);

    showPool(f, pool, { tags: ['新品'] }, 2);
    const pages = await f.walk();

    expect(allTitles(pages)).toEqual(hits);
    for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(2);
    expect(pages.at(-1)).toMatchObject({ has_more: false, next_cursor: null });
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1761] 兜底池不受标签筛选：联盟频道全部失败改读 feed.fallback_pool_id 时，池里打了什么标签的条目都下发',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    await seedRows(f, pool, ROWS);
    f.settings.set(FALLBACK_KEY, pool);

    showPool(f, pool, { tags: ['清仓'] });
    expect(allTitles(await f.walk())).toEqual([title('d-other')]);

    const unavailable = new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');
    f.failChannel(TB, unavailable);
    f.failChannel(JD, unavailable);
    f.setSection({ dataSource: materialSource([TB, JD]) });
    const fallback = await f.walk();

    expect(allTitles(fallback)).toEqual(ROWS.map(([name]) => title(name)));
    for (const page of fallback) {
      for (const card of page.items) {
        expect(card).toMatchObject({ stale: true });
        expect(card).not.toHaveProperty('tags');
      }
    }
  },
  TIMEOUT,
);

const TAG_SET = ['甲', '乙', '丙'] as const;
const SAMPLE = fc.record({
  rows: fc.array(fc.subarray([...TAG_SET]), { maxLength: 8 }),
  filter: fc.option(fc.subarray([...TAG_SET]), { nil: undefined }),
  limit: fc.integer({ min: 1, max: 5 }),
});
/** Each sample writes its rows and walks its list over the real tables. */
const LIST_RUNS = Math.max(8, Math.floor(propRuns() / 1000));

it(
  '[CT-07e][D10-1758] 任意标签组合：翻完所有页，下发的正好是与数据源 tags 有交集的行（不带或 [] 时是全部），顺序按 sort',
  async () => {
    await requireTags(h.db);
    const f = await sectionCase(h);
    let sample = 0;
    await fc.assert(
      fc.asyncProperty(SAMPLE, async ({ rows, filter, limit }) => {
        sample += 1;
        const pool = await f.pool();
        const named = rows.map(
          (tags, index) => [`s${String(sample)}-${String(index).padStart(2, '0')}`, tags] as const,
        );
        await seedRows(f, pool, named);
        showPool(f, pool, filter === undefined ? {} : { tags: filter }, limit);

        const pages = await f.walk();

        const wanted: readonly string[] = filter ?? [];
        const want = named
          .filter(([, tags]) => wanted.length === 0 || tags.some((tag) => wanted.includes(tag)))
          .map(([name]) => title(name));
        expect(allTitles(pages)).toEqual(want);
        for (const page of pages) expect(page.items.length).toBeLessThanOrEqual(limit);
      }),
      { numRuns: LIST_RUNS, seed: propSeed() },
    );
  },
  60_000 + LIST_RUNS * 1000,
);
