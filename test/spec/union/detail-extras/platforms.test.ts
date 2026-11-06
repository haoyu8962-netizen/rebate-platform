import { expect, it } from 'vitest';
import { num } from '../jd-orders/kit.ts';
import {
  ctx as tbCtx,
  DAY_MS,
  detailRow,
  detailSetup,
  nowMs as tbNowMs,
  ref as tbRef,
} from '../taobao-goods/kit.ts';
import {
  EXTRA_FIELDS,
  extrasPresent,
  jdDetail,
  jdDetailRow,
  LOGO,
  pddDetail,
  pddDetailRow,
  SALES,
  scoresOf,
} from './kit.ts';

// 三平台对照（S09c，D10-736 ⑤ / ⑥）：拼多多五个字段都可出；京东只出券结束时间、店铺等级、店铺标识；
// 淘宝（官方详情 upgrade.get）本期一个都不出，报文里有券结束时间、销量、店铺类字段或同名键也不出。

/** Store-like and same-name keys a Taobao detail row might carry; none may surface. */
const taobaoDecoys = {
  coupon_end_at: '2099-01-01T00:00:00+08:00',
  sales_text: SALES,
  shop_logo: LOGO,
  shop_scores: [{ key: 'level', value: '5' }],
  shop_ref: 'synthetic-shop-ref',
  coupon_end_time: String(tbNowMs + DAY_MS),
  sales_tip: SALES,
  mall_img_url: LOGO,
  mall_id: 73_129,
  shop_dsr: 4.9,
  shop_level: 5,
  volume: 12_000,
  annual_vol: '1万+',
};

it('[AC-B1-04zzm#25] 三平台对照：拼多多出五个字段，京东出三个，淘宝详情一个都不出', async () => {
  const pdd = await pddDetail(pddDetailRow());
  expect(extrasPresent(pdd)).toEqual([...EXTRA_FIELDS]);
  expect(scoresOf(pdd)).toEqual({ desc: '高', serv: '中', lgst: '低' });

  const jd = await jdDetail(jdDetailRow({ shopId: num('1000012345'), shopLevel: num('3.5') }));
  expect(extrasPresent(jd)).toEqual(['coupon_end_at', 'shop_scores', 'shop_ref']);
  expect(scoresOf(jd)).toEqual({ level: '3.5' });

  const { adapter } = detailSetup([
    detailRow({
      top: taobaoDecoys,
      basic: { ...taobaoDecoys, shop_title: '合成淘宝小店' },
      price: { coupon_end_time: String(tbNowMs + DAY_MS) },
    }),
  ]);
  const taobao = await adapter.getItem(tbRef, tbCtx);
  // 有可用券、有店名，仍不出这五个字段。
  expect(taobao.coupon_fen).toBe(1000n);
  expect(taobao.shop_name).toBe('合成淘宝小店');
  expect(extrasPresent(taobao)).toEqual([]);
});

it('[AC-B1-04zzm#26] 各平台出的值都合契约形状：+08:00 时刻、https logo、评分键唯一且值非空', async () => {
  const pdd = await pddDetail(pddDetailRow());
  const jd = await jdDetail(jdDetailRow({ shopId: num('1000012345'), shopLevel: num('3.5') }));
  for (const detail of [pdd, jd]) {
    expect(detail.coupon_end_at).toBeTypeOf('string');
    expect(detail.shop_ref).toBeTypeOf('string');
    expect(detail.coupon_end_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?\+08:00$/,
    );
    expect(detail.shop_ref).toMatch(/^[1-9][0-9]*$/);
    const scores = scoresOf(detail);
    expect(Object.keys(scores).length).toBeGreaterThan(0);
  }
  expect(pdd.shop_logo?.startsWith('https://')).toBe(true);
  expect(pdd.sales_text).toBe(SALES);
});
