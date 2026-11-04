import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { createPoolRefreshJobHandler } from '../../../../apps/api/src/modules/catalog/worker/pool-refresh.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { fakeQueue } from '../../settlement/worker/kit.ts';
import { assertSchema } from '../hot-rank/kit.ts';
import {
  FALLBACK_KEY,
  TIMEOUT,
  fakeUnion,
  itemRow,
  refreshOptionsOf,
  sectionCase,
  secondsAgo,
  seedRef,
  usePoolDatabase,
} from '../product-pool-read/kit.ts';
import { JD, TB } from '../section-items/kit.ts';

// Real PostgreSQL via the shared test database harness; no mocked pool reader or card entry.
const h = usePoolDatabase(createTestDatabase);
const MAIN = 'https://img.synthetic.invalid/pool/main.jpg?size=large&v=1';
const SECOND = 'https://img.synthetic.invalid/pool/second.jpg';
const OTHER = 'https://img.synthetic.invalid/pool/not-the-stored-image.jpg';

it.each([
  { ac: 1, source: 'product_pool', fallback: false },
  { ac: 2, source: 'feed.fallback_pool_id', fallback: true },
])(
  '[AC-B1-05za#$ac] 首页 $source 经 listPageSectionItems 读取各行存图，空图不借用其他字段或相邻商品图片',
  async ({ fallback }) => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const names = ['first', 'no-image', 'last'];
    const expected = [MAIN, null, SECOND];
    for (const [index, name] of names.entries()) {
      await f.item(pool, name, {
        sort: index,
        image: expected[index]!,
        // These other stored fields deliberately look like usable image URLs.
        ...(name === 'no-image' ? { title: OTHER, raw_item_id: OTHER } : {}),
      });
    }
    if (fallback) {
      f.settings.set(FALLBACK_KEY, pool);
      f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'));
      f.failChannel(JD, new UnionError('upstream_unavailable', 'synthetic outage', 'jd'));
    } else {
      // A second page ensures the image survives cursor-based pool reads as well.
      f.show(pool, 2);
    }

    const pages = await f.walk();
    for (const page of pages) await assertSchema(page, 'PageSectionItemsData');
    const cards = pages.flatMap((page) => page.items);
    expect(cards.map((card) => card.product_key)).toEqual(names.map((name) => `tb:${name}`));
    expect(cards.map((card) => card.stale)).toEqual(names.map(() => fallback));
    expect(cards.map((card) => card.image)).toEqual(expected);
  },
  TIMEOUT,
);

it(
  '[AC-B1-05za#3] 池刷新后仍展示加池存图：不覆盖、不清空、不从新主图或多图补空图',
  async () => {
    const f = await sectionCase(h);
    const pool = await f.pool();
    const union = fakeUnion();
    const handler = createPoolRefreshJobHandler(
      refreshOptionsOf(h.db, fakeQueue(), union.union, f.clock, f.settings, async () => undefined),
    );
    const samples: readonly {
      name: string;
      stored: string | null;
      detail: Partial<UnionItemDetail>;
    }[] = [
      { name: 'refreshKeeps', stored: MAIN, detail: { main_image_url: OTHER } },
      { name: 'refreshNoFill', stored: null, detail: { main_image_url: OTHER } },
      { name: 'refreshGallery', stored: null, detail: { image_urls: [OTHER] } },
      { name: 'refreshNoClear', stored: SECOND, detail: {} },
    ];
    for (const [index, sample] of samples.entries()) {
      await f.item(pool, sample.name, {
        sort: index,
        image: sample.stored,
        quoted_at: secondsAgo(f.clock, 600),
      });
      await seedRef(h.db, f.owner, f.clock, sample.name);
      union.answers.set(`rawRef-${sample.name}`, () => ({
        platform: 'taobao',
        item_id: `rawRef-${sample.name}`,
        title: `synthetic-${sample.name}`,
        price_fen: 6000n,
        coupon_fen: 1000n,
        final_price_fen: 5000n,
        commission_rate_bp: 1500n,
        quoted_at: f.clock.now().toISOString(),
        ...sample.detail,
      }));
    }
    f.show(pool);
    const beforeCards = (await f.run()).items;
    const beforeRows = await Promise.all(
      samples.map(({ name }) => itemRow(h.db, f.owner.appId, pool, `tb:${name}`)),
    );

    for (const { name } of samples) {
      await handler({
        id: `synthetic-refresh-${name}`,
        queue: 'pool-refresh',
        name: 'refresh',
        payload: { app_id: f.owner.appId, product_key: `tb:${name}`, platform: 'taobao' },
        attempt: 1,
      });
    }

    const afterRows = await Promise.all(
      samples.map(({ name }) => itemRow(h.db, f.owner.appId, pool, `tb:${name}`)),
    );
    const expected = samples.map(({ stored }) => stored);
    expect(beforeRows.map((row) => row.image)).toEqual(expected);
    expect(afterRows.map((row) => row.image)).toEqual(expected);
    // Prove refresh really wrote the new quote, so image preservation is not a no-op result.
    expect(union.asked).toEqual(samples.map(({ name }) => `rawRef-${name}`));
    for (const row of afterRows) {
      expect(row).toMatchObject({ final_price_fen: 5000n, quoted_at: f.clock.now() });
    }
    const after = await f.run();
    await assertSchema(after, 'PageSectionItemsData');
    expect({
      before: beforeCards.map((card) => card.image),
      after: after.items.map((card) => card.image),
    }).toEqual({ before: expected, after: expected });
  },
  TIMEOUT,
);
