// B2-09zb admin harness (claude-independent, SPEC_REF 18f0015): contracts/openapi.yaml
// adminRunSettleAdjust (POST /admin/v1/settle-adjust-runs; CT-24zv, D10-769 / D10-770): permission
// fund.settle_adjust, step-up tier totp, Idempotency-Key, `bill_date` after the current accounting
// day → 20001 data.fields=[bill_date], queues the scheduled run's job (queue settle, job
// settle_adjust, singletonKey settle_adjust:<app_id>:<platform>:<bill_date>), answers
// { result: 'submitted' }, one audit record settle_adjust_run_request (platform, bill_date).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
// entry's job queue on the test database), PostgreSQL as couli_app, Redis for the admin sessions
// (../../payment/orders/kit.ts suite through ../admin-settle-bills/kit.ts). Synthetic: admin
// accounts and every value. The totp step-up token is issued the way POST /admin/v1/auth/step-up
// issues it after a correct authenticator code. Missing pieces fail as assertions (an unregistered
// admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
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
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { contractPaths, type Fixture } from '../admin-settle-bills/kit.ts';

export { fixture, suite, type Fixture } from '../admin-settle-bills/kit.ts';

export const RUN_PATH = '/admin/v1/settle-adjust-runs';
export const ADJUST = 'fund.settle_adjust';
export const VIEW = 'fund.view';
export const RUN_ACTION = 'settle_adjust_run_request';

const ROOT = new URL('../../../../', import.meta.url);

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  40901: 409,
};

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface Sent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface Caller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface RunOptions {
  /** The caller: `adjuster` by default; null sends no token. */
  readonly caller?: Caller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
}

export interface RunAdmin {
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<Caller>;
  stepUp(caller: Caller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/settle-adjust-runs with the JSON body. */
  run(body: unknown, options?: RunOptions): Promise<Sent>;
  /** An account with fund.settle_adjust only. */
  readonly adjuster: Caller;
  /** An account with fund.view only. */
  readonly viewer: Caller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `sa_${randomBytes(12).toString('hex')}`;
}

/** Runs `body` against a started admin entry on the fixture's database, clock and Redis. */
export async function withRunAdmin(f: Fixture, body: (h: RunAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09zb-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
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
        JWT_KEY_ID: 'b2_09zb_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
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
    const caller: RunAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `sarun_${id}`,
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
    const stepUp: RunAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const adjuster = await caller([ADJUST]);
    const viewer = await caller([VIEW]);
    const run: RunAdmin['run'] = async (payload, options = {}) => {
      const who = options.caller === undefined ? adjuster : options.caller;
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
        method: 'POST',
        url: RUN_PATH,
        headers,
        payload: JSON.stringify(payload),
        remoteAddress: '127.0.0.1',
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await body({ caller, stepUp, run, adjuster, viewer });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: Sent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[RUN_PATH]?.['post']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${RUN_PATH} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

export interface QueuedJob {
  readonly state: string;
  readonly name: string | null;
  readonly payload: unknown;
}

/** The jobs of queue settle under the singletonKey (pgboss.job, plain SQL), oldest first. */
export async function jobsUnder(f: Fixture, key: string): Promise<QueuedJob[]> {
  const result = await sql<QueuedJob>`
    SELECT state::text AS state, data ->> 'name' AS name, data -> 'payload' AS payload
    FROM pgboss.job
    WHERE name = 'settle' AND singleton_key = ${key}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** Every job of any queue whose payload names the fixture's app. */
export async function appJobs(f: Fixture): Promise<unknown[]> {
  const result = await sql<{ name: string; data: unknown }>`
    SELECT name, data FROM pgboss.job WHERE data -> 'payload' ->> 'app_id' = ${f.appId}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

export function runKey(f: Fixture, platform: string, billDate: string): string {
  return `settle_adjust:${f.appId}:${platform}:${billDate}`;
}

export function audits(f: Fixture, action?: string) {
  let query = f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId);
  if (action !== undefined) query = query.where('action', '=', action);
  return query.orderBy('id').execute();
}

/** Everything of the app a manual trigger may write besides the job and its audit record. */
export async function footprint(f: Fixture) {
  return {
    jobs: await f.db
      .selectFrom('settle_jobs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    batches: await f.db
      .selectFrom('settle_adjust_batches')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute(),
    candidates: await f.db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute(),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute(),
  };
}
