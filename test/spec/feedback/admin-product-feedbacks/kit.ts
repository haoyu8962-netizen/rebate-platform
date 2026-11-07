// B1-28s rule-test kit (claude-independent, SPEC_REF 18f0015e): contracts/openapi.yaml
// adminListProductFeedbacks (GET /admin/v1/product-feedbacks, CT-26x, 编排 D10-757) — permission
// point feedback.view, read only, no step-up, no audit record; only the caller's app; items are the
// contract's 12 fields of app.product_feedbacks (no phone number, nickname, device identifier or
// app_id; a guest record has user_id null); filters platform / reason / from (inclusive) / to
// (exclusive) combine with AND, from not earlier than to → 20001 data.fields=[from, to]; created_at
// descending, equal times in a server-internal order; page / page_size ≤ 200; total counts the
// filter set; records of a user whose deletion completed are gone (08 BR-ID-30 细则「商品反馈记录」,
// BR-ID-28).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin
// sessions and step-up tokens (../../payment/orders/kit.ts suite). Synthetic: the feedback rows
// (written directly with INSERT into app.product_feedbacks, as couli_app may and as the B1-28p
// submission writes them), the users rows and the admin accounts. No real user data. Missing pieces
// fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
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
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export { suite } from '../../payment/orders/kit.ts';

/** 2026-11-07 10:00 +08:00. */
export const NOW = '2026-11-07T02:00:00.000Z';
export const PATH = '/admin/v1/product-feedbacks';
export const OPERATION_ID = 'adminListProductFeedbacks';
/** specs/permissions.yaml (CT-26x): the read-only point of the product feedback list, no step-up. */
export const VIEW = 'feedback.view';
/** The four reasons of the contract (BR-TEXT-14 feedback.reason.*). */
export const REASONS = ['price', 'rebate', 'info', 'other'] as const;
/** The required keys of AdminProductFeedbackListItem (additionalProperties false), sorted. */
export const ITEM_KEYS = [
  'created_at',
  'id',
  'item_ref',
  'link_id',
  'note',
  'platform',
  'product_key',
  'quoted_at',
  'reason',
  'shown_final_price_fen',
  'shown_rebate_fen',
  'user_id',
] as const;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export interface Fixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
}

/** A fresh app id (28 characters). */
export function newAppId(): string {
  return `fbk_${randomBytes(12).toString('hex')}`;
}

export function fixture(s: Suite, instant = NOW): Fixture {
  return { s, db: s.db(), clock: new FixedClock(instant), appId: newAppId() };
}

/** An instant `minutes` before the fixture's clock. */
export function ago(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * 60_000);
}

export interface Member {
  readonly id: string;
  readonly appId: string;
  /** Synthetic personal data of the account that must never show in the list. */
  readonly nickname: string;
  readonly phone: string;
  readonly phoneHmac: string;
}

/** A synthetic users row (status normal) with a nickname and a phone digest, in `appId`. */
export async function seedMember(f: Fixture, appId = f.appId): Promise<Member> {
  const id = randomUUID();
  const tag = randomBytes(4).toString('hex');
  const member: Member = {
    id,
    appId,
    nickname: `fbk-nick-${tag}`,
    phone: `1990000${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0')}`,
    phoneHmac: randomBytes(32).toString('hex'),
  };
  const at = ago(f, 60 * 24 * 30);
  await sql`INSERT INTO app.users
    (id, app_id, phone_cipher, phone_hmac, nickname, avatar, invite_code, attr_code, level,
     register_method, status, created_at, updated_at)
    VALUES (${id}::uuid, ${appId}, ${Buffer.from(`synthetic-cipher:${member.phone}`)},
      ${member.phoneHmac}, ${member.nickname}, 'synthetic', ${randomUUID()}, ${randomUUID()}, 'L1',
      'sms', 'normal', ${at}, ${at})`.execute(f.db);
  return member;
}

