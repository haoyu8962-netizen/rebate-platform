// B2-09zc rule-test kit (claude-independent, SPEC_REF b79958d): contracts/openapi.yaml CT-24zv
// adminListSettleAdjustments (GET /admin/v1/settle-adjustments), adminApproveSettleAdjustBatch
// (POST /admin/v1/settle-adjust-batches/{batch_id}/approve) and adminRejectSettleAdjustBatch
// (POST /admin/v1/settle-adjust-batches/{batch_id}/reject); 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09,
// BR-FUND-15; rulings D10-769, D10-770 ①–④.
// Real pieces: every order is credited by the real B2-04m credit service and its candidates are
// written by the real B2-09zb generator (../settle-adjust-generate/harness.ts), so approval starts
// from real CREDIT / FORFEIT vouchers, balances, booked pair, obligations and pending candidates; the
// admin entry (createHttpApp('admin'): admin token, session and permission checks, the step-up gate
// over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the real beneficiary
// gate over identity / risk, commission's snapshot read, ledger) runs on a pool of 3 connections,
// the production size of the admin process (B2-09x lesson: the audit must not take a second
// connection while a request transaction is held). PostgreSQL through @couli/db/testing as
// couli_app, Redis for the admin sessions.
// Synthetic: every row, admin accounts, phone numbers, birth dates. Expected amounts are written by
// hand in the tests from the BR-CALC-02 / BR-CALC-04 / BR-CALC-09 formulas, never by calling the
// planner. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { addFen } from '@couli/money';
import { PostgresQueryCompiler, type Kysely, type QueryId, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { deriveAudit } from '../../../../apps/api/src/modules/admin/domain/audit-log-view.ts';
import {
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import { REALNAME_CONTEXT } from '../../../../apps/api/src/modules/identity/infra/realname-reader.ts';
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
  type Clock,
  type DbHandles,
  type FieldCrypto,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { CreditRole } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import { contractPaths } from '../admin-settle-bills/kit.ts';
import { BEFORE } from '../credit/kit.ts';
import { adjustHarness, text, type SeededOrder } from '../settle-adjust-generate/harness.ts';

export {
  EXAMPLE,
  VOID_ON_CLAWBACK,
  failAfter,
  ordered,
  text,
} from '../settle-adjust-generate/harness.ts';
export type { OrderSpec, SeededOrder } from '../settle-adjust-generate/harness.ts';

const ROOT = new URL('../../../../', import.meta.url);

export const TIMEOUT = 180_000;
/** The production size of the admin process' pool (B2-09x). */
export const ADMIN_POOL = 3;

export const LIST_PATH = '/admin/v1/settle-adjustments';
export const APPROVE_PATH = '/admin/v1/settle-adjust-batches/{batch_id}/approve';
export const REJECT_PATH = '/admin/v1/settle-adjust-batches/{batch_id}/reject';
/** specs/permissions.yaml (04 §11.2): approve / reject; the list also takes fund.view. */
export const ADJUST = 'fund.settle_adjust';
export const VIEW = 'fund.view';
export const APPROVE_ACTION = 'settle_adjust_batch_approve';
export const REJECT_ACTION = 'settle_adjust_batch_reject';
/** contracts/error-codes.yaml 20902 data.resource. */
export const BATCH_RESOURCE = 'settle_adjust_batch';
/** The audit view's derived target_type of the two batch actions (audit-log-view.ts). */
export const BATCH_TARGET_TYPE = 'settle_adjust_batch';

// ---------------------------------------------------------------------------------------------
// One test database and one Redis per file.

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}
interface TestRedis {
  readonly url: string;
  stop(): Promise<void>;
}
interface TestingBase {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}

export interface ApproveSuite {
  /** The seeding and reading pool (not the admin entry's). */
  readonly db: Kysely<DB>;
  /** couli_app's connection string of the file's database. */
  readonly url: string;
  readonly redisUrl: string;
}

export function approveSuite(): ApproveSuite {
  let database: TestDatabase | undefined;
  let redis: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  beforeAll(async () => {
    // Loaded at run time: this kit must not depend on @couli/db/testing statically.
    const testing = (await import(
      new URL('packages/db/src/testing/index.ts', ROOT).href
    )) as TestingBase;
    database = await testing.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
    redis = await testing.acquireTestRedis();
  }, TIMEOUT);
  afterAll(async () => {
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await redis?.stop();
      }
    }
  }, TIMEOUT);
  return {
    get db(): Kysely<DB> {
      expect(db, 'test database').toBeDefined();
      return db!;
    },
    get url(): string {
      expect(database, 'test database').toBeDefined();
      return database!.urlFor('couli_app');
    },
    get redisUrl(): string {
      expect(redis, 'test redis').toBeDefined();
      return redis!.url;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The seeding harness: the B2-09zb harness (credit + generator) plus approval-side reads.

interface ShareEventInput {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly status: 'active' | 'held' | 'forfeited';
  readonly reason: 'banned' | 'deleted' | 'minor' | null;
}

interface CommissionEvents {
  appendBeneficiaryEvent(
    trx: Transaction<DB>,
    input: ShareEventInput,
    deps: { readonly clock: Clock },
  ): Promise<void>;
}

export interface AdjLine {
  readonly uniq_key: string;
  readonly voucher_kind: string | null;
  readonly subject: string;
  readonly owner_id: string;
  readonly amount_fen: bigint;
  readonly sub_account: string;
  readonly ledger_type: string;
  readonly sub_type: string | null;
}

export async function approveHarness(s: ApproveSuite) {
  const db = s.db;
  const h = await adjustHarness(db);
  const appId = h.appId;

  /** Every ledger line of the order's vouchers (voucher order_key = the order's key). */
  async function orderLines(o: SeededOrder): Promise<AdjLine[]> {
    const rows = await db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_vouchers as v', (join) =>
        join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
      )
      .innerJoin('ledger_accounts as a', (join) =>
        join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
      )
      .select([
        'v.uniq_key',
        'v.voucher_kind',
        'a.subject',
        'a.owner_id',
        'e.amount_fen',
        'e.sub_account',
        'e.ledger_type',
        'e.sub_type',
      ])
      .where('e.app_id', '=', appId)
      .where('v.order_key', '=', o.orderKey)
      .orderBy('e.id')
      .execute();
    return rows.map((r) => ({
      uniq_key: r.uniq_key,
      voucher_kind: r.voucher_kind,
      subject: r.subject,
      owner_id: r.owner_id,
      amount_fen: r.amount_fen,
      sub_account: r.sub_account,
      ledger_type: r.ledger_type,
      sub_type: r.sub_type,
    }));
  }

  /** The order's lines on any `:ADJ:` voucher (every seq). */
  async function adjLinesOf(o: SeededOrder): Promise<AdjLine[]> {
    return (await orderLines(o)).filter((l) => l.uniq_key.includes(':ADJ:'));
  }

  /** The order's `:ADJ:{seq}` lines as sorted `uniq_key|subject|owner|amount` strings. */
  async function adjLines(o: SeededOrder, seq: number): Promise<string[]> {
    return (await orderLines(o))
      .filter((l) => l.uniq_key.endsWith(`:ADJ:${String(seq)}`))
      .map((l) => `${l.uniq_key}|${l.subject}|${l.owner_id}|${String(l.amount_fen)}`)
      .sort();
  }

  /**
   * The order's `:ADJ:{seq}` vouchers are exactly `expected` (voucherLines form, any order): every
   * line SETTLE_ADJUST / SETTLE_DIFF on the available sub-account, every voucher of kind
   * SETTLE_ADJUST and balanced.
   */
  async function expectAdjust(o: SeededOrder, seq: number, expected: readonly string[]) {
    expect(await adjLines(o, seq)).toEqual([...expected].sort());
    const lines = (await orderLines(o)).filter((l) => l.uniq_key.endsWith(`:ADJ:${String(seq)}`));
    for (const l of lines) {
      expect([l.voucher_kind, l.ledger_type, l.sub_type, l.sub_account], l.uniq_key).toEqual([
        'SETTLE_ADJUST',
        'SETTLE_ADJUST',
        'SETTLE_DIFF',
        'available',
      ]);
    }
    const sums = new Map<string, bigint>();
    for (const l of lines) sums.set(l.uniq_key, addFen(sums.get(l.uniq_key) ?? 0n, l.amount_fen));
    for (const [key, sum] of sums) expect(sum, `${key} balanced`).toBe(0n);
  }

  /** UNION_RECEIVABLE:<platform> net over the order's vouchers. */
  function receivableOf(o: SeededOrder): Promise<bigint> {
    return h.orderSubjectNet(o, `UNION_RECEIVABLE:${o.platform}`);
  }

  function batch(batchId: string) {
    return db
      .selectFrom('settle_adjust_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .where('batch_id', '=', batchId)
      .executeTakeFirstOrThrow();
  }

  /** The generator's run; the batch it wrote (one is expected). */
  async function generate(): Promise<string> {
    const result = await h.run();
    expect(result.batchId, 'the run wrote a batch').not.toBeNull();
    return result.batchId!;
  }

  /** An order_rights case of the order and orders.rights_pending as BR-FUND-06 derives it. */
  async function rightsCase(
    o: SeededOrder,
    status: 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED',
  ): Promise<void> {
    await h.rights(o, { status, deductionFen: null });
    await db
      .updateTable('orders')
      .set({ rights_pending: status !== 'SUCCEEDED' })
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .execute();
  }

  /** A configuration value both for the harness' generator and for the admin entry's reader. */
  async function setConfig(key: string, value: boolean): Promise<void> {
    h.configValues.set(key, value);
    await db
      .insertInto('config_items')
      .values({
        app_id: appId,
        key,
        value: JSON.stringify(value),
        version: 1,
        updated_by: 'fixture',
      })
      .execute();
  }

  /** A forfeited beneficiary event written by commission's own writer (status forfeited). */
  async function forfeitShare(o: SeededOrder, role: CreditRole): Promise<void> {
    // Loaded at run time: commission's entry carries Nest decorators the rule-test project skips.
    const commission = (await import(
      new URL('apps/api/src/modules/commission/index.ts', ROOT).href
    )) as CommissionEvents;
    await db.transaction().execute((trx) =>
      commission.appendBeneficiaryEvent(
        trx,
        {
          appId,
          orderId: o.orderId,
          userId: o.user(role),
          role,
          status: 'forfeited',
          reason: 'banned',
        },
        { clock: h.clock },
      ),
    );
  }

  /** Everything an approval or rejection may write, for before / after comparisons. */
  async function footprint() {
    return {
      state: await h.state(),
      candidates: await h.allRows(),
      batches: await h.batches(),
      audits: await h.audits(),
    };
  }

  /** The money of one order: its vouchers' lines, its people's balances, booked pair, obligations. */
  async function moneyOf(o: SeededOrder) {
    const row = await h.read(o);
    const balances: Record<string, bigint> = {};
    for (const p of o.people) balances[`${p.role}:${p.userId}`] = await h.balance(p.userId);
    return {
      lines: await orderLines(o),
      balances,
      booked: [row.booked_base_fen, row.booked_n_fen],
      rebate_status: row.rebate_status,
      obligations: await h.orderObligations(o),
    };
  }

  return {
    ...h,
    orderLines,
    adjLinesOf,
    adjLines,
    expectAdjust,
    receivableOf,
    batch,
    generate,
    rightsCase,
    setConfig,
    forfeitShare,
    footprint,
    moneyOf,
  };
}

export type ApproveHarness = Awaited<ReturnType<typeof approveHarness>>;

// ---------------------------------------------------------------------------------------------
// Expected vouchers (voucherLines form: `uniq_key|subject|owner|amount`, debit positive).

export const userAdjKey = (o: SeededOrder, role: CreditRole, seq: number) =>
  `${o.orderKey}:${o.user(role)}:${role}:ADJ:${String(seq)}`;
export const platformAdjKey = (o: SeededOrder, seq: number) =>
  `${o.orderKey}:PLATFORM:ADJ:${String(seq)}`;

/** `*:USER:INCREASE`: debit UNION_RECEIVABLE, credit USER_BALANCE.available. */
export function userIncrease(
  o: SeededOrder,
  role: CreditRole,
  amount: bigint,
  seq: number,
): string[] {
  const key = userAdjKey(o, role, seq);
  return [
    `${key}|UNION_RECEIVABLE:${o.platform}|platform|${String(amount)}`,
    `${key}|USER_BALANCE|${o.user(role)}|${String(-amount)}`,
  ];
}

/** `*:PLATFORM:INCREASE` (platform difference > 0): debit UNION_RECEIVABLE, credit COMMISSION_REVENUE. */
export function platformIncrease(o: SeededOrder, amount: bigint, seq: number): string[] {
  const key = platformAdjKey(o, seq);
  return [
    `${key}|UNION_RECEIVABLE:${o.platform}|platform|${String(amount)}`,
    `${key}|COMMISSION_REVENUE|platform|${String(-amount)}`,
  ];
}

/** `*:PLATFORM:DECREASE` (platform difference < 0): debit COMMISSION_REVENUE, credit UNION_RECEIVABLE. */
export function platformDecrease(o: SeededOrder, amount: bigint, seq: number): string[] {
  const key = platformAdjKey(o, seq);
  return [
    `${key}|COMMISSION_REVENUE|platform|${String(amount)}`,
    `${key}|UNION_RECEIVABLE:${o.platform}|platform|${String(-amount)}`,
  ];
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'approve' | 'reject';

const OPERATIONS: Readonly<
  Record<Operation, { readonly path: string; readonly method: 'get' | 'post' }>
> = {
  list: { path: LIST_PATH, method: 'get' },
  approve: { path: APPROVE_PATH, method: 'post' },
  reject: { path: REJECT_PATH, method: 'post' },
};

const HTTP_STATUS: Readonly<Record<number, number>> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
};

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface Sent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface Caller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface SendOptions {
  /** The caller: `adjuster` by default; null sends no token. */
  readonly caller?: Caller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
}

export interface AdjustAdmin {
  /** The entry's field cipher. */
  readonly crypto: FieldCrypto;
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<Caller>;
  stepUp(caller: Caller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST …/{batch_id}/approve with `body` (default `{}`). */
  approve(batchId: string, options?: SendOptions & { readonly body?: unknown }): Promise<Sent>;
  /** POST …/{batch_id}/reject with `body`. */
  reject(batchId: string, body: unknown, options?: SendOptions): Promise<Sent>;
  /** GET /admin/v1/settle-adjustments with the query, as `adjuster` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: Caller | null): Promise<Sent>;
  /** Stores a synthetic phone for the user as identity does; returns its 3 + 4 mask. */
  setPhone(userId: string): Promise<string>;
  /** A verified realname record whose decrypted birth date makes the user a minor (BR-ID-26). */
  markMinor(userId: string): Promise<void>;
  /** An account with fund.settle_adjust only. */
  readonly adjuster: Caller;
  /** An account with fund.view only. */
  readonly viewer: Caller;
}

export interface AdminOptions {
  /** Wraps the admin entry's executor (fault injection); the pool stays ADMIN_POOL connections. */
  readonly wrap?: (db: Kysely<DB>) => Kysely<DB>;
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

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `sz_${randomBytes(12).toString('hex')}`;
}

let phoneSerial = 0;

/**
 * Runs `body` against a started admin entry on the harness' app and clock, the file's database
 * (a pool of ADMIN_POOL connections of its own) and Redis.
 */
export async function withAdmin(
  s: ApproveSuite,
  h: ApproveHarness,
  body: (a: AdjustAdmin) => Promise<void>,
  options: AdminOptions = {},
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
  const seed = s.db;
  const appId = h.appId;
  const clock = h.clock;
  const pool = createDb({ connectionString: s.url, max: ADMIN_POOL });
  const executor = options.wrap === undefined ? pool : options.wrap(pool);
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09zc-'));
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
        JWT_KEY_ID: 'b2_09zc_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: executor, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: s.redisUrl,
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);

    const caller: AdjustAdmin['caller'] = async (permissions, opts = {}) => {
      const id = randomUUID();
      await seed
        .insertInto('admin_users')
        .values({
          id,
          app_id: appId,
          login_name: `szadj_${id}`,
          password_hash: 'unused-test-login',
          is_super: opts.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: clock.now(),
          created_at: clock.now(),
          updated_at: clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await seed
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock }).issue({
        adminId: id,
        appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: AdjustAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const adjuster = await caller([ADJUST]);
    const viewer = await caller([VIEW]);

    const post = async (
      op: 'approve' | 'reject',
      batchId: string,
      payload: unknown,
      opts: SendOptions,
    ): Promise<Sent> => {
      const who = opts.caller === undefined ? adjuster : opts.caller;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-trace-id': randomUUID(),
      };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      if (opts.key !== null) headers['idempotency-key'] = opts.key ?? newKey();
      const token =
        opts.stepUp !== undefined ? opts.stepUp : who === null ? null : await stepUp(who);
      if (token !== null) headers['x-step-up-token'] = token;
      const url = `/admin/v1/settle-adjust-batches/${encodeURIComponent(batchId)}/${op}`;
      const response = await server.inject({
        method: 'POST',
        url,
        headers,
        payload: JSON.stringify(payload),
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };

    const list: AdjustAdmin['list'] = async (query, who) => {
      const actor = who === undefined ? adjuster : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const search = new URLSearchParams(query ?? {}).toString();
      const response = await server.inject({
        method: 'GET',
        url: search === '' ? LIST_PATH : `${LIST_PATH}?${search}`,
        headers,
        remoteAddress: '127.0.0.1',
      });
      return {
        op: 'list',
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };

    const setPhone: AdjustAdmin['setPhone'] = async (userId) => {
      phoneSerial += 1;
      const phone = `139${String(phoneSerial).padStart(8, '0')}`;
      await seed
        .updateTable('users')
        .set({
          phone_cipher: Buffer.from(crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8'),
          phone_hmac: crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT),
        })
        .where('app_id', '=', appId)
        .where('id', '=', userId)
        .execute();
      return `${phone.slice(0, 3)}****${phone.slice(7)}`;
    };

    const markMinor: AdjustAdmin['markMinor'] = async (userId) => {
      await seed
        .insertInto('realname')
        .values({
          id: randomUUID(),
          app_id: appId,
          user_id: userId,
          name_cipher: Buffer.from(crypto.encrypt('合成姓名', REALNAME_CONTEXT.name), 'utf8'),
          id_no_cipher: Buffer.from(
            crypto.encrypt('000000202001010000', REALNAME_CONTEXT.idNo),
            'utf8',
          ),
          id_no_hmac: randomBytes(32).toString('hex'),
          birth_date_cipher: Buffer.from(
            crypto.encrypt('2020-01-01', REALNAME_CONTEXT.birthDate),
            'utf8',
          ),
          status: 'verified',
          provider: 'synthetic',
          verified_at: new Date(BEFORE),
        })
        .execute();
    };

    await body({
      crypto,
      caller,
      stepUp,
      approve(batchId, opts = {}) {
        return post('approve', batchId, opts.body === undefined ? {} : opts.body, opts);
      },
      reject(batchId, payload, opts = {}) {
        return post('reject', batchId, payload, opts);
      },
      list,
      setPhone,
      markMinor,
      adjuster,
      viewer,
    });
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await destroyDb(pool);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Answers.

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: Sent): Promise<void> {
  const { path, method } = OPERATIONS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
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
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

export type Outcome =
  'approved' | 'approved_zero' | 'voided_stale_seq' | 'voided_by_clawback' | 'already_decided';

export interface OrderResult {
  readonly order_id: string;
  readonly outcome: Outcome;
  readonly credited_fen: number;
}

export interface ApproveData {
  readonly batch_id: string;
  readonly results: OrderResult[];
}

function byOrder(results: readonly OrderResult[]): OrderResult[] {
  return [...results].sort((a, b) =>
    a.order_id < b.order_id ? -1 : a.order_id > b.order_id ? 1 : 0,
  );
}

/** The data of a successful approval, its results ordered by order_id. */
export async function approvedData(sent: Sent): Promise<ApproveData> {
  const body = await answer(sent, 0);
  const data = body.data as ApproveData;
  expect(Array.isArray(data.results), sent.body).toBe(true);
  return { batch_id: data.batch_id, results: byOrder(data.results) };
}

/** A successful approval of `batchId` answering exactly these results (any order). */
export async function expectApproved(
  sent: Sent,
  batchId: string,
  results: readonly OrderResult[],
): Promise<ApproveData> {
  const data = await approvedData(sent);
  expect(data).toEqual({ batch_id: batchId, results: byOrder(results) });
  return data;
}

export function result(o: SeededOrder, outcome: Outcome, creditedFen = 0): OrderResult {
  return { order_id: o.orderId, outcome, credited_fen: creditedFen };
}

// ---------------------------------------------------------------------------------------------
// Audit.

/** The stored record's target, before and after as one text (bigint as digits). */
export function recordText(record: {
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): string {
  return text([record.target, record.before, record.after]);
}

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const INSTANT_TEXT = /\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?/g;

/**
 * `amount` appears in `haystack` as a whole number of its own: ids (UUIDs, order keys) and
 * instants are taken out first, and a digit run next to a letter or digit does not count.
 */
export function mentionsAmount(haystack: string, amount: number | bigint): boolean {
  const scrubbed = haystack.replace(UUID_TEXT, ' ').replace(INSTANT_TEXT, ' ');
  return new RegExp(`(?<![0-9A-Za-z])${String(amount)}(?![0-9A-Za-z])`).test(scrubbed);
}

/** The audit view derives target_type settle_adjust_batch, the batch id and fund.settle_adjust. */
export function expectDerived(
  record: { readonly action: string; readonly target: string | null; readonly after: unknown },
  batchId: string,
): void {
  expect(deriveAudit(record, new Map())).toEqual({
    targetType: BATCH_TARGET_TYPE,
    targetId: batchId,
    permission: ADJUST,
  });
}

/** Rejects when `work` has not settled within `ms` (a pool deadlock shows as this, not a hang). */
export async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${String(ms)} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Epoch milliseconds of a response instant (null stays null). */
export function instant(value: unknown): number | null {
  if (value === null) return null;
  expect(typeof value, String(value)).toBe('string');
  return Date.parse(value as string);
}

// ---------------------------------------------------------------------------------------------
// A read barrier for real races (added in attempt 3, spec-test review r1).

/** Which held read goes on first once both reads arrived. */
export type ReleaseOrder = 'arrival' | 'reverse';

export interface ReadBarrier {
  /** The admin entry's executor with the barrier (pass it as AdminOptions.wrap's result). */
  readonly db: Kysely<DB>;
  /** Reads held at the barrier (2: both calls had read the candidates before either went on). */
  arrivals(): number;
}

const SETTLE_ADJUSTMENTS_READ = /\bfrom\s+(?:"?app"?\.)?"?settle_adjustments"?/i;

/**
 * Holds the first select on settle_adjustments that returns rows (PostgreSQL has run it, so the
 * call holds what it read) until a second such select returned too, then lets the two go on in
 * `release` order, `gapMs` apart. A held call issues nothing else meanwhile (its code awaits the
 * read), so the second arrival is the other call. When no second read arrives within `waitMs`
 * (an implementation that reads only under the order's lock, so the other call waits on that
 * lock), the held read goes on alone. Later reads pass through.
 */
export function readBarrier(
  db: Kysely<DB>,
  release: ReleaseOrder,
  options: { readonly waitMs?: number; readonly gapMs?: number } = {},
): ReadBarrier {
  const waitMs = options.waitMs ?? 5_000;
  const gapMs = options.gapMs ?? 150;
  const watched = new Set<QueryId>();
  const held: (() => void)[] = [];
  let arrived = 0;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = (): void => {
    if (opened) return;
    opened = true;
    if (timer !== undefined) clearTimeout(timer);
    const order = release === 'arrival' ? [...held] : [...held].reverse();
    for (const [index, go] of order.entries()) setTimeout(go, index * gapMs);
  };
  const barred = db.withPlugin({
    transformQuery(args) {
      // Builder selects and raw `SELECT …` statements alike.
      if (
        !opened &&
        arrived < 2 &&
        (args.node.kind === 'SelectQueryNode' || args.node.kind === 'RawNode')
      ) {
        const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        if (/^\s*select\b/i.test(compiled.sql) && SETTLE_ADJUSTMENTS_READ.test(compiled.sql)) {
          watched.add(args.queryId);
        }
      }
      return args.node;
    },
    async transformResult(args) {
      if (!watched.delete(args.queryId)) return args.result;
      if (opened || arrived >= 2 || args.result.rows.length === 0) return args.result;
      arrived += 1;
      const gate = new Promise<void>((resolve) => {
        held.push(resolve);
      });
      if (arrived === 1) timer = setTimeout(open, waitMs);
      else open();
      await gate;
      return args.result;
    },
  });
  return { db: barred, arrivals: () => arrived };
}
