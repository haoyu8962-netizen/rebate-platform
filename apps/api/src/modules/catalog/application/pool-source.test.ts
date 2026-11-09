import { expect, it, vi } from 'vitest';
import { UnionError, type UnionItemDetail } from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import {
  createPoolSource,
  PoolManyProductsError,
  type PoolLinkParser,
  type PoolSourceOptions,
} from './pool-source.ts';
import { PoolCategoryBlockedError, type PoolCategoryOptions } from './pool-category.ts';
import { searchRawByTitle } from './raw-reparse.ts';

const NOW = '2026-10-31T02:00:00.000Z';
const CONTEXT = { appId: 'app', requestId: 'r', purpose: 'online' } as const;

function detail(stable: string): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: `raw-${stable}`,
    title: stable,
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 100n,
    quoted_at: NOW,
  };
}

function refOf(item: UnionItemDetail) {
  return {
    appId: 'app',
    platform: item.platform,
    productKey: `tb:${item.title}`,
    rawItemId: item.item_id!,
    rawFetchedAt: NOW,
    receivedAt: NOW,
    canonicalUrl: null,
    title: item.title,
    shopId: null,
    shopType: null,
    source: 'parse' as const,
  };
}

const catalog: PoolSourceOptions['catalog'] = {
  listPlatforms: () =>
    Promise.resolve([
      {
        code: 'taobao',
        key_prefix: 'tb',
        key_stability: 'unverified',
        search_support: 'official',
        convert_support: 'official',
        order_sync_support: 'official',
        stage: 'mvp',
      },
    ]),
  resolveProductKey: (key) => Promise.resolve(key),
  readProductRef: () => Promise.resolve(null),
  takeRawItemId: () => Promise.resolve({ rawItemId: 'raw-K1', source: 'item_ref' }),
};

function source(links: PoolLinkParser, overrides: Partial<PoolSourceOptions> = {}) {
  return createPoolSource({
    clock: { now: () => new Date(NOW) },
    config: { configValue: () => Promise.resolve(null) },
    catalog,
    itemRefs: { read: () => null },
    union: {
      adapter: () => ({ getItem: vi.fn(), resolveLink: vi.fn() }) as never,
    },
    upstream: { detail: () => Promise.resolve(detail('K1')) },
    links,
    ...overrides,
  });
}

function parser(answers: Record<string, Awaited<ReturnType<PoolLinkParser['parse']>>>) {
  return {
    candidates: (text: string) =>
      text
        .split(' ')
        .filter((raw) => raw !== '')
        .map((raw) => ({ kind: 'url' as const, raw })),
    parse: (candidate: { raw: string }) => Promise.resolve(answers[candidate.raw]!),
  };
}
const live = (stable: string) => {
  const item = detail(stable);
  return { ok: true as const, item, ref: refOf(item) };
};

it('[AC-B1-05q-unit#1] 文本里没有候选 → 30132', async () => {
  await expect(source(parser({})).fromLink('app', '')).rejects.toMatchObject({ code: 30132 });
});

it('[AC-B1-05q-unit#2] 两个不同的键 → PoolManyProductsError；同键只算一件', async () => {
  const links = parser({ a: live('K1'), b: live('K2'), c: live('K1') });
  await expect(source(links).fromLink('app', 'a b')).rejects.toBeInstanceOf(PoolManyProductsError);
  expect(await source(links).fromLink('app', 'a c')).toMatchObject({
    kind: 'live',
    productKey: 'tb:K1',
    rawItemId: 'raw-K1',
  });
});

it('[AC-B1-05q-unit#3] 非商品候选不挡住另一件商品，联盟答不了的候选 → 50401', async () => {
  const links = parser({
    a: live('K1'),
    other: { ok: false, code: 30132 },
    down: { ok: false, code: 50301 },
  });
  expect(await source(links).fromLink('app', 'other a')).toMatchObject({ productKey: 'tb:K1' });
  await expect(source(links).fromLink('app', 'a down')).rejects.toMatchObject({ code: 50401 });
});

it('[AC-B1-05q-unit#4] 全部拒绝时用第一个候选的码', async () => {
  const links = parser({ a: { ok: false, code: 30131 }, b: { ok: false, code: 30132 } });
  await expect(source(links).fromLink('app', 'a b')).rejects.toMatchObject({ code: 30131 });
});

