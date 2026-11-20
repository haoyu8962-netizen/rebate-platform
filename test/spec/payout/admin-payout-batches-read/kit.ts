// B2-07g rule-test kit (claude-independent, SPEC_REF ba6655b1): contracts/openapi.yaml
// listAdminPayoutBatches (GET /admin/v1/payout-batches) and getAdminPayoutBatch
// (GET /admin/v1/payout-batches/{batch_id}) of CT-24zzo — payout.execute or fund.view, read only, no
// step-up, no audit; only the batches of the caller's app; members, result_counts and held_count from
// payout_batch_items and withdrawals; last_attempt, next_query_at and has_transfer_attempt from
// payout_attempts (08 BR-WDR-12, BR-WDR-14, BR-WDR-17; ruling D10-2017 ②).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation, the field cipher of the process), content's configuration on config_items,
// PostgreSQL through @couli/db/testing (couli_app; payout_attempts as couli_payout, its only writer),
// Redis for the admin sessions (../admin-withdrawals/kit.ts suite).
// Synthetic: users, withdrawals, payout_batches, payout_batch_items, payout_attempts and config rows
// written directly as EXECUTE, the payout process and W9 would have left them; the admin accounts.
// No real user or payee data. Expected values are written by hand in the tests. Missing pieces fail as
// assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FIELD_CRYPTO,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FieldCrypto,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  MINUTE,
  allAudits,
  contractPaths,
  footprint,
  normalize,
  seedItem,
  seedMember,
  seedWithdrawal,
  type BatchRow,
  type Fixture,
  type Member,
  type Sealer,
  type WithdrawalRow,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';

