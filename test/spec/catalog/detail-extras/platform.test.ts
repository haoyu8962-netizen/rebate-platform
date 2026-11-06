// B1-05zk 第 2 次 (spec-test r1 S2): the detail switches are read under the product's own platform
// code. A pinduoduo detail (pdd:<goods_id>, platform code pdd) follows detail.*.enabled.pdd and
// ignores detail.*.enabled.taobao; the taobao detail of the same configuration follows .taobao.
import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  COUPON_SWITCH,
  SALES_SWITCH,
  SCORES_SWITCH,
  detailFixture,
  expected,
  extras,
  extrasItem,
  ownKeys,
} from './kit.ts';

const PDD_KEY = 'pdd:synthetic001';
const PDD_COUPON = 'detail.coupon_end.enabled.pdd';
const PDD_SALES = 'detail.sales.enabled.pdd';
const PDD_SCORES = 'detail.shop_scores.enabled.pdd';
const TAOBAO_SWITCHES = [COUPON_SWITCH, SALES_SWITCH, SCORES_SWITCH] as const;
const PDD_SWITCHES = [PDD_COUPON, PDD_SALES, PDD_SCORES] as const;
const ALL_ON = { coupon: true, sales: true, scores: true } as const;
const ALL_OWN = [true, true, true, true, true];

/** A pinduoduo union detail (goods_id is the key, goods_sign the raw ID) with every extra field. */
function pddItem(): UnionItemDetail {
  return extrasItem({
    platform: 'pdd',
    item_id: null,
    goods_id: 'synthetic001',
    goods_sign: 'synthetic-opaque-sign',
  });
}

it('[AC-B1-05zk#23] .pdd 三个详情开关开、.taobao 关：拼多多详情带 coupon_end_at、sales_text、shop_scores 联盟原值；同配置下淘宝详情仍置空', async () => {
  const f = detailFixture();
  for (const key of PDD_SWITCHES) f.values.set(key, true);
  for (const key of TAOBAO_SWITCHES) f.values.set(key, false);
  f.detail.mockResolvedValue(pddItem());
  const pdd = await f.get({ product_key: PDD_KEY });
  expect(pdd.product_key).toBe(PDD_KEY);
  expect(ownKeys(pdd)).toEqual(ALL_OWN);
  expect(extras(pdd)).toEqual(expected(ALL_ON));

  f.detail.mockResolvedValue(extrasItem());
  const taobao = await f.get();
  expect(ownKeys(taobao)).toEqual(ALL_OWN);
  expect(extras(taobao)).toEqual(expected({}));
});

it('[AC-B1-05zk#24] .taobao 三个详情开关开、.pdd 关：拼多多详情 coupon_end_at null、sales_text null、shop_scores []；同配置下淘宝详情带联盟原值', async () => {
  const f = detailFixture();
  for (const key of TAOBAO_SWITCHES) f.values.set(key, true);
  for (const key of PDD_SWITCHES) f.values.set(key, false);
  f.detail.mockResolvedValue(pddItem());
  const pdd = await f.get({ product_key: PDD_KEY });
  expect(pdd.product_key).toBe(PDD_KEY);
  expect(ownKeys(pdd)).toEqual(ALL_OWN);
  expect(extras(pdd)).toEqual(expected({}));

  f.detail.mockResolvedValue(extrasItem());
  const taobao = await f.get();
  expect(ownKeys(taobao)).toEqual(ALL_OWN);
  expect(extras(taobao)).toEqual(expected(ALL_ON));
});

it('[AC-B1-05zk#25] .taobao 开、.pdd 没配（默认关）：拼多多详情三个字段按关置空', async () => {
  const f = detailFixture();
  for (const key of TAOBAO_SWITCHES) f.values.set(key, true);
  f.detail.mockResolvedValue(pddItem());
  const pdd = await f.get({ product_key: PDD_KEY });
  expect(ownKeys(pdd)).toEqual(ALL_OWN);
  expect(extras(pdd)).toEqual(expected({}));
});

it.each([
  {
    name: 'detail.coupon_end.enabled',
    pdd: PDD_COUPON,
    taobao: COUPON_SWITCH,
    on: { coupon: true },
  },
  { name: 'detail.sales.enabled', pdd: PDD_SALES, taobao: SALES_SWITCH, on: { sales: true } },
  {
    name: 'detail.shop_scores.enabled',
    pdd: PDD_SCORES,
    taobao: SCORES_SWITCH,
    on: { scores: true },
  },
])(
  '[AC-B1-05zk#26] 只开 $name.pdd（对应 .taobao 关）：拼多多详情只有它管的字段上卡，另两个置空',
  async ({ pdd, taobao, on }) => {
    const f = detailFixture();
    f.values.set(pdd, true);
    f.values.set(taobao, false);
    f.detail.mockResolvedValue(pddItem());
    const card = await f.get({ product_key: PDD_KEY });
    expect(ownKeys(card)).toEqual(ALL_OWN);
    expect(extras(card)).toEqual(expected(on));
  },
);
