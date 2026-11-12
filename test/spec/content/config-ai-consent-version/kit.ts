// CT-26zm: self-contained HTTP fixture for legal.ai_third_party.version on GET /v1/config.
// No imports from other tasks' rule-test kits. The database testing entry is supplied only by
// *.int.test.ts (useHarness takes it as a loader).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { REQUIRED, ROOT, apiRequire, type Config } from './fixtures.ts';

export const NOW = '2026-11-12T02:00:00.000Z';

export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json<T = { code: number; data: Record<string, unknown>; trace_id: string }>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}
export interface TestingEntry {
  createTestDatabase(): Promise<{ urlFor(role: 'couli_app'): string; drop(): Promise<unknown> }>;
  acquireTestRedis(): Promise<{ url: string; stop(): Promise<unknown> }>;
}
interface Overrides {
  config: ReturnType<typeof loadConfig>;
  clock: FixedClock;
  logger: ReturnType<typeof createRootLogger>;
  dbHandles: DbHandles;
  redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
}
export interface Harness {
  db: Kysely<DB>;
  redisUrl: Overrides['redisUrl'];
  env: Record<string, string>;
  apps: HttpApp[];
}

export function useHarness(load: () => Promise<TestingEntry>): Harness {
  const h = {} as Harness;
  let database: Awaited<ReturnType<TestingEntry['createTestDatabase']>> | undefined;
  let redis: Awaited<ReturnType<TestingEntry['acquireTestRedis']>> | undefined;
  let dir: string | undefined;
  beforeAll(async () => {
    h.apps = [];
    const testing = await load();
    database = await testing.createTestDatabase();
    h.db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
    redis = await testing.acquireTestRedis();
    h.redisUrl = loadConnectionConfig('api', {
      DATABASE_URL: database.urlFor('couli_app'),
      REDIS_URL: redis.url,
    }).redisUrl;
    const base = fileURLToPath(new URL('.tmp/', ROOT));
    mkdirSync(base, { recursive: true });
    dir = mkdtempSync(join(base, 'ct26zm-'));
    // Only synthetic, ephemeral keys, created when the orchestrator runs the container.
    const master = randomBytes(32);
    const wrapped = await createWrappedKeyring(new LocalKeyProvider(master));
    const masterFile = join(dir, 'synthetic-master.hex');
    const keyringFile = join(dir, 'synthetic-keyring.json');
    writeFileSync(masterFile, master.toString('hex'), { mode: 0o600 });
    writeFileSync(keyringFile, JSON.stringify(wrapped), { mode: 0o600 });
    const jwt = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    h.env = {
      APP_ENV: 'test',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: masterFile,
      FIELD_KEYRING_FILE: keyringFile,
      JWT_KEY_ID: 'ct26zm',
      JWT_PRIVATE_KEY_PEM: jwt.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }, 180_000);
  afterEach(async () => {
    for (const app of h.apps.splice(0)) await app.close();
  });
  afterAll(async () => {
    try {
      if (h.db !== undefined) await destroyDb(h.db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
        if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  return h;
}

export async function configApp(h: Harness) {
  const clock = new FixedClock(NOW);
  const logs: string[] = [];
  // Nest decorators must be loaded through the existing dynamic bootstrap convention.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(entry: 'api', options: Overrides): Promise<HttpApp>;
  };
  const app = await createHttpApp('api', {
    config: loadConfig(h.env),
    clock,
    logger: createRootLogger(
      { level: 'trace', entry: 'api', appEnv: 'test' },
      { write: (line: string) => void logs.push(line) },
    ),
    dbHandles: { db: h.db, dbRead: null, close: async () => undefined },
    redisUrl: h.redisUrl,
  });
  h.apps.push(app);
  await app.init();
  return { app, clock, logs };
}

export async function config(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
  version = 1,
  rowVersion = 0,
) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: rowVersion,
      updated_by: 'ct26zm-rule-test',
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
}

/** Overwrite one existing row in place (no delete: a malformed row must equal a missing one). */
export async function rewrite(
  h: Harness,
  appId: string,
  key: string,
  value: unknown,
  version: number,
) {
  await h.db
    .updateTable('config_items')
    .set({ value: sql`${JSON.stringify(value)}::jsonb`, version, row_version: version - 1 })
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .execute();
}

/** A fresh app (X-App-Id at most 32 characters) with the required keys plus `values`. */
export async function configured(h: Harness, values: Record<string, unknown> = {}) {
  const id = `ct26zm_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  for (const [key, value] of Object.entries({ ...REQUIRED, ...values })) {
    await config(h, id, key, value);
  }
  return id;
}

export async function getConfig(app: HttpApp, appId: string, extra: Record<string, string> = {}) {
  const trace = randomUUID();
  const response = await app.inject({
    method: 'GET',
    url: '/v1/config',
    headers: {
      'x-app-id': appId,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      'x-device-id': '019a0000-0000-7000-8000-000000000001',
      'x-trace-id': trace,
      ...extra,
    },
  });
  return { response, trace };
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let responseValidator: Promise<Validator> | undefined;
function validator() {
  responseValidator ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    return createValidatorCompiler()({
      schema: doc.paths['/v1/config']!.get.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    });
  })();
  return responseValidator;
}

/** A 200 read that passes the contract; status is asserted before the body is parsed. */
export async function readConfig(app: HttpApp, appId: string, extra: Record<string, string> = {}) {
  const sent = await getConfig(app, appId, extra);
  expect(sent.response.statusCode, 'config read status').toBe(200);
  const body = sent.response.json();
  expect(body.code).toBe(0);
  const check = await validator();
  expect(check(body), JSON.stringify(check.errors)).toBe(true);
  expect(body.trace_id).toBe(sent.trace);
  const data = sent.response.json<{ data: Config }>().data;
  const etag = sent.response.headers['etag'];
  expect(etag).toBe(`"${data.config_version}"`);
  return { data, etag: etag as string };
}

/** warn-and-above entries of one app written after `start`. */
export function configLogs(lines: readonly string[], start: number, appId: string) {
  return lines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['app_id'] === appId && Number(entry['level']) >= 40);
}
