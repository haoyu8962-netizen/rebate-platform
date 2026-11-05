import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ProductDetailData } from '../../../../apps/api/src/modules/catalog/detail.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  DemoUnionAdapter,
  DemoUnionError,
  UnionError,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { HttpApp, Response } from '../search-route/http-kit.ts';
import { headers } from '../search-route/http-kit.ts';
import { enabled, reference, setup } from '../base/kit.ts';
import { NOW, item } from './kit.ts';

type Card = ProductDetailData;
interface ProductResponse {
  readonly code: number;
  readonly data: Card;
}
const root = new URL('../../../../', import.meta.url);
const clock = new FixedClock(NOW);
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
// Capture before spying, once at module load: later tests never capture a prior mock.
const originalGetItem = DemoUnionAdapter.prototype.getItem;
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;
let appId: string;
let ruleConfigKey: string;
let schemas: Record<string, JsonSchema>;
const getItem = vi.spyOn(DemoUnionAdapter.prototype, 'getItem');
const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  const quotes = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ) => Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database.urlFor('couli_app'),
    REDIS_URL: redis.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  ruleConfigKey = quotes.mock.calls[0]![0].ruleConfigKey;
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas = (await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root))))
    .components.schemas;
}, 180_000);

beforeEach(async () => {
  // Fresh app scope per case: no successful response from a previous test can hide a failure.
  appId = `synthetic_detail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  clock.set(NOW);
  getItem.mockReset().mockImplementation(originalGetItem);
  convert.mockClear();
  await db!
    .insertInto('config_items')
    .values([
      { app_id: appId, key: 'search.enabled.taobao', value: true, updated_by: 'synthetic-detail' },
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-detail',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-detail',
      },
      {
        app_id: appId,
        key: ruleConfigKey,
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: 'synthetic-detail',
      },
    ])
    .execute();
  const accountId = randomUUID();
  await db!
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-detail',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db!
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-site',
      pid: 'synthetic-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/detail-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
});

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        try {
          await redis?.stop();
        } finally {
          vi.restoreAllMocks();
        }
      }
    }
  }
});

function assertContract(response: Response, success: boolean): void {
  const schema = schemas[success ? 'ProductResponse' : 'ErrorEnvelope'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}

async function sourceCard(): Promise<Card & { product_key: string; item_ref: string }> {
  const query = new URLSearchParams({ platform: 'taobao', q: '演示商品', limit: '1' });
  const response = await app!.inject({
    method: 'GET',
    url: `/v1/products/search?${query}`,
    headers: { ...headers, 'x-app-id': appId },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ code: number; data: { items: Card[] } }>();
  expect(body.code).toBe(0);
  expect(body.data.items).toHaveLength(1);
  const card = body.data.items[0]!;
  expect(card.product_key).toBeTypeOf('string');
  expect(card.item_ref).toBeTypeOf('string');
  return { ...card, product_key: card.product_key!, item_ref: card.item_ref! };
}

function request(productKey: string, params: Record<string, string> = {}): Promise<Response> {
  return app!.inject({
    method: 'GET',
    url: `/v1/products/${encodeURIComponent(productKey)}?${new URLSearchParams(params)}`,
    headers: {
      ...headers,
      'x-app-id': appId,
      'x-trace-id': '01920000-0000-7000-8000-00000000d018',
    },
  });
}

async function links() {
  return db!
    .selectFrom('links')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('link_id')
    .execute();
}

it('[AC-B1-05e#18] 真实 AppModule 游客详情符合 ProductResponse，重复请求新增两条报价链接且不转链', async () => {
  const source = await sourceCard();
  const before = await links();
  const first = await request(source.product_key, { item_ref: source.item_ref });
  expect(first.statusCode).toBe(200);
  assertContract(first, true);
  const second = await request(source.product_key, { item_ref: source.item_ref });
  expect(second.statusCode).toBe(200);
  assertContract(second, true);
  const a = first.json<ProductResponse>();
  const b = second.json<ProductResponse>();
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  // B1-05zc (D10-641): the search source card and the detail are both one amount on the normal
  // basis, although the configuration still carries compare_rate_ratio_bp = 5000.
  expect(source).toMatchObject({
    rebate_basis: 'normal',
    rebate_min_fen: source.rebate_max_fen,
    disclaimer_keys: expect.arrayContaining(['rebate_estimate']),
  });
  expect(a.data).toMatchObject({
    product_key: source.product_key,
    item_ref: source.item_ref,
    price_fen: source.price_fen,
    coupon_fen: source.coupon_fen,
    final_price_fen: source.final_price_fen,
    rebate_min_fen: source.rebate_max_fen,
    rebate_max_fen: source.rebate_max_fen,
    rebate_basis: 'normal',
    age_sec: 0,
    stale: false,
    availability: 'ok',
  });
  expect(a.data.disclaimer_keys).not.toContain('rebate_compare');
  expect(Date.parse(a.data.quoted_at!)).toBe(clock.now().getTime());
  expect(b.data.link_id).not.toBe(a.data.link_id);
  const after = await links();
  expect(after).toHaveLength(before.length + 2);
  for (const card of [a.data, b.data]) {
    const row = after.find((entry) => entry.link_id === card.link_id);
    expect(row).toMatchObject({
      app_id: appId,
      product_key: card.product_key,
      user_id: null,
      quoted_final_price_fen: BigInt(card.final_price_fen!),
      quoted_coupon_fen: BigInt(card.coupon_fen!),
      convert_result: null,
    });
    expect(row?.quoted_at?.getTime()).toBe(Date.parse(card.quoted_at!));
    // BR-PRICE-12: the coupon of the quote snapshot comes from the same union data as the card.
    expect(row?.quoted_coupon_id ?? null).toBe(
      after.find((entry) => entry.link_id === source.link_id)?.quoted_coupon_id ?? null,
    );
  }
  expect(convert).not.toHaveBeenCalled();
  expect(getItem).toHaveBeenCalled();
  expect(getItem.mock.calls[0]?.[1]).toMatchObject({
    appId,
    purpose: 'online',
    signal: expect.any(AbortSignal),
  });
}, 60_000);

// Convert fixture failures to values so they fail an assertion before any dereference.
async function requireFixtureValue<T>(operation: () => Promise<T>): Promise<T> {
  const result = await Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, value: undefined, error }),
    );
  expect(result).toMatchObject({ ok: true });
  return result.value!;
}

it.each(['missing', 'malformed', 'tampered', 'expired'] as const)(
  '[AC-B1-05e#19] HTTP item_ref=%s 仍能查详情，回退当前 App 的 product_refs',
  async (kind) => {
    const source = await requireFixtureValue(sourceCard);
    let itemRef = source.item_ref;
    if (kind === 'malformed') itemRef = 'synthetic-invalid-ref';
    if (kind === 'tampered') {
      const index = Math.floor(itemRef.length / 2);
      itemRef =
        itemRef.slice(0, index) + (itemRef[index] === 'A' ? 'B' : 'A') + itemRef.slice(index + 1);
    }
    // Search registers a link but does not persist product_refs. Use its demo raw ID
    // explicitly instead of assuming that search has populated the fallback table.
    const sourceLink = await requireFixtureValue(() =>
      db!
        .selectFrom('links')
        .select(['raw_item_id'])
        .where('app_id', '=', appId)
        .where('link_id', '=', source.link_id)
        .executeTakeFirst(),
    );
    expect(sourceLink?.raw_item_id).toBeTypeOf('string');
    if (kind === 'expired') clock.advanceMs(1_801_000);
    // The clicked token keeps its original timestamp; only the fallback is fresh.
    const freshRef = reference({
      appId,
      productKey: source.product_key,
      platform: 'taobao',
      rawItemId: sourceLink!.raw_item_id!,
      rawFetchedAt: clock.now().toISOString(),
      canonicalUrl: null,
      title: 'synthetic-detail-fallback',
      shopId: null,
      shopType: null,
      source: 'search',
      receivedAt: clock.now().toISOString(),
    });
    await requireFixtureValue(async () => {
      const fixture = setup(db!);
      fixture.clock.set(clock.now());
      await fixture.catalog.registerProductRef(freshRef, enabled);
    });
    const stored = await requireFixtureValue(() =>
      db!
        .selectFrom('product_refs')
        .selectAll()
        .where('app_id', '=', appId)
        .where('product_key', '=', source.product_key)
        .executeTakeFirst(),
    );
    expect(stored).toMatchObject({
      app_id: appId,
      product_key: source.product_key,
      raw_item_id: freshRef.rawItemId,
      refreshed_at: clock.now(),
    });
    const response = await request(
      source.product_key,
      kind === 'missing' ? {} : { item_ref: itemRef },
    );
    expect(response.statusCode).toBe(200);
    assertContract(response, true);
    const body = response.json<ProductResponse>();
    expect(body.code).toBe(0);
    expect(body.data.product_key).toBe(source.product_key);
    expect(body.data.item_ref).not.toBe(itemRef);
    expect(getItem.mock.calls[0]?.[0]).toMatchObject({
      platform: 'taobao',
      item_id: stored?.raw_item_id,
    });
  },
  60_000,
);

it.each([
  { name: '派生不一致', status: 422, code: 30143, result: item({ item_id: 'synthetic-other' }) },
  { name: '派生失败', status: 422, code: 30143, result: item({ item_id: null }) },
  {
    name: '商品下架',
    status: 422,
    code: 30141,
    error: new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  },
  {
    name: '演示商品下架',
    status: 422,
    code: 30141,
    error: new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
  },
  {
    name: '联盟故障且无缓存',
    status: 504,
    code: 50401,
    error: new UnionError('upstream_unavailable', 'synthetic dependency failure', 'taobao'),
  },
])(
  '[AC-B1-05e#20] HTTP $name 的状态码和错误信封正确，失败不新增链接',
  async (scenario) => {
    const source = await sourceCard();
    const before = await links();
    if ('result' in scenario) getItem.mockResolvedValue(scenario.result);
    else getItem.mockRejectedValue(scenario.error);
    const response = await request(source.product_key, { item_ref: source.item_ref });
    expect(response.statusCode).toBe(scenario.status);
    expect(response.json()).toMatchObject({ code: scenario.code, trace_id: expect.any(String) });
    assertContract(response, false);
    const body = response.json<{ data?: Record<string, unknown> }>();
    expect(body.data?.['link_id']).toBeUndefined();
    expect(body.data?.['final_price_fen']).toBeUndefined();
    expect(await links()).toEqual(before);
    expect(convert).not.toHaveBeenCalled();
  },
  60_000,
);
