import { expect, it, vi } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  jdDetailItemId,
  jdGoodsCursor,
  jdGoodsHasMore,
  jdGoodsRef,
  JD_GOODS_PAGE_SIZE,
  jingfenItemId,
  mapJdGoods,
  parseJdGoodsCursor,
  pickJdCoupon,
  type JdGoodsPage,
} from './goods.ts';
import { JdRawNumber } from './response.ts';

// 规则测试没钉住的行为。报文全部合成，不是任何京东接口的录制。
const now = new Date('2026-10-30T15:55:42.000Z');
const nowMs = now.getTime();
const hourMs = 3_600_000;

function num(text: string): JdRawNumber {
  return new JdRawNumber(text);
}

function coupon(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    discount: num('10'),
    quota: num('39'),
    useStartTime: num(String(nowMs - hourMs)),
    useEndTime: num(String(nowMs + hourMs)),
    link: 'https://coupon.invalid/unit-marker',
    ...overrides,
  };
}

function goods(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'unitAseg_Bseg',
    skuId: num('100012345678'),
    skuName: '单元测试商品',
    priceInfo: { price: num('39.90') },
    commissionInfo: { commissionShare: num('50') },
    ...overrides,
  };
}

function page(warn?: JdGoodsPage['warn']): JdGoodsPage {
  return { now, productKeyMode: 'item', warn };
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04zc-UNIT#1] 佣金比例异常的 PRICE_ANOMALY 只带固定字段，不带比例原文', () => {
  const warn = vi.fn();
  const item = mapJdGoods(
    goods({ commissionInfo: { commissionShare: num('100.517') } }),
    page(warn),
  );
  expect(item).toMatchObject({
    price_status: 'anomaly',
    price_anomaly_reason: 'missing_field',
    price_fen: 0n,
    final_price_fen: 0n,
  });
  expect(warn.mock.calls).toEqual([
    [
      {
        method: 'jd.union.open.goods.query',
        code: 'PRICE_ANOMALY',
        item_id: 'unitAseg_Bseg',
        reason: 'missing_field',
      },
    ],
  ]);
});

it('[AC-B1-04zc-UNIT#2] 价格与佣金同时异常：只告警一次，原因取价格的', () => {
  const warn = vi.fn();
  const input = goods({ priceInfo: { price: num('0') }, commissionInfo: {} });
  expect(mapJdGoods(input, page(warn)).price_anomaly_reason).toBe('invalid_price');
  expect(warn).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zc-UNIT#3] 异常商品不做 lowestCouponPrice 比对', () => {
  const warn = vi.fn();
  const priceInfo = { price: num('39.90'), lowestCouponPrice: num('1') };
  mapJdGoods(goods({ priceInfo, commissionInfo: {} }), page(warn));
  expect(warn.mock.calls.map(([event]) => (event as { code: string }).code)).toEqual([
    'PRICE_ANOMALY',
  ]);
});

it('[AC-B1-04zc-UNIT#4] 券的时间只收 JSON 数字，券列表不是数组时没有券', () => {
  const stringTime = coupon({ useStartTime: String(nowMs - hourMs) });
  expect(pickJdCoupon([stringTime], 3990n, nowMs)).toBeNull();
  expect(pickJdCoupon({ note: 'x' }, 3990n, nowMs)).toBeNull();
  expect(pickJdCoupon(['x', num('1')], 3990n, nowMs)).toBeNull();
});

it('[AC-B1-04zc-UNIT#5] 选券结果只有面额与门槛，不带券链接', () => {
  expect(pickJdCoupon([coupon()], 3990n, nowMs)).toEqual({
    discount_fen: 1000n,
    quota_fen: 3900n,
  });
});

it('[AC-B1-04zc-UNIT#6] skuId 为 0 或非数字算缺失，不进商品键', () => {
  expect(jdGoodsRef(goods({ skuId: num('0') }), 'sku')).toBeNull();
  expect(jdGoodsRef(goods({ skuId: 'abc' }), 'sku')).toBeNull();
  expect(jdGoodsRef(goods({ skuId: num('0') }), 'item')).toEqual({
    platform: 'jd',
    item_id: 'unitAseg_Bseg',
    itemId: 'unitAseg_Bseg',
  });
  expect(jdGoodsRef('not a row', 'item')).toBeNull();
});

