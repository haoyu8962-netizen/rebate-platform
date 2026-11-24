import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely, PostgresPool } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  AttrCodeReader,
  CallerContext,
  LinkingModule,
  type LinkOpenJump,
} from '../../../../apps/api/src/modules/linking/index.ts';
import * as wiring from '../../../../apps/api/src/modules/linking/application/link-open-wiring.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createIoredisTransport } from '../../../../apps/api/src/modules/platform/redis/ioredis-transport.ts';
import type { RedisTransport } from '../../../../apps/api/src/modules/platform/redis/transport.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import * as union from '../../../../apps/api/src/modules/union/index.ts';

const root = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', root));
const originalLinking = LinkingModule.forRoot;
const clock = new FixedClock('2026-10-08T04:00:00.000Z');
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let observer: RedisTransport | undefined;
let directory: string | undefined;
let config: ReturnType<typeof loadConfig>;
let app: HttpApp | undefined;

interface Response {
  statusCode: number;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<Response>;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const pg = requireApi('pg') as { Pool: new (config: object) => PostgresPool };
  // One connection, bounded acquisition: any catalog/config read that borrows another
  // connection during open fails deterministically instead of hanging the container.
  db = createDb({
    connectionString: database.urlFor('couli_app'),
    max: 1,
    poolFactory: (options) => new pg.Pool({ ...options, connectionTimeoutMillis: 2_000 }),
  });
  redis = await acquireTestRedis();
  observer = createIoredisTransport(redis.url, {
    connectionName: 'synthetic-linking-observer',
    connectTimeoutMs: 2_000,
  });
  await observer.connect();
  const base = fileURLToPath(new URL('.tmp/', root));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, 'b1-06w-'));
  const material = randomBytes(32);
  const ring = await createWrappedKeyring(new LocalKeyProvider(material));
  const materialFile = join(directory, 'synthetic-master.hex');
  const ringFile = join(directory, 'synthetic-keyring.json');
  writeFileSync(materialFile, material.toString('hex'), { mode: 0o600 });
  writeFileSync(ringFile, JSON.stringify(ring), { mode: 0o600 });
  config = loadConfig({
    APP_ENV: 'test',
    FIELD_KEY_PROVIDER: 'local',
    FIELD_MASTER_KEY_FILE: materialFile,
    FIELD_KEYRING_FILE: ringFile,
  });
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', 'in', ['jd', 'pdd'])
    .execute();
}, 180_000);

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  try {
    observer?.disconnect();
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
          if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
});

