// B2-02u rule-test kit (claude-independent, SPEC_REF 39756e36): contracts/openapi.yaml
// adminGetUserFundSummary (GET /admin/v1/users/{user_id}/fund-summary) and adminListLedgerEntries
// (GET /admin/v1/ledger); 08 BR-FUND-13, BR-FUND-15, BR-FUND-16, BR-FUND-18; 编排裁定 D10-1057.
// fund.view or user.lookup (either one, or a super admin), read only, no step-up, no audit; the two
// points get the same shape and the same values; no internal notes in any answer.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), ledger (accounts and vouchers posted through the real posting port),
// PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions.
// Synthetic: users, admin accounts, withdrawals rows and withdraw_holds rows written directly (their
// writers belong to other lanes), and the balance cache overwritten where a test needs it to differ
// from the entries. No real user or merchant data. Missing pieces fail as assertions (an
// unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
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
import type { ReceiptFixture } from '../../settlement/admin-union-receipts/kit.ts';
import { contractPaths } from '../admin-recon-close/kit.ts';

export { audits, fixture, openMember, suite, type Member } from '../admin-fund-ledger/kit.ts';
export { member, seedHold } from '../admin-recon-close/kit.ts';
export type { ReceiptFixture as Fixture } from '../../settlement/admin-union-receipts/kit.ts';

export const SUMMARY_PATH = '/admin/v1/users/{user_id}/fund-summary';
export const LEDGER_PATH = '/admin/v1/ledger';
/** specs/permissions.yaml: both read points, step-up null. */
export const VIEW = 'fund.view';
export const LOOKUP = 'user.lookup';
/** Keys no answer may carry at any depth (D10-1057 ①: 不含内部备注). */
export const HIDDEN_KEYS = ['memo', 'operator', 'note', 'reject_note', 'source_ref', 'created_by'];

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Vouchers through the real ledger. The platform side is COMMISSION_REVENUE unless given.

export interface Owner {
  readonly userId: string;
  readonly accountId: string;
}

export interface UserLine {
  readonly sub: 'available' | 'frozen';
  /** Storage sign: a user entry is debit positive, so a credit to the user is negative. */
  readonly fen: bigint;
}

export interface VoucherSeed {
  readonly ledgerType: string;
  readonly subType?: string | null;
  readonly lines: readonly UserLine[];
  readonly bizType?: string;
  readonly bizId?: string;
  readonly uniqKey?: string;
  readonly operator?: string;
  readonly memo?: string | null;
}

export interface Posted {
  readonly voucherId: string;
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
}

/** One voucher of `who` on the fixture's clock: the user lines, then the platform balancing line. */
export async function post(f: ReceiptFixture, who: Owner, seed: VoucherSeed): Promise<Posted> {
  const bizId = seed.bizId ?? randomUUID();
  const bizType = seed.bizType ?? 'FIXTURE';
  const uniqKey = seed.uniqKey ?? `fixture:${randomUUID()}`;
  const subType = seed.subType ?? null;
  const entries: PostingEntry[] = seed.lines.map((line): PostingEntry => ({
    account: { ownerType: 'user', accountId: who.accountId },
    sub_account: line.sub,
    amount_fen: line.fen,
    ledger_type: seed.ledgerType,
    sub_type: subType,
    income_type: 'SERVICE_FEE',
  }));
  const net = seed.lines.reduce((sum, line) => sum + line.fen, 0n);
  if (net !== 0n) {
    entries.push({
      account: { ownerType: 'platform', subject: 'COMMISSION_REVENUE' },
      sub_account: 'available',
      amount_fen: -net,
      ledger_type: seed.ledgerType,
      sub_type: subType,
      income_type: null,
    });
  }
  const result = await f.db.transaction().execute(async (trx) => {
    await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [who.userId] });
    return f.ledger.post(trx, {
      appId: f.appId,
      uniqKey,
      bizType,
      bizId,
      operator: seed.operator ?? 'system',
      memo: seed.memo ?? null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
  });
  expect(result.kind).toBe('posted');
  return { voucherId: result.voucherId, uniqKey, bizType, bizId };
}

/** Raises the user's available by `fen` (REBATE_CREDIT unless given). */
export function credit(
  f: ReceiptFixture,
  who: Owner,
  fen: bigint,
  seed: Partial<VoucherSeed> = {},
): Promise<Posted> {
  return post(f, who, {
    ledgerType: 'REBATE_CREDIT',
    ...seed,
    lines: [{ sub: 'available', fen: -fen }],
  });
}

