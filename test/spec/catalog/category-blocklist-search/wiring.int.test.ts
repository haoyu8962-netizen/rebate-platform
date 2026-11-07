// B1-04zzx (D10-860 ③⑤, spec-test r1 S1): the production assembly. The real AppModule serves
// GET /v1/products/search; CatalogModule must hand its own Catalog (app.category_blocklist) to the
// search use case, so an active row of the request's app drops the item on the next request and a
// disabled row lets it back. Only the demo union adapter's normalized search DTO is changed (each
// item gets a synthetic level-one category id derived from its title serial; demo items carry none);
// no catalog provider, service, store or filter is replaced. Database via createTestDatabase,
// Redis via acquireTestRedis (same setup as test/spec/catalog/search-route/e2e.int.test.ts).
// Synthetic values.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as catalogPublic from '../../../../apps/api/src/modules/catalog/index.ts';
import type { SearchProductsData } from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { assertContract, headers, type HttpApp } from '../search-route/http-kit.ts';

const root = new URL('../../../../', import.meta.url);
const clock = new FixedClock('2031-05-06T15:08:09+08:00');
// Every run owns its app scope, including keys on a shared test Redis; never flush Redis.
const appId = `synthetic_blk_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;

/** Synthetic decimal category id of a demo item: its two-digit title serial after '90001'. */
function categoryOf(title: string): string {
  return `90001${title.slice(-2)}`;
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  await db
    .insertInto('config_items')
    .values([
      { app_id: appId, key: 'search.enabled.taobao', value: true, updated_by: 'synthetic-blk' },
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-blk',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-blk',
      },
    ])
    .execute();
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-blk-account',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-blk-site',
      pid: 'synthetic-blk-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/synthetic-blk-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}, 180_000);

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
        await redis?.stop();
        vi.restoreAllMocks();
      }
    }
  }
});

async function startApp(): Promise<HttpApp> {
  // Dynamic import, as in the search-route e2e test: Nest/decorator code is compiled by the API
  // project, not the erasable-only rule-test TypeScript project.
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
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  return app;
}

it('[AC-B1-04zzx#14] 生产装配：真实 AppModule 搜索 Tab 经 catalog 自身名单过滤——启用行下次请求即滤掉该类目商品，他应用的行不生效，行改为禁用后下次请求即恢复', async () => {
  const originalSearch = DemoUnionAdapter.prototype.searchItems;
  vi.spyOn(DemoUnionAdapter.prototype, 'searchItems').mockImplementation(async function (
    this: DemoUnionAdapter,
    query,
    context,
  ) {
    const page = await originalSearch.call(this, query, context);
    return {
      ...page,
      items: page.items.map((item) => ({ ...item, category_l1_id: categoryOf(item.title) })),
    };
  });
  // Observation only: the real factory runs; its rule key is seeded as chosen by real assembly.
  const quoters = vi.spyOn(catalogPublic, 'createDemoRebateQuoter');
  await startApp();
  expect(quoters).toHaveBeenCalled();
  await db!
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: quoters.mock.calls[0]![0].ruleConfigKey,
      value: { reserve_bp: 0, self_share_bp: 10000 },
      updated_by: 'synthetic-blk',
    })
    .execute();

  const query = new URLSearchParams({ platform: 'taobao', q: '演示商品', limit: '4' });
  const serials = async (): Promise<(string | null)[]> => {
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/products/search?${query}`,
      headers: { ...headers, 'x-app-id': appId },
    });
    expect(response.statusCode).toBe(200);
    await assertContract(response, true);
    const body = response.json<{ code: number; data: SearchProductsData }>();
    expect(body.code).toBe(0);
    return body.data.items.map((card) => card.title?.slice(-2) ?? null);
  };

  // Control: no rows yet. Demo serial 01 has zero commission, so the page starts at 02, 03.
  const before = await serials();
  expect(before).toContain('02');
  expect(before).toContain('03');

  await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
    VALUES ('0199b0c4-0000-7000-8000-000000000201', ${appId}, 'taobao', ${categoryOf('03')}, NULL, '合成', 'active', 'test'),
           ('0199b0c4-0000-7000-8000-000000000202', 'synthetic-other-app', 'taobao', ${categoryOf('02')}, NULL, '合成', 'active', 'test')`.execute(
    db!,
  );
  const blocked = await serials();
  expect(blocked).not.toContain('03');
  expect(blocked).toContain('02');

  await sql`UPDATE app.category_blocklist SET status = 'disabled'
    WHERE id = '0199b0c4-0000-7000-8000-000000000201'`.execute(db!);
  const restored = await serials();
  expect(restored).toContain('03');
  expect(restored).toContain('02');
}, 60_000);
