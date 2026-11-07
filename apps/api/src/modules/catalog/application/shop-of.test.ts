import { expect, it, vi } from 'vitest';
import { RedisUnavailableError, type RedisNamespace } from '../../platform/index.ts';
import { createShopOf } from './shop-of.ts';

function redisAnswering(get: RedisNamespace['get']): RedisNamespace {
  return {
    get,
    set: vi.fn(async () => undefined),
    eval: vi.fn(async () => null),
  } as unknown as RedisNamespace;
}

const ENTRY = JSON.stringify({
  v: 1,
  fetched_at_ms: 0,
  data: {
    platform: 'taobao',
    item_id: 'unit-raw',
    title: '合成单测商品',
    quoted_at: '2026-11-01T00:00:00.000Z',
    price_fen: '100',
    coupon_fen: '0',
    final_price_fen: '100',
    commission_rate_bp: '0',
    shop_ref: '42',
    shop_name: '合成单测店',
  },
});

it('[AC-B1-05zm-UNIT#4] Redis 故障按没有缓存，答 null 不报错；不读 product_refs', async () => {
  const refs = { shopIdOf: vi.fn(async () => '42') };
  const shopOf = createShopOf({
    cache: redisAnswering(async () => {
      throw new RedisUnavailableError('unexpected_reply');
    }),
    refs,
  });
  await expect(shopOf('unit-app', 'tb:unit')).resolves.toBeNull();
  expect(refs.shopIdOf).not.toHaveBeenCalled();
});

it('[AC-B1-05zm-UNIT#5] 只读本 app 的键 <app_id>:product:<product_key>；Redis 的其他错误照常抛出', async () => {
  const get = vi.fn(async (key: string) => (key === 'unit-app:product:tb:unit' ? ENTRY : null));
  const shopOf = createShopOf({ cache: redisAnswering(get), refs: { shopIdOf: vi.fn() } });
  await expect(shopOf('unit-app', 'tb:unit')).resolves.toEqual({
    shopRef: '42',
    shopName: '合成单测店',
  });
  expect(get).toHaveBeenCalledWith('unit-app:product:tb:unit');
  const broken = createShopOf({
    cache: redisAnswering(async () => {
      throw new TypeError('unit: unexpected');
    }),
    refs: { shopIdOf: vi.fn() },
  });
  await expect(broken('unit-app', 'tb:unit')).rejects.toThrow(TypeError);
});
