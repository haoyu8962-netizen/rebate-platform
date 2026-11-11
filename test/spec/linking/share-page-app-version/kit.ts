// CT-26zj rule-test kit (D10-1232 / D10-1246): getSharePage and getShareTpwd through the real api
// entry (bootstrap createHttpApp + inject) over a throwaway PostgreSQL and Redis. Only one port is
// replaced — SharePageMaterials, the sharer's converted short link and token of a share link (as in
// the B1-15u kit); links, bindings, union accounts, tickets, rate limits, the route schema and the
// minimum-version stage are real. Every case seeds its own App (tenant). Requests carry exactly the
// headers a case gives (a header set to undefined is left out), so X-App-Version can be omitted.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { LandingLink } from '../../../../apps/api/src/modules/linking/application/link-landing.ts';
import {
  SharePageMaterials,
  type SharePageMaterial,
} from '../../../../apps/api/src/modules/linking/application/share-page.ts';
import { LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
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

export const NOW = '2026-11-10T02:00:00.000Z';
const QUOTED = '2026-11-10T01:58:30.000Z';
const LINK_EXPIRES = '2026-12-10T02:00:00.000Z';
export const TRACE = '0199a3b4-5c6d-7000-8000-0000000026a1';
/** A well-formed link id no tenant ever registers. */
export const MISSING = '0199a3b4-5c6d-7000-8000-0000000026a2';
/** A valid SemVer X-App-Version. */
export const VERSION = '1.0.0';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

export const UA = {
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  wechatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN',
} as const;

/** The three apps (X-Platform values judged by the minimum version) with their install channel. */
export const APP_PLATFORMS = [
  { platform: 'ios', channel: 'appstore' },
  { platform: 'android', channel: 'official' },
  { platform: 'harmony', channel: 'agc' },
] as const;

// The *.int.test.ts files hand in the test-database and Redis helpers: only they may depend on
// @couli/db/testing (depcruise rule testcontainers-only-in-int-tests, type-only imports included).
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}
export interface Provisioning {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

export interface InjectResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | string[] | number | undefined>>;
  readonly payload: string;
  json(): unknown;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<InjectResponse>;
}

/** Request headers; undefined leaves the header out. */
export type RequestHeaders = Readonly<Record<string, string | undefined>>;

/** One seeded share link and the material the replaced port hands out for it. */
export interface ShareLink {
  readonly linkId: string;
  readonly jumpUrl: string;
  /** The token of the link; null when it has none (jd). */
  readonly tpwd: string | null;
}

export interface Tenant {
  readonly appId: string;
  /** A Taobao share link (with token) of a sharer whose Taobao binding is active. */
  taobaoLink(): Promise<ShareLink>;
  /** A JD share link (no token, the sharer's authorization is not judged). */
  jdLink(): Promise<ShareLink>;
}

export interface Harness {
  tenant(): Promise<Tenant>;
  get(linkId: string, headers: RequestHeaders): Promise<InjectResponse>;
  tpwd(linkId: string, ticket: string, headers: RequestHeaders): Promise<InjectResponse>;
}

function hex(length: number): string {
  return randomUUID().replaceAll('-', '').slice(0, length);
}

/**
 * Headers of a share page request from the given X-Platform without X-App-Version; an App also
 * sends its X-Channel. Spread `{ 'x-app-version': VERSION }` over it to send the version.
 */
export function headersOf(
  appId: string,
  platform: string,
  extra: RequestHeaders = {},
): Record<string, string | undefined> {
  const app = APP_PLATFORMS.find((entry) => entry.platform === platform);
  return {
    'x-app-id': appId,
    'x-platform': platform,
    ...(app === undefined ? {} : { 'x-channel': app.channel }),
    'x-trace-id': TRACE,
    'user-agent': UA.safariIos,
    ...extra,
  };
}