/** Overwrites the user's balance cache row (the entries stay as they are). */
export async function setCache(
  f: ReceiptFixture,
  who: Owner,
  cache: {
    readonly available: bigint;
    readonly frozen: bigint;
    readonly negativeSince: string | null;
  },
): Promise<void> {
  await sql`UPDATE app.account_balances
    SET available_fen = ${cache.available}, frozen_fen = ${cache.frozen},
      negative_since = ${cache.negativeSince}::date
    WHERE app_id = ${f.appId} AND account_id = ${who.accountId}`.execute(f.db);
}

/** The user's entries of one voucher, as the admin ledger must show them, entry_id descending. */
export async function shown(
  f: ReceiptFixture,
  who: Owner,
  voucher: Posted,
  link: { readonly type: string; readonly id: string } | null,
): Promise<Record<string, unknown>[]> {
  const rows = await sql<{
    id: string;
    booked_at: Date;
    day: string;
    ledger_type: string;
    sub_type: string | null;
    sub_account: string;
    amount_fen: string;
    balance_after_fen: string | null;
    voucher_id: string;
    uniq_key: string;
    biz_type: string;
    biz_id: string;
  }>`SELECT e.id::text AS id, e.booked_at, v.accounting_date::text AS day, e.ledger_type,
      e.sub_type, e.sub_account, e.amount_fen::text AS amount_fen,
      e.balance_after_fen::text AS balance_after_fen, v.id::text AS voucher_id, v.uniq_key,
      v.biz_type, v.biz_id
    FROM app.ledger_entries e
    JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
    WHERE e.app_id = ${f.appId} AND e.account_id = ${who.accountId}
      AND v.id = ${voucher.voucherId}`.execute(f.db);
  expect(rows.rows.length, `entries of ${voucher.uniqKey}`).toBeGreaterThan(0);
  return [...rows.rows]
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0))
    .map((row) => ({
      entry_id: row.id,
      booked_at: row.booked_at.getTime(),
      accounting_date: row.day,
      ledger_type: row.ledger_type,
      sub_type: row.sub_type,
      sub_account: row.sub_account,
      // User view: the stored entry is debit positive on a liability, so the user sees −amount.
      amount_fen: -Number(row.amount_fen),
      balance_after_fen: row.balance_after_fen === null ? null : Number(row.balance_after_fen),
      voucher: {
        voucher_id: row.voucher_id,
        uniq_key: row.uniq_key,
        biz_type: row.biz_type,
        biz_id: row.biz_id,
      },
      link,
    }));
}

// ---------------------------------------------------------------------------------------------
// Withdrawals (payout's table) written directly.

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED' | 'REJECTED';

/** Fee and tax of a withdrawals row; net_fen = amount − fee − tax (the table's check). */
export interface Charges {
  readonly feeFen: bigint;
  readonly taxFen: bigint;
}

/** One withdrawals row of `userId` in the fixture's app; returns its id. */
export async function seedWithdrawal(
  f: ReceiptFixture,
  userId: string,
  amountFen: bigint,
  status: WithdrawalStatus,
  rejectNote: string | null = null,
  charges: Charges = { feeFen: 0n, taxFen: 0n },
): Promise<string> {
  const id = randomUUID();
  const paid = status === 'PAID_API' || status === 'PAID_MANUAL';
  const manual = status === 'PAID_MANUAL';
  const now = f.clock.now();
  const netFen = amountFen - charges.feeFen - charges.taxFen;
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, wechat_app_id, status, out_biz_no,
       payout_channel, reject_reason_code, reject_note, paid_at, manual_entry_by,
       manual_confirm_by, created_at, updated_at)
    VALUES (${id}, ${f.appId}, ${userId}, ${amountFen}, ${charges.feeFen}, ${charges.taxFen},
      ${netFen},
      'SERVICE_FEE', 'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
      ${randomBytes(32).toString('hex')}, ${null}, ${null}, ${status},
      ${randomBytes(16).toString('hex')}, 'alipay', ${status === 'REJECTED' ? 'OTHER' : null},
      ${rejectNote}, ${paid ? now : null}, ${manual ? randomUUID() : null},
      ${manual ? randomUUID() : null}, ${now}, ${now})`.execute(f.db);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Before / after.

/** Every row of the app these reads must never write. */
export async function books(f: ReceiptFixture) {
  const all = async (table: string, order: string) =>
    (
      await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}
        WHERE app_id = ${f.appId} ORDER BY ${sql.ref(order)}`.execute(f.db)
    ).rows;
  return {
    vouchers: await all('ledger_vouchers', 'id'),
    entries: await all('ledger_entries', 'id'),
    accounts: await all('ledger_accounts', 'id'),
    balances: await all('account_balances', 'account_id'),
    holds: await all('withdraw_holds', 'id'),
    withdrawals: await all('withdrawals', 'id'),
    audits: await all('audit_logs', 'id'),
  };
}

