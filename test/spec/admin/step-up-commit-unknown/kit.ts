// B2-02ze rule-test kit (claude-independent, SPEC_REF d49d8aa5): FU-STEPUP-COMMIT-UNKNOWN-RETAIN —
// 08 BR-ID-34 (二次验证令牌; the admin side follows BR-ID-08 「只能用于 1 次成功的业务请求」) for the
// case the step-up gate (apps/api/src/modules/admin/application/permission-guard.ts
// createAdminStepUpGate.run: claim → business → consume / release) cannot tell apart today: the
// business threw while its COMMIT was in flight, so whether it took effect is unknown. Task brief
// §9.2: the token must then stay unusable (a retry with it → 10003, the business not run twice),
// while a failure inside the transaction callback (rolled back) and a business refusal still give
// it back, and a success still consumes it.
//
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, idempotency, admin's audit writer, every module
// it mounts), PostgreSQL as couli_app through the suite's pool, Redis. The step-up token is issued
// the way POST /admin/v1/auth/step-up issues it after a correct code (createAdminStepUpTokens on
// the entry's Redis namespace admin-step-up).
// Synthetic: admin accounts, and the entry's database handle: a Kysely over the suite's own pool
// (every statement runs on a real pool connection, nothing is replayed or faked) whose connections
// carry a one-shot fault —
//   'statement':   the INSERT of the given audit action fails before it runs (inside the transaction
//                  callback; Kysely rolls the transaction back: a known roll-back);
//   'commit_lost': the COMMIT of the transaction that wrote the given audit action runs, then the
//                  call fails as a dropped connection does (pg-shaped, SQLSTATE 08006
//                  connection_failure): the work is committed while the caller only sees an error.
//   'commit_lost_bare': as 'commit_lost', but the failure is what the driver throws when the socket
//                  closes while the COMMIT awaits its acknowledgement: a plain
//                  Error('Connection terminated unexpectedly') with no SQLSTATE (no `code`).
//   'commit_unsent': the connection drops before the COMMIT of that transaction reaches the
//                  database: the COMMIT is never sent, the server aborts the open transaction (the
//                  kit rolls it back on the real connection, as the server does on a lost session)
//                  and the call fails as 'commit_lost' does (08006). Nothing is committed, yet to the
//                  caller it looks the same as 'commit_lost': the outcome is unknown.
// The kit imports nothing of the task's own code. No real user, payee or merchant data.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEMA, type DB } from '@couli/db';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
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

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// The entry's database handle with a one-shot fault.

export type FaultMode = 'statement' | 'commit_lost' | 'commit_lost_bare' | 'commit_unsent';

export interface CommitFault {
  /** One-shot: the next transaction writing an audit row of `action` fails as `mode` says. */
  arm(mode: FaultMode, action: string): void;
  /** How many faults have fired so far. */
  readonly tripped: number;
}

interface FaultState {
  mode: FaultMode | null;
  action: string | null;
  tripped: number;
}

const AUDIT_INSERT = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i;

function parametersOf(query: CompiledQuery): string {
  return (
    JSON.stringify(query.parameters, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ) ?? ''
  );
}

/** The statement inserts an audit_logs row of `action`. */
function writesAudit(query: CompiledQuery, action: string): boolean {
  return (
    AUDIT_INSERT.test(query.sql) &&
    (query.sql.includes(action) || parametersOf(query).includes(JSON.stringify(action)))
  );
}

type Edge = 'begin' | 'commit' | 'rollback';

/** A transaction boundary statement as Kysely's PostgreSQL driver sends it, else null. */
function edgeOf(text: string): Edge | null {
  const head = text.trim().toLowerCase();
  if (head === 'begin' || head.startsWith('start transaction')) return 'begin';
  if (head === 'commit') return 'commit';
  if (head === 'rollback') return 'rollback';
  return null;
}

/** What node-postgres reports when the server connection drops mid-call (SQLSTATE 08006). */
function connectionLost(): Error {
  return Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
}

/** What node-postgres throws when the socket closes while a query awaits its answer: no SQLSTATE. */
function connectionLostBare(): Error {
  return new Error('Connection terminated unexpectedly');
}

function faultyConnection(inner: DatabaseConnection, state: FaultState): DatabaseConnection {
  // Whether the open transaction on this connection has written the armed action's audit row.
  let wrote = false;
  return {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const edge = edgeOf(query.sql);
      if (edge === 'commit') {
        const mode = wrote ? state.mode : null;
        wrote = false;
        if (mode === 'commit_unsent') {
          state.mode = null;
          state.tripped += 1;
          // The COMMIT never reaches the server; the server ends the session's transaction.
          await inner.executeQuery(CompiledQuery.raw('rollback'));
          throw connectionLost();
        }
        const result = await inner.executeQuery<R>(query);
        if (mode === 'commit_lost' || mode === 'commit_lost_bare') {
          state.mode = null;
          state.tripped += 1;
          throw mode === 'commit_lost' ? connectionLost() : connectionLostBare();
        }
        return result;
      }
      if (edge !== null) {
        wrote = false;
        return await inner.executeQuery<R>(query);
      }
      if (state.action !== null && writesAudit(query, state.action)) {
        if (state.mode === 'statement') {
          state.mode = null;
          state.tripped += 1;
          throw new Error(`synthetic failure inside the transaction (${state.action})`);
        }
        const result = await inner.executeQuery<R>(query);
        wrote = true;
        return result;
      }
      return await inner.executeQuery<R>(query);
    },
    streamQuery<R>(query: CompiledQuery, chunkSize: number): AsyncIterableIterator<QueryResult<R>> {
      return inner.streamQuery<R>(query, chunkSize);
    },
  };
}