async function validate(response: Response, schemaName: 'OpenLinkResponse' | 'ErrorEnvelope') {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const contract = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const check = createValidatorCompiler()({
    schema: contract.components.schemas[schemaName]!,
    httpPart: 'body',
  });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

async function seed(appId: string, userId: string) {
  await db!
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: '合成用户',
      avatar: 'https://example.test/avatar',
      invite_code: 'syntheticinvite',
      attr_code: 'demo0001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const settings: [string, boolean | number | Record<string, number>][] = [
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    ['link.open.requote_after_sec', 0],
    ['attr.click_code.jd', false],
    ['attr.click_code.pdd', false],
  ];
  for (const platform of ['jd', 'pdd'] as const) {
    settings.push(
      [`search.enabled.${platform}`, true],
      [`convert.enabled.${platform}`, true],
      [`rebate.${platform}.compare_rate_ratio_bp`, 5000],
    );
    const accountId = randomUUID();
    await db!
      .insertInto('union_accounts')
      .values({
        id: accountId,
        app_id: appId,
        platform,
        account_name: 'synthetic-linking-account',
        status: 'active',
        auth_status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    for (const pidScene of ['query', 'self_buy'] as const) {
      await db!
        .insertInto('union_pids')
        .values({
          id: randomUUID(),
          app_id: appId,
          platform,
          union_account_id: accountId,
          site_id: null,
          pid: `synthetic-${platform}-${pidScene}`,
          pid_scene: pidScene,
          status: 'active',
          hjy_ignore_confirmed_at: clock.now(),
          hjy_ignore_evidence_path: 'https://example.test/evidence',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
    }
  }
  await db!
    .insertInto('config_items')
    .values(
      settings.map(([key, value]) => ({
        app_id: appId,
        key,
        value,
        updated_by: 'synthetic-linking-fixture',
      })),
    )
    .execute();
}

async function start(signedIn: boolean) {
  const appId = `synthetic_open_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const userId = randomUUID();
  await seed(appId, userId);
  if (signedIn) {
    // The only replaced providers: the two identity placeholders explicitly allowed by
    // decision-orchestrator.md. All other providers, including REQUEST_CHECKS, stay real.
    vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
      const module = originalLinking(...args);
      return {
        ...module,
        providers: [
          ...(module.providers ?? []).filter(
            (provider) =>
              !(
                typeof provider === 'object' &&
                (provider.provide === CallerContext || provider.provide === AttrCodeReader)
              ),
          ),
          {
            provide: CallerContext,
            useValue: { current: async () => ({ appId, userId, deviceId: null }) },
          },
          { provide: AttrCodeReader, useValue: { attrCode: async () => 'demo0001' } },
        ],
      };
    });
  }
  // Call-through observers: no factory, union adapter, database or cache is replaced.
  const governed = vi.spyOn(union, 'createGovernedAdapter');
  const convert = vi.spyOn(union.DemoUnionAdapter.prototype, 'convert');
  const getItem = vi.spyOn(union.DemoUnionAdapter.prototype, 'getItem');
  const quoter = vi.spyOn(catalog, 'createDemoRebateQuoter');
  const cards = vi.spyOn(catalog, 'createCatalogCardEntry');
  const entry = vi.spyOn(wiring, 'createWiredLinkOpen');
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  const bootstrapOptions = {
    config,
    clock,
    logger,
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  };
  app = await createHttpApp('api', bootstrapOptions);
  await app.init();
  expect(quoter).toHaveBeenCalledTimes(1);
  await db!
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: quoter.mock.calls[0]![0].ruleConfigKey,
      value: { reserve_bp: 0, self_share_bp: 10000 },
      updated_by: 'synthetic-linking-fixture',
    })
    .execute();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-app-version': '2.0.0',
    'x-device-id': randomUUID(),
    'x-trace-id': randomUUID(),
  };
  const created = await app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(created.statusCode).toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  headers['x-device-id'] = device.device_id;
  const post = async (linkId: string, idempotencyKey: string) => {
    const path = `/v1/links/${linkId}/open`;
    const payload = JSON.stringify({ installed: 'true', no_rebate: false });
    const timestamp = String(Math.floor(clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = createHmac('sha256', device.install_secret)
      .update(
        ['POST', path, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join(
          '\n',
        ),
      )
      .digest('hex');
    return app!.inject({
      method: 'POST',
      url: path,
      payload,
      headers: {
        ...headers,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': signature,
        'idempotency-key': idempotencyKey,
      },
    });
  };
  const link = async (platform: 'jd' | 'pdd') => {
    const query = new URLSearchParams({ platform, q: '演示商品', limit: '1' });
    const response = await app!.inject({
      method: 'GET',
      url: `/v1/products/search?${query}`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const result = response.json<{ code: number; data: { items: { link_id: string }[] } }>();
    expect(result.code).toBe(0);
    expect(result.data.items).toHaveLength(1);
    const registered = await db!
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', appId)
      .where('link_id', '=', result.data.items[0]!.link_id)
      .executeTakeFirstOrThrow();
    const linkId = randomUUID();
    // Insert a complete synthetic stale snapshot: written identity/quote columns are immutable.
    // Keep the real registration's identity and product reference, leaving its row untouched.
    // The different quote makes open exercise pricing, the catalog card entry and registration.
    await db!
      .insertInto('links')
      .values({ ...registered, link_id: linkId, quoted_final_price_fen: 1n })
      .execute();
    getItem.mockClear();
    convert.mockClear();
    return linkId;
  };
  const restart = async () => {
    await app!.close();
    app = undefined;
    governed.mockClear();
    quoter.mockClear();
    cards.mockClear();
    entry.mockClear();
    app = await createHttpApp('api', bootstrapOptions);
    await app.init();
    expect(quoter).toHaveBeenCalledTimes(1);
  };
  return { appId, userId, post, link, governed, convert, getItem, cards, entry, restart };
}

async function keys(): Promise<string[]> {
  const all = new Set<string>();
  let cursor = '0';
  do {
    const page = (await observer!.call('SCAN', cursor, 'COUNT', 200)) as [string, string[]];
    cursor = page[0];
    for (const key of page[1]) all.add(key);
  } while (cursor !== '0');
  return [...all];
}

function containsJump(value: unknown, jump: LinkOpenJump): boolean {
  if (isDeepStrictEqual(value, jump)) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).some((nested: unknown) => containsJump(nested, jump))
  );
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06w#1] 真实应用 %s open 经治理取价和转链、重算卡片、注册新 link 并把 jump 写进 Redis',
  async (platform) => {
    const f = await start(true);
    const linkId = await f.link(platform);
    // Cold process: the preceding search must not warm the quoter/config reader and hide
    // a second pool acquisition during the open transaction (B1-06m follow-up).
    await f.restart();
    const before = new Set(await keys());
    const response = await f.post(linkId, 'synthetic-first-open');
    expect(response.statusCode).toBe(200);
    await validate(response, 'OpenLinkResponse');
    const body = response.json<{
      code: number;
      data: {
        jump: LinkOpenJump;
        new_link_id: string;
        attempt_id: string;
        requote_failed: boolean;
      };
    }>();
    expect(body.code).toBe(0);
    expect(body.data.requote_failed).toBe(false);
    expect(body.data.new_link_id).toEqual(expect.any(String));
    expect(body.data.new_link_id).not.toBe(linkId);
    expect(f.entry).toHaveBeenCalled();
    const environment = f.entry.mock.calls[0]![0].environment;
    expect(environment.appEnv).toBe('test');
    const appDefinitions = JSON.parse(
      readFileSync(new URL('contracts/apps.json', root), 'utf8'),
    ) as wiring.LinkOpenApps;
    expect(environment.apps.apps.pdd).toEqual(appDefinitions.apps.pdd);
    expect(environment.apps.apps.jd).toEqual(appDefinitions.apps.jd);
    if (platform === 'pdd' && appDefinitions.apps.pdd.ios.query_schemes.length === 0) {
      expect(
        [body.data.jump.primary, ...body.data.jump.fallbacks].some(
          (step) => step.type === 'scheme',
        ),
      ).toBe(false);
    }
    expect(f.cards).toHaveBeenCalled();
    expect(f.getItem).toHaveBeenCalled();
    expect(f.convert).toHaveBeenCalledTimes(1);
    for (const spy of [f.getItem, f.convert]) {
      for (const [index, args] of spy.mock.calls.entries()) {
        const wrapping = f.governed.mock.calls.filter(
          ([adapter]) => adapter === spy.mock.contexts[index],
        );
        expect(wrapping).toHaveLength(1);
        const context = args.at(-1);
        expect(context).toMatchObject({
          appId: f.appId,
          purpose: 'online',
          signal: expect.any(AbortSignal),
          baseUrl: wrapping[0]![1].endpoint.baseUrl,
          headers: {},
        });
      }
    }
    expect(
      f.governed.mock.calls.filter(([, options]) => options.endpoint.platform === platform),
    ).toHaveLength(1);
    const identity = f.convert.mock.calls[0]![1];
    expect(identity.claims.appId).toBe(f.appId);
    expect(identity.claims.userId).toBe('demo0001');
    expect(identity.claims.userId).not.toBe(f.userId);
    const renewed = await db!
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('link_id', '=', body.data.new_link_id)
      .executeTakeFirstOrThrow();
    expect(renewed.user_id).toBe(f.userId);
    expect(renewed.platform).toBe(platform);
    expect(
      await db!
        .selectFrom('link_open_attempts')
        .select('attempt_id')
        .where('app_id', '=', f.appId)
        .where('attempt_id', '=', body.data.attempt_id)
        .execute(),
    ).toHaveLength(1);

    const cached: string[] = [];
    for (const key of (await keys()).filter((key) => !before.has(key))) {
      if ((await observer!.call('TYPE', key)) !== 'string') continue;
      const text = await observer!.call('GET', key);
      if (typeof text !== 'string') continue;
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      if (containsJump(value, body.data.jump)) cached.push(key);
    }
    expect(cached.length, '应在真实 Redis 读到这次 open 的外跳方案').toBeGreaterThan(0);
    for (const key of cached) {
      const ttl = (await observer!.call('TTL', key)) as number;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
    const replay = await f.post(linkId, 'synthetic-first-open');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);
    expect(f.convert).toHaveBeenCalledTimes(1);
    // A new idempotency key after the single-flight window must still reuse Redis.
    clock.advanceMs(3001);
    const cachedResponse = await f.post(linkId, 'synthetic-second-open');
    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json()).toMatchObject({ code: 0, data: { jump: body.data.jump } });
    expect(f.convert).toHaveBeenCalledTimes(1);
    const logs = await db!
      .selectFrom('link_logs')
      .select('cache_hit')
      .where('app_id', '=', f.appId)
      .where('event', '=', 'open')
      .execute();
    expect(logs).toHaveLength(2);
    expect(logs.filter((row) => row.cache_hit)).toHaveLength(1);
  },
  60_000,
);

it('[AC-B1-06w#2] 身份端口不替换时，真实游客非分享 open 返回 10001 而非暂停占位 50301', async () => {
  const f = await start(false);
  const linkId = await f.link('jd');
  const response = await f.post(linkId, 'synthetic-guest-open');
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 10001 });
  await validate(response, 'ErrorEnvelope');
  expect(f.convert).not.toHaveBeenCalled();
}, 60_000);

type LinkOpenApps = wiring.LinkOpenApps;
type LinkOpenEnvironment = wiring.LinkOpenEnvironment;
const apps = JSON.parse(readFileSync(new URL('contracts/apps.json', root), 'utf8')) as LinkOpenApps;

/** Reuse every real port assembled by AppModule; inject only the linking environment.
 * The process and demo adapters stay in test mode. No prod AppModule is started.
 */
async function setup(platform: 'jd' | 'pdd', environment: LinkOpenEnvironment) {
  const f = await start(true);
  const linkId = await f.link(platform);
  // Resolve the real request-scoped service without converting/caching the subject link.
  const probe = await f.post(randomUUID(), 'synthetic-resolve-open');
  expect(probe.statusCode).toBe(404);
  expect(probe.json()).toMatchObject({ code: 30144 });
  expect(f.entry).toHaveBeenCalled();
  const options = f.entry.mock.calls.at(-1)![0];
  const cacheGet = vi.spyOn(options.cache, 'get');
  // Outside rejection handling: NotImplemented is never an accepted denial.
  const service = wiring.createWiredLinkOpen({ ...options, environment });
  const open = async (client: 'ios' | 'android' | 'harmony' | 'h5' | 'web' = 'ios') => {
    try {
      return await service.open({
        linkId,
        client,
        installed: 'true',
        noRebate: false,
        idempotencyKey: randomUUID(),
        traceId: randomUUID(),
      });
    } catch (rejected) {
      return { rejected };
    }
  };
  return { ...f, open, cache: options.cache, cacheGet };
}

function jumpOf(result: unknown): LinkOpenJump {
  expect(result).toMatchObject({
    status: 200,
    envelope: {
      code: 0,
      data: {
        jump: {
          primary: { type: expect.any(String), value: expect.any(String) },
          fallbacks: expect.any(Array),
          expire_at: expect.any(String),
        },
      },
    },
  });
  return (result as { envelope: { data: { jump: LinkOpenJump } } }).envelope.data.jump;
}

function denied(result: unknown): void {
  expect(result).toMatchObject({ status: 503, envelope: { code: expect.any(Number) } });
  const envelope = (result as { envelope: { code: number; data?: unknown } }).envelope;
  expect([50301, 50303]).toContain(envelope.code);
  expect(envelope.data == null || !('jump' in Object(envelope.data))).toBe(true);
}

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06w#10] prod %s 的 CAP 外跳路径全未验证时不能下发方案',
  async (platform) => {
    const f = await setup(platform, { appEnv: 'prod', apps, verifiedPaths: {} });
    denied(await f.open());
  },
  30_000,
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06w#11] prod %s 只验证 H5 时主路径是 H5，fallback 也不能夹带未验证路径',
  async (platform) => {
    const f = await setup(platform, {
      appEnv: 'prod',
      apps,
      verifiedPaths: { [platform]: { ios: ['h5'] } },
    });
    const jump = jumpOf(await f.open());
    expect(jump).toMatchObject({ primary: { type: 'h5' }, fallbacks: [] });
    expect(f.convert).toHaveBeenCalledTimes(1);
    const converted = await f.convert.mock.results[0]!.value;
    expect(converted).toMatchObject({ kind: 'url', url: jump.primary.value });
  },
  30_000,
);

it.each(['android', 'harmony', 'h5', 'web'] as const)(
  '[AC-B1-06w#12] ios 验证标记不能放行 %s 客户端',
  async (client) => {
    const f = await setup('jd', {
      appEnv: 'prod',
      apps,
      verifiedPaths: { jd: { ios: ['scheme', 'universal_link', 'h5'] } },
    });
    denied(await f.open(client));
  },
  30_000,
);

it('[AC-B1-06w#13] 京东标记不能放行拼多多，候选 scheme 不能靠平台名称自动获准', async () => {
  const f = await setup('pdd', {
    appEnv: 'prod',
    apps,
    verifiedPaths: { jd: { ios: ['scheme', 'universal_link', 'h5'] } },
  });
  denied(await f.open());
}, 30_000);

it.each(['synthetic-pdd-a', 'synthetic-pdd-b'])(
  '[AC-B1-06w#14] 已验证拼多多 scheme %s 来自注入的 apps.json，不写死 pinduoduo',
  async (scheme) => {
    const configured = structuredClone(apps);
    const modified: LinkOpenApps = {
      apps: {
        ...configured.apps,
        pdd: {
          ...configured.apps.pdd,
          status: 'verified',
          ios: { query_schemes: [scheme] },
        },
      },
    };
    const f = await setup('pdd', {
      appEnv: 'prod',
      apps: modified,
      verifiedPaths: { pdd: { ios: ['scheme', 'h5'] } },
    });
    const mobileUrl = 'https://example.test/synthetic-pdd-purchase';
    const schemaUrl = `${scheme}://synthetic/landing?token=a%2fb`;
    f.convert.mockResolvedValue({ kind: 'url', url: mobileUrl, schema_url: schemaUrl });
    const jump = jumpOf(await f.open());
    expect(jump.primary).toEqual({ type: 'scheme', value: schemaUrl });
    expect(jump.fallbacks).toEqual([{ type: 'h5', value: mobileUrl }]);
  },
  30_000,
);

it('[AC-B1-06w#15] apps.json 未给拼多多 scheme，即使标记为已验证也不能凭空补一个', async () => {
  const f = await setup('pdd', {
    appEnv: 'prod',
    apps,
    verifiedPaths: { pdd: { ios: ['scheme', 'h5'] } },
  });
  const jump = jumpOf(await f.open());
  expect(jump).toMatchObject({ primary: { type: 'h5' }, fallbacks: [] });
}, 30_000);

it('[AC-B1-06w#17] prod 京东验证了三种路径后保留已安装端的主路径与回退顺序', async () => {
  const f = await setup('jd', {
    appEnv: 'prod',
    apps: { apps: { ...apps.apps, jd: { ...apps.apps.jd, status: 'verified' } } },
    verifiedPaths: { jd: { ios: ['scheme', 'universal_link', 'h5'] } },
  });
  const jump = jumpOf(await f.open());
  expect(jump.primary.type).toBe('scheme');
  expect(jump.primary.value.startsWith(`${apps.apps.jd.ios.query_schemes[0]!}://`)).toBe(true);
  expect(jump.fallbacks.map((step) => step.type)).toEqual(['universal_link', 'h5']);
}, 30_000);

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-06w#16] prod %s 的缓存主路径和 fallback 同样须验证',
  async (platform) => {
    const f = await setup(platform, {
      appEnv: 'prod',
      apps,
      verifiedPaths: { [platform]: { ios: ['h5'] } },
    });
    const allowed = jumpOf(await f.open());
    expect(allowed.primary.type).toBe('h5');
    expect(f.cacheGet).toHaveBeenCalled();
    const cacheKey = f.cacheGet.mock.calls[0]![0];
    // Fixture data through the real Redis cache, never a substituted get/put implementation.
    for (const bad of [
      {
        ...allowed,
        primary: { type: 'scheme' as const, value: 'synthetic-unverified://open' },
        fallbacks: [],
      },
      {
        ...allowed,
        fallbacks: [{ type: 'scheme' as const, value: 'synthetic-unverified://fallback' }],
      },
    ]) {
      await f.cache.put(cacheKey, {
        jump: bad,
        fetchedAt: clock.now().toISOString(),
        ...(cacheKey.variant === undefined ? {} : { variant: cacheKey.variant }),
      });
      clock.advanceMs(3001);
      const result = await f.open();
      if ('envelope' in result && result.envelope.code === 0) {
        const safe = jumpOf(result);
        expect([safe.primary, ...safe.fallbacks].every((step) => step.type === 'h5')).toBe(true);
      } else {
        denied(result);
      }
    }
  },
  60_000,
);

it('[AC-B1-06w#18] prod 已验证 H5 缓存仍可复用，不必重新转链', async () => {
  const f = await setup('jd', {
    appEnv: 'prod',
    apps,
    verifiedPaths: { jd: { ios: ['h5'] } },
  });
  const first = jumpOf(await f.open());
  clock.advanceMs(3001);
  expect(jumpOf(await f.open())).toEqual(first);
  expect(f.convert).toHaveBeenCalledTimes(1);
}, 60_000);