it('[AC-B1-05q-unit#5] 详情阶段下架：用已认出的引用派生 key，不当成拒绝', async () => {
  const links: PoolLinkParser = {
    candidates: () => [{ kind: 'url', raw: 'a' }],
    parse: async (_candidate, adapters) => {
      await adapters('taobao')
        .getItem({ platform: 'taobao', item_id: 'x-K9' }, CONTEXT)
        .catch(() => undefined);
      return { ok: false, code: 30141 };
    },
  };
  const union = {
    adapter: () =>
      ({ getItem: () => Promise.reject(new Error('off')), resolveLink: vi.fn() }) as never,
  };
  expect(await source(links, { union }).fromLink('app', 'a')).toEqual({
    kind: 'off_shelf',
    productKey: 'tb:K9',
  });
});

it('[AC-B1-05q-unit#6] 解析阶段下架认不出 key → 30141', async () => {
  const links = parser({ a: { ok: false, code: 30141 } });
  await expect(source(links).fromLink('app', 'a')).rejects.toMatchObject({ code: 30141 });
});

it('[AC-B1-05q-unit#7] 打不开或别的 App 的 item_ref → 30132，不问联盟', async () => {
  const takeRawItemId = vi.fn();
  const pool = source(parser({}), { catalog: { ...catalog, takeRawItemId } });
  await expect(pool.fromItemRef('app', 'bad')).rejects.toMatchObject({ code: 30132 });
  expect(takeRawItemId).not.toHaveBeenCalled();
});

const token = {
  appId: 'app',
  platform: 'taobao' as const,
  productKey: 'tb:K1',
  rawItemId: 'raw-K1',
  fetchedAt: NOW,
  source: 'item_ref' as const,
};

it('[AC-B1-05q-unit#8] 联盟明确下架 → off_shelf；暂时失败 → 50401', async () => {
  const pool = (upstream: PoolSourceOptions['upstream']) =>
    source(parser({}), { upstream, itemRefs: { read: () => token } });
  const refused = (code: 'item_unavailable' | 'upstream_unavailable') => ({
    detail: () => Promise.reject(new UnionError(code, 'synthetic', 'taobao')),
  });
  expect(await pool(refused('item_unavailable')).fromItemRef('app', 'ref')).toEqual({
    kind: 'off_shelf',
    productKey: 'tb:K1',
  });
  await expect(
    pool(refused('upstream_unavailable')).fromItemRef('app', 'ref'),
  ).rejects.toMatchObject({ code: 50401 });
});

const notPassed = (failure: string, code: number) => ({
  kind: 'not_passed',
  productKey: 'tb:K1',
  failure,
  refusal: expect.objectContaining({ code }) as CatalogError,
});

it('[AC-B1-05q-unit#9] 联盟标记的异常价不入价：not_passed，新 key 的拒绝码是 50401', async () => {
  const pool = source(parser({}), {
    itemRefs: { read: () => token },
    upstream: { detail: () => Promise.resolve({ ...detail('K1'), price_status: 'anomaly' }) },
  });
  expect(await pool.fromItemRef('app', 'ref')).toEqual(notPassed('price_anomaly', 50401));
});

it('[AC-B1-05q-unit#21] 引用失效都是 not_passed：别的键 30143，拒绝原串 30143，派生不出 30131', async () => {
  const pool = (upstream: PoolSourceOptions['upstream']) =>
    source(parser({}), { upstream, itemRefs: { read: () => token } });
  expect(
    await pool({ detail: () => Promise.resolve(detail('K2')) }).fromItemRef('app', 'ref'),
  ).toEqual(notPassed('ref_expired', 30143));
  expect(
    await pool({
      detail: () => Promise.reject(new UnionError('upstream_rejected', 'synthetic', 'taobao')),
    }).fromItemRef('app', 'ref'),
  ).toEqual(notPassed('ref_expired', 30143));
  expect(
    await pool({
      detail: () => Promise.resolve({ ...detail('K1'), item_id: 'AbC-' }),
    }).fromItemRef('app', 'ref'),
  ).toEqual(notPassed('ref_expired', 30131));
});

it('[AC-B1-05q-unit#22] 回退找不到同键 → not_passed 30143，重新解析答不了仍抛 50401', async () => {
  const taking = (error: CatalogError) =>
    source(parser({}), {
      itemRefs: { read: () => token },
      catalog: { ...catalog, takeRawItemId: () => Promise.reject(error) },
    });
  expect(await taking(new CatalogError(30143, 'x')).fromItemRef('app', 'ref')).toEqual(
    notPassed('ref_expired', 30143),
  );
  await expect(
    taking(new CatalogError(50401, 'x')).fromItemRef('app', 'ref'),
  ).rejects.toMatchObject({ code: 50401 });
});

/** A candidate whose reference was identified, then answered with `code` at detail. */
function refusedAtDetail(code: number): PoolLinkParser {
  return {
    candidates: () => [{ kind: 'url', raw: 'a' }],
    parse: async (_candidate, adapters) => {
      await adapters('taobao')
        .getItem({ platform: 'taobao', item_id: 'x-K1' }, CONTEXT)
        .catch(() => undefined);
      return { ok: false, code };
    },
  };
}

