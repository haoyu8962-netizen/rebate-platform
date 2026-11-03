// B2-04zs rule-test kit (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminGetFundLedger (GET /admin/v1/fund-ledger) and AdminFundLedger; 08 BR-FUND-20, BR-WDR-18;
// 编排裁定 D10-589. fund.view or a super admin, read only, no step-up, no audit; computed when read
// from all the posted entries (no accounting-day cut), limited to the console's app.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation), ledger, POST /admin/v1/union-receipts and its
// reversal (B2-04zr), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions.
// Synthetic: receivables and member balances posted directly through the real ledger; admin accounts;
// payout_watermarks rows (the W entry belongs to the withdraw lane, so rows are written as it would)
// and withdrawals rows (states outside this task are not produced by a fake command). No real user
// or merchant data. Expected amounts are written by hand in the tests. Missing pieces fail as
// assertions (an unregistered admin route answers 404).
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
import type { PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
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
  CASH_ENTRY,
  REASON,
  VIEW,
  entryBody,
  newKey,
  type AdminCaller,
  type AdminSent,
  type ReceiptFixture,
} from '../../settlement/admin-union-receipts/kit.ts';
import { contractPaths, member } from '../admin-recon-close/kit.ts';

export {
  CASH_ENTRY,
  VIEW,
  audits,
  entryBody,
  everything,
  fixture,
  idOf,
  receiptOf,
  seedReceivable,
  suite,
} from '../../settlement/admin-union-receipts/kit.ts';

export const PATH = '/admin/v1/fund-ledger';
export const OPERATION_ID = 'adminGetFundLedger';
/** The fixture's default clock: 2026-10-29 16:00 +08:00; today starts at 2026-10-28T16:00:00Z. */
export const NOW = '2026-10-29T08:00:00.000Z';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Members and their balances, posted through the real ledger. The other side is always
// COMMISSION_REVENUE, so nothing here moves a UNION_RECEIVABLE subject.

export interface Member {
  readonly userId: string;
  readonly accountId: string;
}

/** A member of the fixture's app with an open account and no entries. */
export async function openMember(f: ReceiptFixture): Promise<Member> {
  const userId = await member(f);
  const account = await f.db
    .transaction()
    .execute((trx) => f.ledger.openUserAccount(trx, { appId: f.appId, userId }));
  return { userId, accountId: account.account_id };
}

async function post(
  f: ReceiptFixture,
  who: Member,
  entries: readonly PostingEntry[],
): Promise<void> {
  const id = randomUUID();
  await f.db.transaction().execute(async (trx) => {
    await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [who.userId] });
    await f.ledger.post(trx, {
      appId: f.appId,
      uniqKey: `fixture:${id}`,
      bizType: 'FIXTURE',
      bizId: id,
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
  });
}

function userLine(
  who: Member,
  subAccount: 'available' | 'frozen',
  amount: bigint,
  type: string,
): PostingEntry {
  return {
    account: { ownerType: 'user', accountId: who.accountId },
    sub_account: subAccount,
    amount_fen: amount,
    ledger_type: type,
    sub_type: null,
    income_type: 'SERVICE_FEE',
  };
}

function revenueLine(amount: bigint, type: string): PostingEntry {
  return {
    account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: type,
    sub_type: null,
    income_type: null,
  };
}

/** Raises the member's available by `fen` (a user entry is debit positive, so −fen). */
export function credit(f: ReceiptFixture, who: Member, fen: bigint): Promise<void> {
  return post(f, who, [
    userLine(who, 'available', -fen, 'REBATE_CREDIT'),
    revenueLine(fen, 'REBATE_CREDIT'),
  ]);
}

/** Lowers the member's available by `fen`; CLAWBACK may end below zero (BR-FUND-10). */
export function clawback(f: ReceiptFixture, who: Member, fen: bigint): Promise<void> {
  return post(f, who, [userLine(who, 'available', fen, 'CLAWBACK'), revenueLine(-fen, 'CLAWBACK')]);
}

/** Moves `fen` from the member's available to their frozen sub-account. */
export function freeze(f: ReceiptFixture, who: Member, fen: bigint): Promise<void> {
  return post(f, who, [
    userLine(who, 'available', fen, 'WITHDRAW_FREEZE'),
    userLine(who, 'frozen', -fen, 'WITHDRAW_FREEZE'),
  ]);
}

