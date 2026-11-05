import { expect, it } from 'vitest';
import { APP, COMPARE, NORMAL, fixture, item, version, viewer } from './fixtures.ts';

it('[AC-B2-03c#39] BR-PRICE-07 比价系数不参与报价：淘宝按接口佣金率单值，系数 5000、2500 同额', async () => {
  const f = fixture();
  f.values.set('rebate.taobao.compare_rate_ratio_bp', 5000);
  f.values.set('tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 });
  f.versions.set(APP, [
    version({
      rules: version().rules.map((r) => ({ ...r, r_own_bp: 8000, r_direct_bp: 0 })),
    }),
  ]);
  // B1-05zc (D10-641): gross = floor(20000 × 1235 / 10000) = 2470；fee = 0，N = B = 2470。
  // 本人 = floor(2470 × 8000 / 10000) = 1976；返后价 = 20000 − 1976 = 18024。
  // 旧区间下限（987，返后价 19013）不再出现，系数换成 2500 金额也不变。
  const product = item({
    price_fen: 20000n,
    coupon_fen: 0n,
    final_price_fen: 20000n,
    commission_rate_bp: 1235n,
  });
  const single = {
    rebateMinFen: 1976n,
    rebateMaxFen: 1976n,
    estNetPriceFen: 18024n,
    rebateBasis: 'normal',
  };
  expect(await f.quoter.quote(product, viewer())).toEqual(single);
  f.values.set('rebate.taobao.compare_rate_ratio_bp', 2500);
  expect(await f.quoter.quote(product, viewer(), { ...NORMAL, entrySource: 'search' })).toEqual(
    single,
  );
  await expect(f.quoter.quote(product, viewer(), COMPARE)).rejects.toThrow(TypeError);
  expect(f.configValue).not.toHaveBeenCalledWith(APP, 'rebate.taobao.compare_rate_ratio_bp');
});

it('[AC-B2-03c#40] BR-CALC-20 拼多多自购同时应用自购系数和账号等级系数', async () => {
  const f = fixture();
  f.values.set('union.pdd.self_buy_factor_bp', 7500);
  f.values.set('union.pdd.account_level_factor_bp', 8000);
  // gross = floor(10000 × 400 / 10000) = 400，fee = 0。
  // 自购 N = floor(400 × 7500 × 8000 / 100000000) = 240。
  // reserve_bp = 0，B = 240；本人 = floor(240 × 5000 / 10000) = 120。
  // 忽略账号等级系数会得到 150，不能通过此断言。
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 400n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 120n,
    rebateMaxFen: 120n,
    estNetPriceFen: 9880n,
    rebateBasis: 'normal',
  });
});

it('[AC-B2-03c#41] BR-CALC-20 拼多多分享应用账号等级系数，不应用自购系数', async () => {
  const f = fixture();
  f.values.set('union.pdd.self_buy_factor_bp', 7500);
  f.values.set('union.pdd.account_level_factor_bp', 8000);
  // gross = 400，fee = 0；分享 N = floor(400 × 8000 / 10000) = 320。
  // reserve_bp = 0，B = 320；L1 share 本人 = floor(320 × 5000 / 10000) = 160。
  // 忽略账号等级系数会得到 200，误用自购系数会得到 120。
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 400n }), viewer(), {
      ...NORMAL,
      buyType: 'share',
    }),
  ).toEqual({
    rebateMinFen: 160n,
    rebateMaxFen: 160n,
    estNetPriceFen: 9840n,
    rebateBasis: 'normal',
  });
});

it('[AC-B2-03c#42] BR-PRICE-08 淘宝 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'taobao', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});

it('[AC-B2-03c#43] BR-PRICE-08 京东 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'jd', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});

it('[AC-B2-03c#44] BR-PRICE-08 拼多多 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});
