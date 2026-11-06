// B2-12d rule-test kit (claude-independent, SPEC_REF 0df853be; D10-587, D10-590): the system-prefilled
// ACCOUNT_CLOSED decrease of a deletion (08 BR-FUND-24 ①⑥⑧, 细则「驳回与撤回不需二次验证」「后台入口」
// 「注销调减单被驳回与注销中的调账」; BR-ID-28), contracts/openapi.yaml adminApproveAdjustment and
// adminRejectAdjustment (CT-24zg, CT-26n), and identity's closing gate of the deletion completion.
// Real pieces, never replaced on the path under test:
// - the admin entry (createHttpApp('admin'): admin token, session and permission checks, the
//   step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
//   entry's ledger); the sms-tier token is issued the way POST /admin/v1/auth/step-up issues it;
// - the worker entry (AppModule.forEntry({ entry: 'worker' }) over a real field keyring, as
//   ../../orders/rebate-wiring/kit.ts): its deletion runner (deletionExpiryToken(): the processing
//   round, then the cooling-period expiry) with whatever prefill and closing ports app.module
//   assembles. Only the job queue is a stub.
// Synthetic fixtures (B2-12c's kit and the helpers below, never on the path under test): members and
// balances, deletion requests as earlier steps leave them (a processing request whose cleanup and
// Apple step already finished: cleaned_at set, apple_revoke_result not_applicable), forms filed
// before, admin accounts. A fixture that cannot be built throws a plain Error, never an assertion;
// a missing piece fails as an assertion (an unregistered admin route answers 404).
// The skeleton of this task is never imported. No real user, payee or merchant data.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type KyselyPlugin,
  type Selectable,
} from 'kysely';
import { expect, vi } from 'vitest';
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
import {
  ADJUST,
  VIEW,
  audits,
  entriesOf,
  expectMentions,
  formNow,
  formView,
  inboxOf,
  moneyOf,
  normalizeForm,
  templateEntries,
  voucherByKey,
  type AdjustFixture,
  type AdminCaller,
  type CallerOptions,
  type Envelope,
  type FormRow,
} from '../admin-adjustments/kit.ts';
import { contractPaths } from '../admin-recon-diffs/kit.ts';

export {
  ADJUST,
  DAY,
  DAY_MS,
  NOW,
  VIEW,
  adjustVouchers,
  allForms,
  audits,
  balanceOf,
  expectMentions,
  fixture,
  formNow,
  formView,
  holdMember,
  inboxOf,
  member,
  moneyOf,
  newAppId,
  newKey,
  normalizeForm,
  seedForm,
  seedPrefill,
  shift,
  suite,
  trace,
  type AdjustFixture,
  type AdminCaller,
  type FormRow,
} from '../admin-adjustments/kit.ts';

