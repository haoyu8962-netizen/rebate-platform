// B1-28m (D10-462 ③, BR-PRICE-11): GET /v1/rank/hot over the real AppModule, database and Redis. A
// signed-in user's cards are quoted for that user; identity comes only from what the token check
// verified. specs/material-channels.yaml lists no channel yet, so the whitelist is one synthetic
// entry, and the demo adapter's channel ports answer one synthetic item. Controllers, request
// checks, identity, the hot list cache, card assembly and link persistence stay real.
//
// The guest cases hold on a route that never reads a token, so each one goes on to a request with
// a token in the same flow: that is what tells "guest because no token came" from "guest because
// tokens are ignored".
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { HotRankData } from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { createTokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { seedUser } from '../../identity/request-context/db-kit.ts';
import { fixture } from '../../identity/token/kit.ts';
import { channel, TB_CHANNEL, tbItem } from '../hot-rank-upstream/kit.ts';
import { assertSchema } from '../hot-rank/kit.ts';

const root = new URL('../../../../', import.meta.url);
const deps = fixture();
const appId = `synthetic_rank_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const productKey = 'tb:28';
const cachedCategory = 'synthetic-rank-category';
const headers = {
  'x-app-id': appId,
  'x-platform': 'ios',
  'x-app-version': '2.0.0',
  'x-trace-id': '0000000000000000000000000000b28d',
};
const item = tbItem('viewer', 28, {
  finalFen: 2990n,
  commissionBp: 2000n,
  quotedAt: deps.clock.now().toISOString(),
});
/**
 * The demo quoter's amount of `item` under the rule seeded below. B1-05zc (D10-641): one amount on
 * the normal basis (2990 × 20% = 598), although compare_rate_ratio_bp = 5000 is still seeded; the
 * old range was 299–598.
 */
const GUEST_REBATE = { rebate_basis: 'normal', rebate_min_fen: 598, rebate_max_fen: 598 };

interface Device {
  device_id: string;
  install_secret: string;
}

interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
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

type Account = Awaited<ReturnType<typeof signIn>>;

let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;
let directory: string | undefined;
let phone: Device;
let tablet: Device;
const quotedViewers: catalog.Viewer[] = [];
const ownRebates = new Map<string, bigint>();
const rankedCategories: (string | null)[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  const base = fileURLToPath(new URL('.tmp/', root));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, 'b1-28m-'));
  // Ephemeral fixture material, as identity's request-context test; no real credentials are read.
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  const masterFile = join(directory, 'synthetic-master.hex');
  const keyringFile = join(directory, 'synthetic-keyring.json');
  writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
  writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });

  vi.spyOn(platform, 'getMaterialChannels').mockReturnValue({
    version: 'synthetic-viewer',
    channels: [channel('taobao', TB_CHANNEL)],
  });
  vi.spyOn(DemoUnionAdapter.prototype, 'channelCategories').mockResolvedValue([
    { categoryId: cachedCategory, name: '合成类目' },
  ]);
  vi.spyOn(DemoUnionAdapter.prototype, 'channelRanking').mockImplementation(async (request) => {
    rankedCategories.push(request.categoryId);
    return { items: [{ item, salesText: '合成销量' }], hasMore: false };
  });
  // The demo quoter ignores who asks, so its result alone cannot show whose quote a card carries:
  // the wrapper records the viewer the process quoter receives and gives each signed-in user an
  // amount of their own, as the real quoter does by user level.
  const demoQuoter = catalog.createDemoRebateQuoter;
  const quoters = vi.spyOn(catalog, 'createDemoRebateQuoter').mockImplementation((options) => {
    const quoter = demoQuoter(options);
    return {
      quote: async (quoted, viewer, context) => {
        quotedViewers.push(viewer);
        const quote = await quoter.quote(quoted, viewer, context);
        const own = viewer.userId === null ? undefined : ownRebates.get(viewer.userId);
        return own === undefined ? quote : { ...quote, rebateMinFen: own, rebateMaxFen: own };
      },
    };
  });

  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(
      entry: 'api',
      options: {
        config: platform.AppConfig;
        clock: typeof deps.clock;
        logger: ReturnType<typeof platform.createRootLogger>;
        dbHandles: platform.DbHandles;
        redisUrl: platform.ConnectionConfig['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  app = await createHttpApp('api', {
    config: platform.loadConfig({
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: deps.keyring.kid,
      JWT_PRIVATE_KEY_PEM: deps.keyring.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    }),
    clock: deps.clock,
    logger: platform.createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: platform.loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl,
  });
  await app.init();
  expect(quoters).toHaveBeenCalledTimes(1);
  await db
    .insertInto('config_items')
    .values([
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-viewer',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-viewer',
      },
      {
        app_id: appId,
        key: quoters.mock.calls[0]![0].ruleConfigKey,
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: 'synthetic-viewer',
      },
    ])
    .execute();
  phone = await registerDevice();
  tablet = await registerDevice();
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
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  }
});

async function registerDevice(): Promise<Device> {
  const response = await app!.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify({
      device_hash: createHash('sha256').update(randomUUID()).digest('hex'),
      id_source: 'idfv',
    }),
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ data: Device }>().data;
}

/** A really issued session of a new user on the device, with that user's own rebate amount. */
async function signIn(
  device: Device,
  options: {
    issuer?: Pick<typeof deps, 'clock' | 'tokens'>;
    scp?: 'full' | 'deletion_only';
  } = {},
) {
  const user = await seedUser(db, appId);
  const issued = await db.transaction().execute((trx) =>
    createSession(
      trx,
      {
        uid: user.id,
        app_id: appId,
        device_id: device.device_id,
        scp: options.scp ?? 'full',
      },
      options.issuer ?? deps,
    ),
  );
  const rebateFen = 700 + ownRebates.size;
  ownRebates.set(user.id, BigInt(rebateFen));
  return { user, device, token: issued.access_token, rebateFen };
}

function bearer(account: Account | undefined): string | undefined {
  return account === undefined ? undefined : `Bearer ${account.token}`;
}

/** One GET of the list; X-Device-Id is always sent, and never names the viewer by itself. */
function rank(
  device: Device,
  authorization?: string,
  extra: Record<string, string> = {},
  category?: string,
): Promise<Response> {
  const query = new URLSearchParams({
    platform: 'taobao',
    ...(category === undefined ? {} : { category }),
  });
  quotedViewers.length = 0;
  return app!.inject({
    method: 'GET',
    url: `/v1/rank/hot?${query}`,
    headers: {
      ...headers,
      'x-device-id': device.device_id,
      ...extra,
      ...(authorization === undefined ? {} : { authorization }),
    },
  });
}

/** A 200 list of one card for the account (a guest when undefined): quote, card and links row. */
async function expectCardFor(response: Response, account: Account | undefined) {
  expect(response.statusCode).toBe(200);
  await assertSchema(response.json(), 'HotRankResponse');
  const { items } = response.json<{ data: HotRankData }>().data;
  expect(items).toHaveLength(1);
  const card = items[0]!.product_card;
  expect(card).toMatchObject({ product_key: productKey, link_id: expect.any(String) });

  const viewer = {
    appId,
    userId: account?.user.id ?? null,
    deviceId: account?.device.device_id ?? null,
  };
  expect(quotedViewers).toEqual([viewer]);
  expect(card).toMatchObject(
    account === undefined
      ? GUEST_REBATE
      : { rebate_min_fen: account.rebateFen, rebate_max_fen: account.rebateFen },
  );
  const link = await db
    .selectFrom('links')
    .select(['user_id', 'device_id', 'entry_source', 'identity_snapshot'])
    .where('app_id', '=', appId)
    .where('link_id', '=', card.link_id!)
    .executeTakeFirstOrThrow();
  expect(link).toMatchObject({
    user_id: viewer.userId,
    device_id: viewer.deviceId,
    entry_source: 'rank',
    identity_snapshot: {
      user_id: viewer.userId,
      attr_code: account?.user.attrCode ?? null,
    },
  });
  return card;
}

/** Refused by the request checks: an error envelope, and no quote for anyone. */
async function expectRefused(response: Response, status: number, code: number) {
  expect(response.statusCode).toBe(status);
  await assertSchema(response.json(), 'ErrorEnvelope');
  expect(response.json()).toMatchObject({ code });
  expect(quotedViewers).toEqual([]);
}

function tamperedSignature(token: string): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  return `Bearer ${header}.${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
}

const MALFORMED: readonly (readonly [string, (token: string) => string])[] = [
  ['不是 JWT', () => 'Bearer synthetic-broken-token'],
  ['Bearer 后没有令牌', () => 'Bearer'],
  ['不是 Bearer', () => 'Basic synthetic-password'],
  ['签名被改动', tamperedSignature],
];

it('[AC-B1-28m#4][BR-PRICE-11] 真实 AppModule：带登录 token，报价收到的查看者是该用户而不是 userId=null，卡面是本人报价，links 行归本人，响应 no-store', async () => {
  const account = await signIn(phone);

  // The raw X-Device-Id names another device: the viewer's device comes from the token.
  const response = await rank(tablet, bearer(account));

  await expectCardFor(response, account);
  expect(response.headers['cache-control']).toBe('no-store');
}, 60_000);

it('[AC-B1-28m#5] 真实 AppModule：登录与游客交替，每次请求只按自己的 token，不串身份', async () => {
  const first = await signIn(phone);
  const second = await signIn(tablet);

  // Alternation also catches a singleton provider retaining an earlier request's identity.
  for (const account of [first, undefined, second, first]) {
    await expectCardFor(await rank(tablet, bearer(account)), account);
  }
}, 60_000);

it('[AC-B1-28m#6] 不带 token 仍是游客：userId 与 deviceId 都为空（裸 X-Device-Id 不算验证过的设备），游客报价，响应不加 no-store；同一设备带上 token 才换成本人', async () => {
  const account = await signIn(phone);

  const guest = await rank(phone);
  await expectCardFor(guest, undefined);
  expect(guest.headers['cache-control']).toBeUndefined();

  await expectCardFor(await rank(phone, bearer(account)), account);
}, 60_000);

it('[AC-B1-28m#7] 伪造 x-user-id 不提升身份：不带 token 仍是游客，带 token 仍是 token 的用户', async () => {
  const victim = await signIn(phone);
  const account = await signIn(tablet);
  const forged = { 'x-user-id': victim.user.id, 'x-session-id': 'synthetic-forged-session' };

  await expectCardFor(await rank(phone, undefined, forged), undefined);
  await expectCardFor(await rank(tablet, bearer(account), forged), account);
}, 60_000);

it.each(MALFORMED)(
  '[AC-B1-28m#8][BR-ID-01] 无效 Authorization（%s）→ 401/10002，同 searchProducts 的 optional 口径，不退回游客',
  async (_name, authorization) => {
    const account = await signIn(phone);

    await expectRefused(await rank(phone, authorization(account.token)), 401, 10002);
  },
  60_000,
);

it('[AC-B1-28m#9][BR-ID-01] 过期 token（签名有效、会话未吊销）→ 401/10002，不退回游客', async () => {
  const clock = new platform.FixedClock('2025-10-05T04:00:00.000Z');
  const tokens = createTokenService({ clock, keys: deps.keyring });
  const account = await signIn(phone, { issuer: { clock, tokens } });

  await expectRefused(await rank(phone, bearer(account)), 401, 10002);
}, 60_000);

it('[AC-B1-28m#10][BR-ID-07] 会话吊销后同一 token → 401/10002，不退回游客', async () => {
  const account = await signIn(phone);
  await db
    .updateTable('sessions')
    .set({
      revoked_at: deps.clock.now(),
      revoke_reason: 'synthetic-viewer',
      updated_at: deps.clock.now(),
    })
    .where('app_id', '=', appId)
    .where('user_id', '=', account.user.id)
    .execute();

  await expectRefused(await rank(phone, bearer(account)), 401, 10002);
}, 60_000);

it('[AC-B1-28m#11][BR-ID-07] token 与 X-App-Id 不是同一 App → 403/10403', async () => {
  const account = await signIn(phone);

  await expectRefused(
    await rank(phone, bearer(account), { 'x-app-id': 'synthetic_rank_other' }),
    403,
    10403,
  );
}, 60_000);

it('[AC-B1-28m#12][BR-ID-01] deletion_only 会话：x-session-scopes 只有 full，同 searchProducts → 403/10405', async () => {
  const account = await signIn(phone, { scp: 'deletion_only' });

  await expectRefused(await rank(phone, bearer(account)), 403, 10405);
}, 60_000);

it('[AC-B1-28m#13][BR-PRICE-11] 榜单缓存不分人：同一页只向联盟取一次，卡片与 link_id 每次按当前查看者现算', async () => {
  const first = await signIn(phone);
  const second = await signIn(tablet);
  const links: string[] = [];

  for (const account of [first, second, undefined]) {
    const response = await rank(tablet, bearer(account), {}, cachedCategory);
    links.push((await expectCardFor(response, account)).link_id!);
  }

  expect(new Set(links).size).toBe(3);
  expect(rankedCategories.filter((category) => category === cachedCategory)).toHaveLength(1);
}, 60_000);