/** Overwrites the balance cache of the member (the entries stay as they are). */
export async function tamperCache(f: ReceiptFixture, who: Member, availableFen: bigint) {
  await sql`UPDATE app.account_balances SET available_fen = ${availableFen}
    WHERE app_id = ${f.appId} AND account_id = ${who.accountId}`.execute(f.db);
}

// ---------------------------------------------------------------------------------------------
// Admin accounts that are not callers, and W.

export interface SeededAdmin {
  readonly id: string;
  readonly loginName: string;
}

/** An admin account of the app (the fixture's by default) that only appears as entered_by. */
export async function seedAdmin(
  f: ReceiptFixture,
  options: { readonly displayName?: string; readonly appId?: string } = {},
): Promise<SeededAdmin> {
  const id = randomUUID();
  const loginName = `fl_${id}`;
  await f.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: options.appId ?? f.appId,
      login_name: loginName,
      display_name: options.displayName ?? null,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_bound_at: f.clock.now(),
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return { id, loginName };
}

export type Channel = 'alipay' | 'bank_card' | 'wechat';

export interface WatermarkSeed {
  readonly fen: bigint;
  /** How long before the fixture's clock W was read (default 30 minutes). */
  readonly ageMs?: number;
  readonly channel?: Channel;
  /** payout_watermarks.entered_by is free text (default a synthetic non-admin value). */
  readonly enteredBy?: string;
}

/** One payout_watermarks row of the fixture's app; returns its measured_at in epoch milliseconds. */
export async function seedWatermark(f: ReceiptFixture, seed: WatermarkSeed): Promise<number> {
  const measuredAt = new Date(f.clock.now().getTime() - (seed.ageMs ?? 30 * MINUTE));
  await sql`INSERT INTO app.payout_watermarks
      (id, app_id, channel, available_fen, measured_at, entered_by)
    VALUES (${randomUUID()}, ${f.appId}, ${seed.channel ?? 'alipay'}, ${seed.fen}, ${measuredAt},
      ${seed.enteredBy ?? 'finance:synthetic'})`.execute(f.db);
  return measuredAt.getTime();
}

export interface WithdrawalSeed {
  /** amount_fen, the amount P is computed from (BR-WDR-18). */
  readonly amountFen: bigint;
  /** created_at: when the withdrawal was applied for. */
  readonly createdAt: string;
  /** updated_at, and paid_at of a paid row: when it last moved (default createdAt). */
  readonly updatedAt?: string;
  readonly channel?: Channel;
  readonly status?:
    'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED' | 'REJECTED';
  /** net_fen = amount_fen − fee_fen. */
  readonly feeFen?: bigint;
}