export interface FeedbackSeed {
  readonly appId?: string;
  readonly deviceId?: string;
  readonly userId?: string | null;
  readonly platform?: string;
  readonly productKey?: string;
  readonly itemRef?: string | null;
  readonly linkId?: string;
  readonly shownFinalPriceFen?: bigint;
  readonly shownRebateFen?: bigint | null;
  readonly quotedAt?: Date;
  readonly reason?: string;
  readonly note?: string | null;
  readonly createdAt?: Date;
}

/** A seeded app.product_feedbacks row, its values exactly as written. */
export interface Feedback {
  readonly id: string;
  readonly appId: string;
  readonly deviceId: string;
  readonly userId: string | null;
  readonly platform: string;
  readonly productKey: string;
  readonly itemRef: string | null;
  readonly linkId: string;
  readonly shownFinalPriceFen: bigint;
  readonly shownRebateFen: bigint | null;
  readonly quotedAt: Date;
  readonly reason: string;
  readonly note: string | null;
  readonly createdAt: Date;
}

function build(f: Fixture, seed: FeedbackSeed): Feedback {
  const createdAt = seed.createdAt ?? ago(f, 60);
  return {
    id: randomUUID(),
    appId: seed.appId ?? f.appId,
    deviceId: seed.deviceId ?? randomUUID(),
    userId: seed.userId !== undefined ? seed.userId : null,
    platform: seed.platform ?? 'jd',
    productKey: seed.productKey ?? 'jd:synthetic-5001',
    itemRef: seed.itemRef !== undefined ? seed.itemRef : null,
    linkId: seed.linkId ?? randomUUID(),
    shownFinalPriceFen: seed.shownFinalPriceFen ?? 12_900n,
    shownRebateFen: seed.shownRebateFen !== undefined ? seed.shownRebateFen : 350n,
    quotedAt: seed.quotedAt ?? new Date(createdAt.getTime() - 5 * 60_000),
    reason: seed.reason ?? 'price',
    note: seed.note !== undefined ? seed.note : null,
    createdAt,
  };
}

function valuesOf(row: Feedback) {
  return sql`(${row.id}::uuid, ${row.appId}, ${row.deviceId}::uuid, ${row.userId}::uuid,
    ${row.platform}, ${row.productKey}, ${row.itemRef}, ${row.linkId}::uuid,
    ${row.shownFinalPriceFen.toString()}::bigint,
    ${row.shownRebateFen === null ? null : row.shownRebateFen.toString()}::bigint,
    ${row.quotedAt}, ${row.reason}, ${row.note}, ${row.createdAt})`;
}

/** Writes the rows in one INSERT; returns them as written, in the order given. */
export async function seedFeedbacks(
  f: Fixture,
  seeds: readonly FeedbackSeed[],
): Promise<Feedback[]> {
  const rows = seeds.map((seed) => build(f, seed));
  if (rows.length === 0) return rows;
  await sql`INSERT INTO app.product_feedbacks (id, app_id, device_id, user_id, platform,
      product_key, item_ref, link_id, shown_final_price_fen, shown_rebate_fen, quoted_at, reason,
      note, created_at)
    VALUES ${sql.join(rows.map(valuesOf))}`.execute(f.db);
  return rows;
}

export async function seedFeedback(f: Fixture, seed: FeedbackSeed = {}): Promise<Feedback> {
  const [row] = await seedFeedbacks(f, [seed]);
  if (row === undefined) throw new Error('kit: the feedback row was not built');
  return row;
}

/** Every app.product_feedbacks row of every app, as text, by id (reads must leave them as they were). */
export async function allFeedbackRows(db: Kysely<DB>): Promise<Record<string, unknown>[]> {
  const { rows } = await sql<Record<string, unknown>>`SELECT id::text AS id, app_id,
      device_id::text AS device_id, user_id::text AS user_id, platform, product_key, item_ref,
      link_id::text AS link_id, shown_final_price_fen::text AS shown_final_price_fen,
      shown_rebate_fen::text AS shown_rebate_fen, quoted_at, reason, note, created_at
    FROM app.product_feedbacks ORDER BY id`.execute(db);
  return rows;
}