export {
  MINUTE,
  NOW,
  ago,
  allAudits,
  contractPaths,
  fixture,
  footprint,
  later,
  normalize,
  seedAttempt,
  seedBatch,
  seedItem,
  seedMember,
  seedWithdrawal,
  suite,
  withOffset,
  type AttemptRow,
  type BatchRow,
  type Fixture,
  type ItemRow,
  type Member,
  type Sealer,
  type WithdrawalRow,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';

export const LIST_PATH = '/admin/v1/payout-batches';
export const DETAIL_PATH = '/admin/v1/payout-batches/{batch_id}';
/** specs/permissions.yaml: the two read points of CT-24zzo (either is enough). */
export const EXECUTE = 'payout.execute';
export const VIEW = 'fund.view';
/** A point that is not enough. */
export const REVIEW = 'withdraw.review';
export const SECOND = 1000;
export const HOUR = 60 * MINUTE;

// ---------------------------------------------------------------------------------------------
// Rows (inside withBatches: payee accounts and phones go through the entry's field cipher).

/** An instant `ms` milliseconds after `at`. */
export function plus(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** Two fresh UUIDs, the first one lower (uuid order in PG = lowercase hex text order). */
export function orderedIds(): readonly [string, string] {
  const a = randomUUID();
  const b = randomUUID();
  return a < b ? [a, b] : [b, a];
}

/** One payout_attempts row with a chosen id (as couli_payout; the bodies carry `marker`). */
export async function seedAttemptWithId(
  f: Fixture,
  w: WithdrawalRow,
  seed: {
    readonly id: string;
    readonly kind: 'transfer' | 'query' | 'cancel';
    readonly result: 'pending' | 'success' | 'fail' | 'unknown';
    readonly at: Date;
    readonly marker?: string;
  },
): Promise<void> {
  const marker = seed.marker ?? 'synthetic';
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result,
     latency_ms, at)
    VALUES (${seed.id}, ${w.app_id}, ${w.id}, ${seed.kind},
      ${JSON.stringify({ out_biz_no: w.out_biz_no, note: `${marker}-request` })}::jsonb,
      ${JSON.stringify({ note: `${marker}-response` })}::jsonb, ${`${marker}-code`},
      ${`${marker}-sub`}, ${seed.result}, ${seed.result === 'pending' ? null : 12},
      ${seed.at})`.execute(f.payout);
}

/** One payout_batch_items row with a chosen id. */
export async function seedItemWithId(
  f: Fixture,
  w: WithdrawalRow,
  batch: BatchRow,
  seed: {
    readonly id: string;
    readonly result: 'paying' | 'skipped' | 'blocked' | 'moved_out';
    readonly at: Date;
    readonly reason?: string;
    readonly movedTo?: BatchRow;
  },
): Promise<void> {
  await f.db
    .withSchema('app')
    .insertInto('payout_batch_items')
    .values({
      id: seed.id,
      app_id: w.app_id,
      batch_id: batch.id,
      withdrawal_id: w.id,
      result: seed.result,
      reason: seed.reason ?? null,
      moved_to_batch_id: seed.movedTo?.id ?? null,
      at: seed.at,
    })
    .execute();
}

/** payout.query_schedule of the fixture's app (content's config_items row, as the console saves it). */
export async function setSchedule(
  f: Fixture,
  schedule: {
    readonly points_min: readonly number[];
    readonly interval_min: number;
    readonly manual_after_min: number;
  },
): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, 'payout.query_schedule', ${JSON.stringify(schedule)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE
      SET value = EXCLUDED.value, version = app.config_items.version + 1`.execute(f.db);
}

/** A payout switch of the fixture's app (payout.enabled, payout.queue_paused; JSON booleans). */
export async function setSwitch(
  f: Fixture,
  key: 'payout.enabled' | 'payout.queue_paused',
  value: boolean,
): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE
      SET value = EXCLUDED.value, version = app.config_items.version + 1`.execute(f.db);
}

/**
 * A withdrawal the EXECUTE of `batch` moved to PAYING at `executedAt` (its paying item at the same
 * instant), net 12,345; `transferAt` adds its kind=transfer attempt (result unknown by default).
 */
export async function payingOn(
  f: Fixture,
  h: Sealer,
  who: Member,
  batch: BatchRow,
  options: {
    readonly executedAt: Date;
    /** The paying item's `at` (default executedAt). */
    readonly itemAt?: Date;
    readonly transferAt?: Date;
    readonly transferResult?: 'pending' | 'success' | 'fail' | 'unknown';
    readonly seed?: WithdrawalSeed;
  },
): Promise<WithdrawalRow> {
  const row = await seedWithdrawal(f, h, who, {
    status: 'PAYING',
    review_mode: 'manual',
    execute_seq: 1,
    batch_id: batch.id,
    executor_id: batch.created_by ?? null,
    executed_at: options.executedAt,
    created_at: plus(options.executedAt, -HOUR),
    row_version: 3,
    ...options.seed,
  });
  await seedItem(f, row, batch, { result: 'paying', at: options.itemAt ?? options.executedAt });
  if (options.transferAt !== undefined) {
    await sql`INSERT INTO app.payout_attempts
      (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result,
       latency_ms, at)
      VALUES (${randomUUID()}, ${row.app_id}, ${row.id}, 'transfer',
        ${JSON.stringify({ out_biz_no: row.out_biz_no })}::jsonb, NULL, NULL, NULL,
        ${options.transferResult ?? 'unknown'}, 12, ${options.transferAt})`.execute(f.payout);
  }
  return row;
}

/** A withdrawal W9 returned to APPROVED on `batch` with `reason` (execute_seq 1, its paying item). */
export async function heldOn(
  f: Fixture,
  h: Sealer,
  who: Member,
  batch: BatchRow,
  options: {
    readonly reason: NonNullable<WithdrawalRow['hold_reason']>;
    readonly executedAt: Date;
    /** The paying item's `at` (default executedAt). */
    readonly itemAt?: Date;
    readonly heldAt: Date;
    readonly seed?: WithdrawalSeed;
  },
): Promise<WithdrawalRow> {
  const row = await seedWithdrawal(f, h, who, {
    status: 'APPROVED',
    review_mode: 'manual',
    execute_seq: 1,
    batch_id: batch.id,
    executor_id: batch.created_by ?? null,
    executed_at: options.executedAt,
    hold_reason: options.reason,
    hold_at: options.heldAt,
    created_at: plus(options.executedAt, -HOUR),
    row_version: 4,
    ...options.seed,
  });
  await seedItem(f, row, batch, { result: 'paying', at: options.itemAt ?? options.executedAt });
  return row;
}

/** Everything of the app a read could have written (reads leave it as it was). */
export async function world(f: Fixture) {
  return {
    ...(await footprint(f)),
    audits: await allAudits(f),
    config: await f.db
      .withSchema('app')
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('key')
      .execute(),
  };
}

// ---------------------------------------------------------------------------------------------
// Expected shapes (instants as epoch milliseconds, as normalize() turns the response).

export interface LastAttempt {
  readonly kind: 'transfer' | 'query' | 'cancel';
  readonly result: 'pending' | 'success' | 'fail' | 'unknown';
  /** epoch ms */
  readonly at: number;
}

export interface MemberFacts {
  readonly result: 'paying' | 'skipped' | 'blocked' | 'moved_out';
  readonly last_attempt: LastAttempt | null;
  /** epoch ms or null */
  readonly next_query_at: number | null;
  readonly has_transfer_attempt: boolean;
}

/**
 * The AdminPayoutBatchMember of `row` as it is now (pass the row as the test last left it); the
 * hold_reason column is shown only for APPROVED.
 */
export function memberView(row: WithdrawalRow, facts: MemberFacts): Record<string, unknown> {
  return {
    execute_seq: row.execute_seq,
    withdrawal_id: row.id,
    out_biz_no: row.out_biz_no,
    net_fen: Number(row.net_fen),
    status: row.status,
    result: facts.result,
    hold_reason: row.status === 'APPROVED' ? row.hold_reason : null,
    needs_manual: row.needs_manual,
    last_attempt: facts.last_attempt,
    next_query_at: facts.next_query_at,
    has_transfer_attempt: facts.has_transfer_attempt,
  };
}

export interface Counts {
  readonly paying?: number;
  readonly skipped?: number;
  readonly blocked?: number;
  readonly moved_out?: number;
}

/** The AdminPayoutBatchSummary of `batch` (instants as epoch ms). */
export function summaryView(
  batch: BatchRow,
  facts: {
    readonly executed_at: number | null;
    readonly member_count: number;
    readonly result_counts: Counts;
    readonly held_count: number;
  },
): Record<string, unknown> {
  return {
    batch_id: batch.id,
    kind: batch.kind,
    created_at: batch.created_at.getTime(),
    executed_at: facts.executed_at,
    executor_id: batch.created_by,
    member_count: facts.member_count,
    result_counts: {
      paying: facts.result_counts.paying ?? 0,
      skipped: facts.result_counts.skipped ?? 0,
      blocked: facts.result_counts.blocked ?? 0,
      moved_out: facts.result_counts.moved_out ?? 0,
    },
    held_count: facts.held_count,
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'detail';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface BatchesAdmin extends Sealer {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/payout-batches with the query, as `executor` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/payout-batches/{batch_id}, as `executor` unless given (null: no token). */
  detail(batchId: string, caller?: AdminCaller | null): Promise<AdminSent>;
  /** An account with payout.execute only. */
  readonly executor: AdminCaller;
  /** An account with fund.view only. */
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

const ROOT = new URL('../../../../', import.meta.url);

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withBatches(
  f: Fixture,
  run: (h: BatchesAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-07g-'));
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
        JWT_KEY_ID: 'b2_07g_test',
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
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: BatchesAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .withSchema('app')
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `pbr_${id}`,
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
          .withSchema('app')
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
      return { id, token };
    };
    const executor = await caller([EXECUTE]);
    const viewer = await caller([VIEW]);
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? executor : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const response = await server.inject({
        method: 'GET',
        url,
        headers,
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
      caller,
      executor,
      viewer,
      list(query, who) {
        const text = new URLSearchParams(query ?? {}).toString();
        return send('list', text === '' ? LIST_PATH : `${LIST_PATH}?${text}`, who);
      },
      detail(batchId, who) {
        return send('detail', `${LIST_PATH}/${encodeURIComponent(batchId)}`, who);
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

/** A member of the fixture's app (its phone through the entry's cipher). */
export function member(f: Fixture, h: Sealer): Promise<Member> {
  return seedMember(f, h);
}

// ---------------------------------------------------------------------------------------------
// The contract.

const PATHS: Record<Operation, string> = { list: LIST_PATH, detail: DETAIL_PATH };

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${path} ${status}`).toBeDefined();
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