function present(headers: RequestHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Registers the file's hooks: one api entry for the whole file. */
export function harness({ createTestDatabase, acquireTestRedis }: Provisioning): Harness {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  const materials = new Map<string, SharePageMaterial>();
  async function read(link: LandingLink): Promise<SharePageMaterial | null> {
    return materials.get(link.link_id) ?? null;
  }
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    redis = await acquireTestRedis();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
    const forRoot = LinkingModule.forRoot;
    vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
      const module = forRoot(...args);
      return {
        ...module,
        providers: [
          ...(module.providers ?? []).filter((provider) => {
            return typeof provider !== 'object' || provider.provide !== SharePageMaterials;
          }),
          { provide: SharePageMaterials, useValue: { read } },
        ],
      };
    });
    // The dynamic import keeps Nest's decorators out of the test TS project.
    const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
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
  }, 180_000);

  beforeEach(() => {
    clock.set(NOW);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      vi.restoreAllMocks();
      try {
        if (db !== undefined) await destroyDb(db);
      } finally {
        try {
          await database?.drop();
        } finally {
          await redis?.stop();
        }
      }
    }
  }, 60_000);

  const handle = (): Kysely<DB> => db!;

  async function tenant(): Promise<Tenant> {
    const appId = `ct26zj_${hex(20)}`;
    const taobaoAccount = randomUUID();
    await handle()
      .insertInto('union_accounts')
      .values({
        id: taobaoAccount,
        app_id: appId,
        platform: 'taobao',
        account_name: 'synthetic-ct26zj-taobao',
        status: 'active',
        auth_status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();

    async function sharer(taobaoActive: boolean): Promise<string> {
      const userId = randomUUID();
      await handle()
        .insertInto('users')
        .values({
          id: userId,
          app_id: appId,
          nickname: '合成分享者',
          avatar: 'https://example.test/avatar',
          invite_code: hex(8),
          attr_code: hex(8),
          level: 'T1',
          register_method: 'synthetic',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      if (taobaoActive) {
        await handle()
          .insertInto('union_bindings')
          .values({
            id: randomUUID(),
            app_id: appId,
            user_id: userId,
            platform: 'taobao',
            union_account_id: taobaoAccount,
            relation_id: `9${hex(8).replace(/[a-f]/g, '7')}`,
            pdd_custom: null,
            status: 'active',
            bound_at: clock.now(),
            blocked_reason: null,
            released_at: null,
            cooldown_until: null,
            created_at: clock.now(),
            updated_at: clock.now(),
          })
          .execute();
      }
      return userId;
    }

    async function link(platform: 'taobao' | 'jd'): Promise<ShareLink> {
      const sharerId = await sharer(platform === 'taobao');
      const linkId = randomUUID();
      const tpwd = platform === 'taobao' ? `￥SynTpwd${hex(12)}￥` : null;
      const jumpUrl = `https://s.click.example.test/t?e=ct26zj${hex(16)}`;
      await handle()
        .insertInto('links')
        .values({
          link_id: linkId,
          lk: null,
          app_id: appId,
          user_id: sharerId,
          device_id: null,
          platform,
          product_key: `${platform}:synthetic-ct26zj-${hex(6)}`,
          raw_item_id: `synthetic-${hex(10)}`,
          raw_fetched_at: QUOTED,
          scene: 'share',
          sub_scene: null,
          pid_scene: 'share',
          pid: 'synthetic-share',
          entry_source: 'search',
          identity_snapshot: {
            user_id: sharerId,
            platform,
            pid: 'synthetic-share',
            pid_scene: 'share',
            attr_code: 'demo0001',
            agent_session_id: null,
          },
          convert_result: null,
          cache_hit: false,
          quoted_final_price_fen: 10000n,
          quoted_coupon_fen: 2000n,
          quoted_coupon_id: null,
          quoted_at: QUOTED,
          expire_at: LINK_EXPIRES,
          agent_session_id: null,
          agent_card_id: null,
          row_version: 0,
          created_at: QUOTED,
          updated_at: QUOTED,
          promo_url: platform === 'taobao' ? jumpUrl : null,
          promo_url_fetched_at: platform === 'taobao' ? QUOTED : null,
        })
        .execute();
      materials.set(linkId, { jumpUrl, tpwd });
      return { linkId, jumpUrl, tpwd };
    }

    return { appId, taobaoLink: () => link('taobao'), jdLink: () => link('jd') };
  }

  return {
    tenant,
    get: (linkId, headers) =>
      app!.inject({
        method: 'GET',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}`,
        headers: present(headers),
        remoteAddress: '198.51.100.31',
      }),
    tpwd: (linkId, ticket, headers) =>
      app!.inject({
        method: 'POST',
        url: `/v1/share-pages/${encodeURIComponent(linkId)}/tpwd`,
        headers: present({ ...headers, 'content-type': 'application/json' }),
        payload: JSON.stringify({ ticket }),
        remoteAddress: '198.51.100.32',
      }),
  };
}

let schemas: Promise<Record<string, JsonSchema>> | undefined;
async function validate(
  value: unknown,
  name: 'SharePageResponse' | 'ShareTpwdResponse' | 'ErrorEnvelope',
): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((contract) => contract.components.schemas);
  const check = createValidatorCompiler()({ schema: (await schemas)[name]!, httpPart: 'body' });
  expect(check(value)).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

/** The data of a 200 share page that passes the contract and is no-store. */
export async function pageData(
  response: InjectResponse,
  what: string,
): Promise<Readonly<Record<string, unknown>>> {
  expect(response.statusCode, `${what}: ${response.payload}`).toBe(200);
  const body = response.json() as { data: Record<string, unknown> };
  expect(body, what).toMatchObject({ code: 0, trace_id: TRACE });
  expect(response.headers['cache-control'], what).toBe('no-store');
  await validate(body, 'SharePageResponse');
  return body.data;
}

/** The token of a 200 token exchange that passes the contract and is no-store. */
export async function tpwdOf(response: InjectResponse, what: string): Promise<string> {
  expect(response.statusCode, `${what}: ${response.payload}`).toBe(200);
  const body = response.json() as { data: { tpwd: string } };
  expect(body, what).toMatchObject({ code: 0, trace_id: TRACE });
  expect(response.headers['cache-control'], what).toBe('no-store');
  await validate(body, 'ShareTpwdResponse');
  return body.data.tpwd;
}

/** A contract error envelope of the given HTTP status and code, no-store; its body. */
export async function refused(
  response: InjectResponse,
  status: number,
  code: number,
  what: string,
): Promise<{ readonly code: number; readonly data?: Readonly<Record<string, unknown>> }> {
  const body = response.json() as { code: number; data?: Record<string, unknown> };
  expect(body, what).toMatchObject({ code, trace_id: TRACE });
  expect(response.statusCode, what).toBe(status);
  expect(response.headers['cache-control'], what).toBe('no-store');
  await validate(body, 'ErrorEnvelope');
  return body;
}

/**
 * An App request without X-App-Version, answered as on trunk and as every other operation answers
 * it: the request check refuses it with 20001, data.fields = [x-app-version].
 */
export async function versionMissing(response: InjectResponse, what: string): Promise<void> {
  const body = await refused(response, 400, 20001, what);
  expect(body.data, what).toEqual({ fields: ['x-app-version'] });
}

/**
 * The share page without its per-read values: the ticket (a new one is issued on every read) and
 * product_card.item_ref (encrypted under a random IV on every read); only their presence is kept.
 */
export function stable(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { tpwd_ticket: ticket, ...rest } = data;
  const out: Record<string, unknown> = {
    ...rest,
    has_ticket: typeof ticket === 'string' && ticket.length > 0,
  };
  const card = rest['product_card'];
  if (typeof card === 'object' && card !== null && 'item_ref' in card) {
    const itemRef = (card as Record<string, unknown>)['item_ref'];
    out['product_card'] = {
      ...card,
      item_ref: typeof itemRef === 'string' && itemRef.length > 0 ? '<item_ref>' : itemRef,
    };
  }
  return out;
}
