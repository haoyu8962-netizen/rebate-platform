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
import { requireShopName, seedShopName, storedShopName } from './kit.ts';

const h = usePoolDatabase(createTestDatabase);
const IMAGE = 'https://img.synthetic.invalid/pool/stored.jpg';
const NEW_IMAGE = 'https://img.synthetic.invalid/pool/latest.jpg';

it(
  '[AC-B1-05zd#5] shop_name 是可空 text，无默认值；旧写入者不传列时存 NULL',
  async () => {
    await requireShopName(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    await f.item(pool, 'legacy', { title: '合成店铺式标题' });
    expect(await storedShopName(h.db, f.owner.appId, pool, 'tb:legacy')).toBeNull();
  },
  TIMEOUT,
);

it.each([
  { ac: 6, source: 'product_pool', fallback: false },
  { ac: 7, source: 'feed.fallback_pool_id', fallback: true },
])(
  '[AC-B1-05zd#$ac] listPageSectionItems 的 $source 池卡逐行读店名，NULL 不从标题、原串或邻行补',
  async ({ fallback }) => {
    await requireShopName(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    const names = ['shop-first', 'shop-missing', 'shop-last'];
    const expected = ['合成甲店 · A＆B', null, '合成乙店'];
    const images = [IMAGE, null, NEW_IMAGE];
    for (const [index, name] of names.entries()) {
      await f.item(pool, name, {
        sort: index,
        image: images[index]!,
        title: `不能充当店名的标题 ${name}`,
        raw_item_id: `不能充当店名的原串 ${name}`,
      });
      await seedShopName(h.db, f.owner.appId, pool, `tb:${name}`, expected[index]!);
    }
    if (fallback) {
      f.settings.set(FALLBACK_KEY, pool);
      f.failChannel(TB, new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'));
      f.failChannel(JD, new UnionError('upstream_unavailable', 'synthetic outage', 'jd'));
    } else {
      f.show(pool, 2);
    }

    const pages = await f.walk();
    for (const page of pages) await assertSchema(page, 'PageSectionItemsData');
    const cards = pages.flatMap((page) => page.items);
    expect(cards.map((card) => card.product_key)).toEqual(names.map((name) => `tb:${name}`));
    expect(cards.map((card) => card.shop_name)).toEqual(expected);
    expect(cards.map((card) => card.image)).toEqual(images);
    expect(cards.map((card) => card.stale)).toEqual(names.map(() => fallback));
    for (const card of cards) {
      expect(card).toMatchObject({ price_fen: 8800, coupon_fen: 800, final_price_fen: 8000 });
    }
  },
  TIMEOUT,
);

const REFRESH_CASES: readonly {
  ac: number;
  stored: string | null;
  fields: Pick<UnionItemDetail, 'shop_name'>;
  expected: string | null;
}[] = [
  {
    ac: 8,
    stored: '合成旧店',
    fields: { shop_name: '合成新店 · A＆B' },
    expected: '合成新店 · A＆B',
  },
  { ac: 9, stored: null, fields: { shop_name: '合成首次店名' }, expected: '合成首次店名' },
  { ac: 10, stored: '必须被清掉的合成旧店', fields: {}, expected: null },
  { ac: 11, stored: null, fields: {}, expected: null },
];

it.each(REFRESH_CASES)(
  '[AC-B1-05zd#$ac] 刷新店名 $stored → $expected：使用最新条目，缺省置 NULL，保持原图并更新报价',
  async ({ ac, stored, fields, expected }) => {
    await requireShopName(h.db);
    const f = await sectionCase(h);
    const pool = await f.pool();
    // The synthetic taobao raw ID derives its stable key from the final hyphen segment.
    const name = `shopRefresh${String(ac)}`;
    const key = `tb:${name}`;
    await f.item(pool, name, {
      image: IMAGE,
      title: '池内标题不能补店名',
      quoted_at: secondsAgo(f.clock, 600),
    });
    await seedShopName(h.db, f.owner.appId, pool, key, stored);
    await seedRef(h.db, f.owner, f.clock, name);
    const union = fakeUnion();
    union.answers.set(`rawRef-${name}`, () => ({
      platform: 'taobao',
      item_id: `rawRef-${name}`,
      title: '联盟新标题不能补店名',
      nick: '联盟昵称不能补店名',
      seller_nick: '合成卖家昵称',
      main_image_url: NEW_IMAGE,
      image_urls: [NEW_IMAGE],
      price_fen: 6000n,
      coupon_fen: 1000n,
      final_price_fen: 5000n,
      commission_rate_bp: 1500n,
      quoted_at: f.clock.now().toISOString(),
      ...fields,
    }));
    const handler = createPoolRefreshJobHandler(
      refreshOptionsOf(h.db, fakeQueue(), union.union, f.clock, f.settings, async () => undefined),
    );

    await handler({
      id: `synthetic-${name}`,
      queue: 'pool-refresh',
      name: 'refresh',
      payload: { app_id: f.owner.appId, product_key: key, platform: 'taobao' },
      attempt: 1,
    });

    expect(union.asked).toEqual([`rawRef-${name}`]);
    expect(await storedShopName(h.db, f.owner.appId, pool, key)).toBe(expected);
    expect(await itemRow(h.db, f.owner.appId, pool, key)).toMatchObject({
      image: IMAGE,
      title: '池内标题不能补店名',
      price_fen: 6000n,
      coupon_fen: 1000n,
      final_price_fen: 5000n,
      commission_rate_bp: 1500,
      quoted_at: f.clock.now(),
    });
    f.show(pool);
    const page = await f.run();
    await assertSchema(page, 'PageSectionItemsData');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      product_key: key,
      shop_name: expected,
      image: IMAGE,
      final_price_fen: 5000,
    });
  },
  TIMEOUT,
);