/** The number of app.audit_logs rows of every app. */
export async function auditCount(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM app.audit_logs`.execute(
    db,
  );
  return Number(rows[0]?.n ?? '0');
}

// ---------------------------------------------------------------------------------------------
// Expected shapes.

/** The AdminProductFeedbackListItem a row must be shown as (instants as epoch milliseconds). */
export function view(row: Feedback): Record<string, unknown> {
  return {
    id: row.id,
    platform: row.platform,
    product_key: row.productKey,
    item_ref: row.itemRef,
    link_id: row.linkId,
    shown_final_price_fen: Number(row.shownFinalPriceFen),
    shown_rebate_fen: row.shownRebateFen === null ? null : Number(row.shownRebateFen),
    quoted_at: row.quotedAt.getTime(),
    reason: row.reason,
    note: row.note,
    user_id: row.userId,
    created_at: row.createdAt.getTime(),
  };
}

/** A response item with its date-time strings turned into epoch milliseconds. */
export function normalize(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['quoted_at', 'created_at'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** Rows newest first (the seeds of a test using it have distinct created_at). */
export function newestFirst(rows: readonly Feedback[]): Feedback[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface FeedbackAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session. */
  stepUp(caller: AdminCaller, tier: 'totp' | 'sms'): Promise<string>;
  /**
   * GET /admin/v1/product-feedbacks with the query, as `viewer` unless given (null: no token),
   * with any extra headers.
   */
  list(
    query?: Record<string, string>,
    caller?: AdminCaller | null,
    headers?: Record<string, string>,
  ): Promise<AdminSent>;
  /** An account with feedback.view only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withFeedbackAdmin(
  f: Fixture,
  run: (h: FeedbackAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b1-28s-'));
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
        JWT_KEY_ID: 'b1_28s_test',
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
    const caller: FeedbackAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `fbk_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
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
    };
    const stepUp: FeedbackAdmin['stepUp'] = async (who, tier) => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const viewer = await caller([VIEW]);
    await run({
      caller,
      stepUp,
      viewer,
      async list(query, who, extra) {
        const actor = who === undefined ? viewer : who;
        const headers: Record<string, string> = { 'x-trace-id': randomUUID(), ...(extra ?? {}) };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
        const text = new URLSearchParams(query ?? {}).toString();
        const response = await server.inject({
          method: 'GET',
          url: text === '' ? PATH : `${PATH}?${text}`,
          headers,
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

// ---------------------------------------------------------------------------------------------
// The contract.

export interface ContractOperation {
  readonly operationId?: string;
  readonly 'x-implementation'?: string;
  readonly 'x-auth'?: string;
  readonly 'x-error-codes'?: readonly number[];
  readonly parameters?: readonly unknown[];
  readonly responses: Record<
    string,
    { readonly content?: Record<string, { readonly schema: JsonSchema }> }
  >;
}
type ContractPaths = Record<string, Record<string, ContractOperation>>;
let contractPromise: Promise<ContractPaths> | undefined;

/** The dereferenced paths of contracts/openapi.yaml. */
export function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[PATH]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${PATH} ${status}`).toBeDefined();
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
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 10403 of an account without the permission point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** 20001 with exactly these data.fields. */
export function invalid(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response (data exactly items / page / page_size / total). */
export async function page(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  expect(Object.keys(data as object).sort(), sent.body).toEqual([
    'items',
    'page',
    'page_size',
    'total',
  ]);
  expect(Array.isArray((data as Record<string, unknown>)['items']), sent.body).toBe(true);
  return data as Page;
}

/** The ids of a successful list response, in order. */
export async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['id']);
}