it('[AC-B1-05q-unit#23] 链接：详情拒绝且认得 key → not_passed，拒绝码沿用解析的码', async () => {
  const union = {
    adapter: () =>
      ({ getItem: () => Promise.reject(new Error('no')), resolveLink: vi.fn() }) as never,
  };
  expect(await source(refusedAtDetail(30132), { union }).fromLink('app', 'a')).toEqual(
    notPassed('ref_expired', 30132),
  );
  await expect(
    source(refusedAtDetail(50301), { union }).fromLink('app', 'a'),
  ).rejects.toMatchObject({ code: 50401 });
});

it('[AC-B1-05q-unit#24] 链接：异常价 → not_passed 50401；详情答成别的键 → not_passed 30143', async () => {
  const anomaly = live('K1');
  const flagged = parser({
    a: { ...anomaly, item: { ...anomaly.item, price_status: 'anomaly' } },
  });
  expect(await source(flagged).fromLink('app', 'a')).toEqual(notPassed('price_anomaly', 50401));
  const other = parser({ a: { ...live('K1'), item: detail('K2') } });
  expect(await source(other).fromLink('app', 'a')).toEqual(notPassed('ref_expired', 30143));
});

it('[AC-B1-05q-unit#25] 链接：详情不带 ID 不算别的键', async () => {
  const bare = live('K1');
  const item = { ...bare.item };
  delete item.item_id;
  expect(await source(parser({ a: { ...bare, item } })).fromLink('app', 'a')).toMatchObject({
    kind: 'live',
    productKey: 'tb:K1',
  });
});

it('[AC-B1-05q-unit#26] 重新上架的复核先解析别名再比较', async () => {
  const pool = source(parser({}), {
    catalog: {
      ...catalog,
      resolveProductKey: (key) => Promise.resolve(key === 'tb:OLD' ? 'tb:K1' : key),
    },
  });
  expect(
    await pool.recheck({
      appId: 'app',
      platform: 'taobao',
      productKey: 'tb:OLD',
      rawItemId: 'raw-K1',
      fetchedAt: NOW,
      title: 'K1',
    }),
  ).toMatchObject({ kind: 'live', productKey: 'tb:K1' });
});

it('[AC-B1-05r-unit#1] current 不带请求原串：按 BR-PROD-05 顺序取原串后问详情，下架答 off_shelf', async () => {
  const asked: (string | undefined)[] = [];
  const pool = source(parser({}), {
    upstream: {
      detail: (request) => {
        asked.push(request.rawItemId);
        return Promise.reject(new UnionError('item_unavailable', 'synthetic', 'taobao'));
      },
    },
  });
  expect(
    await pool.current({ appId: 'app', platform: 'taobao', productKey: 'tb:K1', title: 'K1' }),
  ).toEqual({ kind: 'off_shelf', productKey: 'tb:K1' });
  expect(asked).toHaveLength(1);
});

it('[AC-B1-05r-unit#2] 平台不支持按标题搜：与找不到同键一样答 null；暂时失败仍抛', async () => {
  const search = (error: UnionError) =>
    searchRawByTitle({
      adapter: { searchItems: () => Promise.reject(error) },
      platform: 'taobao',
      title: 'K1',
      jdMode: 'item',
      context: CONTEXT,
      isTarget: () => true,
    });
  await expect(search(new UnionError('adapter_unimplemented', 'x', 'taobao'))).resolves.toBeNull();
  await expect(search(new UnionError('rate_limited', 'x', 'taobao'))).rejects.toMatchObject({
    code: 'rate_limited',
  });
});

/** B1-05zo: a blocklist of one taobao category; `blocked` records each judged title. */
const BLOCKED = '9000501';
function blocklist() {
  const judged: string[] = [];
  const warn = vi.fn();
  const category: PoolCategoryOptions = {
    filter: {
      filterCategories: (_app, items) => {
        judged.push(...items.map((item) => item.title));
        return Promise.resolve(items.filter((item) => item.categoryId !== BLOCKED));
      },
    },
    logger: { warn },
  };
  return { category, judged, warn };
}
const blockedDetail = (stable: string): UnionItemDetail => ({
  ...detail(stable),
  category_l1_id: BLOCKED,
});
const blockedLive = (stable: string) => {
  const item = blockedDetail(stable);
  return { ok: true as const, item, ref: refOf(item) };
};