/** The 20001 naming exactly these fields. */
export function fieldsError(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

/** The 10403 of an account without either read point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response, its instants as epoch milliseconds. */
export async function pageOf(sent: AdminSent): Promise<Page> {
  const data = normalize((await answer(sent, 0)).data);
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  expect(Array.isArray((data as Record<string, unknown>)['items']), sent.body).toBe(true);
  return data as Page;
}

/** The batch_id of each row of a successful list response, in order. */
export async function batchIds(sent: AdminSent): Promise<unknown[]> {
  return (await pageOf(sent)).items.map((item) => item['batch_id']);
}

/** The data of a successful detail response, its instants (next_query_at too) as epoch ms. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const data = normalize((await answer(sent, 0)).data) as Record<string, unknown>;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  const members = data['members'];
  expect(Array.isArray(members), sent.body).toBe(true);
  return {
    ...data,
    members: (members as Record<string, unknown>[]).map((m) => ({
      ...m,
      next_query_at:
        typeof m['next_query_at'] === 'string'
          ? Date.parse(m['next_query_at'])
          : m['next_query_at'],
    })),
  };
}

/** The batch part of a detail (every field of a list row). */
export function summaryPart(detail: Record<string, unknown>): Record<string, unknown> {
  const { members, ...rest } = detail;
  void members;
  return rest;
}

/** One member of a detail by withdrawal id, which must be listed. */
export function memberOf(
  detail: Record<string, unknown>,
  row: { readonly id: string },
): Record<string, unknown> {
  const found = (detail['members'] as Record<string, unknown>[]).find(
    (m) => m['withdrawal_id'] === row.id,
  );
  expect(found, `member ${row.id} in ${JSON.stringify(detail)}`).toBeDefined();
  return found!;
}

/** The member ids of a detail in order. */
export function memberIds(detail: Record<string, unknown>): unknown[] {
  return (detail['members'] as Record<string, unknown>[]).map((m) => m['withdrawal_id']);
}