const ROOT = new URL('../../../../', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;

export const TIMEOUT = 120_000;
export const APPROVE_PATH = '/admin/v1/adjustments/{adjust_id}/approve';
export const REJECT_PATH = '/admin/v1/adjustments/{adjust_id}/reject';
export const CREATE_PATH = '/admin/v1/adjustments';
export const DETAIL_PATH = '/admin/v1/adjustments/{adjust_id}';
/** The audit actions of the contract (adminApproveAdjustment, adminRejectAdjustment). */
export const APPROVE_ACTION = 'adjustment_approve';
export const REJECT_ACTION = 'adjustment_reject';
/** identity's daily warn while the closing gate is not passed (deletion-processing.ts). */
export const ADJUSTMENT_PENDING = 'identity_deletion_adjustment_pending';
/** identity's warn of a cooling-period request whose transaction threw (deletion-expiry.ts). */
export const EXPIRY_ROW_FAILED = 'identity_deletion_expiry_row_failed';
/** specs/ledger-templates.csv. */
export const CLOSING_TEMPLATE = 'ADMIN_ADJUST:ACCOUNT_CLOSED';

/** The +08:00 accounting day of an instant. */
export function dayOf(at: Date): string {
  return new Date(at.getTime() + 8 * HOUR_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Deletion requests (identity's table, written as earlier steps leave it).

export type RequestRow = Selectable<DB['deletion_requests']>;

/**
 * Settles every open deletion request of earlier tests in this file (the worker's rounds are
 * cross-app): status done, as the identity kit's reset() does.
 */
export async function settleOpenDeletions(f: AdjustFixture): Promise<void> {
  await sql`UPDATE app.deletion_requests SET status = 'done', processed_at = cooling_until,
    row_version = row_version + 1 WHERE status IN ('cooling', 'processing')`.execute(f.db);
}

/**
 * A deletion request of the member. `cooling`: its cooling period ended one hour ago (the member
 * must be normal). `processing` (default): it entered processing one day ago and its cleanup and
 * Apple step already finished, so the next round goes straight to the completion transaction (the
 * member must be deleting).
 */
export async function seedRequest(
  f: AdjustFixture,
  userId: string,
  status: 'cooling' | 'processing' = 'processing',
): Promise<RequestRow> {
  const now = f.clock.now().getTime();
  const coolingUntil = new Date(now - (status === 'cooling' ? HOUR_MS : 24 * HOUR_MS));
  const applyAt = new Date(coolingUntil.getTime() - 7 * 24 * HOUR_MS);
  const processing = status === 'processing';
  return f.db
    .withSchema('app')
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: userId,
      status,
      apply_at: applyAt,
      cooling_until: coolingUntil,
      balance_snapshot_fen: 0n,
      created_at: applyAt,
      updated_at: processing ? coolingUntil : applyAt,
      cleaned_at: processing ? coolingUntil : null,
      apple_revoke_result: processing ? 'not_applicable' : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** What the cleanup and the Apple step leave (no binding: not_applicable), written directly. */
export async function markCleaned(f: AdjustFixture, requestId: string): Promise<void> {
  await f.db
    .withSchema('app')
    .updateTable('deletion_requests')
    .set({ cleaned_at: f.clock.now(), apple_revoke_result: 'not_applicable' })
    .where('app_id', '=', f.appId)
    .where('id', '=', requestId)
    .execute();
}

export async function requestNow(f: AdjustFixture, requestId: string): Promise<RequestRow> {
  const row = await f.db
    .withSchema('app')
    .selectFrom('deletion_requests')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', requestId)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`kit: deletion request ${requestId} is missing`);
  return row;
}

export async function userStatusOf(f: AdjustFixture, userId: string): Promise<string> {
  const row = await f.db
    .withSchema('app')
    .selectFrom('users')
    .select('status')
    .where('app_id', '=', f.appId)
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`kit: user ${userId} is missing`);
  return row.status;
}

/** The member's forms, oldest first (created_at, then adjust_id). */
export function formsOf(f: AdjustFixture, userId: string): Promise<FormRow[]> {
  return f.db
    .selectFrom('admin_adjustments')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('adjust_id')
    .execute();
}

/** The member's PENDING ACCOUNT_CLOSED forms. */
export async function pendingClosing(f: AdjustFixture, userId: string): Promise<FormRow[]> {
  return (await formsOf(f, userId)).filter(
    (row) => row.reason_code === 'ACCOUNT_CLOSED' && row.status === 'PENDING',
  );
}

/**
 * A form exactly as the system prefills it (BR-FUND-24 ⑧; contract examples of approve / reject):
 * PENDING decrease ACCOUNT_CLOSED without amount, filer, note or review, refs the deletion request,
 * contra subject COMMISSION_REVENUE, created at `at`.
 */
export function expectPrefilled(
  f: AdjustFixture,
  row: FormRow | undefined,
  e: { readonly userId: string; readonly requestId: string; readonly at: Date },
): FormRow {
  expect(row, 'a prefilled ACCOUNT_CLOSED form').toBeDefined();
  const form = row!;
  expect(UUID.test(form.adjust_id), form.adjust_id).toBe(true);
  expect(form).toEqual({
    adjust_id: form.adjust_id,
    app_id: f.appId,
    user_id: e.userId,
    direction: 'decrease',
    amount_fen: null,
    reason_code: 'ACCOUNT_CLOSED',
    refs: [{ ref_type: 'account_deletion', ref_id: e.requestId }],
    contra_subject: 'COMMISSION_REVENUE',
    contra_platform: null,
    note: null,
    status: 'PENDING',
    reverses_adjust_id: null,
    created_by: null,
    created_at: e.at,
    reviewed_by: null,
    reviewed_at: null,
    reject_note: null,
    voucher_id: null,
    row_version: form.row_version,
  });
  return form;
}

// ---------------------------------------------------------------------------------------------
// Statement hooks on a database handle.

function compiledOf(
  compiler: PostgresQueryCompiler,
  node: Parameters<PostgresQueryCompiler['compileQuery']>[0],
  queryId: Parameters<PostgresQueryCompiler['compileQuery']>[1],
): { text: string; params: string } {
  const compiled = compiler.compileQuery(node, queryId);
  return {
    text: compiled.sql,
    params: JSON.stringify(compiled.parameters, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  };
}

export interface InsertFault {
  /** One-shot: while armed, the next INSERT into admin_adjustments naming the user fails. */
  armed: boolean;
  tripped: number;
}

/** A one-shot failure of the INSERT into admin_adjustments whose parameters name `userId`. */
export function formInsertFault(userId: string): { fault: InsertFault; plugin: KyselyPlugin } {
  const compiler = new PostgresQueryCompiler();
  const fault: InsertFault = { armed: true, tripped: 0 };
  return {
    fault,
    plugin: {
      transformQuery({ node, queryId }) {
        if (!fault.armed) return node;
        const { text, params } = compiledOf(compiler, node, queryId);
        if (
          /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?admin_adjustments\b/i.test(text) &&
          (params.includes(userId) || text.includes(userId))
        ) {
          fault.armed = false;
          fault.tripped += 1;
          throw new Error('synthetic failure of the prefill insert');
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
}

/**
 * Right after the statement that turns the member's users row into the tombstone (status
 * deleted) has run inside the completion transaction, reads the member's committed available from
 * another connection: a completion that let a balance through finds it still there.
 */
export function tombstoneProbe(
  f: AdjustFixture,
  userId: string,
): { seen: bigint[]; plugin: KyselyPlugin } {
  const compiler = new PostgresQueryCompiler();
  const seen: bigint[] = [];
  const flagged = new Set<string>();
  return {
    seen,
    plugin: {
      transformQuery({ node, queryId }) {
        const { text, params } = compiledOf(compiler, node, queryId);
        if (
          /update\s+(?:"?app"?\s*\.\s*)?"?users"?\s/i.test(text) &&
          (params.includes('"deleted"') || /'deleted'/.test(text)) &&
          (params.includes(userId) || text.includes(userId))
        ) {
          flagged.add(queryId.queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (flagged.delete(queryId.queryId)) {
          const committed = await sql<{ available_fen: string }>`
            SELECT b.available_fen::text AS available_fen
            FROM app.account_balances b
            JOIN app.ledger_accounts a ON a.app_id = b.app_id AND a.id = b.account_id
            WHERE a.app_id = ${f.appId} AND a.owner_type = 'user' AND a.owner_id = ${userId}`.execute(
            f.db,
          );
          for (const row of committed.rows) seen.push(BigInt(row.available_fen));
        }
        return result;
      },
    },
  };
}

async function lockWaiting(f: AdjustFixture): Promise<number> {
  const { rows } = await sql<{ waiting: number }>`SELECT count(DISTINCT l.pid)::int AS waiting
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE NOT l.granted AND a.datname = current_database()`.execute(f.db);
  return rows[0]?.waiting ?? 0;
}

/** Waits (bounded poll of pg_locks, not a timed bet) until `count` sessions wait on a lock. */
export async function lockWaiters(f: AdjustFixture, count: number): Promise<void> {
  let waiting = 0;
  for (let attempt = 0; attempt < 1500 && waiting < count; attempt += 1) {
    if (attempt > 0) await delay(10);
    waiting = await lockWaiting(f);
  }
  expect(waiting, `${count} sessions waiting on a lock within the bound`).toBeGreaterThanOrEqual(
    count,
  );
}

// ---------------------------------------------------------------------------------------------
// The worker entry.

interface WorkerPlatform {
  PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  JOB_QUEUE: symbol;
}

interface WorkerContext {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

interface DeletionRunner {
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

export interface DeletionWorker {
  /** One round of the worker's deletion timer: the processing round, then the cooling expiry. */
  round(): Promise<void>;
  /** The warn lines (level 40) of `msg`, of the fixture's app and, when given, of the request. */
  warnings(msg: string, requestId?: string): Record<string, unknown>[];
  /** Every warn line of `msg`, of any app. */
  anyWarnings(msg: string): Record<string, unknown>[];
}

function isRunner(value: unknown): value is DeletionRunner {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runOnce?: unknown }).runOnce === 'function'
  );
}

/**
 * Runs `run` against a real worker entry on the fixture's database (through `plugins`), clock and
 * a memory logger; the job queue is a stub.
 */
export async function withDeletionWorker(
  f: AdjustFixture,
  run: (w: DeletionWorker) => Promise<void>,
  plugins: readonly KyselyPlugin[] = [],
): Promise<void> {
  // URL imports keep decorated modules out of the spec project's TS compilation.
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as WorkerPlatform;
  const identity = (await import(new URL('apps/api/src/modules/identity/index.ts', ROOT).href)) as {
    deletionExpiryToken(): symbol;
  };
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(module: unknown, options: object): Promise<WorkerContext>;
    };
  };
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const parsed = (): Record<string, unknown>[] =>
    lines
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn<(name: string, handler: unknown) => void>(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const spy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-12d-worker-'));
  let store: Kysely<DB> = f.db;
  for (const plugin of plugins) store = store.withPlugin(plugin);
  let context: WorkerContext | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    let created: WorkerContext;
    try {
      created = await NestFactory.createApplicationContext(
        AppModule.forEntry({
          entry: 'worker',
          config: loadConfig({
            APP_ENV: 'test',
            FIELD_KEY_PROVIDER: 'local',
            FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
            FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
          }),
          clock: f.clock,
          logger,
          dbHandles: { db: store, dbRead: null, close: async () => undefined },
        }),
        { logger: false, abortOnError: false },
      );
    } finally {
      spy.mockRestore();
    }
    context = created;
    const runner = created.get(identity.deletionExpiryToken(), { strict: false });
    expect(isRunner(runner), 'the worker entry assembles the deletion runner').toBe(true);
    const deletion = runner as DeletionRunner;
    const warnLines = (msg: string) =>
      parsed().filter((line) => line['level'] === 40 && line['msg'] === msg);
    await run({
      async round() {
        await deletion.runOnce();
      },
      warnings(msg, requestId) {
        return warnLines(msg).filter(
          (line) =>
            line['app_id'] === f.appId &&
            (requestId === undefined || line['deletion_request_id'] === requestId),
        );
      },
      anyWarnings(msg) {
        return warnLines(msg);
      },
    });
  } finally {
    try {
      await context?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'approve' | 'reject' | 'create' | 'detail';

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface PostOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `maker` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /**
   * X-Step-Up-Token: approve and create send a fresh sms-tier token of the caller by default,
   * reject sends none by default; null sends none.
   */
  readonly stepUp?: string | null;
}

export interface ClosingAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(permissions: readonly string[], options?: CallerOptions): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier sms by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/adjustments/{adjust_id}/approve, body `{}` unless given. */
  approve(
    adjustId: string,
    options?: PostOptions & { readonly body?: unknown },
  ): Promise<AdminSent>;
  /** POST /admin/v1/adjustments/{adjust_id}/reject with the JSON body. */
  reject(adjustId: string, body: unknown, options?: PostOptions): Promise<AdminSent>;
  /** POST /admin/v1/adjustments (B2-12c) with the JSON body. */
  create(body: unknown, options?: PostOptions): Promise<AdminSent>;
  /** GET /admin/v1/adjustments/{adjust_id}, as `maker` unless given. */
  detail(adjustId: string, caller?: AdminCaller): Promise<AdminSent>;
  /** An account with fund.adjust only and a registered verify phone. */
  readonly maker: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withClosingAdmin(
  f: AdjustFixture,
  run: (h: ClosingAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-12d-admin-'));
  let app: HttpApp | undefined;
  try {
    const master = randomBytes(32);
    const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
    writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
    writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const tokenKey = randomBytes(32);
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_12d_test',
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
    const caller: ClosingAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `adj_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          verify_phone_cipher:
            options.phone === false ? null : Buffer.from('synthetic-verify-phone-cipher'),
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
    const stepUp: ClosingAdmin['stepUp'] = async (who, tier = 'sms') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const maker = await caller([ADJUST]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    const post = async (
      op: Operation,
      url: string,
      body: unknown,
      options: PostOptions,
      stepUpByDefault: boolean,
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? maker : options.caller;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-trace-id': randomUUID(),
      };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (options.key !== null) headers['idempotency-key'] = options.key ?? newIdemKey();
      const token =
        options.stepUp !== undefined
          ? options.stepUp
          : stepUpByDefault && who !== null
            ? await stepUp(who)
            : null;
      if (token !== null) headers['x-step-up-token'] = token;
      const response = await server.inject({
        method: 'POST',
        url,
        headers,
        payload: JSON.stringify(body),
        remoteAddress: '127.0.0.1',
      });
      return sent(op, response);
    };
    const formUrl = (adjustId: string) => `${CREATE_PATH}/${encodeURIComponent(adjustId)}`;
    await run({
      caller,
      stepUp,
      maker,
      viewer,
      approve(adjustId, options = {}) {
        const body = 'body' in options ? options.body : {};
        return post('approve', `${formUrl(adjustId)}/approve`, body, options, true);
      },
      reject(adjustId, body, options = {}) {
        return post('reject', `${formUrl(adjustId)}/reject`, body, options, false);
      },
      create(body, options = {}) {
        return post('create', CREATE_PATH, body, options, true);
      },
      async detail(adjustId, who = maker) {
        const response = await server.inject({
          method: 'GET',
          url: formUrl(adjustId),
          headers: { 'x-trace-id': randomUUID(), authorization: `Bearer ${who.token}` },
          remoteAddress: '127.0.0.1',
        });
        return sent('detail', response);
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

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newIdemKey(): string {
  return `adc_${randomBytes(12).toString('hex')}`;
}

// ---------------------------------------------------------------------------------------------
// The contract.

const PATHS: Record<Operation, { path: string; method: 'get' | 'post' }> = {
  approve: { path: APPROVE_PATH, method: 'post' },
  reject: { path: REJECT_PATH, method: 'post' },
  create: { path: CREATE_PATH, method: 'post' },
  detail: { path: DETAIL_PATH, method: 'get' },
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const { path, method } = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${method} ${path} ${status}`).toBeDefined();
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
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, `${sent.op}: ${sent.body}`).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 20001 with exactly these data.fields (and data.reason when given). */
export function invalid(
  sent: AdminSent,
  fields: readonly string[],
  reason?: string,
): Promise<Envelope> {
  return answer(sent, 20001, reason === undefined ? { fields } : { fields, reason });
}

/** 20001 whose data.fields names `field` (the route schema may name more). */
export async function refusedField(sent: AdminSent, field: string): Promise<void> {
  const body = await answer(sent, 20001);
  const fields = (body.data as { fields?: unknown } | undefined)?.fields;
  expect(Array.isArray(fields), sent.body).toBe(true);
  expect(fields as unknown[], sent.body).toContain(field);
}

/** 10403 of an account without the permission point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** 10003 of the sms tier (verify_phone_missing for an account without a verify phone). */
export function stepUpRequired(sent: AdminSent, phoneMissing = false): Promise<Envelope> {
  return answer(
    sent,
    10003,
    phoneMissing ? { tier: 'sms', reason: 'verify_phone_missing' } : { tier: 'sms' },
  );
}

/** 20902 of a form that is no longer PENDING. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'admin_adjustment' });
}

/** 20001 of a balance not above 0 at approval. */
export function noBalance(sent: AdminSent): Promise<Envelope> {
  return invalid(sent, ['adjust_id'], 'adjust_no_balance');
}

/**
 * An approval in effect (BR-FUND-24 ①⑥⑧; adminApproveAdjustment): the prefilled form APPROVED
 * with the available at approval as its amount, the caller as reviewer at the clock, everything
 * else as it was; the response shows it with the available before and after (0); its one voucher
 * `ADJ:{adjust_id}` by `admin:{caller}` on the clock's accounting day, without order_key or role,
 * whose entries are exactly ADMIN_ADJUST:ACCOUNT_CLOSED of specs/ledger-templates.csv (debit
 * USER_BALANCE.available, credit COMMISSION_REVENUE); available 0, frozen 0; no in-app message to
 * the member in deletion.
 */
export async function expectApproved(
  f: AdjustFixture,
  sent: AdminSent,
  e: { readonly caller: AdminCaller; readonly form: FormRow; readonly amount: bigint },
): Promise<FormRow> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'adjustment',
    'available_after_fen',
    'available_before_fen',
  ]);
  const id = e.form.adjust_id;
  const row = await formNow(f, id);
  expect(row, `admin_adjustments ${id}`).toBeDefined();
  expect(row!.voucher_id, `voucher of ${id}`).not.toBeNull();
  const now = f.clock.now();
  expect(row).toEqual({
    ...e.form,
    amount_fen: e.amount,
    status: 'APPROVED',
    reviewed_by: e.caller.id,
    reviewed_at: now,
    voucher_id: row!.voucher_id,
    row_version: row!.row_version,
  });
  expect(normalizeForm(data['adjustment'])).toEqual(formView(row!, null));
  expect(data['available_before_fen'], sent.body).toBe(Number(e.amount));
  expect(data['available_after_fen'], sent.body).toBe(0);

  const uniq = `ADJ:${id}`;
  const voucher = await voucherByKey(f, uniq);
  expect(voucher, uniq).toBeDefined();
  expect(voucher).toMatchObject({
    id: row!.voucher_id,
    operator: `admin:${e.caller.id}`,
    accounting_date: dayOf(now),
    order_key: null,
    role: null,
  });
  const entries = await entriesOf(f, uniq);
  expect(entries, CLOSING_TEMPLATE).toEqual(
    templateEntries(CLOSING_TEMPLATE, { userId: e.form.user_id, platform: null, amount: e.amount }),
  );
  expect(await moneyOf(f, e.form.user_id)).toEqual({ available: 0n, frozen: 0n });
  expect(await inboxOf(f, e.form.user_id), 'no in-app message to a deleted member').toEqual([]);
  return row!;
}

/** The one adjustment_approve record of the form: by the caller, ids, amount, before and after. */
export async function expectApproveAudit(
  f: AdjustFixture,
  e: { readonly caller: AdminCaller; readonly form: FormRow; readonly amount: bigint },
): Promise<void> {
  const rows = (await audits(f, APPROVE_ACTION)).filter((row) =>
    JSON.stringify([row.target, row.before, row.after]).includes(e.form.adjust_id),
  );
  expect(rows.map((row) => row.admin_id)).toEqual([e.caller.id]);
  expectMentions(rows[0]!, { ids: [e.form.adjust_id, e.form.user_id], values: [e.amount, 0n] });
}

/**
 * A rejection in effect (adminRejectAdjustment): the form REJECTED with the trimmed reason as
 * reject_note, the caller as reviewer at the clock, amount_fen still null, no voucher; the
 * response shows exactly the form; the member's balance as `available` (unchanged); one
 * adjustment_reject record by the caller with the ids and the reason.
 */
export async function expectRejected(
  f: AdjustFixture,
  sent: AdminSent,
  e: {
    readonly caller: AdminCaller;
    readonly form: FormRow;
    readonly note: string;
    readonly available: bigint;
  },
): Promise<FormRow> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data), sent.body).toEqual(['adjustment']);
  const id = e.form.adjust_id;
  const row = await formNow(f, id);
  expect(row, `admin_adjustments ${id}`).toBeDefined();
  expect(row).toEqual({
    ...e.form,
    status: 'REJECTED',
    reject_note: e.note,
    reviewed_by: e.caller.id,
    reviewed_at: f.clock.now(),
    amount_fen: null,
    voucher_id: null,
    row_version: row!.row_version,
  });
  expect(normalizeForm(data['adjustment'])).toEqual(formView(row!, null));
  expect(await voucherByKey(f, `ADJ:${id}`), `no voucher for ${id}`).toBeUndefined();
  expect(await moneyOf(f, e.form.user_id)).toEqual({ available: e.available, frozen: 0n });
  const rows = (await audits(f, REJECT_ACTION)).filter((audit) =>
    JSON.stringify([audit.target, audit.before, audit.after]).includes(id),
  );
  expect(rows.map((audit) => audit.admin_id)).toEqual([e.caller.id]);
  expectMentions(rows[0]!, { ids: [id, e.form.user_id], values: [e.note] });
  return row!;
}