it('[AC-B1-04zc-UNIT#7] 标题或商品键不合格的行 invalid_dto', () => {
  expect(code(() => mapJdGoods(goods({ skuName: '  ' }), page()))).toBe('invalid_dto');
  expect(code(() => mapJdGoods(goods({ itemId: undefined }), page()))).toBe('invalid_dto');
  expect(code(() => mapJdGoods('not a row', page()))).toBe('invalid_dto');
});

it('[AC-B1-04zc-UNIT#8] totalCount 不可用时满页才继续；有 totalCount 时短页也按它判定', () => {
  expect(jdGoodsHasMore({}, JD_GOODS_PAGE_SIZE, 1)).toBe(true);
  expect(jdGoodsHasMore({}, JD_GOODS_PAGE_SIZE - 1, 1)).toBe(false);
  expect(jdGoodsHasMore({ totalCount: 'x' }, JD_GOODS_PAGE_SIZE, 1)).toBe(true);
  expect(jdGoodsHasMore({ totalCount: num('100') }, 5, 1)).toBe(true);
  expect(jdGoodsHasMore({ totalCount: num('100') }, 0, 1)).toBe(false);
  expect(jdGoodsHasMore({ totalCount: num('25') }, 5, 2)).toBe(false);
});

it('[AC-B1-04zc-UNIT#9] 游标往返保留页码，第 1 页没有游标', () => {
  expect(parseJdGoodsCursor(jdGoodsCursor(7))).toBe(7);
  expect(code(() => parseJdGoodsCursor('jd-goods:1'))).toBe('invalid_dto');
  expect(code(() => parseJdGoodsCursor('jd-goods:2:x'))).toBe('invalid_dto');
});

it('[AC-B1-04zc-UNIT#10] jingfen 路径里 itemId 字符集之外的不算详情页', () => {
  expect(jingfenItemId('https://jingfen.jd.com/detail/unitA_B-c.html#top')).toBe('unitA_B-c');
  expect(jingfenItemId('https://jingfen.jd.com/detail/a%2Fb.html')).toBeNull();
  expect(jingfenItemId('https://jingfen.jd.com/detail/.html')).toBeNull();
});

it('[AC-B1-04zc-UNIT#11] item 模式只有 skuId 的引用 invalid_dto，不把 skuId 当 itemIds', () => {
  expect(code(() => jdDetailItemId({ platform: 'jd', skuId: '1' }, 'item'))).toBe('invalid_dto');
  expect(jdDetailItemId({ platform: 'jd', item_id: 'a_b', itemId: 'c_d' }, 'item')).toBe('a_b');
  expect(code(() => jdDetailItemId({ platform: 'jd' }, 'sku'))).toBe('invalid_dto');
  expect(code(() => jdDetailItemId({ platform: 'jd', skuId: '1' }, 'sku'))).toBe(
    'item_unavailable',
  );
});

function shopRow(shopInfo: Record<string, unknown>, coupons: readonly unknown[] = [coupon()]) {
  return goods({ shopInfo, couponInfo: { couponList: coupons } });
}

it('[AC-B1-04zzm-UNIT#1] 京东详情：所选券结束 +08:00、shopLevel → level、shopId 原文；不出销量与 logo', () => {
  const mapped = mapJdGoods(
    shopRow({ shopName: 'unit', shopLevel: num('4.5'), shopId: num('1000012345') }),
    page(),
  );
  expect(mapped.coupon_fen).toBe(1000n);
  // nowMs + 1h = 2026-10-30T16:55:42Z → 北京 2026-10-31T00:55:42。
  expect(mapped.coupon_end_at).toBe('2026-10-31T00:55:42+08:00');
  expect(mapped.shop_scores).toEqual([{ key: 'level', value: '4.5' }]);
  expect(mapped.shop_ref).toBe('1000012345');
  expect(Object.hasOwn(mapped, 'sales_text')).toBe(false);
  expect(Object.hasOwn(mapped, 'shop_logo')).toBe(false);
  const fraction = mapJdGoods(
    shopRow({}, [coupon({ useEndTime: num(String(nowMs + hourMs + 7)) })]),
    page(),
  );
  expect(fraction.coupon_end_at).toBe('2026-10-31T00:55:42.007+08:00');
});