/** One withdrawals row of the fixture's app, of a fresh member. */
export async function seedWithdrawal(f: ReceiptFixture, seed: WithdrawalSeed): Promise<void> {
  const owner = await member(f);
  const channel = seed.channel ?? 'alipay';
  const status = seed.status ?? 'APPROVED';
  const fee = seed.feeFen ?? 0n;
  const createdAt = new Date(seed.createdAt);
  const updatedAt = seed.updatedAt === undefined ? createdAt : new Date(seed.updatedAt);
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  const manual = status === 'PAID_MANUAL';
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, wechat_app_id, status, out_biz_no,
       payout_channel, reject_reason_code, paid_at, manual_entry_by, manual_confirm_by,
       created_at, updated_at)
    VALUES (${randomUUID()}, ${f.appId}, ${owner}, ${seed.amountFen}, ${fee}, ${0n},
      ${seed.amountFen - fee}, 'SERVICE_FEE', ${channel}, '合成姓名',
      ${Buffer.from('synthetic-encrypted-account')}, ${randomBytes(32).toString('hex')},
      ${channel === 'bank_card' ? '合成银行' : null}, ${channel === 'wechat' ? 'wx_synthetic' : null},
      ${status}, ${randomBytes(16).toString('hex')}, ${channel},
      ${status === 'REJECTED' ? 'OTHER' : null}, ${paid ? updatedAt : null},
      ${manual ? randomUUID() : null}, ${manual ? randomUUID() : null},
      ${createdAt}, ${updatedAt})`.execute(f.db);
}

/**
 * Seven-day applications of ¥49,000 (BR-WDR-18 例), one row of the alipay channel in the middle of
 * the window of the default clock, so P = 700,000 × 3 = 2,100,000.
 */
export function seedForecastOf2100000(f: ReceiptFixture): Promise<void> {
  return seedWithdrawal(f, { amountFen: 4_900_000n, createdAt: '2026-10-25T04:00:00.000Z' });
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

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

export interface FundAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean; readonly displayName?: string },
  ): Promise<AdminCaller>;
  /**
   * GET /admin/v1/fund-ledger without a step-up token, as `who`; a fresh fund.view account at the
   * fixture's current clock by default; null sends no token.
   */
  read(who?: AdminCaller | null): Promise<Sent>;
  /** POST /admin/v1/union-receipts by a fresh fund.cash_entry account with its step-up token. */
  create(body?: unknown): Promise<AdminSent>;
  /** POST /admin/v1/union-receipts/{receipt_id}/reverse, likewise. */
  reverse(receiptId: string): Promise<AdminSent>;
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
export async function withFundAdmin(
  f: ReceiptFixture,
  run: (h: FundAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-04zs-'));
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
        JWT_KEY_ID: 'b2_04zs_test',
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
    const caller: FundAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      const loginName = `fl_${id}`;
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
      return { id, token, sessionId: claims.sessionId, loginName, displayName };
    };
    const write = async (
      op: 'create' | 'reverse',
      url: string,
      body: unknown,
    ): Promise<AdminSent> => {
      const who = await caller([CASH_ENTRY]);
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier: 'totp' });
      const response = await server.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
          authorization: `Bearer ${who.token}`,
          'idempotency-key': newKey(),
          'x-step-up-token': grant.step_up_token,
        },
        payload: JSON.stringify(body),
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
      caller,
      async read(who) {
        const actor = who === undefined ? await caller([VIEW]) : who;
        const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
        const response = await server.inject({
          method: 'GET',
          url: PATH,
          headers,
          remoteAddress: '127.0.0.1',
        });
        return {
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
      },
      create(body = entryBody()) {
        return write('create', '/admin/v1/union-receipts', body);
      },
      reverse(receiptId) {
        const url = `/admin/v1/union-receipts/${encodeURIComponent(receiptId)}/reverse`;
        return write('reverse', url, { reason: REASON });
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

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: Sent): Promise<void> {
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
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** The 10403 of an account without the permission point. */
export function denied(sent: Sent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

export interface ShownWatermark {
  readonly available_fen: number;
  readonly measured_at: string;
  readonly entered_by: string | null;
  readonly entered_by_name: string | null;
}

export interface Overview {
  readonly as_of: string;
  readonly receivables: readonly {
    readonly platform: string;
    readonly union_receivable_fen: number;
  }[];
  readonly union_receivable_total_fen: number;
  readonly negative_total_fen: number;
  readonly negative_user_count: number;
  readonly watermark: ShownWatermark | null;
  readonly forecast_withdrawal_fen: number | null;
  readonly water_level: string | null;
}

/** The data of a successful read (200, code 0, the contract schema). */
export async function overview(sent: Sent): Promise<Overview> {
  const body = await answer(sent, 0);
  return body.data as Overview;
}

/** The watermark of a reading with measured_at as epoch milliseconds; null when there is none. */
export function watermarkOf(view: Overview) {
  const shown = view.watermark;
  return shown === null ? null : { ...shown, measured_at: Date.parse(shown.measured_at) };
}

/** A watermark as the reading must show it when no admin of the app entered it. */
export function byNobody(fen: number, measuredAt: number) {
  return { available_fen: fen, measured_at: measuredAt, entered_by: null, entered_by_name: null };
}

/** The water-level part of a reading, in one value. */
export function levelOf(view: Overview) {
  return {
    available_fen: view.watermark === null ? null : view.watermark.available_fen,
    forecast_withdrawal_fen: view.forecast_withdrawal_fen,
    water_level: view.water_level,
  };
}
