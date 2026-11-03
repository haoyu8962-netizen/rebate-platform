// B2-09i rule-test kit (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutWatermark (POST /admin/v1/payout-watermarks: fund.cash_entry, totp step-up,
// Idempotency-Key, audit payout_watermark_create), 08 BR-WDR-18 and its 细则「W 的取数时刻」「多通道的 W」,
// 编排裁定 D10-241, D10-248, D10-285, D10-288, D10-290, D10-591, D10-592.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer),
// B2-06c's createPayoutExecute with its real watermark reader and the real ledger and event bus,
// PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions
// (../../payment/orders/kit.ts suite).
// Synthetic: W is entered through the route; only the preconditions of 「倒退」 and 「只取最新」 and rows
// of another app are written directly (seedWatermark). Members, withdrawals and config_items rows are
// written directly, as ../execute/kit.ts does; risk's state and appeal readers are in-memory ports;
// payout jobs are recorded, never run; admin accounts; a one-shot fault and a one-shot pause in the
// entry's database handle. The totp step-up token is issued the way POST /admin/v1/auth/step-up issues
// it after a correct authenticator code. No real user or merchant data. Expected amounts are written
// by hand in the tests. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { createLedger, type Ledger } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createPayoutExecute,
  type ExecuteBatchResult,
  type PayoutExecute,
  type PayoutExecuteOptions,
} from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
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
import type { RiskStateBatchValue } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  contractPaths,
  fixture as appFixture,
  track,
  waiting,
  type Fixture,
  type Tracked,
} from '../../ledger/admin-recon-close/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import { fund, seedUser } from '../apply/kit.ts';

export {
  audits,
  chars,
  idempotencyRows,
  suite,
  track,
  waiting,
  type Tracked,
} from '../../ledger/admin-recon-close/kit.ts';

export const PATH = '/admin/v1/payout-watermarks';
/** specs/permissions.yaml: fund.cash_entry (step-up tier totp) writes; fund.view only reads. */
export const CASH_ENTRY = 'fund.cash_entry';
export const VIEW = 'fund.view';
/** The audit action of the contract. */
export const ACTION = 'payout_watermark_create';
/** 2026-11-03 10:00 +08:00, the default clock of the fixture. */
export const TEN_AM = '2026-11-03T02:00:00.000Z';
/** A reading 30 minutes before TEN_AM: inside every limit, and the default of enterBody(). */
export const MEASURED = '2026-11-03T09:30:00+08:00';
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
/** The executor of an automatic batch (BR-WDR-30). */
export const SYSTEM = 'system:auto_payout';

export type Channel = 'alipay' | 'wechat';

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// One app on the suite's database, with the real EXECUTE on the fixture's clock.

function recordingSend() {
  return vi.fn(
    async (...args: Parameters<PayoutExecuteOptions['queue']['send']>): Promise<string | null> => {
      void args;
      return 'synthetic-job';
    },
  );
}

export interface WatermarkFixture extends Fixture {
  readonly ledger: Ledger;
  /** B2-06c's real EXECUTE. */
  readonly execute: PayoutExecute;
  /** The payout jobs EXECUTE enqueued (recorded, never run). */
  readonly send: ReturnType<typeof recordingSend>;
}

export function fixture(s: Suite, instant: string = TEN_AM): WatermarkFixture {
  const base = appFixture(s, instant);
  const ledger = createLedger({ clock: base.clock });
  const send = recordingSend();
  const execute = createPayoutExecute({
    config: {
      async configValue(app, key, handle) {
        return (
          (await handle
            .withSchema('app')
            .selectFrom('config_items')
            .select(['value', 'version'])
            .where('app_id', '=', app)
            .where('key', '=', key)
            .executeTakeFirst()) ?? null
        );
      },
    },
    risk: {
      async read(_executor, request) {
        return new Map(
          request.userIds.map((id): [string, RiskStateBatchValue] => [
            id,
            { state: 'normal', frozen_until: null },
          ]),
        );
      },
    },
    appeal: {
      async read() {
        return null;
      },
    },
    ledger,
    queue: { send },
    eventBus: createEventBus({ clock: base.clock, queue: { send }, subscriptions: [] }),
    logger: { warn: vi.fn() },
  });
  return { ...base, ledger, execute, send };
}

