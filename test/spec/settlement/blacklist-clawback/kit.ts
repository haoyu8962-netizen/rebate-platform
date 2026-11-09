// B2-04zzl rule-test kit (claude-independent, SPEC_REF d5713bf4): contracts/openapi.yaml
// blacklistClawbackAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback,
// CT-24zzf r1–r3) and 08 BR-ATTR-26, BR-FUND-01 R8 (BLACKLIST_CONFIRMED), BR-FUND-08; 编排裁定
// D10-1035, D10-1095, D10-1101.
// Real pieces: the credit service (the order reaches CREDITED through the B2-04m credit, so the
// clawback starts from real CREDIT / FORFEIT vouchers, balances and the booked pair), the admin entry
// (createHttpApp('admin'): token, session, permission and step-up checks, contract validation,
// PostgreSQL idempotency, the audit writer, the event bus), ledger, PostgreSQL through
// @couli/db/testing as couli_app, Redis for the admin sessions.
// Synthetic: the difference of a confirmation as the consumer registers it (the contract's shape, so
// the confirmation's tests do not depend on the consumer), admin accounts, the switch's config_items
// row, and a one-shot fault in the entry's database handle. No real user or merchant data.
//
// Default order of the credit harness (N = 1000, reserve_bp 1500 → base 850; self 5000 / direct 1000
// / indirect 500 → 425 / 85 / 42): beneficiaries 552, platform 448. Expected amounts are written by
// hand in the tests. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresQueryCompiler, sql, type KyselyPlugin } from 'kysely';
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
  type ReceivedEvent,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { createBlacklistAfterCreditHandler } from '../../../../apps/api/src/modules/settlement/application/blacklist-clawback.ts';
import { diffNow } from '../../ledger/admin-recon-close/kit.ts';
import {
  contractPaths,
  normalize,
  seedDiff,
  type DiffRow,
  type DiffSeed,
} from '../../ledger/admin-recon-diffs/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import type { RestoreFixture } from '../admin-recon-restore/kit.ts';
import { harness, type Harness, type SeededOrder } from '../clawback/kit.ts';

export {
  audits,
  chars,
  diffNow,
  holdNow,
  idempotencyRows,
  seedHold,
  sourceOf,
  suite,
  track,
  waiting,
} from '../../ledger/admin-recon-close/kit.ts';
export {
  DETAIL_KEYS,
  detailView,
  seedDiff,
  type DiffRow,
} from '../../ledger/admin-recon-diffs/kit.ts';
export { holdOrderKey } from '../admin-recon-restore/kit.ts';
export {
  badDebtLines,
  clawbackKey,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
  type Harness,
  type SeededOrder,
} from '../clawback/kit.ts';

export const CLAWBACK_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback';
/** specs/permissions.yaml: order.blacklist_clawback, step-up tier totp. */
export const PERMISSION = 'order.blacklist_clawback';
/** The audit action of the contract. */
export const ACTION = 'recon_diff_blacklist_clawback';
/** content/domain/config-registry.ts: boolean, no seed row, on only when true. */
export const SWITCH = 'order.blacklist_clawback.enabled';
export const NOT_SUPPORTED = 'blacklist_clawback_not_supported';
export const DISABLED = 'blacklist_clawback_disabled';
export const CONSUMER = 'settlement-blacklist-after-credit';
/** The accounting month at the credit harness' clock (2032-07-24T10:00:00+08:00). */
export const PERIOD = '2032-07';
export const CHANNEL = 'channel';
export const SUFFIX = 'order_no_suffix';

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export interface App {
  readonly s: Suite;
  readonly h: Harness;
  /** The fixture the shared admin-recon helpers take (h's handles, h's app and clock). */
  readonly f: RestoreFixture;
}

/** The switch's row in config_items of the app (false / true; null writes no row). */
export async function setSwitch(h: Harness, value: boolean): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${h.appId}, ${SWITCH}, ${JSON.stringify(value)}::jsonb, 'test')`.execute(h.db);
}

/** A fresh app on the suite's database, with the switch on by default; null leaves it unset. */
export async function app(s: Suite, switchValue: boolean | null = true): Promise<App> {
  const h = await harness(s.db());
  if (switchValue !== null) await setSwitch(h, switchValue);
  return {
    s,
    h,
    f: {
      s,
      db: h.db,
      clock: h.clock,
      appId: h.appId,
      ledger: h.ledger,
      ruleVersionId: 'unused',
      accounts: h.accounts,
    },
  };
}

/** The ref_id the contract gives the difference of `dimensions` on the order. */
export function refIdOf(o: SeededOrder, dimensions: readonly string[]): string {
  return `${o.orderKey}#BLACKLIST#${[...dimensions].sort().join(',')}`;
}

