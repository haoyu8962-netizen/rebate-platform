// B1-08zza 源码旁单元测试：classifyBuyTypeByLink 的各项核对（BR-ATTR-08 拼多多单推广位）。
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  classifyBuyTypeByLink,
  type BuyTypeLinkFacts,
  type BuyTypeLinkOrder,
} from './attribution.ts';

const at = (iso: string) => new FixedClock(iso).now();
const FALLBACK = { buy_type: 'self', scene_basis: 'fallback' };

const order: BuyTypeLinkOrder = {
  user_id: 'u-1',
  platform: 'pdd',
  goods_sign: 'sign-1',
  product_key: 'pp:1',
  paid_at: at('2026-10-15T16:00:00.000Z'),
};
const link: BuyTypeLinkFacts = {
  user_id: 'u-1',
  platform: 'pdd',
  raw_item_id: 'sign-1',
  product_key: 'pp:1',
  created_at: at('2026-10-14T00:00:00.000Z'),
  pid_scene: 'share',
};

it('[AC-B1-08zza#U8] 三项都对得上按 link；缺 link 或任一项不符一律 self / fallback', () => {
  expect(classifyBuyTypeByLink(order, link)).toEqual({ buy_type: 'share', scene_basis: 'link' });
  expect(classifyBuyTypeByLink(order, null)).toEqual(FALLBACK);
  expect(classifyBuyTypeByLink(order, { ...link, user_id: 'u-2' })).toEqual(FALLBACK);
  expect(classifyBuyTypeByLink(order, { ...link, platform: 'jd' })).toEqual(FALLBACK);
  expect(
    classifyBuyTypeByLink(order, { ...link, raw_item_id: 'sign-2', product_key: 'pp:2' }),
  ).toEqual(FALLBACK);
  expect(
    classifyBuyTypeByLink(order, { ...link, created_at: at('2026-10-15T16:00:00.001Z') }),
  ).toEqual(FALLBACK);
  expect(classifyBuyTypeByLink({ ...order, paid_at: null }, link)).toEqual(FALLBACK);
});

it('[AC-B1-08zza#U9] 商品按 goods_sign 或 product_key 之一相等；空串与 null 不算相等', () => {
  expect(classifyBuyTypeByLink(order, { ...link, raw_item_id: 'other' })).toEqual({
    buy_type: 'share',
    scene_basis: 'link',
  });
  expect(classifyBuyTypeByLink(order, { ...link, product_key: 'pp:other' })).toEqual({
    buy_type: 'share',
    scene_basis: 'link',
  });
  expect(
    classifyBuyTypeByLink(
      { ...order, goods_sign: '', product_key: null },
      { ...link, raw_item_id: '', product_key: null },
    ),
  ).toEqual(FALLBACK);
});

it('[AC-B1-08zza#U10] link 的 pid_scene 为空或未写明（如 query）不映射，按 self / fallback', () => {
  expect(classifyBuyTypeByLink(order, { ...link, pid_scene: null })).toEqual(FALLBACK);
  expect(classifyBuyTypeByLink(order, { ...link, pid_scene: 'query' })).toEqual(FALLBACK);
});
