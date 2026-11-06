// B1-05zk (D10-664 S-09 S09b, D10-736): which cards carry the five detail-only keys. 04 §8.3: list
// cards, Agent cards, favourites and the hot list do not; the pool fallback of a detail carries them
// empty (null / null / null / [] / false). Contract CT-26s: only GET /v1/products/{product_key}.
import { expect, it } from 'vitest';
import { getProduct } from '../../../../apps/api/src/modules/catalog/detail.ts';
import { favoriteCardView } from '../../../../apps/api/src/modules/catalog/index.ts';
import { UnionError, type UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import { item } from '../detail/kit.ts';
import { candidate, fixture as searchFixture } from '../search/kit.ts';
import {
  APP_ID,
  COUPON_END,
  EMPTY,
  EXTRA_KEYS,
  LOGO,
  PRODUCT_KEY,
  SALES,
  SCORES,
  SHOP_REF,
  detailFixture,
  expected,
  extras,
  extrasItem,
  favoriteCard,
  ownKeys,
  poolReader,
} from './kit.ts';

const ALL_ON = { coupon: true, sales: true, scores: true } as const;
const ALL_OWN = [true, true, true, true, true];

it('[AC-B1-05zk#11] 收藏卡（card-port 复用 getProduct）不带五个详情专用键，即便开关全开、联盟都给了；同一答复走详情路由五个键都在', async () => {
  const f = detailFixture();
  f.allOn();
  const outcome = await favoriteCard(extrasItem(), f.config);
  expect(outcome.kind).toBe('card');
  const view = favoriteCardView(outcome);
  expect(view.invalid).toBe(false);
  for (const key of EXTRA_KEYS) {
    expect(outcome).not.toHaveProperty(['card', key]);
    expect(view.productCard).not.toHaveProperty([key]);
  }

  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected(ALL_ON));
});

it.each([
  { name: '池行只有原有字段', pooled: item() },
  { name: '池行另带了券结束时刻、销量、店铺 logo 与评分、店铺标识', pooled: extrasItem() },
])(
  '[AC-B1-05zk#12] 联盟查不到走池回退（$name）：开关全开也出 coupon_end_at null、sales_text null、shop_logo null、shop_scores []、shop_entry false',
  async ({ pooled }) => {
    const f = detailFixture();
    f.allOn();
    const reader = poolReader(pooled);
    f.detail.mockRejectedValue(
      new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    );
    const card = await getProduct(
      { product_key: PRODUCT_KEY },
      { ...f.options, poolReader: reader },
    );
    expect(card.stale).toBe(true);
    expect(reader.detail).toHaveBeenCalledWith(APP_ID, PRODUCT_KEY);
    expect(ownKeys(card)).toEqual(ALL_OWN);
    expect(extras(card)).toEqual(EMPTY);
  },
);

it('[AC-B1-05zk#13] 搜索卡不带五个详情专用键：开关全开、联盟搜索结果带了这些字段也没有；详情卡带', async () => {
  const s = searchFixture();
  s.configValue.mockImplementation(async (_appId: string, key: string) => ({
    value:
      key.startsWith('search.enabled.') ||
      key.startsWith('detail.') ||
      key.startsWith('shop.entry.enabled.'),
    version: 1,
  }));
  const base = candidate('extras');
  const rich: UnionItemDetail = {
    ...base.item,
    coupon_end_at: COUPON_END,
    sales_text: SALES,
    shop_logo: LOGO,
    shop_scores: SCORES.map((score) => ({ ...score })),
    shop_ref: SHOP_REF,
  };
  s.pages.set(1, { items: [{ ...base, item: rich }], hasMore: false });
  const result = await s.run();
  expect(result.items).toHaveLength(1);
  for (const searched of result.items) {
    for (const key of EXTRA_KEYS) expect(Object.hasOwn(searched, key)).toBe(false);
  }

  const f = detailFixture();
  f.allOn();
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected(ALL_ON));
});
