import { expect, it } from 'vitest';
import { num } from '../jd-orders/kit.ts';
import { basePrice, coupon, hourMs, ms, nowMs, type Row } from '../jd-goods/kit.ts';
import {
  expectBeijingInstant,
  expectNoScores,
  has,
  jdDetail,
  jdDetailRow,
  LOGO,
  SALES,
  scoresOf,
} from './kit.ts';

// 京东 jd.union.open.goods.query 详情（S09c，D10-736）：coupon_end_at 取所选那张券（与 coupon_fen 同一张，
// BR-PRICE-01 选券）的 useEndTime（毫秒）按 +08:00 表示；shop_scores 只出 shopInfo.shopLevel →
// { key: 'level' }，不出 desc / serv / lgst（D10-736 ⑥）；shop_ref = shopInfo.shopId 原文；
// 京东不出 sales_text、shop_logo。字段值全部合成。

const SHOP_ID = '1000012345';
const SHOP_LEVEL = '3.5';
const shop: Row = { shopId: num(SHOP_ID), shopLevel: num(SHOP_LEVEL) };

function withList(coupons: readonly Row[], overrides: Row = {}): Row {
  return jdDetailRow(shop, { couponInfo: { couponList: coupons }, ...overrides });
}

it('[AC-B1-04zzm#17] 京东详情：所选券的 useEndTime（毫秒）按北京时间 +08:00 写成 coupon_end_at', async () => {
  const detail = await jdDetail(withList([coupon()]));
  expect(detail.coupon_fen).toBe(1000n);
  // 取数时刻 2026-10-30T15:55:42Z，券结束于一小时后：北京时间已是 31 日。
  expectBeijingInstant(detail.coupon_end_at, nowMs + hourMs);
  expect(detail.coupon_end_at?.replace('.000', '')).toBe('2026-10-31T00:55:42+08:00');
});

/** Label, coupon list, the coupon_fen chosen, hours after the fetch at which that coupon ends. */
const choices: readonly [string, readonly Row[], bigint, number][] = [
  [
    '面额大的券结束更晚',
    [
      coupon(),
      coupon({ discount: num('15'), quota: num('20'), useEndTime: ms(nowMs + 2 * hourMs) }),
    ],
    1500n,
    2,
  ],
  [
    '面额大的券结束更早，不取最晚的',
    [
      coupon({ useEndTime: ms(nowMs + 3 * hourMs) }),
      coupon({ discount: num('15'), quota: num('20'), useEndTime: ms(nowMs + 2 * hourMs) }),
    ],
    1500n,
    2,
  ],
  [
    '同面额取门槛低的那张的结束时间',
    [
      coupon({ quota: num('30'), useEndTime: ms(nowMs + 3 * hourMs) }),
      coupon({ quota: num('20'), useEndTime: ms(nowMs + 2 * hourMs) }),
    ],
    1000n,
    2,
  ],
  [
    '不可领取的大券不提供结束时间',
    [
      coupon({ discount: num('15'), couponStatus: num('-1'), useEndTime: ms(nowMs + 5 * hourMs) }),
      coupon(),
    ],
    1000n,
    1,
  ],
  [
    '门槛不够的大券不提供结束时间',
    [
      coupon({ discount: num('20'), quota: num('50'), useEndTime: ms(nowMs + 6 * hourMs) }),
      coupon(),
    ],
    1000n,
    1,
  ],
  [
    'isBest 指向的小券不提供结束时间',
    [
      coupon({ discount: num('5'), isBest: num('1'), useEndTime: ms(nowMs + 4 * hourMs) }),
      coupon(),
    ],
    1000n,
    1,
  ],
];

it.each(choices)(
  '[AC-B1-04zzm#18] 京东详情：%s → coupon_end_at 是 coupon_fen 那张券的 useEndTime',
  async (_label, coupons, couponFen, hours) => {
    const detail = await jdDetail(withList(coupons));
    expect(detail.coupon_fen).toBe(couponFen);
    expectBeijingInstant(detail.coupon_end_at, nowMs + hours * hourMs);
  },
);

it.each([
  ['券列表为空', withList([])],
  ['没有 couponInfo', jdDetailRow(shop, { couponInfo: undefined })],
  ['券已过期', withList([coupon({ useEndTime: ms(nowMs - 1) })])],
  ['券未开始', withList([coupon({ useStartTime: ms(nowMs + 1) })])],
  ['门槛高于价格', withList([coupon({ quota: num('50') })])],
  ['不可领取', withList([coupon({ couponStatus: num('-1') })])],
  ['缺结束时间', withList([coupon({ useEndTime: undefined })])],
  ['面额为 0', withList([coupon({ discount: num('0') })])],
  ['价格异常（缺 price）', withList([coupon()], { priceInfo: basePrice({ price: undefined }) })],
  [
    '佣金异常（缺 commissionShare）',
    withList([coupon()], { commissionInfo: { commission: num('14.95') } }),
  ],
])('[AC-B1-04zzm#19] 京东详情：%s → coupon_fen 为 0，不出 coupon_end_at', async (_label, input) => {
  const control = await jdDetail(withList([coupon()]));
  expectBeijingInstant(control.coupon_end_at, nowMs + hourMs);
  const detail = await jdDetail(input);
  expect(detail.coupon_fen).toBe(0n);
  expect(has(detail, 'coupon_end_at')).toBe(false);
});

