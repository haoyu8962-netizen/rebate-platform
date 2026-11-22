// B1-13n end-to-end kit: the real AppModule over the test database and Redis (as B1-13d's realname
// kit), with one difference: identity's member-side REALNAME_VERIFIER provider is handed what
// loadConfig(env, 'api') of a staging node returned (`staged`: its appEnv and its list of
// STAGING_TEST_REALNAME_USER_IDS, as the real api entry would have them). Nothing replaces the
// verifier itself. The rest of the AppModule stays APP_ENV=test: a whole
// staging AppModule needs KMS and node files that the test machine does not have.
// @couli/db/testing is imported only by the integration test, never by this kit.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { sql } from 'kysely';
import { expect, vi } from 'vitest';
import type * as Platform from '../../../../apps/api/src/modules/platform/index.ts';
import type * as Crypto from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type * as Validation from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type * as Sessions from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import type * as Tokens from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import { ROOT } from './kit.ts';

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
export const PATH = '/v1/me/realname';
export const NOW = '2026-09-29T15:59:00.000Z';
/** FieldCrypto contexts of app.realname (technical domains, not business constants). */
const CONTEXT = {
  name: 'realname.name',
  idNo: 'realname.id_no',
  birthDate: 'realname.birth_date',
};
type Schema = Record<string, unknown>;
type Operation = { responses: Record<string, { content: Record<string, { schema: Schema }> }> };
type Contract = { paths: Record<string, Record<string, Operation>> };
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
    method: 'GET' | 'POST';
    url: string;
    payload?: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}
type CreateHttpApp = (
  entry: 'api',
  overrides: Pick<
    Platform.PlatformOptions,
    'config' | 'clock' | 'logger' | 'dbHandles' | 'redisUrl'
  >,
) => Promise<HttpApp>;
interface ProviderShape {
  readonly provide?: unknown;
  readonly inject?: readonly unknown[];
  readonly useFactory?: (...args: unknown[]) => unknown;
}
interface IdentityModuleShape {
  forRoot(options: unknown): { providers?: readonly unknown[] } & Record<string, unknown>;
}

function isProvider(item: unknown, token: symbol): item is ProviderShape {
  return typeof item === 'object' && item !== null && (item as ProviderShape).provide === token;
}

function tokenOf(token: unknown): unknown {
  if (typeof token === 'object' && token !== null && 'token' in token) return token.token;
  return token;
}

/**
 * The provider with its APP_CONFIG argument given the appEnv and the list of `staged` (the
 * configuration loadConfig(env, 'api') returned for a staging node).
 */
function stagedProvider(
  provider: ProviderShape,
  configToken: unknown,
  staged: Readonly<Record<string, unknown>>,
): ProviderShape {
  const at = (provider.inject ?? []).findIndex((token) => tokenOf(token) === configToken);
  expect(at, 'REALNAME_VERIFIER reads APP_CONFIG').toBeGreaterThanOrEqual(0);
  const factory = provider.useFactory!;
  return {
    ...provider,
    useFactory: (...args: unknown[]) => {
      const replaced = [...args];
      replaced[at] = {
        ...(args[at] as Record<string, unknown>),
        appEnv: staged['appEnv'],
        stagingTestRealnameUserIds: staged['stagingTestRealnameUserIds'],
      };
      return factory(...replaced);
    },
  };
}