it('[AC-B1-04zzm-UNIT#2] 面额与门槛完全并列：结束时刻取先出现的那张，与 pickJdCoupon 同一张', () => {
  const first = coupon({ useEndTime: num(String(nowMs + 2 * hourMs)) });
  const second = coupon({ useEndTime: num(String(nowMs + 3 * hourMs)) });
  expect(pickJdCoupon([first, second], 3990n, nowMs)).toEqual({
    discount_fen: 1000n,
    quota_fen: 3900n,
  });
  const mapped = mapJdGoods(shopRow({}, [first, second]), page());
  expect(mapped.coupon_fen).toBe(1000n);
  expect(mapped.coupon_end_at).toBe('2026-10-31T01:55:42+08:00');
  const swapped = mapJdGoods(shopRow({}, [second, first]), page());
  expect(swapped.coupon_end_at).toBe('2026-10-31T02:55:42+08:00');
});

it('[AC-B1-04zzm-UNIT#3] 京东 shopId 为 0、负数、小数（数字或字符串）、前导零都不出 shop_ref', () => {
  for (const shopId of [
    num('0'),
    '0',
    num('-5'),
    '-5',
    num('12.5'),
    '12.5',
    num('1e3'),
    '0012',
    ' 12',
  ]) {
    const mapped = mapJdGoods(shopRow({ shopId }), page());
    expect(Object.hasOwn(mapped, 'shop_ref'), String(shopId)).toBe(false);
  }
  expect(mapJdGoods(shopRow({ shopId: '73129' }), page()).shop_ref).toBe('73129');
});

it.each([
  ['JdRawNumber', num('7000101')],
  ['JS number', 7000101],
  ['字符串', '7000101'],
] as const)('[AC-B1-04zzv-UNIT#1] cid1 为%s → category_l1_id 十进制串', (_label, cid1) => {
  const item = mapJdGoods(goods({ categoryInfo: { cid1, cid1Name: '合成一级类目' } }), page());
  expect(item.category_l1_id).toBe('7000101');
  expect(item.category_l1_name).toBe('合成一级类目');
});

it.each([
  ['字符串 00', '00'],
  ['字符串 000', '000'],
  ['字符串 0123', '0123'],
  ['JdRawNumber 0123', num('0123')],
  ['JS number 0', 0],
  ['JS number 负数', -5],
  ['JS number 小数', 1.5],
  ['JS number NaN', Number.NaN],
  ['JS number 超出安全整数', 2 ** 60],
  ['JdRawNumber 指数写法', num('7e6')],
  ['字符串带空格', ' 7000101'],
] as const)('[AC-B1-04zzv-UNIT#2] cid1 为%s → 不出 category_l1_id，不告警', (_label, cid1) => {
  const warn = vi.fn();
  const item = mapJdGoods(goods({ categoryInfo: { cid1 } }), page(warn));
  expect(Object.hasOwn(item, 'category_l1_id')).toBe(false);
  expect(item.price_status).toBe('ok');
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzv-UNIT#3] 价格异常的行同样带一级类目（类目不依赖价格）', () => {
  const item = mapJdGoods(
    goods({ priceInfo: {}, categoryInfo: { cid1: num('7000101'), cid1Name: '\u3000合成\u3000' } }),
    page(),
  );
  expect(item.price_status).toBe('anomaly');
  expect(item.category_l1_id).toBe('7000101');
  expect(item.category_l1_name).toBe('\u3000合成\u3000');
});