/** Every object key anywhere in a JSON value. */
export function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysDeep(item, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'summary' | 'ledger';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface Sent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
  json(): Envelope;
}

export interface Caller {
  readonly id: string;
  readonly token: string;
}

export interface LedgerAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<Caller>;
  /** GET /admin/v1/users/{user_id}/fund-summary as `who` (fund.view by default; null: no token). */
  summary(userId: string, who?: Caller | null): Promise<Sent>;
  /** GET /admin/v1/ledger with the query as `who` (fund.view by default; null: no token). */
  ledger(query: Record<string, string>, who?: Caller | null): Promise<Sent>;
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
  }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withLedgerAdmin(
  f: ReceiptFixture,
  run: (h: LedgerAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-02u-'));
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
        JWT_KEY_ID: 'b2_02u_test',
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
    const caller: LedgerAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `lr_${id}`,
          display_name: null,
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
      return { id, token };
    };
    const get = async (op: Operation, url: string, who: Caller | null | undefined) => {
      const actor = who === undefined ? await caller([VIEW]) : who;
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
        headers: response.headers,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      caller,
      summary(userId, who) {
        return get('summary', `/admin/v1/users/${encodeURIComponent(userId)}/fund-summary`, who);
      },
      ledger(query, who) {
        const text = new URLSearchParams(query).toString();
        return get('ledger', text === '' ? LEDGER_PATH : `${LEDGER_PATH}?${text}`, who);
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

const PATHS: Record<Operation, string> = { summary: SUMMARY_PATH, ledger: LEDGER_PATH };

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: Sent): Promise<void> {
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
export async function answer(sent: Sent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** A successful read: 200, code 0, the schema, Cache-Control: no-store; returns data. */
export async function ok(sent: Sent): Promise<unknown> {
  const body = await answer(sent, 0);
  expect(sent.headers['cache-control'], sent.body).toBe('no-store');
  return body.data;
}

/** The 10403 of an account holding neither point. */
export function denied(sent: Sent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 20001 naming exactly these fields. */
export function fieldsError(sent: Sent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

export interface LedgerPage {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** A successful ledger page, booked_at of each item as epoch milliseconds. */
export async function pageOf(sent: Sent): Promise<LedgerPage> {
  const data = (await ok(sent)) as LedgerPage;
  expect(Array.isArray(data.items), sent.body).toBe(true);
  return {
    ...data,
    items: data.items.map((item) => {
      const at = item['booked_at'];
      return { ...item, booked_at: typeof at === 'string' ? Date.parse(at) : at };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// One member's books over three accounting days (+08:00), with a neighbour in the same app.

/** The fixture's default clock (2026-10-29 16:00 +08:00), where every request is sent. */
export const NOW = '2026-10-29T08:00:00.000Z';
/** 2026-10-27 10:00 +08:00. */
export const AT_1 = '2026-10-27T02:00:00.000Z';
/** 2026-10-28 11:00 +08:00. */
export const AT_2 = '2026-10-28T03:00:00.000Z';
/** 2026-10-28 13:00 +08:00. */
export const AT_3 = '2026-10-28T05:00:00.000Z';
/** 2026-10-29 09:00 +08:00 (two vouchers at this same instant). */
export const AT_4 = '2026-10-29T01:00:00.000Z';

/** Internal texts the books carry; none may reach an answer. */
export const INTERNAL_TEXT = 'b202u-internal';

export interface Story {
  readonly a: Owner;
  readonly b: Owner;
  /** REBATE_CREDIT +1000 on 2026-10-27 (biz FIXTURE). */
  readonly v1: Posted;
  /** REFERRAL_CREDIT / DIRECT +300 on 2026-10-28 (biz FIXTURE). */
  readonly v2: Posted;
  /** WITHDRAW_FREEZE 500, available → frozen, on 2026-10-28 (biz withdrawal). */
  readonly v3: Posted;
  /** ADMIN_ADJUST +200 on 2026-10-29 with an internal memo and operator (biz admin_adjustment). */
  readonly v4: Posted;
  /** CLAWBACK / FULL −100 on 2026-10-29, the same instant as v4 (biz FIXTURE). */
  readonly v5: Posted;
}

/** Posts the story, then puts the clock back at NOW. */
export async function seedStory(f: ReceiptFixture, owners: { a: Owner; b: Owner }): Promise<Story> {
  const { a, b } = owners;
  f.clock.set(AT_1);
  const v1 = await credit(f, a, 1_000n);
  f.clock.set(AT_2);
  const v2 = await credit(f, a, 300n, { ledgerType: 'REFERRAL_CREDIT', subType: 'DIRECT' });
  await credit(f, b, 700n);
  f.clock.set(AT_3);
  const withdrawalId = randomUUID();
  const v3 = await post(f, a, {
    ledgerType: 'WITHDRAW_FREEZE',
    lines: [
      { sub: 'available', fen: 500n },
      { sub: 'frozen', fen: -500n },
    ],
    bizType: 'withdrawal',
    bizId: withdrawalId,
    uniqKey: `WITHDRAW_FREEZE:${withdrawalId}`,
  });
  f.clock.set(AT_4);
  const adjustId = randomUUID();
  const v4 = await credit(f, a, 200n, {
    ledgerType: 'ADMIN_ADJUST',
    bizType: 'admin_adjustment',
    bizId: adjustId,
    uniqKey: `ADJ:${adjustId}`,
    operator: `admin:${INTERNAL_TEXT}-operator`,
    memo: `${INTERNAL_TEXT}-memo`,
  });
  const v5 = await post(f, a, {
    ledgerType: 'CLAWBACK',
    subType: 'FULL',
    lines: [{ sub: 'available', fen: 100n }],
  });
  f.clock.set(NOW);
  return { a, b, v1, v2, v3, v4, v5 };
}

/** The entries of each story voucher as the admin ledger must show them. */
export async function storyRows(f: ReceiptFixture, story: Story) {
  const { a } = story;
  return {
    v1: await shown(f, a, story.v1, null),
    v2: await shown(f, a, story.v2, null),
    v3: await shown(f, a, story.v3, { type: 'withdrawal', id: story.v3.bizId }),
    v4: await shown(f, a, story.v4, { type: 'adjustment', id: story.v4.bizId }),
    v5: await shown(f, a, story.v5, null),
  };
}

// ---------------------------------------------------------------------------------------------
// Every ledger type a user's balance account carries, with the biz_type the ledger's own writers
// put on the voucher: ORDER_CREDIT (settlement/credit), ORDER_CLAWBACK and ORDER_SETTLE_ADJUST
// (settlement/clawback; biz_id = order key), withdrawal (payout; biz_id = withdrawal id),
// admin_adjustment (ledger/admin-adjustment; biz_id = adjustment id), bad_debt_writeoff
// (ledger/bad-debt-writeoff; biz_id = write-off id), INVITE_REWARD (ledger/invite-reward-grant).

/** A synthetic order key of the fixture's app (an order_keys row only): `taobao:{sub_order_id}`. */
export async function seedOrderKey(
  f: ReceiptFixture,
): Promise<{ readonly key: string; readonly orderId: string }> {
  const orderId = randomUUID();
  const subOrderId = `b202u-${orderId}`;
  const at = f.clock.now();
  await sql`INSERT INTO app.order_keys
      (platform, sub_order_id, order_id, app_id, attr_at, created_at)
    VALUES ('taobao', ${subOrderId}, ${orderId}, ${f.appId}, ${at}, ${at})`.execute(f.db);
  return { key: `taobao:${subOrderId}`, orderId };
}

export type Link = { readonly type: string; readonly id: string } | null;

export interface Typed {
  readonly posted: Posted;
  /** The link the admin ledger must give (an order's id here is its order key, see orderIds). */
  readonly link: Link;
}

export interface AllTypes {
  /** In posting order, one minute apart from AT_1 on (2026-10-27 +08:00). */
  readonly vouchers: readonly Typed[];
  /** order_id → order key of the seeded orders. */
  readonly orderIds: ReadonlyMap<string, string>;
}

/** The 13 ledger_type values (contracts/enums/fund.yaml ledger_type, BR-FUND-15). */
export const LEDGER_TYPES = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
];

/**
 * One voucher per user-side movement, all 13 ledger types, on `who`'s balance account; the
 * available sub-account never goes below zero and frozen ends at zero. Puts the clock back at NOW.
 */
export async function seedAllTypes(f: ReceiptFixture, who: Owner): Promise<AllTypes> {
  const k1 = await seedOrderKey(f);
  const k2 = await seedOrderKey(f);
  const k3 = await seedOrderKey(f);
  const w1 = randomUUID();
  const w2 = randomUUID();
  const adjustId = randomUUID();
  const writeoffId = randomUUID();
  const avail = (fen: bigint): UserLine[] => [{ sub: 'available', fen }];
  const frozen = (fen: bigint): UserLine[] => [{ sub: 'frozen', fen }];
  const plan: [VoucherSeed, Link][] = [
    [
      {
        ledgerType: 'REBATE_CREDIT',
        lines: avail(-5_000n),
        bizType: 'ORDER_CREDIT',
        bizId: k1.key,
      },
      { type: 'order', id: k1.key },
    ],
    [
      { ledgerType: 'SHARE_CREDIT', lines: avail(-800n), bizType: 'ORDER_CREDIT', bizId: k2.key },
      { type: 'order', id: k2.key },
    ],
    [{ ledgerType: 'REFERRAL_CREDIT', subType: 'DIRECT', lines: avail(-300n) }, null],
    [{ ledgerType: 'REFERRAL_CREDIT', subType: 'INDIRECT', lines: avail(-120n) }, null],
    [
      { ledgerType: 'REWARD', subType: 'invite', lines: avail(-200n), bizType: 'INVITE_REWARD' },
      null,
    ],
    [
      {
        ledgerType: 'SETTLE_ADJUST',
        subType: 'SETTLE_DIFF',
        lines: avail(-90n),
        bizType: 'ORDER_SETTLE_ADJUST',
        bizId: k3.key,
      },
      { type: 'order', id: k3.key },
    ],
    [
      {
        ledgerType: 'CLAWBACK',
        subType: 'PART_REFUND',
        lines: avail(150n),
        bizType: 'ORDER_CLAWBACK',
        bizId: k2.key,
      },
      { type: 'order', id: k2.key },
    ],
    [
      {
        ledgerType: 'WITHDRAW_FREEZE',
        lines: [
          { sub: 'available', fen: 1_000n },
          { sub: 'frozen', fen: -1_000n },
        ],
        bizType: 'withdrawal',
        bizId: w1,
      },
      { type: 'withdrawal', id: w1 },
    ],
    [
      { ledgerType: 'WITHDRAW_FEE', lines: frozen(20n), bizType: 'withdrawal', bizId: w1 },
      { type: 'withdrawal', id: w1 },
    ],
    [
      { ledgerType: 'TAX_WITHHOLD', lines: frozen(100n), bizType: 'withdrawal', bizId: w1 },
      { type: 'withdrawal', id: w1 },
    ],
    [
      { ledgerType: 'WITHDRAW_PAID', lines: frozen(880n), bizType: 'withdrawal', bizId: w1 },
      { type: 'withdrawal', id: w1 },
    ],
    [
      {
        ledgerType: 'WITHDRAW_FREEZE',
        lines: [
          { sub: 'available', fen: 300n },
          { sub: 'frozen', fen: -300n },
        ],
        bizType: 'withdrawal',
        bizId: w2,
      },
      { type: 'withdrawal', id: w2 },
    ],
    [
      {
        ledgerType: 'WITHDRAW_RETURN',
        lines: [
          { sub: 'frozen', fen: 300n },
          { sub: 'available', fen: -300n },
        ],
        bizType: 'withdrawal',
        bizId: w2,
      },
      { type: 'withdrawal', id: w2 },
    ],
    [
      {
        ledgerType: 'ADMIN_ADJUST',
        subType: 'OTHER',
        lines: avail(-50n),
        bizType: 'admin_adjustment',
        bizId: adjustId,
      },
      { type: 'adjustment', id: adjustId },
    ],
    [
      {
        ledgerType: 'BAD_DEBT_WRITEOFF',
        lines: avail(-60n),
        bizType: 'bad_debt_writeoff',
        bizId: writeoffId,
      },
      { type: 'writeoff', id: writeoffId },
    ],
  ];
  const vouchers: Typed[] = [];
  for (const [index, [seed, link]] of plan.entries()) {
    f.clock.set(new Date(Date.parse(AT_1) + index * 60_000).toISOString());
    vouchers.push({ posted: await post(f, who, seed), link });
  }
  f.clock.set(NOW);
  return {
    vouchers,
    orderIds: new Map([k1, k2, k3].map((k): [string, string] => [k.orderId, k.key])),
  };
}

/**
 * The items with an order link's id written as the order key: the link of an order may name it by
 * the voucher's biz_id (the order key) or by its order_id (order_keys), either is the same order.
 */
export function orderLinksByKey(
  items: readonly Record<string, unknown>[],
  orderIds: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
  return items.map((item) => {
    const link = item['link'] as { type?: unknown; id?: unknown } | null | undefined;
    if (link === null || link === undefined || link.type !== 'order') return item;
    if (typeof link.id !== 'string') return item;
    const key = orderIds.get(link.id);
    return key === undefined ? item : { ...item, link: { type: 'order', id: key } };
  });
}
