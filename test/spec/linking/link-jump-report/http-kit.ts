// Real production api assembly, real optional-token guard, real PostgreSQL writes. No listen.
// *.int.test.ts supplies the global setup's provisioner; this helper imports no containers.
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, vi, type MockInstance } from 'vitest';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { createSession } from '../../../../apps/api/src/modules/identity/application/sessions.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import * as receiver from '../../../../apps/api/src/modules/linking/application/ingest-events.ts';
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
import { NOW, ROOT, TRACE } from './vectors.ts';

interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface Redis {
  readonly url: string;
  stop(): Promise<void>;
}
interface Response {
  readonly statusCode: number;
  readonly payload: string;
  json(): unknown;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: symbol): T;
  inject(request: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<Response>;
}
export interface User {
  appId: string;
  uid: string;
  deviceId: string;
  token: string;
}
export interface Attempt {
  attempt_id: string;
  link_id: string;
}

const requireApi = createRequire(new URL('apps/api/package.json', ROOT));
let schemas: Promise<Record<string, JsonSchema>> | undefined;
async function validate(response: Response, schemaName: string): Promise<void> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  schemas ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)))
    .then((doc) => doc.components.schemas);
  const check = createValidatorCompiler()({
    schema: (await schemas)[schemaName]!,
    httpPart: 'body',
  });
  expect(check(response.json())).toBe(true);
  expect(check.errors ?? []).toEqual([]);
}

export async function accepted(response: Response, dropped = 0): Promise<void> {
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    trace_id: TRACE,
    data: { dropped_count: dropped },
  });
  await validate(response, 'IngestEventsResponse');
}

export async function rejected(response: Response, status: number, code: number): Promise<void> {
  expect(response.statusCode, response.payload).toBe(status);
  expect(response.json()).toMatchObject({ code, trace_id: TRACE });
  await validate(response, 'ErrorEnvelope');
}

export function harness(provision: {
  createTestDatabase(): Promise<Database>;
  acquireTestRedis(): Promise<Redis>;
}) {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
  let database: Database | undefined;
  let redis: Redis | undefined;
  let db: Kysely<DB> | undefined;
  let app: HttpApp | undefined;
  let prepare: MockInstance<typeof receiver.prepareEvents>;
  const mutations: string[] = [];

  beforeAll(async () => {
    database = await provision.createTestDatabase();
    redis = await provision.acquireTestRedis();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 }).withPlugin({
      transformQuery({ node }) {
        const serialized = JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        );
        if (/"(?:Insert|Update|Delete|Merge)QueryNode"/u.test(serialized))
          mutations.push(serialized);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    // Call-through only: tests also verify the real receiver uses the normalized handoff.
    prepare = vi.spyOn(receiver, 'prepareEvents');
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
    mutations.length = 0;
    prepare.mockClear();
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

  async function user(appId = `jump_${randomBytes(10).toString('hex')}`): Promise<User> {
    const uid = randomUUID();
    const deviceId = randomUUID();
    await db!
      .insertInto('users')
      .values({
        id: uid,
        app_id: appId,
        nickname: '合成外跳用户',
        avatar: 'https://example.test/avatar',
        invite_code: randomBytes(8).toString('hex'),
        attr_code: randomBytes(4).toString('hex'),
        level: 'T1',
        register_method: 'synthetic',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    // An unsigned endpoint never reads the synthetic device's install secret.
    await db!
      .insertInto('devices')
      .values({
        id: deviceId,
        app_id: appId,
        device_hash: randomBytes(32).toString('hex'),
        id_source: 'idfv',
        platform: 'ios',
        app_version: '2.0.0',
        last_seen_at: clock.now(),
        install_secret_cipher: Buffer.from('synthetic-unused-secret'),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    await db!
      .insertInto('user_risk_state')
      .values({
        app_id: appId,
        user_id: uid,
        state: 'normal',
        changed_by: 'synthetic',
        changed_at: clock.now(),
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    const session = await db!
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { uid, app_id: appId, device_id: deviceId, scp: 'full' },
          { clock, tokens: app!.get<TokenService>(TOKEN_SERVICE) },
        ),
      );
    return { appId, uid, deviceId, token: session.access_token };
  }

  async function attempt(owner: User, linkId?: string): Promise<Attempt> {
    const link_id = linkId ?? randomUUID();
    if (linkId === undefined) {
      await db!
        .insertInto('links')
        .values({
          link_id,
          app_id: owner.appId,
          user_id: owner.uid,
          platform: 'jd',
          scene: 'self_buy',
          expire_at: '2026-12-14T02:00:00.000Z',
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
    }
    const attempt_id = randomUUID();
    await db!
      .insertInto('link_open_attempts')
      .values({
        attempt_id,
        app_id: owner.appId,
        link_id,
        user_id: owner.uid,
        opened_at: '2026-11-14T01:00:00.000Z',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    return { attempt_id, link_id };
  }

  function post(user: User, payload: unknown, headers: Record<string, string | undefined> = {}) {
    const combined = {
      'content-type': 'application/json',
      'x-app-id': user.appId,
      'x-platform': 'ios',
      'x-channel': 'appstore',
      'x-app-version': '2.0.0',
      'x-device-id': user.deviceId,
      'x-trace-id': TRACE,
      authorization: `Bearer ${user.token}`,
      ...headers,
    };
    return app!.inject({
      method: 'POST',
      url: '/v1/events',
      payload: JSON.stringify(payload),
      headers: Object.fromEntries(
        Object.entries(combined).filter((pair): pair is [string, string] => pair[1] !== undefined),
      ),
      remoteAddress: '198.51.100.61',
    });
  }

  return {
    clock,
    user,
    attempt,
    post,
    mutations,
    db: () => db!,
    clearObserved: () => {
      mutations.length = 0;
      prepare.mockClear();
    },
    prepared: () => prepare.mock.results.map((result) => result.value as receiver.PreparedEvents),
    row: (attempt: Attempt) =>
      db!
        .selectFrom('link_open_attempts')
        .selectAll()
        .where('attempt_id', '=', attempt.attempt_id)
        .executeTakeFirstOrThrow(),
    async evidence(appId: string) {
      return {
        links: await db!
          .selectFrom('links')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('link_id')
          .execute(),
        logs: await db!
          .selectFrom('link_logs')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        events: await db!
          .selectFrom('events')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('event_id')
          .execute(),
        bus: await db!
          .selectFrom('event_log')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('event_id')
          .execute(),
      };
    },
  };
}
