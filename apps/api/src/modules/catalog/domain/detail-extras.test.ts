import { expect, it } from 'vitest';
import {
  detailExtraSwitchKeys,
  detailExtras,
  emptyDetailExtras,
  shopEntryOf,
  switchOn,
} from './detail-extras.ts';

const FULL = {
  coupon_end_at: '2026-10-31T23:59:59+08:00',
  sales_text: '已拼 10 万+件',
  shop_logo: 'https://img.example.test/unit/logo.png',
  shop_scores: [
    { key: 'desc', value: '高' },
    { key: 'level', value: '5' },
  ],
} as const;
const ON = { couponEnd: true, sales: true, shopScores: true } as const;
const OFF = { couponEnd: false, sales: false, shopScores: false } as const;

it('[AC-B1-05zk] 只有严格的 true 算开', () => {
  expect(switchOn(true)).toBe(true);
  for (const value of [false, 'true', 1, 'on', null, undefined, { enabled: true }, [true]]) {
    expect(switchOn(value)).toBe(false);
  }
});

it('[AC-B1-05zk] 开关键按平台代码拼', () => {
  expect(detailExtraSwitchKeys('pdd')).toEqual({
    couponEnd: 'detail.coupon_end.enabled.pdd',
    sales: 'detail.sales.enabled.pdd',
    shopScores: 'detail.shop_scores.enabled.pdd',
  });
});

it('[AC-B1-05zk] 全开：联盟值原样，评分复制且顺序不变，shop_entry 为 false', () => {
  const extras = detailExtras(FULL, ON);
  expect(extras).toEqual({ ...FULL, shop_entry: false });
  expect(extras.shop_scores).not.toBe(FULL.shop_scores);
});

it('[AC-B1-05zk] 全关：coupon_end_at / sales_text 为 null，shop_scores 为 []，shop_logo 不受开关', () => {
  expect(detailExtras(FULL, OFF)).toEqual({
    coupon_end_at: null,
    sales_text: null,
    shop_logo: FULL.shop_logo,
    shop_scores: [],
    shop_entry: false,
  });
});

it('[AC-B1-05zk] 每个开关只管自己的字段', () => {
  expect(detailExtras(FULL, { ...OFF, sales: true })).toMatchObject({
    coupon_end_at: null,
    sales_text: FULL.sales_text,
    shop_scores: [],
  });
  expect(detailExtras(FULL, { ...OFF, shopScores: true })).toMatchObject({
    coupon_end_at: null,
    sales_text: null,
    shop_scores: FULL.shop_scores,
  });
});

it('[AC-B1-05zk] 开关开但联盟没给：null / null / null / [] / false，不补默认值', () => {
  expect(detailExtras({}, ON)).toEqual(emptyDetailExtras());
  expect(emptyDetailExtras()).toEqual({
    coupon_end_at: null,
    sales_text: null,
    shop_logo: null,
    shop_scores: [],
    shop_entry: false,
  });
});

it('[AC-B1-05zm-UNIT#1] detailExtras 不传进店判定时 shop_entry 为 false，传 true 才为 true', () => {
  expect(detailExtras(FULL, ON).shop_entry).toBe(false);
  expect(detailExtras(FULL, ON, true).shop_entry).toBe(true);
});

it('[AC-B1-05zm-UNIT#2] 进店判定：来源须在适配器声明里且严格相等，店铺两字段须非空', () => {
  const met = {
    enabled: true,
    source: 'dataoke',
    adapterSources: ['dataoke'],
    item: { shop_ref: '123', shop_name: '合成店' },
  } as const;
  expect(shopEntryOf(met)).toBe(true);
  expect(shopEntryOf({ ...met, adapterSources: ['other'] })).toBe(false);
  expect(shopEntryOf({ ...met, source: ' dataoke' })).toBe(false);
  expect(shopEntryOf({ ...met, item: { shop_ref: '123' } })).toBe(false);
});