export async function open(
  database: TestDatabase,
  server: TestRedis,
  staged: Readonly<Record<string, unknown>>,
) {
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as typeof Platform;
  const cryptoModule = (await import(
    new URL('apps/api/src/modules/platform/crypto/index.ts', ROOT).href
  )) as typeof Crypto;
  const validation = (await import(
    new URL('apps/api/src/modules/platform/validation/index.ts', ROOT).href
  )) as typeof Validation;
  const sessions = (await import(
    new URL('apps/api/src/modules/identity/application/sessions.ts', ROOT).href
  )) as typeof Sessions;
  const tokens = (await import(
    new URL('apps/api/src/modules/identity/application/tokens.ts', ROOT).href
  )) as typeof Tokens;
  const { IdentityModule } = (await import(
    new URL('apps/api/src/modules/identity/identity.module.ts', ROOT).href
  )) as { IdentityModule: IdentityModuleShape };
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-13n-'));
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
  function stage(provider: unknown): unknown {
    if (!isProvider(provider, tokens.REALNAME_VERIFIER)) return provider;
    return stagedProvider(provider, platform.APP_CONFIG, staged);
  }
  const original = IdentityModule.forRoot.bind(IdentityModule);
  const wiring = vi.spyOn(IdentityModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return { ...module, providers: (module.providers ?? []).map(stage) };
  });
  let app: HttpApp | undefined;
  try {
    const bootstrap = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
      createHttpApp: CreateHttpApp;
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
        REDIS_URL: server.url,
      }).redisUrl,
    });
    await app.init();
    expect(wiring).toHaveBeenCalled();
    const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
    const parser = requireApi('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Contract>;
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
      lines,
      /** The lines written while the entry started. */
      startup: [...lines],
      document,
      compile: validation.createValidatorCompiler(),
      crypto: app.get<Platform.FieldCrypto>(platform.FIELD_CRYPTO),
      tokens: app.get<Parameters<typeof sessions.createSession>[2]['tokens']>(tokens.TOKEN_SERVICE),
      createSession: sessions.createSession,
    };
  } catch (error) {
    await app?.close();
    await destroyDb(db);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    wiring.mockRestore();
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

/** A user `uid` with a bound phone, a device and (unless `consent: false`) the current consent. */
export async function fixture(
  kit: Kit,
  uid: string,
  options: { appId?: string; consent?: boolean } = {},
) {
  const appId = options.appId ?? `sn_${randomBytes(10).toString('hex')}`;
  const headers = {
    'content-type': 'application/json',
    'x-app-id': appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
  };
  if (options.appId === undefined) {
    await sql`INSERT INTO app.app_versions (id, app_id, platform, channel, latest_version, min_supported_version, update_title, update_notes, store_url, default_store, store_listings)
      VALUES (${randomUUID()}, ${appId}, 'ios', 'appstore', '2.0.0', '2.0.0', 'fixture', 'fixture', 'https://example.test/app', 'appstore', '[]'::jsonb)`.execute(
      kit.db,
    );
  }
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers,
    payload: JSON.stringify({ device_hash: randomBytes(32).toString('hex'), id_source: 'idfv' }),
  });
  expect(created.statusCode).toBe(200);
  const device = created.json<{ data: { device_id: string; install_secret: string } }>().data;
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, phone_hmac)
    VALUES (${uid}, ${appId}, 'fixture', 'https://example.test/avatar.png', ${randomUUID()}, ${randomUUID()}, 'L1', 'wechat', ${randomBytes(32).toString('hex')})`.execute(
    kit.db,
  );
  if (options.consent !== false) {
    const at = new Date(kit.clock.now().getTime() - 1000);
    await sql`INSERT INTO app.consent_records (app_id, subject_type, user_id, device_id, type, version, channel, accepted, client_at, server_at, created_at)
      VALUES (${appId}, 'user', ${uid}, ${null}, 'id_verification', 1, 'realname_sheet', true, ${at}, ${at}, ${at})`.execute(
      kit.db,
    );
  }
  const submit = async (body: unknown): Promise<Response> => {
    const session = await kit.db
      .withSchema('app')
      .transaction()
      .execute((trx) =>
        kit.createSession(
          trx,
          { uid, app_id: appId, device_id: device.device_id, scp: 'full' },
          { clock: kit.clock, tokens: kit.tokens },
        ),
      );
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const text = [
      'POST',
      PATH,
      timestamp,
      nonce,
      createHash('sha256').update(raw).digest('hex'),
    ].join('\n');
    return kit.app.inject({
      method: 'POST',
      url: PATH,
      payload: raw,
      headers: {
        ...headers,
        authorization: `Bearer ${session.access_token}`,
        'x-device-id': device.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': createHmac('sha256', device.install_secret).update(text).digest('hex'),
        'idempotency-key': randomUUID(),
        'x-trace-id': randomUUID(),
      },
    });
  };
  const rows = async () =>
    (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM app.realname WHERE app_id = ${appId} AND user_id = ${uid}`.execute(kit.db)
    ).rows;
  return { appId, uid, submit, rows };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Another user of the app already verified with `id` (born `birth`). */
export async function seedVerified(kit: Kit, f: Fixture, name: string, id: string, birth: string) {
  const encrypted = (value: string, context: string) =>
    Buffer.from(kit.crypto.encrypt(value, context));
  await sql`INSERT INTO app.realname (id, app_id, user_id, status, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, provider, verified_at)
    VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, 'verified', ${encrypted(name, CONTEXT.name)}, ${encrypted(id, CONTEXT.idNo)}, ${kit.crypto.blindIndex(id, CONTEXT.idNo)}, ${encrypted(birth, CONTEXT.birthDate)}, 'test-two-elements', ${kit.clock.now()})`.execute(
    kit.db,
  );
}

/** The response's envelope, checked against the contract of POST /v1/me/realname. */
export function envelope(kit: Kit, response: Response, code: number) {
  const statuses: Record<number, number> = {
    0: 200,
    10004: 403,
    20001: 400,
    50001: 500,
    50301: 503,
    50401: 504,
  };
  expect(response.statusCode).toBe(statuses[code] ?? 422);
  const body = response.json<{
    code: number;
    msg: string;
    trace_id: string;
    data?: Record<string, unknown>;
  }>();
  expect(body).toMatchObject({ code, msg: expect.any(String), trace_id: expect.any(String) });
  const operation = kit.document.paths[PATH]!['post']!;
  const schema =
    operation.responses[code === 0 ? '200' : code >= 50000 ? '5XX' : '4XX']!.content[
      'application/json'
    ]!.schema;
  const validate = kit.compile({ schema, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return body;
}