it('[AC-B1-04zzm#20] 京东详情：只出 shopInfo.shopLevel 一项 level（原文），不出 desc / serv / lgst', async () => {
  const detail = await jdDetail(
    jdDetailRow({
      ...shop,
      // 店铺三项分与排名一律不入 shop_scores（D10-736 ⑥）。
      userEvaluateScore: num('9.61'),
      commentFactorScoreRankGrade: '高',
      logisticsLvyueScore: num('9.52'),
      logisticsFactorScoreRankGrade: '中',
      afterServiceScore: num('9.43'),
      afsFactorScoreRankGrade: '低',
      scoreRankRate: num('98.70'),
    }),
  );
  expect(detail.shop_scores).toEqual([{ key: 'level', value: SHOP_LEVEL }]);
  expect(scoresOf(detail)).toEqual({ level: SHOP_LEVEL });
  for (const level of ['4', '4.85', '12']) {
    const other = await jdDetail(jdDetailRow({ shopLevel: num(level) }));
    expect(other.shop_scores, level).toEqual([{ key: 'level', value: level }]);
  }
});

it.each([
  ['shopLevel 缺失', jdDetailRow({ shopId: num(SHOP_ID) })],
  ['shopLevel 为 null', jdDetailRow({ shopLevel: null })],
  ['shopLevel 为空串', jdDetailRow({ shopLevel: '' })],
  ['shopLevel 为对象', jdDetailRow({ shopLevel: { value: num('3.5') } })],
  ['shopLevel 为布尔', jdDetailRow({ shopLevel: true })],
  ['没有 shopInfo', jdDetailRow(null)],
  ['只有顶层 shopLevel', jdDetailRow({}, { shopLevel: num('4.5') })],
])('[AC-B1-04zzm#21] 京东详情：%s → 不出店铺评分', async (_label, input) => {
  const control = await jdDetail(jdDetailRow(shop));
  expect(control.shop_scores).toEqual([{ key: 'level', value: SHOP_LEVEL }]);
  const detail = await jdDetail(input);
  expectNoScores(detail);
});

it('[AC-B1-04zzm#22] 京东详情：shopInfo.shopId 原文作 shop_ref，不读顶层或其他店铺键', async () => {
  const detail = await jdDetail(
    jdDetailRow({ ...shop, venderId: num('7000000001') }, { shopId: num('1000099999') }),
  );
  expect(detail.shop_ref).toBe(SHOP_ID);
  const other = await jdDetail(jdDetailRow({ shopId: num('1000000001') }));
  expect(other.shop_ref).toBe('1000000001');
});

it.each([
  ['shopId 缺失', jdDetailRow({ shopLevel: num(SHOP_LEVEL) })],
  ['shopId 为 null', jdDetailRow({ shopId: null })],
  ['shopId 为空串', jdDetailRow({ shopId: '' })],
  ['shopId 为布尔', jdDetailRow({ shopId: true })],
  ['shopId 为对象', jdDetailRow({ shopId: { id: num(SHOP_ID) } })],
  ['没有 shopInfo', jdDetailRow(null)],
  ['只有顶层 shopId', jdDetailRow({}, { shopId: num(SHOP_ID) })],
])('[AC-B1-04zzm#23] 京东详情：%s → 不出 shop_ref', async (_label, input) => {
  const control = await jdDetail(jdDetailRow(shop));
  expect(control.shop_ref).toBe(SHOP_ID);
  const detail = await jdDetail(input);
  expect(has(detail, 'shop_ref')).toBe(false);
});

it('[AC-B1-04zzm#24] 京东详情：不出 sales_text、shop_logo，报文里有同类或同名的键也不出', async () => {
  const detail = await jdDetail(
    jdDetailRow(
      { ...shop, shopLogo: LOGO, logo: LOGO, shop_logo: LOGO },
      {
        sales_tip: SALES,
        sales_text: SALES,
        shop_logo: LOGO,
        mall_img_url: LOGO,
        inOrderCount30Days: num('12000'),
        inOrderCount30DaysSku: num('300'),
        comments: num('5000'),
      },
    ),
  );
  expect(detail.shop_ref).toBe(SHOP_ID);
  expect(detail.shop_scores).toEqual([{ key: 'level', value: SHOP_LEVEL }]);
  expect(has(detail, 'sales_text')).toBe(false);
  expect(has(detail, 'shop_logo')).toBe(false);
});