it('[AC-B1-05zo-UNIT#4] 链接：两件不同商品、其中一件禁售 → PoolManyProductsError（20001），不判类目；只有一件且禁售才 30147', async () => {
  const { category, judged } = blocklist();
  const links = parser({ a: live('K1'), b: blockedLive('K2'), c: blockedLive('K2') });
  await expect(source(links, { category }).fromLink('app', 'b a')).rejects.toBeInstanceOf(
    PoolManyProductsError,
  );
  await expect(source(links, { category }).fromLink('app', 'a b')).rejects.toBeInstanceOf(
    PoolManyProductsError,
  );
  expect(judged).toEqual([]);
  await expect(source(links, { category }).fromLink('app', 'b c')).rejects.toBeInstanceOf(
    PoolCategoryBlockedError,
  );
  expect(judged).toEqual(['K2']);
});

it('[AC-B1-05zo-UNIT#5] 带详情的答复才判：异常价且禁售 → 30147（先于 50401）；派生出别的键且禁售 → 照旧 not_passed 30143', async () => {
  const { category } = blocklist();
  const flagged = blockedLive('K1');
  const anomaly = parser({ a: { ...flagged, item: { ...flagged.item, price_status: 'anomaly' } } });
  await expect(source(anomaly, { category }).fromLink('app', 'a')).rejects.toBeInstanceOf(
    PoolCategoryBlockedError,
  );
  const other = parser({ a: { ...live('K1'), item: blockedDetail('K2') } });
  expect(await source(other, { category }).fromLink('app', 'a')).toEqual(
    notPassed('ref_expired', 30143),
  );
  const pool = (item: UnionItemDetail) =>
    source(parser({}), {
      category,
      itemRefs: { read: () => token },
      upstream: { detail: () => Promise.resolve(item) },
    });
  expect(await pool(blockedDetail('K2')).fromItemRef('app', 'ref')).toEqual(
    notPassed('ref_expired', 30143),
  );
  await expect(
    pool({ ...blockedDetail('K1'), price_status: 'anomaly' }).fromItemRef('app', 'ref'),
  ).rejects.toBeInstanceOf(PoolCategoryBlockedError);
  // Every call is judged on its own answer, also when the union hands back the same object.
  const repeated = pool(blockedDetail('K1'));
  await expect(repeated.fromItemRef('app', 'ref')).rejects.toBeInstanceOf(PoolCategoryBlockedError);
  await expect(repeated.fromItemRef('app', 'ref')).rejects.toBeInstanceOf(PoolCategoryBlockedError);
});

it('[AC-B1-05zo-UNIT#6] 复核走重新解析且禁售 → 30147，product_refs 不登记；不禁售照旧登记一次、只问一次详情；current 不判类目', async () => {
  const run = async (item: UnionItemDetail) => {
    const { category } = blocklist();
    const registered: string[] = [];
    const asked: (string | undefined)[] = [];
    const pool = source(parser({}), {
      category,
      union: {
        adapter: () =>
          ({
            searchItems: () => Promise.resolve({ items: [item], hasMore: false }),
            getItem: vi.fn(),
            resolveLink: vi.fn(),
          }) as never,
      },
      catalog: {
        ...catalog,
        // As Catalog.takeRawItemId step ③: re-parse, then register the found raw ID.
        takeRawItemId: async (request) => {
          const result = await request.reparse({
            appId: request.appId,
            platform: request.platform,
            productKey: request.productKey,
          });
          if (result.kind !== 'found') throw new CatalogError(30143, 'x');
          registered.push(result.ref.rawItemId);
          return { rawItemId: result.ref.rawItemId, source: 'reparse' };
        },
      },
      upstream: {
        detail: (request) => {
          asked.push(request.rawItemId);
          return Promise.resolve(item);
        },
      },
    });
    const stored = {
      appId: 'app',
      platform: 'taobao' as const,
      productKey: 'tb:K1',
      rawItemId: 'raw-K1',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      title: 'K1',
    };
    return { pool, stored, registered, asked };
  };
  const hit = await run(blockedDetail('K1'));
  await expect(hit.pool.recheck(hit.stored)).rejects.toBeInstanceOf(PoolCategoryBlockedError);
  expect(hit.registered).toEqual([]);
  const pass = await run(detail('K1'));
  expect(await pass.pool.recheck(pass.stored)).toMatchObject({ kind: 'live', productKey: 'tb:K1' });
  expect(pass.registered).toEqual(['raw-K1']);
  expect(pass.asked).toEqual(['raw-K1']);
  const refresh = await run(blockedDetail('K1'));
  expect(
    await refresh.pool.current({
      appId: 'app',
      platform: 'taobao',
      productKey: 'tb:K1',
      title: 'K1',
    }),
  ).toMatchObject({ kind: 'live' });
  expect(refresh.registered).toEqual(['raw-K1']);
});
