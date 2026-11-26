import { expect, it } from 'vitest';
import { classifyBuyTypeByLink } from '../../../../apps/api/src/modules/orders/domain/attribution.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

it('[AC-B1-08zza#24] 订单已按 uid 归属，无主分享链接仍走 self / fallback', () => {
  const paidAt = new FixedClock('2026-10-15T16:00:00.000Z').now();
  const createdAt = new FixedClock('2026-10-14T12:00:00.000Z').now();
  // 若把空链接用户视为任意用户均可匹配，商品和时序都对得上的链接会误判 share / link。
  expect(
    classifyBuyTypeByLink(
      {
        user_id: 'uid-owner',
        platform: 'pdd',
        goods_sign: 'goods-sign',
        product_key: 'pp:123',
        paid_at: paidAt,
      },
      {
        user_id: null,
        platform: 'pdd',
        raw_item_id: 'goods-sign',
        product_key: 'pp:123',
        created_at: createdAt,
        pid_scene: 'share',
      },
    ),
  ).toEqual({ buy_type: 'self', scene_basis: 'fallback' });
});
