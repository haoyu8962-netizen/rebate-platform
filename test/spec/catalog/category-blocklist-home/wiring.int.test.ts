// B1-04zzzz (D10-860 ⑦ / D10-1045, spec-test point 13): the production assembly. The real AppModule
// serves GET /v1/rank/hot and GET /v1/pages/{page_key}/sections/{section_id}/items; CatalogModule
// must hand its own Catalog (app.category_blocklist) to both use cases, so an active row of the
// request's app drops the item on the next request (after the hot list cache), another app's row
// has no effect, and a disabled row lets it back. specs/material-channels.yaml lists no channel yet,
// so the whitelist is one synthetic entry; the demo adapter's channel ports only answer normalized
// DTOs of synthetic items that carry a synthetic level-one category id (as hot-rank-viewer and
// product-pool-read/wiring do). No catalog provider, service, store or filter is replaced. Database
// via createTestDatabase, Redis via acquireTestRedis. Synthetic values.
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
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { HotRankData } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import type { PageSectionItemsData } from '../../../../apps/api/src/modules/catalog/section-items.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter, type UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { channel, TB_CHANNEL, tbItem } from '../hot-rank-upstream/kit.ts';
import { assertSchema } from '../hot-rank/kit.ts';
import { admin } from '../product-pool-schema/kit.ts';
import { headers, type HttpApp, type Response } from '../search-route/http-kit.ts';

const root = new URL('../../../../', import.meta.url);
const TIMEOUT = 120_000;
const PAGE_KEY = 'home';
const SECTION_ID = 'synthetic_home_feed';
const clock = new platform.FixedClock('2031-05-06T15:08:09+08:00');
const logger = platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
// Every run owns its app scope, including keys on a shared test Redis; never flush Redis.
const appId = `synthetic_home_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const otherApp = `synthetic_home_other_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const ROW_OWN = '0199b0c4-0000-7000-8000-000000000431';
const ROW_OTHER = '0199b0c4-0000-7000-8000-000000000432';

/** Synthetic channel items: a different decimal level-one category per item. */
const NAMES = ['home-a', 'home-b', 'home-c'] as const;
function categoryOf(index: number): string {
  return `9000${String(index + 1).padStart(2, '0')}`;
}
function rankedItem(index: number): UnionItem {
  const item = tbItem(NAMES[index]!, index + 1, {
    finalFen: 2990n,
    commissionBp: 2000n,
    quotedAt: clock.now().toISOString(),
  });
  return { ...item, category_l1_id: categoryOf(index) };
}
const TITLES = NAMES.map((name) => `synthetic-${name}`);
const [TITLE_A, TITLE_B, TITLE_C] = TITLES as [string, string, string];

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  redis = await acquireTestRedis();

  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic-home',
    channels: [channel('taobao', TB_CHANNEL)],
  });
  vi.spyOn(DemoUnionAdapter.prototype, 'channelCategories').mockResolvedValue([
    { categoryId: 'synthetic-home-category', name: '合成类目' },
  ]);
  vi.spyOn(DemoUnionAdapter.prototype, 'channelRanking').mockImplementation(async () => ({
    items: NAMES.map((_name, index) => ({ item: rankedItem(index), salesText: '合成销量' })),
    hasMore: false,
  }));
  // Observation only: the real factory runs; its rule key is seeded as chosen by real assembly.
  const quoters = vi.spyOn(catalog, 'createDemoRebateQuoter');

  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof platform.loadConfig>;
        clock: platform.FixedClock;
        logger: typeof logger;
        dbHandles: platform.DbHandles;
        redisUrl: platform.ConnectionConfig['redisUrl'];
      },
    ) => Promise<HttpApp>;
  };
  app = await createHttpApp('api', {
    config: platform.loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: platform.loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  });
  await app.init();
  expect(quoters).toHaveBeenCalled();

  await db
    .insertInto('config_items')
    .values([
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-home',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-home',
      },
      {
        app_id: appId,
        key: quoters.mock.calls[0]![0].ruleConfigKey,
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: 'synthetic-home',
      },
    ])
    .execute();

  // A published home page holding one union_material section of the whitelisted channel.
  const adminId = await admin(db, appId);
  const sections = [
    {
      id: SECTION_ID,
      type: 'product_grid',
      data_source: {
        kind: 'union_material',
        channels: [{ platform: 'taobao', channel_id: TB_CHANNEL }],
      },
    },
  ];
  await db
    .insertInto('page_versions')
    .values({
      app_id: appId,
      page_key: PAGE_KEY,
      version: 1,
      sections: sql`${JSON.stringify(sections)}::jsonb`,
      status: 'published',
      publish_at: clock.now(),
      publisher: adminId,
      created_by_admin_id: adminId,
      created_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('pages')
    .values({
      app_id: appId,
      page_key: PAGE_KEY,
      current_version: 1,
      gray_version: null,
      gray_percent: 0,
      updated_by_admin_id: adminId,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}, 180_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    vi.restoreAllMocks();
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
}, TIMEOUT);

function get(url: string): Promise<Response> {
  return app!.inject({ method: 'GET', url, headers: { ...headers, 'x-app-id': appId } });
}

async function rankTitles(): Promise<(string | null)[]> {
  const response = await get('/v1/rank/hot?platform=taobao');
  expect(response.statusCode).toBe(200);
  await assertSchema(response.json(), 'HotRankResponse');
  const body = response.json<{ code: number; data: HotRankData }>();
  expect(body.code).toBe(0);
  return body.data.items.map((entry) => entry.product_card.title);
}

async function feedTitles(): Promise<(string | null)[]> {
  const response = await get(`/v1/pages/${PAGE_KEY}/sections/${SECTION_ID}/items`);
  expect(response.statusCode).toBe(200);
  await assertSchema(response.json(), 'PageSectionItemsResponse');
  const body = response.json<{ code: number; data: PageSectionItemsData }>();
  expect(body.code).toBe(0);
  return body.data.items.map((card) => card.title);
}

it(
  '[AC-B1-04zzzz#18] 生产装配：真实 AppModule 的热销榜与首页物料流都经 catalog 自身名单过滤——启用行下次请求即滤掉该类目商品（缓存之后），他应用的行不生效，行改为禁用后下次请求即恢复',
  async () => {
    // Control: no rows yet; both routes show every synthetic item.
    expect(await rankTitles()).toEqual(TITLES);
    expect(await feedTitles()).toEqual(TITLES);

    await sql`INSERT INTO app.category_blocklist (id, app_id, platform, category_id, keyword, reason, status, updated_by)
      VALUES (${ROW_OWN}, ${appId}, 'taobao', ${categoryOf(1)}, NULL, '合成', 'active', 'test'),
             (${ROW_OTHER}, ${otherApp}, 'taobao', ${categoryOf(2)}, NULL, '合成', 'active', 'test')`.execute(
      db!,
    );
    expect(await rankTitles()).toEqual([TITLE_A, TITLE_C]);
    expect(await feedTitles()).toEqual([TITLE_A, TITLE_C]);

    await sql`UPDATE app.category_blocklist SET status = 'disabled' WHERE id = ${ROW_OWN}`.execute(
      db!,
    );
    expect(await rankTitles()).toEqual([TITLE_A, TITLE_B, TITLE_C]);
    expect(await feedTitles()).toEqual([TITLE_A, TITLE_B, TITLE_C]);
  },
  TIMEOUT,
);
