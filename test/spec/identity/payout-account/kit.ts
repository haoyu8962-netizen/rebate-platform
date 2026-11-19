// Real AppModule + PG + Redis. No route replacement, service mocks or private-member spies.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { payoutSummary, resavedDigest } from '../step-up-digest/payout-summary.ts';

type Platform = typeof import('../../../../apps/api/src/modules/platform/index.ts');
type Crypto = typeof import('../../../../apps/api/src/modules/platform/crypto/index.ts');
// Type only the erasable service surface; typing the whole identity barrel would pull Nest
// controllers into the test project's deliberately decorator-free TypeScript compilation.
type Identity =
  typeof import('../../../../apps/api/src/modules/identity/application/payout-account.ts');
type Risk = typeof import('../../../../apps/api/src/modules/risk/index.ts');
type Sessions = typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
type Tokens = typeof import('../../../../apps/api/src/modules/identity/application/tokens.ts');
type Access =
  typeof import('../../../../apps/api/src/modules/identity/application/access-tokens.ts');
type Validation = typeof import('../../../../apps/api/src/modules/platform/validation/index.ts');
type PlatformOptions = Parameters<Platform['PlatformModule']['forRoot']>[0];

// Provisioning is imported only from *.int.test.ts.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
}
interface TestRedis {
  url: string;
}
export interface Response {
  statusCode: number;
  body: string;
  json<T = Record<string, unknown>>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
type Operation = {
  'x-implementation'?: string;
  'x-auth'?: string;
  responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
};
export const ROOT = new URL('../../../../', import.meta.url);
export const PATH = '/v1/me/payout-account';
export const NOW = '2026-10-18T04:00:00.000Z';
export const NAME = '阿依古丽·买买提';
export const MASKED_NAME = '*******提';
export const LOGIN = 'zhang.san@example.com';
export const ALIPAY_CONTEXT = 'payout_accounts.alipay';
export const BANK_CONTEXT = 'payout_accounts.bank_card';

export async function open(database: TestDatabase, redis: TestRedis) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as Platform;
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as Crypto;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as Sessions;
  const tokensModule = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as Tokens;
  const access = (await import(
    new URL('apps/api/src/modules/identity/application/access-tokens.ts', ROOT).href
  )) as Access;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as Validation;
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-13e-'));
  const master = randomBytes(32);
  const keyring = await cryptoModule.createWrappedKeyring(
    new cryptoModule.LocalKeyProvider(master),
  );
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const clock = new platform.FixedClock(NOW);
  const lines: string[] = [];
  const logger = platform.createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  let app: HttpApp | undefined;
  try {
    const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp(
        entry: 'api',
        options: Pick<PlatformOptions, 'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'>,
      ): Promise<HttpApp>;
    };
    app = await bootstrap.createHttpApp('api', {
      config: platform.loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
      }),
      clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: platform.loadConnectionConfig('api', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: redis.url,
      }).redisUrl,
    });
    await app.init();
    const parser = createRequire(new URL('apps/api/package.json', ROOT))(
      '@readme/openapi-parser',
    ) as {
      dereference(
        path: string,
        options: object,
      ): Promise<{ paths: Record<string, Record<string, Operation>> }>;
    };
    const document = await parser.dereference(
      fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
      { resolve: { external: false } },
    );
    return {
      app,
      db,
      dir,
      clock,
      logger,
      lines,
      document,
      compile: validation.createValidatorCompiler(),
      crypto: app.get<Awaited<ReturnType<Crypto['openFieldCrypto']>>>(platform.FIELD_CRYPTO),
      tokens: app.get<Parameters<Sessions['createSession']>[2]['tokens']>(
        tokensModule.TOKEN_SERVICE,
      ),
      keys: app.get<Parameters<Access['signScopedToken']>[0]>(tokensModule.TOKEN_KEYS),
      createSession: sessions.createSession,
      signScopedToken: access.signScopedToken,
    };
  } catch (error) {
    await app?.close();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
export type Kit = Awaited<ReturnType<typeof open>>;
export async function close(kit: Kit | undefined) {
  if (!kit) return;
  try {
    await kit.app.close();
  } finally {
    await destroyDb(kit.db);
    rmSync(kit.dir, { recursive: true, force: true });
  }
}

export async function fixture(
  kit: Kit,
  options: { appId?: string; verified?: boolean; name?: string } = {},
) {
  const appId = options.appId ?? `pa_${randomBytes(10).toString('hex')}`;
  const uid = randomUUID();
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture', 'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(
      kit.db,
    );
  }
  const phone = '13800138000';
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_cipher, phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar.png', ${randomUUID()}, ${randomUUID()}, 'L1', 'wechat', ${Buffer.from(kit.crypto.encrypt(phone, 'users.phone'))}, ${kit.crypto.blindIndex(uid, 'users.phone')})`.execute(
    kit.db,
  );
  // The unique synthetic identity is encrypted; no real person or supplier is involved.
  if (options.verified !== false) {
    await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
      VALUES (${randomUUID()}, ${appId}, ${uid}, 'verified', ${Buffer.from(kit.crypto.encrypt(options.name ?? NAME, 'realname.name'))}, ${Buffer.from(kit.crypto.encrypt(uid, 'realname.id_no'))}, ${kit.crypto.blindIndex(uid, 'realname.id_no')}, ${Buffer.from(kit.crypto.encrypt('1990-01-01', 'realname.birth_date'))}, 'fixture', ${kit.clock.now()})`.execute(
      kit.db,
    );
  }
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const deviceId = created.json<{ data: { device_id: string } }>().data.device_id;
  return {
    appId,
    uid,
    command: {
      appId,
      userId: uid,
      alipayLogonId: LOGIN,
      payeeName: NAME,
      // B1-02zzzb: the step_up_token digest of the account this command saves.
      stepUpSummary: payoutSummary(kit.crypto, { alipayLogonId: LOGIN }),
    },
    async get(mode: 'app' | 'h5' | 'guest' = 'app') {
      const session = await kit.db
        .transaction()
        .execute((trx) =>
          kit.createSession(
            trx,
            { uid, app_id: appId, device_id: deviceId, scp: 'full' },
            { clock: kit.clock, tokens: kit.tokens },
          ),
        );
      const token =
        mode === 'h5'
          ? await kit.signScopedToken(kit.keys, {
              audience: 'h5',
              claims: {
                uid,
                app_id: appId,
                sid: session.sid,
                device_id: deviceId,
                scp: 'read_only',
              },
              issuedAt: Math.floor(kit.clock.now().getTime() / 1000),
              ttlSeconds: 300,
            })
          : session.access_token;
      return kit.app.inject({
        method: 'GET',
        url: PATH,
        headers: {
          ...headers,
          'x-device-id': deviceId,
          ...(mode === 'guest' ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function service(kit: Kit) {
  const identity = (await import(
    new URL('apps/api/src/modules/identity/index.ts', ROOT).href
  )) as Identity;
  const risk = (await import(new URL('apps/api/src/modules/risk/index.ts', ROOT).href)) as Risk;
  const options = { db: kit.db, clock: kit.clock, crypto: kit.crypto, logger: kit.logger };
  return identity.createPayoutAccountService({
    ...options,
    blocklist: risk.createBlocklistService(options),
  });
}
export async function save(kit: Kit, f: Fixture, input: Partial<Fixture['command']> = {}) {
  const app = await service(kit); // In each test, so NotImplemented is a test failure, not a suite hook failure.
  // B1-02zzzb: the token digest follows the account this call saves, unless the input sets one.
  return kit.db
    .transaction()
    .execute((trx) =>
      app.save(trx, { ...f.command, ...input, ...resavedDigest(kit.crypto, f.command, input) }),
    );
}
export async function config(kit: Kit, f: Fixture, key: string, value: unknown) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'fixture')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(kit.db);
}
export async function account(
  kit: Kit,
  f: Fixture,
  value = LOGIN,
  options: {
    method?: 'alipay' | 'bank_card';
    current?: boolean;
    name?: string;
    hmac?: string;
    handle?: Kysely<DB>;
  } = {},
) {
  const method = options.method ?? 'alipay';
  const hmac =
    options.hmac ??
    kit.crypto.blindIndex(value, method === 'alipay' ? ALIPAY_CONTEXT : BANK_CONTEXT);
  return (options.handle ?? kit.db)
    .insertInto('payout_accounts')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: f.uid,
      payout_method: method,
      is_current: options.current ?? true,
      payee_name: options.name ?? NAME,
      alipay_hmac: method === 'alipay' ? hmac : null,
      alipay_logon_id_cipher:
        method === 'alipay' ? Buffer.from(kit.crypto.encrypt(value, ALIPAY_CONTEXT)) : null,
      bank_card_hmac: method === 'bank_card' ? hmac : null,
      bank_card_no_cipher:
        method === 'bank_card' ? Buffer.from(kit.crypto.encrypt(value, BANK_CONTEXT)) : null,
      bank_name: method === 'bank_card' ? '招商银行' : null,
      card_bin: method === 'bank_card' ? value.slice(0, 6) : null,
      created_at: kit.clock.now(),
      updated_at: kit.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function change(
  kit: Kit,
  f: Fixture,
  at = kit.clock.now(),
  handle: Kysely<DB> = kit.db,
) {
  return handle
    .insertInto('payout_account_changes')
    .values({
      app_id: f.appId,
      user_id: f.uid,
      old_payout_method: 'bank_card',
      new_payout_method: 'alipay',
      old_hmac: randomBytes(32).toString('hex'),
      new_hmac: randomBytes(32).toString('hex'),
      operator: 'fixture',
      changed_at: at,
      created_at: at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function state(kit: Kit, f: Fixture, handle: Kysely<DB> = kit.db) {
  return {
    accounts: await handle
      .selectFrom('payout_accounts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('user_id', '=', f.uid)
      .orderBy('id')
      .execute(),
    changes: await handle
      .selectFrom('payout_account_changes')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('user_id', '=', f.uid)
      .orderBy('id')
      .execute(),
  };
}
export async function block(
  kit: Kit,
  f: Fixture,
  value: string,
  options: { status?: 'active' | 'inactive'; expireAt?: Date } = {},
) {
  await kit.db
    .insertInto('blocklist')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      dimension: 'alipay',
      value_hmac: kit.crypto.blindIndex(value, ALIPAY_CONTEXT),
      violation_type: 'other',
      status: options.status ?? 'active',
      created_by: 'fixture',
      expire_at: options.expireAt ?? new Date('2027-01-01T00:00:00Z'),
    })
    .execute();
}
export function envelope(kit: Kit, response: Response, code = 0) {
  const statuses: Record<number, number> = { 0: 200, 10001: 401, 10403: 403, 30304: 422 };
  expect(response.statusCode).toBe(statuses[code]);
  const body = response.json<{ code: number; msg: string; trace_id: string; data?: unknown }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const schema =
    kit.document.paths[PATH]!['get']!.responses[code === 0 ? '200' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body.data;
}
export function privateDataAbsent(kit: Kit, outputs: unknown[], secrets: string[]) {
  const text = kit.lines.join('\n') + JSON.stringify(outputs);
  for (const secret of secrets)
    expect(text.includes(secret), 'plaintext or private identifier escaped').toBe(false);
}
export async function pid(handle: Kysely<DB>) {
  return (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(handle)).rows[0]!.pid;
}
/** Observe the real PostgreSQL wait edge, not scheduler timing or an implementation spy. */
export async function waitBlocked(kit: Kit, waiter: number, blocker: number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const row = (
      await sql<{
        blocked: boolean;
      }>`SELECT ${blocker} = ANY(pg_blocking_pids(${waiter})) AS blocked`.execute(kit.db)
    ).rows[0]!;
    if (row.blocked) return;
    await delay(10);
  }
  expect.fail('expected PostgreSQL blocking edge was not observed');
}
