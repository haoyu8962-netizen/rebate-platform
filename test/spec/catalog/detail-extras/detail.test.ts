// B1-05zk (D10-664 S-09 S09b, D10-736): the detail-only keys of GET /v1/products/{product_key}
// through the real getProduct, switches driven by the configuration fake (kit.ts).
// 04 §8.3「商品详情专用字段」; 08 BR-PRICE-04 细则「商品详情的券标签」, BR-PRICE-21 细则「进店」,
// BR-TEXT-13 细则「虚拟数据」; contract CT-26s.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  markCachedDetail,
  markStaleDetail,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { item } from '../detail/kit.ts';
import {
  COUPON_END,
  COUPON_SWITCH,
  EMPTY,
  ENTRY_SOURCE,
  ENTRY_SWITCH,
  LOGO,
  PRODUCT_KEY,
  SALES,
  SALES_SWITCH,
  SCORES,
  SCORES_SWITCH,
  detailFixture,
  expected,
  extras,
  extrasItem,
  ownKeys,
} from './kit.ts';

const ALL_ON = { coupon: true, sales: true, scores: true } as const;
const ALL_OWN = [true, true, true, true, true];

it('[AC-B1-05zk#1] 三个详情开关都开且联盟都给了：coupon_end_at、sales_text、shop_scores、shop_logo 原样上卡，shop_entry 为 false，其余卡片字段照旧', async () => {
  const f = detailFixture();
  f.allOn();
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(card.coupon_end_at).toBe(COUPON_END);
  expect(card.sales_text).toBe(SALES);
  expect(card.shop_logo).toBe(LOGO);
  expect(card.shop_scores).toEqual(SCORES);
  expect(card.shop_entry).toBe(false);
  expect(card).toMatchObject({ product_key: PRODUCT_KEY, title: '合成详情商品', stale: false });
  expect(Object.hasOwn(card, 'images')).toBe(true);
});

it('[AC-B1-05zk#2] 开关都没配（默认关）：联盟给了也出 coupon_end_at null、sales_text null、shop_scores []，shop_logo 照联盟原样，shop_entry false，五个键都在', async () => {
  const f = detailFixture();
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected({}));
});

it.each([
  { name: 'detail.coupon_end.enabled', key: COUPON_SWITCH, on: { coupon: true } },
  { name: 'detail.sales.enabled', key: SALES_SWITCH, on: { sales: true } },
  { name: 'detail.shop_scores.enabled', key: SCORES_SWITCH, on: { scores: true } },
])(
  '[AC-B1-05zk#3] 只开 $name.taobao：只有它管的字段上卡，另两个仍按关置空',
  async ({ key, on }) => {
    const f = detailFixture();
    f.values.set(key, true);
    f.detail.mockResolvedValue(extrasItem());
    const card = await f.get();
    expect(ownKeys(card)).toEqual(ALL_OWN);
    expect(extras(card)).toEqual(expected(on));
  },
);

it.each([
  { name: 'false', value: false },
  { name: '字符串 "true"', value: 'true' },
  { name: '数字 1', value: 1 },
  { name: '字符串 "on"', value: 'on' },
  { name: 'null', value: null },
  { name: '对象 {enabled:true}', value: { enabled: true } },
  { name: '数组 [true]', value: [true] },
])('[AC-B1-05zk#4] 开关值为 $name 不是严格的 true，一律按关', async ({ value }) => {
  const f = detailFixture();
  for (const key of [COUPON_SWITCH, SALES_SWITCH, SCORES_SWITCH, ENTRY_SWITCH]) {
    f.values.set(key, value);
  }
  f.values.set(ENTRY_SOURCE, 'dataoke');
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected({}));
});

it('[AC-B1-05zk#5] 开关都开但联盟什么都没给：coupon_end_at、sales_text、shop_logo 为 null，shop_scores 为 []，shop_entry false，不补默认值', async () => {
  const f = detailFixture();
  f.allOn();
  f.detail.mockResolvedValue(item());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(EMPTY);
});

it('[AC-B1-05zk#6] 只认商品所在平台（平台代码 taobao）的开关：京东、拼多多或按前缀 tb 命名的开关开着，淘宝详情仍按关', async () => {
  const f = detailFixture();
  const prefixes = [
    'detail.coupon_end.enabled',
    'detail.sales.enabled',
    'detail.shop_scores.enabled',
  ];
  for (const platform of ['jd', 'pdd', 'tb']) {
    for (const prefix of prefixes) f.values.set(`${prefix}.${platform}`, true);
  }
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(ownKeys(card)).toEqual(ALL_OWN);
  expect(extras(card)).toEqual(expected({}));
});

it.each([
  { name: '进店开关开、来源已配置 dataoke、商品带店铺标识', all: false, source: true, entry: true },
  { name: '另把三个详情开关也全开', all: true, source: true, entry: true },
  { name: '进店开关开但来源没配', all: false, source: false, entry: true },
  { name: '进店开关关、来源已配置', all: false, source: true, entry: false },
])('[AC-B1-05zk#7] S-17 店铺转链落地前 shop_entry 恒为 false：$name', async (row) => {
  const f = detailFixture();
  if (row.all) f.allOn();
  f.values.set(ENTRY_SWITCH, row.entry);
  if (row.source) {
    f.values.set(ENTRY_SOURCE, 'dataoke');
  } else {
    f.values.delete(ENTRY_SOURCE);
  }
  f.detail.mockResolvedValue(extrasItem());
  const card = await f.get();
  expect(Object.hasOwn(card, 'shop_entry')).toBe(true);
  expect(card.shop_entry).toBe(false);
});

it.each([
  { name: '命中缓存', mark: markCachedDetail, stale: false },
  { name: '联盟故障用过期缓存', mark: markStaleDetail, stale: true },
])('[AC-B1-05zk#8] $name 时同一份联盟详情按同样的开关出同样的五个字段', async ({ mark, stale }) => {
  const f = detailFixture();
  f.allOn();
  f.detail.mockImplementation(async () => mark(extrasItem()));
  const card = await f.get();
  expect(card.stale).toBe(stale);
  expect(extras(card)).toEqual(expected(ALL_ON));
});

it('[AC-B1-05zk#9] 带 item_ref 原样透传、带 from_link_id 时五个字段照样按开关出', async () => {
  const f = detailFixture();
  f.allOn();
  f.detail.mockResolvedValue(extrasItem());
  const token = f.issue();
  const tapped = await f.get({ item_ref: token });
  expect(tapped.item_ref).toBe(token);
  expect(extras(tapped)).toEqual(expected(ALL_ON));
  const sourced = await f.get({ from_link_id: '01920000-0000-7000-8000-00000000e009' });
  expect(extras(sourced)).toEqual(expected(ALL_ON));
});

it('[AC-B1-05zk#10] 开关开与关两态的详情卡都符合 ProductCard 契约，并且都带齐五个键', async () => {
  const root = new URL('../../../../', import.meta.url);
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const contract = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schema = contract.components.schemas['ProductCard'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });

  const on = detailFixture();
  on.allOn();
  on.detail.mockResolvedValue(extrasItem());
  const off = detailFixture();
  off.detail.mockResolvedValue(extrasItem());
  for (const card of [await on.get(), await off.get()]) {
    const serialized: unknown = JSON.parse(JSON.stringify(card));
    expect(validate(serialized), JSON.stringify(validate.errors)).toBe(true);
    expect(ownKeys(card)).toEqual(ALL_OWN);
  }
});
