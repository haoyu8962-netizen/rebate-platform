// B2-09w: withUnknownAdmin's real admin bootstrap, with a captured pino destination.
// Auth, permissions, step-up, idempotency, PG and Redis are real. No implementation mocks.
// Temporary synthetic crypto material stays under .tmp/ and is removed on close.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FIELD_CRYPTO,
  REDIS,
  JOB_QUEUE,
  EVENT_BUS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FieldCrypto,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
  type JobQueue,
  type EventBus,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { newKey, type ReviewFixture } from '../admin-withdrawal-review/review-harness.ts';
import type {
  UnknownAdmin,
  AdminCaller,
  AdminSent,
  Envelope,
  Fault,
  Operation,
  WriteOptions,
} from '../admin-unknown-payouts/unknown-harness.ts';

const ROOT = new URL('../../../../', import.meta.url);

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST' | 'GET';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withLoggedUnknownAdmin(
  f: ReviewFixture,
  lines: string[],
  run: (h: UnknownAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09w-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, contains: null, tripped: 0 };
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09w_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'warn' },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: UnknownAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `mp_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: UnknownAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const executor = await caller(['payout.execute']);
    const post = async (
      op: Operation,
      url: string,
      body: unknown,
      options: WriteOptions,
      fallback: AdminCaller,
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? fallback : options.caller;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-trace-id': randomUUID(),
      };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
      const token =
        options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
      if (token !== null) headers['x-step-up-token'] = token;
      const response = await server.inject({
        method: op === 'list' || op === 'audit' ? 'GET' : 'POST',
        url,
        headers,
        ...(op === 'list' || op === 'audit' ? {} : { payload: JSON.stringify(body) }),
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      crypto,
      fault,
      caller,
      stepUp,
      executor,
      queue: server.get<JobQueue>(JOB_QUEUE),
      events: server.get<EventBus>(EVENT_BUS),
      resolve: (id, body, options = {}) =>
        post('resolve', `/admin/v1/withdrawals/${id}/resolve`, body, options, executor),
      query: (id, options = {}, body = {}) =>
        post('query', `/admin/v1/withdrawals/${id}/query`, body, options, executor),
      list: (query = '', options = {}) =>
        post(
          'list',
          `/admin/v1/unknown-payouts${query}`,
          {},
          { stepUp: null, ...options },
          executor,
        ),
      audit: (id, options = {}) =>
        post('audit', `/admin/v1/audit-logs?target_id=${id}`, {}, options, executor),
      manualPaid: (items, options = {}) =>
        post('manualPaid', '/admin/v1/withdrawals/batch-manual-paid', { items }, options, executor),
      reject: (id, options = {}) =>
        post(
          'reject',
          `/admin/v1/withdrawals/${id}/reject`,
          { reason_code: 'OTHER', note: '合成驳回原因' },
          options,
          executor,
        ),
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
