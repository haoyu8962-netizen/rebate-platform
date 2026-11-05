import { createHash, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { CallerContext, LinkingModule } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  tokenPrincipal,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { NOW, ROOT, TRACE, success, validate, type Response } from '../auth-url/kit.ts';
import { expectNoState, planValues } from '../pdd-auth-link/kit.ts';

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(key: symbol): T;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

type Platform = 'taobao' | 'pdd';
type BindingStatus = 'unbound' | 'pending_auth' | 'released' | 'invalid' | 'active' | 'blocked';
const originalLinking = LinkingModule.forRoot;
const clock = new FixedClock(NOW);
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB>;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.restoreAllMocks();
  }
}, 60_000);

afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    try {
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
}, 60_000);

async function seed() {
  const appId = `synthetic_pdd_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userId = randomUUID();
  const deviceId = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: userId,
      app_id: appId,
      nickname: '合成拼多多授权用户',
      avatar: 'https://example.test/avatar',
      invite_code: 'syntheticinvite',
      attr_code: 'demo0001',
      level: 'T1',
      register_method: 'synthetic',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('user_risk_state')
    .values({
      app_id: appId,
      user_id: userId,
      state: 'normal',
      changed_by: 'synthetic-fixture',
      changed_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      app_id: appId,
      device_hash: createHash('sha256').update(deviceId).digest('hex'),
      id_source: 'idfv',
      install_secret_cipher: Buffer.from('synthetic-unused-cipher'),
      platform: 'ios',
      app_version: '2.0.0',
      last_seen_at: clock.now(),
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const accounts = { taobao: randomUUID(), pdd: randomUUID() };
  for (const platform of ['taobao', 'pdd'] as const) {
    await db
      .insertInto('union_accounts')
      .values({
        id: accounts[platform],
        app_id: appId,
        platform,
        account_name: 'synthetic-auth-account',
        status: 'active',
        auth_status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
  }
  const rows = () =>
    db
      .selectFrom('union_auth_sessions')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('state')
      .execute();
  return { appId, userId, deviceId, accounts, rows };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function start(f: Fixture) {
  // 仅替换身份占位端口，身份仍从实际验证过的令牌读取，保留请求检查链。
  vi.spyOn(LinkingModule, 'forRoot').mockImplementation((...args) => {
    const module = originalLinking(...args);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) => {
        if (
          typeof provider !== 'object' ||
          provider.provide !== CallerContext ||
          !('useFactory' in provider)
        )
          return provider;
        return {
          ...provider,
          useFactory: (request: { headers: Record<string, string> }) => ({
            current: async () => {
              const principal = tokenPrincipal(request);
              return {
                appId: principal?.app_id ?? request.headers['x-app-id']!,
                userId: principal?.uid ?? null,
                deviceId: principal?.device_id ?? null,
              };
            },
          }),
        };
      }),
    };
  });
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
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  const sid = randomUUID();
  await db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      sid,
      app_id: f.appId,
      user_id: f.userId,
      device_id: f.deviceId,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  const issued = await app.get<TokenService>(TOKEN_SERVICE).issueAccess({
    app_id: f.appId,
    uid: f.userId,
    device_id: f.deviceId,
    sid,
    scp: 'full',
  });
  return (platform: Platform) =>
    app!.inject({
      method: 'GET',
      url: `/v1/unions/${platform}/auth-url`,
      headers: {
        'x-app-id': f.appId,
        'x-device-id': f.deviceId,
        'x-platform': 'ios',
        'x-app-version': '2.0.0',
        'x-trace-id': TRACE,
        authorization: `Bearer ${issued}`,
      },
    });
}

async function bind(f: Fixture, platform: Platform, status: BindingStatus, accountId?: string) {
  const id = randomUUID();
  await db
    .insertInto('union_bindings')
    .values({
      id,
      app_id: f.appId,
      user_id: f.userId,
      platform,
      union_account_id: accountId ?? f.accounts[platform],
      status,
      blocked_reason: status === 'blocked' ? 'admin_disable' : null,
      released_at: status === 'released' ? new Date('2026-01-01T00:00:00.000Z') : null,
      cooldown_until: status === 'released' ? new Date('2026-02-01T00:00:00.000Z') : null,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return id;
}

/** B1-06zf (D10-658 ②): an active self_buy slot of the account, for the authorization link. */
async function selfBuySlot(f: Fixture, accountId: string) {
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      platform: 'pdd',
      union_account_id: accountId,
      site_id: null,
      pid: `synthetic-maintenance-pdd-self_buy-${randomUUID().slice(0, 8)}`,
      pid_scene: 'self_buy',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'synthetic/evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}

async function expire(f: Fixture, platform: Platform) {
  await db
    .updateTable('union_accounts')
    .set({ auth_status: 'expired' })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.accounts[platform])
    .execute();
}

async function refused(response: Response, code: number, http: number, reason?: string) {
  const body = response.json();
  expect(body).toMatchObject({ code, trace_id: TRACE });
  expect(response.statusCode).toBe(http);
  if (reason !== undefined) expect(body).toHaveProperty('data.reason', reason);
  await validate(body, 'ErrorEnvelope');
  for (const field of ['auth_url', 'state', 'auth_jump', 'auth_methods']) {
    expect(body).not.toHaveProperty(`data.${field}`);
  }
}

async function issuedPdd(f: Fixture, response: Response) {
  const data = success(response);
  await validate(response.json(), 'UnionAuthUrlResponse');
  expect(data.state).not.toBe('');
  expect(data.auth_url).not.toBe('');
  expect(data).not.toHaveProperty('auth_methods');
  expect(data.auth_jump).toMatchObject({
    primary: { type: expect.any(String), value: expect.any(String) },
    fallbacks: expect.any(Array),
    expire_at: expect.any(String),
  });
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      state: data.state,
      app_id: f.appId,
      user_id: f.userId,
      device_id: f.deviceId,
      platform: 'pdd',
      mode: 'bind',
      link_id: null,
      used_at: null,
      auth_methods: null,
      auth_app_refs: null,
    }),
  ]);
}

it.each(['absent', 'unbound', 'pending_auth', 'released', 'invalid', 'active'] as const)(
  '[AC-B1-06t#1][AC-B1-06t#2] 拼多多绑定 %s、所用账号 expired：50301 maintenance；同夹具淘宝仍为授权不可用',
  async (status) => {
    const f = await seed();
    if (status !== 'absent') await bind(f, 'pdd', status);
    const taobaoStatus = status === 'invalid' ? 'invalid' : 'unbound';
    await bind(f, 'taobao', taobaoStatus);
    await expire(f, 'taobao');
    await expire(f, 'pdd');
    const get = await start(f);
    await refused(
      await get('taobao'),
      taobaoStatus === 'invalid' ? 30102 : 30101,
      422,
      'auth_unavailable',
    );
    expect(await f.rows()).toEqual([]);
    const response = await get('pdd');
    expect(await f.rows()).toEqual([]);
    await refused(response, 50301, 503, 'maintenance');
  },
  60_000,
);

it('[AC-B1-06t#3] normal 用户的拼多多 blocked 优先于 expired 返回 30153；解除 blocked 后才返回 50301', async () => {
  const f = await seed();
  const bindingId = await bind(f, 'pdd', 'blocked');
  await expire(f, 'pdd');
  const get = await start(f);
  await refused(await get('pdd'), 30153, 422);
  expect(await f.rows()).toEqual([]);
  // 只改变绑定夹具，保持同一身份和失效账号，检查两个分支的优先次序。
  await db
    .updateTable('union_bindings')
    .set({ status: 'invalid', blocked_reason: null })
    .where('app_id', '=', f.appId)
    .where('id', '=', bindingId)
    .execute();
  const response = await get('pdd');
  expect(await f.rows()).toEqual([]);
  await refused(response, 50301, 503, 'maintenance');
}, 60_000);

it('[AC-B1-06t#4] 两个拼多多账号一有效一过期：只按未释放绑定所用账号判断，拒绝时保留既有 state 且不新增', async () => {
  const f = await seed();
  await expire(f, 'pdd');
  const activeAccountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: activeAccountId,
      app_id: f.appId,
      platform: 'pdd',
      account_name: 'synthetic-second-account',
      status: 'active',
      auth_status: 'active',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    .execute();
  const bindingId = await bind(f, 'pdd', 'active', activeAccountId);
  await selfBuySlot(f, activeAccountId);
  // D10-661 甲: record what the union port answers (the governed wrapper takes the method at
  // entry build, so the call-through spy goes in before start).
  const portAnswers: Array<Awaited<ReturnType<DemoUnionAdapter['pddAuthorityUrl']>>> = [];
  const portAuthorityUrl = DemoUnionAdapter.prototype.pddAuthorityUrl;
  vi.spyOn(DemoUnionAdapter.prototype, 'pddAuthorityUrl').mockImplementation(async function (
    this: DemoUnionAdapter,
    identity,
    context,
  ) {
    const answer = await portAuthorityUrl.call(this, identity, context);
    portAnswers.push(answer);
    return answer;
  });
  const get = await start(f);
  const first = await get('pdd');
  await issuedPdd(f, first);
  // D10-661 甲: every auth_jump step is a link the port answered, never the example.test
  // placeholder and never carrying this state (raw or decoded).
  const issued = success(first);
  const decoded = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  expect(portAnswers).toHaveLength(1);
  const answered = [
    portAnswers[0]!.schema_url,
    portAnswers[0]!.mobile_short_url,
    portAnswers[0]!.url,
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  const steps = planValues(issued.auth_jump);
  for (const step of steps) expect(answered).toContain(step);
  expectNoState([...steps, ...steps.map(decoded)], issued.state);
  const before = await f.rows();
  // 账号集合不变，仅切换绑定所用账号；不依赖随机 UUID 排序或调度时序。
  await db
    .updateTable('union_bindings')
    .set({ union_account_id: f.accounts.pdd })
    .where('app_id', '=', f.appId)
    .where('id', '=', bindingId)
    .execute();
  const response = await get('pdd');
  expect(await f.rows()).toEqual(before);
  await refused(response, 50301, 503, 'maintenance');
}, 60_000);

it('[AC-B1-06t#5] 拼多多站长授权 active 正常签发，随后 expired 拒绝签发且不改动原会话', async () => {
  const f = await seed();
  await selfBuySlot(f, f.accounts.pdd);
  // D10-661 甲: record what the union port answers (the governed wrapper takes the method at
  // entry build, so the call-through spy goes in before start).
  const portAnswers: Array<Awaited<ReturnType<DemoUnionAdapter['pddAuthorityUrl']>>> = [];
  const portAuthorityUrl = DemoUnionAdapter.prototype.pddAuthorityUrl;
  vi.spyOn(DemoUnionAdapter.prototype, 'pddAuthorityUrl').mockImplementation(async function (
    this: DemoUnionAdapter,
    identity,
    context,
  ) {
    const answer = await portAuthorityUrl.call(this, identity, context);
    portAnswers.push(answer);
    return answer;
  });
  const get = await start(f);
  const first = await get('pdd');
  await issuedPdd(f, first);
  // D10-661 甲: every auth_jump step is a link the port answered, never the example.test
  // placeholder and never carrying this state (raw or decoded).
  const issued = success(first);
  const decoded = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  expect(portAnswers).toHaveLength(1);
  const answered = [
    portAnswers[0]!.schema_url,
    portAnswers[0]!.mobile_short_url,
    portAnswers[0]!.url,
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  const steps = planValues(issued.auth_jump);
  for (const step of steps) expect(answered).toContain(step);
  expectNoState([...steps, ...steps.map(decoded)], issued.state);
  const before = await f.rows();
  await expire(f, 'pdd');
  const response = await get('pdd');
  expect(await f.rows()).toEqual(before);
  await refused(response, 50301, 503, 'maintenance');
}, 60_000);
