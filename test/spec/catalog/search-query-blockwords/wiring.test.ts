// B1-04zzzza (D10-1064 口径 A): the production assembly wires the prohibited query words by default.
// The real AppModule serves GET /v1/products/search; CatalogModule's own CatalogSearchService
// factory, the real union search wiring and the page cache stay in place. Only the ports without a
// database or Redis are replaced (as test/spec/catalog/cache/wiring.test.ts does): the catalog
// dictionary, the configuration reader, the query PID reader, the session store, the governed
// union (a call-recording adapter), the link registrar, the quoter and the source-link reader.
// The fallback whitelist is empty so a query that reached the union stays a plain empty page.
// All values are synthetic.
import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogConfigReader,
  CatalogModule,
  GovernedUnion,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
  type SearchProductsData,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CATALOG } from '../../../../apps/api/src/modules/catalog/catalog.module.ts';
import * as platformModule from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { cacheConfig } from '../cache/kit.ts';
import { fixture as detailFixture } from '../detail/kit.ts';
import { fixture as searchFixture } from '../search/kit.ts';
import { assertContract, createApp, headers, type HttpApp } from '../search-route/http-kit.ts';
import { EMPTY } from './harness.ts';

const originalModule = CatalogModule.forRoot;
let app: HttpApp | undefined;

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});

it('[AC-B1-04zzzza#15] 生产装配：真实 AppModule 上 GET /v1/products/search?platform=taobao&q=电子烟 返回 200、空结果且过契约，联盟替身 0 调用、不读写会话、不登记链接；同一装配下普通查询词照常调联盟一次', async () => {
  const d = detailFixture();
  const s = searchFixture();
  const settings = cacheConfig();
  vi.spyOn(platformModule, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic',
    channels: [],
  });
  const keywords: string[] = [];
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`synthetic adapter: unexpected ${name}`);
  };
  const adapter: UnionAdapter = {
    platform: 'taobao',
    searchItems: async (query) => {
      keywords.push(query.keyword);
      return { items: [], nextCursor: null };
    },
    getItem: unexpected('getItem'),
    resolveLink: unexpected('resolveLink'),
    convert: unexpected('convert'),
    listOrders: unexpected('listOrders'),
  };
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((config, ports) => {
    const module = originalModule(config, ports);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).map((provider) => {
          if (typeof provider !== 'object') return provider;
          if (provider.provide === CATALOG)
            return { provide: CATALOG, useValue: { ...d.options.catalog, ...s.options.catalog } };
          if (provider.provide === CatalogConfigReader)
            return { provide: CatalogConfigReader, useValue: settings.config };
          if (typeof provider.provide === 'symbol') {
            if (provider.provide.description === 'CATALOG_QUERY_PIDS')
              return { provide: provider.provide, useValue: s.options.pids };
            if (provider.provide.description === 'CATALOG_SEARCH_SESSIONS')
              return { provide: provider.provide, useValue: s.sessions };
          }
          return provider;
        }),
        { provide: GovernedUnion, useValue: { adapter: () => adapter } },
        { provide: LinkRegistrar, useValue: { register: s.register } },
        { provide: RebateQuoter, useValue: { quote: s.quote } },
        { provide: SourceLinkReader, useValue: { entrySource: d.entrySource } },
      ],
    };
  });
  app = await createApp(s.clock);
  await app.init();

  const prohibited = new URLSearchParams({ platform: 'taobao', q: '电子烟' });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/products/search?${prohibited}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  await assertContract(response, true);
  const body = response.json<{ code: number; data: SearchProductsData }>();
  expect(body.code).toBe(0);
  expect(body.data).toStrictEqual(EMPTY);
  expect(keywords).toEqual([]);
  expect(s.getActivePid).not.toHaveBeenCalled();
  expect(s.sessions.read).not.toHaveBeenCalled();
  expect(s.sessions.write).not.toHaveBeenCalled();
  expect(s.register).not.toHaveBeenCalled();

  // Control on the same assembly: an ordinary query does reach the recording adapter.
  const ordinary = new URLSearchParams({ platform: 'taobao', q: '合成纸巾' });
  const control = await app.inject({
    method: 'GET',
    url: `/v1/products/search?${ordinary}`,
    headers,
  });
  expect(control.statusCode).toBe(200);
  await assertContract(control, true);
  expect(keywords).toEqual(['合成纸巾']);
});