/** Kysely's PostgreSQL driver over connections leased from `base`'s pool, with the fault on them. */
function faultyDriver(base: Kysely<DB>, state: FaultState): Driver {
  const releases = new WeakMap<DatabaseConnection, () => void>();
  return {
    init: async () => undefined,
    acquireConnection() {
      return new Promise<DatabaseConnection>((resolve, reject) => {
        let handed = false;
        void base
          .getExecutor()
          .provideConnection(
            (inner) =>
              new Promise<void>((release) => {
                const connection = faultyConnection(inner, state);
                releases.set(connection, release);
                handed = true;
                resolve(connection);
              }),
          )
          .catch((error: unknown) => {
            if (!handed) reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    },
    async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
      if (settings.isolationLevel !== undefined || settings.accessMode !== undefined) {
        let text = 'start transaction';
        if (settings.isolationLevel !== undefined)
          text += ` isolation level ${settings.isolationLevel}`;
        if (settings.accessMode !== undefined) text += ` ${settings.accessMode}`;
        await connection.executeQuery(CompiledQuery.raw(text));
      } else {
        await connection.executeQuery(CompiledQuery.raw('begin'));
      }
    },
    async commitTransaction(connection: DatabaseConnection) {
      await connection.executeQuery(CompiledQuery.raw('commit'));
    },
    async rollbackTransaction(connection: DatabaseConnection) {
      await connection.executeQuery(CompiledQuery.raw('rollback'));
    },
    async releaseConnection(connection: DatabaseConnection) {
      const release = releases.get(connection);
      releases.delete(connection);
      release?.();
    },
    destroy: async () => undefined,
  };
}

/**
 * A handle on `base`'s pool (schema app, as createDb binds it) whose connections carry the
 * one-shot fault; `base` itself is untouched (fixtures and reads keep using it).
 */
export function faultyDb(base: Kysely<DB>): {
  readonly db: Kysely<DB>;
  readonly fault: CommitFault;
} {
  const state: FaultState = { mode: null, action: null, tripped: 0 };
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => faultyDriver(base, state),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createIntrospector: (db) => new PostgresIntrospector(db),
  };
  return {
    db: new Kysely<DB>({ dialect }).withSchema(APP_SCHEMA),
    fault: {
      arm(mode, action) {
        state.mode = mode;
        state.action = action;
      },
      get tripped() {
        return state.tripped;
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry on that handle.

/** What the entry needs of a fixture of the borrowed kits (recalc, write-off). */
export interface EntryFixture {
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
  readonly s: { redisUrl(): string };
}

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

export interface PostOptions {
  readonly caller: Caller;
  /** X-Step-Up-Token; null sends none. */
  readonly stepUp: string | null;
  /** Idempotency-Key; null sends none. */
  readonly key: string | null;
}

export interface Entry {
  readonly fault: CommitFault;
  /** An admin account of the fixture app with these points and a registered verify phone. */
  caller(permissions: readonly string[]): Promise<Caller>;
  /** A step-up token of the caller's account and admin session. */
  stepUp(caller: Caller, tier: 'totp' | 'sms'): Promise<string>;
  /** POST `path` with the JSON body. */
  post(path: string, body: unknown, options: PostOptions): Promise<Sent>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the faulty handle over the fixture's pool. */
export async function withEntry(f: EntryFixture, run: (h: Entry) => Promise<void>): Promise<void> {
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
  const dir = mkdtempSync(join(base, 'b2-02ze-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const { db, fault } = faultyDb(f.db);
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
        JWT_KEY_ID: 'b2_02ze_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    await run({
      fault,
      async caller(permissions) {
        const id = randomUUID();
        await f.db
          .insertInto('admin_users')
          .values({
            id,
            app_id: f.appId,
            login_name: `b2ze_${id}`,
            password_hash: 'unused-test-login',
            is_super: false,
            status: 'active',
            password_must_change: false,
            totp_bound_at: f.clock.now(),
            verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
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
      },
      async stepUp(who, tier) {
        const grant = await createAdminStepUpTokens({
          clock: f.clock,
          redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
        }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
        return grant.step_up_token;
      },
      async post(path, body, options) {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
          authorization: `Bearer ${options.caller.token}`,
        };
        if (options.stepUp !== null) headers['x-step-up-token'] = options.stepUp;
        if (options.key !== null) headers['idempotency-key'] = options.key;
        const response = await server.inject({
          method: 'POST',
          url: path,
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** The request ended in an error (any non-2xx status, a code other than 0). */
export function expectFailed(sent: Sent): void {
  expect(sent.statusCode >= 400, `${String(sent.statusCode)} ${sent.body}`).toBe(true);
  let code: unknown;
  try {
    code = (JSON.parse(sent.body) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  expect(code, sent.body).not.toBe(0);
}