/** The voucher event id of a difference (`B{recon_diff_id}`). */
export function eventIdOf(diff: DiffRow): string {
  return `B${diff.id}`;
}

/**
 * The difference of a confirmation, as the contract says the consumer registers it, written directly
 * so that the confirmation's tests do not depend on the consumer. `patch` overrides any column.
 */
export async function seedBlacklistDiff(
  a: App,
  o: SeededOrder,
  options: { readonly dimensions?: readonly string[]; readonly patch?: DiffSeed } = {},
): Promise<DiffRow> {
  const dimensions = [...(options.dimensions ?? [CHANNEL])].sort();
  const row = await a.h.read(o);
  const booked = row.booked_n_fen;
  expect(booked, 'booked_n_fen of the seeded order').not.toBeNull();
  return seedDiff(a.f, {
    type: 'blacklist_after_credit',
    source: 'R3',
    period: PERIOD,
    ref_type: 'order',
    ref_id: refIdOf(o, dimensions),
    expected_fen: booked!,
    actual_fen: 0n,
    diff_fen: booked!,
    resolution: { dimensions },
    ...options.patch,
  });
}

/** Everything of the app a confirmation or a delivery may write, for before / after comparisons. */
export async function everything(a: App) {
  const { h, f } = a;
  return {
    ...(await h.state()),
    diffs: await h.reconDiffs(),
    holds: await f.db
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    audits: await f.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

// ---------------------------------------------------------------------------------------------
// The consumer.

/** The event data orders publishes (orders/application/alert-events.ts publishBlacklistAfterCredit). */
export type HitPayload = {
  order_id: string;
  platform: string;
  dimensions: string[];
};

export function hitOf(o: SeededOrder, dimensions: readonly string[]): HitPayload {
  return { order_id: o.orderId, platform: o.platform, dimensions: [...dimensions] };
}

export function eventOf(
  a: App,
  payload: HitPayload,
  eventId: string = randomUUID(),
): ReceivedEvent {
  return {
    eventId,
    appId: a.h.appId,
    name: 'order.blacklist_hit_after_credit',
    version: 1,
    occurredAt: a.h.clock.now().toISOString(),
    payload,
    consumer: CONSUMER,
    attempt: 1,
  };
}

/** One delivery on its own transaction, through the consumer's real handler. */
export async function deliver(a: App, event: ReceivedEvent): Promise<void> {
  const logger = createRootLogger(
    { level: 'silent', entry: 'worker', appEnv: 'test' },
    { write: () => undefined },
  );
  const handler = createBlacklistAfterCreditHandler({ clock: a.h.clock, logger });
  await a.h.db.transaction().execute((trx) => handler(event, trx));
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** Where the next failure is thrown; each runs in the confirmation's transaction. */
export type FaultPoint = 'audit' | 'diff_update' | 'voucher' | 'order_update';
export const FAULT_POINTS: readonly FaultPoint[] = [
  'audit',
  'diff_update',
  'voucher',
  'order_update',
];

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function faultHit(point: FaultPoint, text: string, parameters: readonly unknown[]): boolean {
  const table = String.raw`(?:"?app"?\s*\.\s*)?"?`;
  if (point === 'audit') {
    return (
      new RegExp(String.raw`\binsert\s+into\s+${table}audit_logs\b`, 'i').test(text) &&
      (text.includes(ACTION) || JSON.stringify(parameters).includes(ACTION))
    );
  }
  if (point === 'diff_update') {
    return new RegExp(String.raw`\bupdate\s+${table}recon_diffs\b`, 'i').test(text);
  }
  if (point === 'order_update') {
    return new RegExp(String.raw`\bupdate\s+${table}orders\b`, 'i').test(text);
  }
  return new RegExp(String.raw`\binsert\s+into\s+${table}ledger_vouchers\b`, 'i').test(text);
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      if (faultHit(point, compiled.sql, compiled.parameters)) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
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

export interface ConfirmOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `operator` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface Admin {
  readonly fault: Fault;
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST .../blacklist-clawback with the JSON body ({} by default). */
  confirm(reconDiffId: string, body?: unknown, options?: ConfirmOptions): Promise<AdminSent>;
  /** An account with order.blacklist_clawback only. */
  readonly operator: AdminCaller;
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

/** A fresh Idempotency-Key of the contract format. */
export function newKey(): string {
  return `bc_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the confirmation (also the idempotency scope's path). */
export function clawbackPath(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}/blacklist-clawback`;
}

/** Runs `run` against a started admin entry on the app's database, clock and Redis. */
export async function withAdmin(a: App, run: (admin: Admin) => Promise<void>): Promise<void> {
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
  const { f } = a;
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-04zzl-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
  let started: HttpApp | undefined;
  try {
    started = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_04zzl_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await started.init();
    const server = started;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: Admin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `blacklist_${id}`,
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
    const stepUp: Admin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const operator = await caller([PERMISSION]);
    await run({
      fault,
      caller,
      stepUp,
      operator,
      async confirm(reconDiffId, body = {}, options = {}) {
        const who = options.caller === undefined ? operator : options.caller;
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
          url: clawbackPath(reconDiffId),
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
      await started?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract.

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

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[CLAWBACK_PATH]?.['post']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${CLAWBACK_PATH} ${status}`).toBeDefined();
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

export interface Confirmed {
  /** data.recon_diff, its instants as epoch milliseconds. */
  readonly recon_diff: Record<string, unknown>;
  readonly clawed_back_fen: unknown;
  readonly rebate_status_after: unknown;
}

/** The data of a successful confirmation: exactly the contract's three keys. */
export async function confirmed(sent: AdminSent): Promise<Confirmed> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'clawed_back_fen',
    'rebate_status_after',
    'recon_diff',
  ]);
  return {
    recon_diff: normalize(data['recon_diff']),
    clawed_back_fen: data['clawed_back_fen'],
    rebate_status_after: data['rebate_status_after'],
  };
}

export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}

export function noteInvalid(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['note'] });
}

/** The 20001 of an id that names no difference this operation can see (no reason, no 404). */
export function unknownDiff(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'] });
}

export function notSupported(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'], reason: NOT_SUPPORTED });
}

export function disabled(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'], reason: DISABLED });
}

/** The 20902 of a difference already adjusted, written off or closed. */
export function diffConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/** The 20902 of an order that is no longer CREDITED. */
export function orderConflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'order' });
}

/**
 * The difference after a confirmation by `adminId` at the app's clock: status adjusted, handler, both
 * instants the clock, the three amounts as registered, resolution the stored keys plus clawback
 * { operator, clawed_back_at, clawed_back_fen (a JSON integer) } and (when given) the trimmed note;
 * every other column as it was. Returns the row.
 */
export async function expectAdjusted(
  a: App,
  before: DiffRow,
  expected: {
    readonly adminId: string;
    readonly clawedBackFen: number;
    readonly note?: string;
  },
): Promise<DiffRow> {
  const now = await diffNow(a.f, before.id);
  const resolution = now.resolution as Record<string, unknown> | null;
  expect(typeof resolution === 'object' && resolution !== null, JSON.stringify(resolution)).toBe(
    true,
  );
  const clawback = resolution!['clawback'] as Record<string, unknown> | undefined;
  expect(Object.keys(clawback ?? {}).sort(), JSON.stringify(resolution)).toEqual([
    'clawed_back_at',
    'clawed_back_fen',
    'operator',
  ]);
  expect(clawback!['operator']).toBe(expected.adminId);
  expect(clawback!['clawed_back_fen'], 'an int64 JSON integer').toBe(expected.clawedBackFen);
  expect(typeof clawback!['clawed_back_at']).toBe('string');
  expect(Date.parse(clawback!['clawed_back_at'] as string)).toBe(a.h.clock.now().getTime());
  expect(resolution).toEqual({
    ...(before.resolution as Record<string, unknown>),
    clawback,
    ...(expected.note === undefined ? {} : { note: expected.note }),
  });
  expect(now).toEqual({
    ...before,
    status: 'adjusted',
    handler_id: expected.adminId,
    closed_at: a.h.clock.now(),
    updated_at: a.h.clock.now(),
    resolution: now.resolution,
  });
  return now;
}
