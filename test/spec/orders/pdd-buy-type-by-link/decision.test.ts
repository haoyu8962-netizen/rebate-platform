import { expect, it } from 'vitest';
import {
  classifyBuyTypeByLink,
  type BuyTypeLinkFacts,
  type BuyTypeLinkOrder,
} from '../../../../apps/api/src/modules/orders/domain/attribution.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

const paidAt = new FixedClock('2026-10-15T16:00:00.000Z').now();

const order: BuyTypeLinkOrder = {
  user_id: 'uid-owner',
  platform: 'pdd',
  goods_sign: 'goods-sign',
  product_key: 'pdd:123',
  paid_at: paidAt,
};

const link: BuyTypeLinkFacts = {
  user_id: 'uid-owner',
  platform: 'pdd',
  raw_item_id: 'goods-sign',
  product_key: 'pdd:123',
  created_at: paidAt,
  pid_scene: 'share',
};

it.each([
  ['share', 'share'],
  ['self_buy', 'self'],
  ['agent', 'self'],
  ['taolijin', 'self'],
  ['fallback', 'self'],
] as const)(
  '[AC-B1-08zza#1] 链接与付款同刻有效，链接场景 %s 映射为 %s，依据仍为 link',
  (pidScene, buyType) => {
    // 若把同刻排除、只承认分享链接，或让 self 一律记 fallback，此处会因分类或依据不同而红。
    expect(classifyBuyTypeByLink(order, { ...link, pid_scene: pidScene })).toEqual({
      buy_type: buyType,
      scene_basis: 'link',
    });
  },
);

it('[AC-B1-08zza#2] uid 未归属时，无主链接不能凭两个 null 相等判为分享', () => {
  // 若只比较两个 user_id 是否相等，无主链接会误判 share / link。
  expect(classifyBuyTypeByLink({ ...order, user_id: null }, { ...link, user_id: null })).toEqual({
    buy_type: 'self',
    scene_basis: 'fallback',
  });
});

it('[AC-B1-08zza#3] 商品两侧都缺标识时不能凭两个 null 相等判为同商品', () => {
  // 若把 null 当成商品键匹配，缺少商品证据仍会误判 share / link。
  expect(
    classifyBuyTypeByLink(
      { ...order, goods_sign: null, product_key: null },
      { ...link, raw_item_id: null, product_key: null },
    ),
  ).toEqual({ buy_type: 'self', scene_basis: 'fallback' });
});
