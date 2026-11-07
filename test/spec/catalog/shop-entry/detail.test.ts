// B1-05zm (S17-c1): shop_entry on GET /v1/products/{product_key} through the real getProduct. The
// configuration fake answers APP_ID only (detail-extras kit); the governed adapters are a recording
// double (kit.ts shopAdapters) handed in as ProductDetailOptions.shopAdapters. 08 BR-PRICE-21 细则
// 「进店」, D10-736 ②: decided without any union request; a pool fallback card stays false.
import { expect, it } from 'vitest';
import {
  getProduct,
  markCachedDetail,
  markStaleDetail,
} from '../../../../apps/api/src/modules/catalog/detail.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { LOGO, poolReader } from '../detail-extras/kit.ts';
import {
  APP_ID,
  ENTRY_SOURCE,
  ENTRY_SWITCH,
  PRODUCT_KEY,
  entryFixture,
  shopItem,
  without,
  type EntryFixture,
} from './kit.ts';

it('[AC-B1-05zm#4] 四条件全满足：详情卡 shop_entry 为 true；判定只读两个配置键与适配器声明，不调联盟任何接口（详情只取一次）', async () => {
  const f = entryFixture();
  const card = await f.get();
  expect(card.shop_entry).toBe(true);
  expect(card.shop_logo).toBe(LOGO);
  expect(f.configValue).toHaveBeenCalledWith(APP_ID, ENTRY_SWITCH);
  expect(f.configValue).toHaveBeenCalledWith(APP_ID, ENTRY_SOURCE);
  expect(f.detail).toHaveBeenCalledTimes(1);
  expect(f.adapters.convertShop).not.toHaveBeenCalled();
  expect(f.adapters.unionCalls()).toBe(0);
});

it.each<{ readonly name: string; readonly make: () => EntryFixture }>([
  {
    name: '进店开关为 false',
    make: () => {
      const f = entryFixture();
      f.values.set(ENTRY_SWITCH, false);
      return f;
    },
  },
  {
    name: '进店开关为字符串 "true"',
    make: () => {
      const f = entryFixture();
      f.values.set(ENTRY_SWITCH, 'true');
      return f;
    },
  },
  {
    name: '进店开关没配（默认关）',
    make: () => {
      const f = entryFixture();
      f.values.delete(ENTRY_SWITCH);
      return f;
    },
  },
  {
    name: '只开了京东、拼多多和按前缀 tb 命名的进店开关',
    make: () => {
      const f = entryFixture();
      f.values.delete(ENTRY_SWITCH);
      for (const platform of ['jd', 'pdd', 'tb']) {
        f.values.set(`shop.entry.enabled.${platform}`, true);
      }
      return f;
    },
  },
  {
    name: '来源没配',
    make: () => {
      const f = entryFixture();
      f.values.delete(ENTRY_SOURCE);
      return f;
    },
  },
  {
    name: '来源为空串',
    make: () => {
      const f = entryFixture();
      f.values.set(ENTRY_SOURCE, '');
      return f;
    },
  },
  {
    name: '来源不在适配器声明里（合成值）',
    make: () => {
      const f = entryFixture();
      f.values.set(ENTRY_SOURCE, 'synthetic-other');
      return f;
    },
  },
  {
    name: '来源只配在京东、拼多多和按前缀 tb 命名的键上',
    make: () => {
      const f = entryFixture();
      f.values.delete(ENTRY_SOURCE);
      for (const platform of ['jd', 'pdd', 'tb']) {
        f.values.set(`shop.entry.source.${platform}`, 'dataoke');
      }
      return f;
    },
  },
  { name: '适配器没声明 shopConvertSources', make: () => entryFixture({ declared: false }) },
  { name: '详情没拿到适配器（没有 shopAdapters）', make: () => entryFixture({ adapters: false }) },
  {
    name: '联盟详情没有 shop_ref',
    make: () => {
      const f = entryFixture();
      f.detail.mockResolvedValue(without(shopItem(), 'shop_ref'));
      return f;
    },
  },
  {
    name: '联盟详情 shop_ref 为空串',
    make: () => {
      const f = entryFixture();
      f.detail.mockResolvedValue(shopItem({ shop_ref: '' }));
      return f;
    },
  },
  {
    name: '联盟详情没有店名',
    make: () => {
      const f = entryFixture();
      f.detail.mockResolvedValue(without(shopItem(), 'shop_name'));
      return f;
    },
  },
  {
    name: '联盟详情店名为空串',
    make: () => {
      const f = entryFixture();
      f.detail.mockResolvedValue(shopItem({ shop_name: '' }));
      return f;
    },
  },
])(
  '[AC-B1-05zm#5] 四条件缺一即 false（同样的夹具四条件全满足时为 true）：$name',
  async ({ make }) => {
    const control = await entryFixture().get();
    expect(control.shop_entry).toBe(true);
    const f = make();
    const card = await f.get();
    expect(Object.hasOwn(card, 'shop_entry')).toBe(true);
    expect(card.shop_entry).toBe(false);
    expect(f.adapters.unionCalls()).toBe(0);
  },
);

it.each([
  { name: '命中详情缓存', mark: markCachedDetail, stale: false },
  { name: '联盟故障用过期缓存', mark: markStaleDetail, stale: true },
])(
  '[AC-B1-05zm#6] $name 时同一份联盟详情同样判定：四条件全满足为 true',
  async ({ mark, stale }) => {
    const f = entryFixture();
    f.detail.mockImplementation(async () => mark(shopItem()));
    const card = await f.get();
    expect(card.stale).toBe(stale);
    expect(card.shop_entry).toBe(true);
    expect(f.adapters.unionCalls()).toBe(0);
  },
);

it('[AC-B1-05zm#7] 联盟查不到走池回退：池行带了 shop_ref 与店名、四条件其余都满足，shop_entry 仍为 false', async () => {
  const f = entryFixture();
  expect((await f.get()).shop_entry).toBe(true);
  const reader = poolReader(shopItem());
  f.detail.mockRejectedValue(new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'));
  const card = await getProduct({ product_key: PRODUCT_KEY }, { ...f.options, poolReader: reader });
  expect(card.stale).toBe(true);
  expect(reader.detail).toHaveBeenCalledWith(APP_ID, PRODUCT_KEY);
  expect(card.shop_entry).toBe(false);
  expect(f.adapters.unionCalls()).toBe(0);
});