/** Another app's id, for the isolation cases. */
export function otherApp(f: Fixture, tag = 'other'): string {
  return `${tag}_${f.appId}`;
}

/** The WeChat channel on for `app` (BR-WDR-33: off by default). */
export async function openWechat(f: Fixture, app: string = f.appId): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${app}, 'payout.channel_enabled.wechat', ${JSON.stringify(true)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE
      SET value = EXCLUDED.value, version = app.config_items.version + 1`.execute(f.db);
}

/** A member of `app` with a funded ledger account. */
export async function member(f: WatermarkFixture, app: string = f.appId): Promise<string> {
  const userId = await seedUser(f.db, app);
  await fund(f.db, f.ledger, { appId: app, userId }, 100_000n);
  return userId;
}

export interface WithdrawalSeed {
  readonly userId: string;
  readonly net?: bigint;
  /** fee_fen, 0 by default; amount_fen is net + fee (withdrawals_net_check, tax 0). */
  readonly fee?: bigint;
  readonly channel?: Channel;
  /** APPROVED by default, reviewed by the automatic path (review_mode auto, no reviewer). */
  readonly status?: 'APPROVED' | 'PAYING' | 'PAID_API';
  readonly createdAt?: Date;
  readonly paidAt?: Date;
  readonly appId?: string;
}

/** A withdrawal of the automatic path, written directly as ../execute/kit.ts writes them. */
export async function seedWithdrawal(f: Fixture, values: WithdrawalSeed): Promise<string> {
  const id = randomUUID();
  const net = values.net ?? 100n;
  const fee = values.fee ?? 0n;
  const channel = values.channel ?? 'alipay';
  const status = values.status ?? 'APPROVED';
  const createdAt = values.createdAt ?? f.clock.now();
  await sql`INSERT INTO app.withdrawals
    (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
     payee_name, payee_account_cipher, payee_hmac, wechat_app_id, status, out_biz_no, payout_channel,
     review_mode, reviewed_at, paid_at, created_at, updated_at)
    VALUES (${id}, ${values.appId ?? f.appId}, ${values.userId}, ${net + fee}, ${fee}, ${0n}, ${net},
     'SERVICE_FEE', ${channel}, '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
     ${randomBytes(32).toString('hex')}, ${channel === 'wechat' ? 'wx_synthetic' : null}, ${status},
     ${randomBytes(16).toString('hex')}, ${channel}, 'auto', ${createdAt},
     ${status === 'PAID_API' ? (values.paidAt ?? createdAt) : null}, ${createdAt},
     ${createdAt})`.execute(f.db);
  return id;
}

/**
 * BR-WDR-18 例: 近 7 日申请合计 ¥49,000, ¥7,000 on each of the seven complete natural days before
 * 2026-11-03 (+08:00), all paid long before any reading of these tests. P = ¥21,000. `feeFen` comes
 * out of each ¥7,000: amount_fen stays 700,000 and net_fen drops by it (no fee by default).
 */
export async function seedSevenDays(
  f: WatermarkFixture,
  options: { readonly feeFen?: bigint } = {},
): Promise<void> {
  const fee = options.feeFen ?? 0n;
  const userId = await member(f);
  for (let day = 0; day < 7; day += 1) {
    const createdAt = new Date(Date.parse('2026-10-27T02:00:00.000Z') + day * 24 * HOUR);
    await seedWithdrawal(f, {
      userId,
      net: 700_000n - fee,
      fee,
      status: 'PAID_API',
      createdAt,
      paidAt: new Date(createdAt.getTime() + MINUTE),
    });
  }
}

export interface WatermarkSeed {
  readonly availableFen: bigint;
  readonly measuredAt: string;
  /** created_at of the row, the fixture's clock by default. */
  readonly createdAt?: string;
  readonly channel?: Channel;
  readonly appId?: string;
}

/** A precondition row of W, written directly (the tests enter W through the route otherwise). */
export async function seedWatermark(f: Fixture, seed: WatermarkSeed): Promise<void> {
  await sql`INSERT INTO app.payout_watermarks
      (id, app_id, channel, available_fen, measured_at, entered_by, created_at)
    VALUES (${randomUUID()}, ${seed.appId ?? f.appId}, ${seed.channel ?? 'alipay'},
      ${seed.availableFen}, ${new Date(seed.measuredAt)}, ${randomUUID()},
      ${seed.createdAt === undefined ? f.clock.now() : new Date(seed.createdAt)})`.execute(f.db);
}

// ---------------------------------------------------------------------------------------------
// What the tests read.

export type WatermarkRow = Selectable<DB['payout_watermarks']>;

/** Every payout_watermarks row of `app`, by measured_at (entry order within one reading unknown). */
export function watermarkRows(f: Fixture, app: string = f.appId): Promise<WatermarkRow[]> {
  return f.db
    .selectFrom('payout_watermarks')
    .selectAll()
    .where('app_id', '=', app)
    .orderBy('measured_at')
    .orderBy('id')
    .execute();
}

/** The measured_at of each row of the channel, oldest first, as epoch milliseconds. */
export async function readings(
  f: Fixture,
  channel: Channel = 'alipay',
  app: string = f.appId,
): Promise<number[]> {
  const rows = await watermarkRows(f, app);
  return rows.filter((row) => row.channel === channel).map((row) => row.measured_at.getTime());
}

/** What entering W must not touch: the books, the withdrawals, the batches and the events. */
export async function books(f: Fixture) {
  return {
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    entries: await f.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    accounts: await f.db
      .selectFrom('ledger_accounts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    balances: await f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    withdrawals: await f.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    batches: await f.db
      .selectFrom('payout_batches')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    items: await f.db
      .selectFrom('payout_batch_items')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('batch_id')
      .orderBy('withdrawal_id')
      .execute(),
    events: await f.db
      .selectFrom('event_log')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** Everything of the app an entry could write, for before / after comparisons. */
export async function everything(f: Fixture) {
  return {
    ...(await books(f)),
    watermarks: await watermarkRows(f),
    audits: await f.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    idempotency: await f.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** One withdrawal as it is now. */
export async function withdrawalRow(f: Fixture, id: string, app: string = f.appId) {
  const row = await f.db
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', app)
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `withdrawals ${id}`).toBeDefined();
  return row!;
}

/** target, before and after of an audit record as one text. */
export function auditText(record: {
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): string {
  return JSON.stringify([record.target, record.before, record.after]);
}

// ---------------------------------------------------------------------------------------------
// The judgement of EXECUTE, on the fixture's clock.

/** EXECUTE of an automatic batch, committed. */
export function executeAuto(
  f: WatermarkFixture,
  members: readonly string[],
  app: string = f.appId,
): Promise<ExecuteBatchResult> {
  return f.db.transaction().execute((trx) =>
    f.execute.executeBatch(trx, {
      appId: app,
      members,
      executorId: SYSTEM,
      now: f.clock.now(),
    }),
  );
}

const ROLL_BACK = new Error('the probe rolls back');

/**
 * EXECUTE of an automatic batch, rolled back: the same batch can be judged again. Returns the
 * judgement and the states the transaction saw right after it.
 */
export async function probeAuto(f: WatermarkFixture, members: readonly string[]) {
  let result: ExecuteBatchResult | undefined;
  let statuses: string[] = [];
  try {
    await f.db.transaction().execute(async (trx) => {
      result = await f.execute.executeBatch(trx, {
        appId: f.appId,
        members,
        executorId: SYSTEM,
        now: f.clock.now(),
      });
      const rows = await trx
        .selectFrom('withdrawals')
        .select('status')
        .where('app_id', '=', f.appId)
        .where('id', 'in', [...members])
        .execute();
      statuses = rows.map((row) => row.status);
      throw ROLL_BACK;
    });
  } catch (error: unknown) {
    if (error !== ROLL_BACK) throw error;
  }
  f.send.mockClear();
  expect(result, 'the probe must reach the judgement').toBeDefined();
  return { result: result!, statuses };
}

/** The refusal of EXECUTE for this reason and channel. */
export function refusedFor(
  reason: 'watermark_stale' | 'watermark_below_forecast' | 'watermark_usable_exceeded',
  channel: Channel = 'alipay',
): ExecuteBatchResult {
  return { kind: 'rejected', reason, channel };
}

/** Narrows to the executed result after asserting it. */
export function executedOf(result: ExecuteBatchResult) {
  expect(result.kind, JSON.stringify(result)).toBe('executed');
  if (result.kind !== 'executed') throw new Error(`expected executed, got ${result.reason}`);
  return result;
}

export function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault and a one-shot pause in the entry's database handle.

/** Where the next failure is thrown; each is one statement of the entry's transaction. */
export type FaultPoint = 'watermark_insert' | 'audit';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

/** A pause armed for the next INSERT into payout_watermarks. */
interface Armed {
  arrive(): void;
  readonly opened: Promise<void>;
}

interface Gate {
  armed: Armed | null;
}

function insertsInto(text: string, table: string): boolean {
  return new RegExp(String.raw`\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?${table}\b`, 'i').test(text);
}

function faultHit(point: FaultPoint, text: string, parameters: readonly unknown[]): boolean {
  if (point === 'watermark_insert') return insertsInto(text, 'payout_watermarks');
  return (
    insertsInto(text, 'audit_logs') &&
    (text.includes(ACTION) ||
      JSON.stringify(parameters, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ).includes(ACTION))
  );
}

function entryPlugin(fault: Fault, gate: Gate): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  const held = new Map<object, Armed>();
  return {
    transformQuery({ node, queryId }) {
      if (fault.point === null && gate.armed === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const point = fault.point;
      if (point !== null && faultHit(point, compiled.sql, compiled.parameters)) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      if (gate.armed !== null && insertsInto(compiled.sql, 'payout_watermarks')) {
        held.set(queryId, gate.armed);
        gate.armed = null;
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      const armed = held.get(queryId);
      if (armed !== undefined) {
        held.delete(queryId);
        armed.arrive();
        await armed.opened;
      }
      return result;
    },
  };
}

/** The next entry stops right after its INSERT returned, its transaction still open. */
export interface InsertHold {
  /** True once `request` stands at the pause; false when it ended without reaching it. */
  reachedBy(request: Tracked<unknown>): Promise<boolean>;
  /** Lets it go on (idempotent). */
  open(): void;
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
  readonly loginName: string;
  readonly displayName: string | null;
}

export interface EnterOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `operator` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface WatermarkAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean; readonly displayName?: string },
  ): Promise<AdminCaller>;
  /** A new session of the same account on the current clock (after the clock moved). */
  relogin(caller: AdminCaller): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/payout-watermarks with the JSON body (enterBody() by default). */
  enter(body?: unknown, options?: EnterOptions): Promise<AdminSent>;
  /** Arms the pause for the next entry that reaches its INSERT. */
  holdNextInsert(): InsertHold;
  /** An account with fund.cash_entry only. */
  readonly operator: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
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

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `wm_${randomBytes(12).toString('hex')}`;
}

/** A valid body of adminCreatePayoutWatermark; `patch` replaces or adds fields. */
export function enterBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { channel: 'alipay', available_fen: 3_000_000, measured_at: MEASURED, ...patch };
}

/**
 * Bodies the route schema accepts and the checks after the guard refuse, at the fixture's default
 * clock: a blank note, a reading more than 5 minutes ahead, a reading more than 2 hours old.
 */
export function refusableBodies(): readonly Record<string, unknown>[] {
  return [
    enterBody({ note: '   ' }),
    enterBody({ measured_at: '2026-11-03T10:05:00.001+08:00' }),
    enterBody({ measured_at: '2026-11-03T07:59:59.999+08:00' }),
  ];
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withWatermarkAdmin(
  f: Fixture,
  run: (h: WatermarkAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-09i-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const gate: Gate = { armed: null };
  const store = f.db.withPlugin(entryPlugin(fault, gate));
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
        JWT_KEY_ID: 'b2_09i_test',
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
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const session = async (adminId: string) => {
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { token, sessionId: claims.sessionId };
    };
    const caller: WatermarkAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      const loginName = `wm_${id}`;
      const displayName = options.displayName ?? null;
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: loginName,
          display_name: displayName,
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
      return { id, ...(await session(id)), loginName, displayName };
    };
    const stepUp: WatermarkAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const operator = await caller([CASH_ENTRY]);
    const viewer = await caller([VIEW]);
    await run({
      fault,
      caller,
      stepUp,
      operator,
      viewer,
      async relogin(who) {
        return { ...who, ...(await session(who.id)) };
      },
      async enter(body = enterBody(), options = {}) {
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
          url: PATH,
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
      holdNextInsert() {
        let arrive!: () => void;
        const arrived = new Promise<void>((resolve) => {
          arrive = resolve;
        });
        let open!: () => void;
        const opened = new Promise<void>((resolve) => {
          open = resolve;
        });
        gate.armed = { arrive, opened };
        return {
          reachedBy: (request) =>
            Promise.race([arrived.then(() => true), request.promise.then(() => false)]),
          open,
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

/**
 * The interleaving of a race, by a lock and no timing: `firstBody` stops right after its INSERT with
 * its transaction open, `secondBody` is sent and must wait on a lock, then the first commits.
 * `waited`: the second was waiting on a lock when the first went on.
 */
export async function interleaved(
  f: Fixture,
  h: WatermarkAdmin,
  firstBody: unknown,
  secondBody: unknown,
): Promise<{ first: AdminSent; second: AdminSent; waited: boolean }> {
  const hold = h.holdNextInsert();
  const first = track(h.enter(firstBody));
  try {
    expect(await hold.reachedBy(first), '第一个请求应走到写入水位表这一步').toBe(true);
    const second = track(h.enter(secondBody));
    const waited = await waiting(f, 1, [second]);
    hold.open();
    return { first: await first.promise, second: await second.promise, waited };
  } finally {
    hold.open();
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
  40901: 409,
  50001: 500,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[PATH]?.['post']?.responses[status]?.content?.[
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

/** data.watermark of a successful entry, its instants as epoch milliseconds. */
export async function entered(sent: AdminSent): Promise<Record<string, unknown>> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data), sent.body).toEqual(['watermark']);
  const out: Record<string, unknown> = { ...(data['watermark'] as Record<string, unknown>) };
  for (const key of ['measured_at', 'created_at']) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** The view a row must be shown as, with the name the account has now. */
export function viewOf(row: WatermarkRow, name: string): Record<string, unknown> {
  return {
    watermark_id: row.id,
    channel: row.channel,
    available_fen: Number(row.available_fen),
    measured_at: row.measured_at.getTime(),
    entered_by: row.entered_by,
    entered_by_name: name,
    created_at: row.created_at.getTime(),
  };
}

/** The 20001 naming exactly these fields. */
export function fieldsError(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

/** The 10403 of an account without the permission point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 10003 of a missing or wrong totp-tier step-up token. */
export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}
