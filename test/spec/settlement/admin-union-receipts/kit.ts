// B2-04zr rule-test kit (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreateUnionReceipt, adminReverseUnionReceipt and adminListUnionReceipts; 08 BR-FUND-20 细则
// 「联盟回款凭证」, BR-FUND-16; specs/ledger-templates.csv UNION_RECEIPT:*; 编排裁定 D10-538, D10-589.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer),
// ledger, PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions
// (../../payment/orders/kit.ts suite).
// Synthetic: receivables and collection records written directly through the real ledger (a record
// of method R1_RECON has no write entry here, D10-538 ③), switches as config_items rows, admin
// accounts, and a one-shot fault in the entry's database handle for the roll-back cases. The totp
// step-up token is issued the way POST /admin/v1/auth/step-up issues it after a correct
// authenticator code. No real user or merchant data. Expected amounts are written by hand in the
// tests. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import {
  PostgresQueryCompiler,
  sql,
  type KyselyPlugin,
  type Selectable,
  type Transaction,
} from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createDailyCheck,
  createLedger,
  type Ledger,
  type PostingEntry,
  type PostingResult,
} from '../../../../apps/api/src/modules/ledger/index.ts';
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
  NOW,
  contractPaths,
  fixture as appFixture,
  type Fixture,
  type HeldLock,
} from '../../ledger/admin-recon-close/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export {
  audits,
  chars,
  idempotencyRows,
  suite,
  track,
  waiting,
} from '../../ledger/admin-recon-close/kit.ts';

export const LIST_PATH = '/admin/v1/union-receipts';
export const REVERSE_PATH = '/admin/v1/union-receipts/{receipt_id}/reverse';
/** specs/permissions.yaml: fund.cash_entry (step-up tier totp) writes; fund.view only reads. */
export const CASH_ENTRY = 'fund.cash_entry';
export const VIEW = 'fund.view';
/** The audit actions of the contract. */
export const CREATE_ACTION = 'union_receipt_create';
export const REVERSE_ACTION = 'union_receipt_reverse';
/** The accounting day of the fixture's default clock (2026-10-29 16:00 +08:00). */
export const TODAY = '2026-10-29';
/** The switch behind 银行卡通道未开通 (D10-538; content's registry default: off). */
export const BANK_SWITCH = 'payout.channel_enabled.bank_card';
export const REASON = '同一笔回款录了两次';

const ROOT = new URL('../../../../', import.meta.url);

/** The invariant files of db/invariants/ledger 01–09 the daily runner executes (03 is superseded). */
const INVARIANT_FILES = [
  '01_user-balances.sql',
  '02_voucher-balanced.sql',
  '04_beneficiary-net.sql',
  '05_union-receivable.sql',
  '06_frozen-equals-open-withdrawals.sql',
  '07_negative-balance-drops.sql',
  '08_invalid-still-credited.sql',
  '09_credit-unique-net.sql',
];

// ---------------------------------------------------------------------------------------------
// One app on the suite's database. Every value below is synthetic.

export interface ReceiptFixture extends Fixture {
  /** The ledger of the seeds, on the fixture's clock. */
  readonly ledger: Ledger;
}

export function fixture(
  s: Suite,
  options: { readonly instant?: string; readonly appId?: string } = {},
): ReceiptFixture {
  const base = appFixture(s, options.instant ?? NOW);
  return {
    ...base,
    appId: options.appId ?? base.appId,
    ledger: createLedger({ clock: base.clock }),
  };
}

/** A configuration value of the fixture's app (written before the entry reads it). */
export async function setSwitch(f: Fixture, key: string, value: unknown): Promise<void> {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${f.appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE
      SET value = EXCLUDED.value, version = app.config_items.version + 1`.execute(f.db);
}

/** A row of W, as the payout console would have entered it. */
export async function seedWatermark(f: Fixture, availableFen: bigint): Promise<void> {
  await sql`INSERT INTO app.payout_watermarks
      (id, app_id, channel, available_fen, measured_at, entered_by)
    VALUES (${randomUUID()}, ${f.appId}, 'alipay', ${availableFen}, ${f.clock.now()},
      'finance:synthetic')`.execute(f.db);
}

/** A platform entry in the placeholder type of specs/ledger-templates.csv UNION_RECEIPT:*. */
function platformLine(subject: string, amount: bigint): PostingEntry {
  return {
    account: { ownerType: 'platform', subject },
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    income_type: null,
  };
}

/** Debit `debit`, credit `credit` on one voucher outside any order, on the fixture's clock. */
export async function transfer(
  f: ReceiptFixture,
  debit: string,
  credit: string,
  fen: bigint,
): Promise<void> {
  const id = randomUUID();
  await f.db.transaction().execute((trx) =>
    f.ledger.post(trx, {
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
      entries: [platformLine(debit, fen), platformLine(credit, -fen)],
    }),
  );
}

/** 已入账未回款 of the platform: debit UNION_RECEIVABLE:{platform} / credit COMMISSION_REVENUE. */
export function seedReceivable(f: ReceiptFixture, platform: string, fen: bigint): Promise<void> {
  return transfer(f, `UNION_RECEIVABLE:${platform}`, 'COMMISSION_REVENUE', fen);
}

export type ReceiptRow = Selectable<DB['union_receipts']> & {
  /** receipt_date as YYYY-MM-DD. */
  readonly day: string;
};

/** One union_receipts row of the fixture's app as it is now. */
export async function receiptRow(f: Fixture, receiptId: string): Promise<ReceiptRow> {
  const row = await f.db
    .selectFrom('union_receipts')
    .selectAll()
    .select((eb) => eb.cast<string>('receipt_date', 'text').as('day'))
    .where('app_id', '=', f.appId)
    .where('receipt_id', '=', receiptId)
    .executeTakeFirst();
  expect(row, `union_receipts ${receiptId}`).toBeDefined();
  return row!;
}

/** Every union_receipts row of the app, by receipt_id. */
export function receiptRows(f: Fixture): Promise<ReceiptRow[]> {
  return f.db
    .selectFrom('union_receipts')
    .selectAll()
    .select((eb) => eb.cast<string>('receipt_date', 'text').as('day'))
    .where('app_id', '=', f.appId)
    .orderBy('receipt_id')
    .execute();
}

export interface ReceiptSeed {
  readonly platform?: string;
  readonly amountFen?: bigint;
  readonly receiptDate?: string;
  readonly cash?: 'CASH_ALIPAY' | 'CASH_BANK';
  readonly note?: string | null;
  /** Null (the default) is a record confirmed by R1 without an operator. */
  readonly createdBy?: string | null;
  readonly createdAt?: Date;
}

/**
 * A collection record with its voucher, written directly: RECEIPT:{platform}:{receipt_id} through
 * the real ledger, the row as the writer leaves it; ADMIN_ENTRY with an operator, else R1_RECON.
 */
export async function seedReceipt(f: ReceiptFixture, seed: ReceiptSeed = {}): Promise<ReceiptRow> {
  const id = randomUUID();
  const platform = seed.platform ?? 'taobao';
  const fen = seed.amountFen ?? 100_000n;
  const cash = seed.cash ?? 'CASH_ALIPAY';
  const createdBy = seed.createdBy ?? null;
  await f.db.transaction().execute(async (trx) => {
    const posted = await f.ledger.post(trx, {
      appId: f.appId,
      uniqKey: receiptKey(platform, id),
      bizType: 'UNION_RECEIPT',
      bizId: id,
      operator: createdBy === null ? 'system' : `admin:${createdBy}`,
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: 'UNION_RECEIPT',
      entries: [platformLine(cash, fen), platformLine(`UNION_RECEIVABLE:${platform}`, -fen)],
    });
    await trx
      .insertInto('union_receipts')
      .values({
        receipt_id: id,
        app_id: f.appId,
        platform,
        receipt_date: seed.receiptDate ?? '2026-10-20',
        amount_fen: fen,
        method: createdBy === null ? 'R1_RECON' : 'ADMIN_ENTRY',
        cash_account: cash,
        voucher_id: posted.voucherId,
        note: seed.note ?? null,
        created_by: createdBy,
        created_at: seed.createdAt ?? f.clock.now(),
      })
      .execute();
  });
  return receiptRow(f, id);
}

/** A record already reversed by `adminId` at `at`, written directly through the real ledger. */
export async function seedReversal(
  f: ReceiptFixture,
  row: ReceiptRow,
  adminId: string,
  at: Date,
): Promise<ReceiptRow> {
  await f.db.transaction().execute(async (trx) => {
    const posted: PostingResult = await f.ledger.reverse(trx, {
      appId: f.appId,
      originalUniqKey: receiptKey(row.platform, row.receipt_id),
    });
    await trx
      .updateTable('union_receipts')
      .set({ reversed_at: at, reversed_by: adminId, reversal_voucher_id: posted.voucherId })
      .where('app_id', '=', f.appId)
      .where('receipt_id', '=', row.receipt_id)
      .execute();
  });
  return receiptRow(f, row.receipt_id);
}

// ---------------------------------------------------------------------------------------------
// The books.

/** The voucher key of a record (BR-FUND-20 细则). */
export function receiptKey(platform: string, receiptId: string): string {
  return `RECEIPT:${platform}:${receiptId}`;
}

/** The voucher key of its reversal (BR-FUND-16). */
export function reversalKey(platform: string, receiptId: string): string {
  return `${receiptKey(platform, receiptId)}:REVERSE`;
}

/** Every voucher of the app whose uniq_key is a record's or its reversal's, by uniq_key. */
export function receiptVouchers(f: Fixture) {
  return f.db
    .selectFrom('ledger_vouchers')
    .selectAll()
    .select((eb) => eb.cast<string>('accounting_date', 'text').as('day'))
    .where('app_id', '=', f.appId)
    .where('uniq_key', 'like', 'RECEIPT:%')
    .orderBy('uniq_key')
    .execute();
}

/** The voucher of one uniq_key. */
export async function voucherOf(f: Fixture, uniqKey: string) {
  const row = (await receiptVouchers(f)).find((voucher) => voucher.uniq_key === uniqKey);
  expect(row, `voucher ${uniqKey}`).toBeDefined();
  return row!;
}

/** The entries of one voucher as sorted `subject|owner|sub_account|amount|type|sub_type`. */
export async function linesOf(f: Fixture, uniqKey: string): Promise<string[]> {
  const rows = await f.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
    )
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
    )
    .select([
      'a.subject',
      'a.owner_id',
      'e.sub_account',
      'e.amount_fen',
      'e.ledger_type',
      'e.sub_type',
    ])
    .where('e.app_id', '=', f.appId)
    .where('v.uniq_key', '=', uniqKey)
    .execute();
  return rows
    .map(
      (r) =>
        `${r.subject}|${r.owner_id ?? ''}|${r.sub_account ?? ''}|${String(r.amount_fen)}|${r.ledger_type ?? ''}|${r.sub_type ?? ''}`,
    )
    .sort();
}

/** The two entries of a record: debit the cash subject, credit the receivable; REBATE_CREDIT 占位. */
export function receiptLines(platform: string, cash: string, fen: bigint): string[] {
  return [
    `${cash}|platform|available|${String(fen)}|REBATE_CREDIT|`,
    `UNION_RECEIVABLE:${platform}|platform|available|${String(-fen)}|REBATE_CREDIT|`,
  ].sort();
}

/** The two entries of its reversal, every line negated. */
export function reversalLines(platform: string, cash: string, fen: bigint): string[] {
  return receiptLines(platform, cash, -fen);
}

/** Σ amount_fen (debit positive) of a platform subject of the app. */
export async function balanceOf(f: Fixture, subject: string): Promise<bigint> {
  const result = await sql<{ fen: string }>`
    SELECT coalesce(sum(e.amount_fen), 0)::text AS fen
    FROM app.ledger_entries e
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE e.app_id = ${f.appId} AND a.owner_type = 'platform' AND a.subject = ${subject}`.execute(
    f.db,
  );
  return BigInt(result.rows[0]?.fen ?? '0');
}

/** The subjects of the app with at least one entry, sorted. */
export async function subjectsWithEntries(f: Fixture): Promise<string[]> {
  const rows = await f.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
    )
    .select('a.subject')
    .distinct()
    .where('e.app_id', '=', f.appId)
    .execute();
  return rows.map((row) => row.subject).sort();
}

/** Everything of the app these operations could write, for before / after comparisons. */
export async function everything(f: Fixture) {
  return {
    receipts: await receiptRows(f),
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
    audits: await f.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    watermarks: await f.db
      .selectFrom('payout_watermarks')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    diffs: await f.db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    holds: await f.db
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/**
 * The real daily check of the app's accounting day: every invariant of db/invariants/ledger runs
 * and none reports a difference of this app (D10-538: the placeholder ledger_type stays out).
 */
export async function expectCleanBooks(f: Fixture, day: string): Promise<void> {
  const runner = createDailyCheck({
    clock: f.clock,
    logger: { warn: () => undefined, error: () => undefined },
  });
  const result = await runner.runDailyCheck(f.db, { appId: f.appId, accountingDate: day });
  expect(result.checks.map((check) => check.file)).toEqual(expect.arrayContaining(INVARIANT_FILES));
  expect(result.accountDifferences).toEqual([]);
  expect(result.globalDifferences).toEqual([]);
  expect(result.filedDifferences).toEqual([]);
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
// Row locks held from the suite's second pool.

async function holding(
  f: Fixture,
  lock: (trx: Transaction<DB>) => Promise<void>,
): Promise<HeldLock> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      await lock(trx);
      locked();
      await gate;
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

/** Holds `SELECT … FOR UPDATE` on one union_receipts row of the app. */
export function holdReceipt(f: Fixture, receiptId: string): Promise<HeldLock> {
  return holding(f, async (trx) => {
    const rows = await sql`SELECT receipt_id FROM app.union_receipts
      WHERE app_id = ${f.appId} AND receipt_id = ${receiptId} FOR UPDATE`.execute(trx);
    expect(rows.rows, `union_receipts ${receiptId}`).toHaveLength(1);
  });
}

/**
 * Holds `SELECT … FOR UPDATE` on an admin_users row: an INSERT into union_receipts with that
 * created_by waits on its foreign key (FOR KEY SHARE), so an entry stays running on its transaction.
 */
export function holdAdmin(f: Fixture, adminId: string): Promise<HeldLock> {
  return holding(f, async (trx) => {
    const rows = await sql`SELECT id FROM app.admin_users
      WHERE app_id = ${f.appId} AND id = ${adminId} FOR UPDATE`.execute(trx);
    expect(rows.rows, `admin_users ${adminId}`).toHaveLength(1);
  });
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** Where the next failure is thrown; each is one statement of the operation's transaction. */
export type FaultPoint =
  'voucher' | 'entries' | 'receipt_insert' | 'receipt_update' | 'create_audit' | 'reverse_audit';
export const CREATE_FAULTS: readonly FaultPoint[] = [
  'voucher',
  'entries',
  'receipt_insert',
  'create_audit',
];
export const REVERSE_FAULTS: readonly FaultPoint[] = [
  'voucher',
  'entries',
  'receipt_update',
  'reverse_audit',
];

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function faultHit(point: FaultPoint, text: string, parameters: readonly unknown[]): boolean {
  const table = String.raw`(?:"?app"?\s*\.\s*)?"?`;
  const into = (name: string) =>
    new RegExp(String.raw`\binsert\s+into\s+${table}${name}\b`, 'i').test(text);
  const audited = (action: string) =>
    into('audit_logs') &&
    (text.includes(action) ||
      JSON.stringify(parameters, (_key, item: unknown) =>
        typeof item === 'bigint' ? item.toString() : item,
      ).includes(action));
  switch (point) {
    case 'voucher':
      return into('ledger_vouchers');
    case 'entries':
      return into('ledger_entries');
    case 'receipt_insert':
      return into('union_receipts');
    case 'receipt_update':
      return new RegExp(String.raw`\bupdate\s+${table}union_receipts\b`, 'i').test(text);
    case 'create_audit':
      return audited(CREATE_ACTION);
    case 'reverse_audit':
      return audited(REVERSE_ACTION);
  }
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

export type Operation = 'create' | 'reverse' | 'list';

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
  readonly sessionId: string;
  readonly loginName: string;
  readonly displayName: string | null;
}

export interface WriteOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `operator` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface ReceiptAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean; readonly displayName?: string },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/union-receipts with the JSON body (entryBody() by default). */
  create(body?: unknown, options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/union-receipts/{receipt_id}/reverse with the JSON body ({ reason } by default). */
  reverse(receiptId: string, body?: unknown, options?: WriteOptions): Promise<AdminSent>;
  /** GET /admin/v1/union-receipts, as `viewer` unless given (null: no token); no step-up token. */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
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
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `ur_${randomBytes(12).toString('hex')}`;
}

/** A valid body of adminCreateUnionReceipt; `patch` replaces or adds fields. */
export function entryBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'taobao',
    receipt_date: '2026-10-20',
    amount_fen: 1_150_000,
    cash_account: 'CASH_ALIPAY',
    ...patch,
  };
}

/** The name a record shows for an account: display_name, else the username. */
export function nameOf(caller: AdminCaller): string {
  return caller.displayName ?? caller.loginName;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withReceiptAdmin(
  f: ReceiptFixture,
  run: (h: ReceiptAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-04zr-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
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
        JWT_KEY_ID: 'b2_04zr_test',
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
    const caller: ReceiptAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      const loginName = `ur_${id}`;
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
    const stepUp: ReceiptAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const operator = await caller([CASH_ENTRY]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    const write = async (
      op: Operation,
      url: string,
      body: unknown,
      options: WriteOptions,
    ): Promise<AdminSent> => {
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
        url,
        headers,
        payload: JSON.stringify(body),
        remoteAddress: '127.0.0.1',
      });
      return sent(op, response);
    };
    await run({
      fault,
      caller,
      stepUp,
      operator,
      viewer,
      create(body = entryBody(), options = {}) {
        return write('create', LIST_PATH, body, options);
      },
      reverse(receiptId, body = { reason: REASON }, options = {}) {
        const url = `${LIST_PATH}/${encodeURIComponent(receiptId)}/reverse`;
        return write('reverse', url, body, options);
      },
      async list(query = {}, who) {
        const actor = who === undefined ? viewer : who;
        const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
        const text = new URLSearchParams(query).toString();
        const response = await server.inject({
          method: 'GET',
          url: text === '' ? LIST_PATH : `${LIST_PATH}?${text}`,
          headers,
          remoteAddress: '127.0.0.1',
        });
        return sent('list', response);
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

const PATHS: Record<Operation, { path: string; method: 'get' | 'post' }> = {
  create: { path: LIST_PATH, method: 'post' },
  reverse: { path: REVERSE_PATH, method: 'post' },
  list: { path: LIST_PATH, method: 'get' },
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

/** A contract record with its instants as epoch milliseconds. */
export function normalized(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['created_at', 'reversed_at']) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** data.receipt of a successful create or reverse, its instants as epoch milliseconds. */
export async function receiptOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data), sent.body).toEqual(['receipt']);
  return normalized(data['receipt']);
}

/** The id of a record returned by receiptOf. */
export function idOf(receipt: Record<string, unknown>): string {
  const id = receipt['receipt_id'];
  expect(typeof id, JSON.stringify(receipt)).toBe('string');
  return id as string;
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response, its items normalized. */
export async function pageOf(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data as Page;
  return { ...data, items: data.items.map(normalized) };
}

/** The receipt_id of each item of a successful list response, in order. */
export async function idsOf(sent: AdminSent): Promise<unknown[]> {
  return (await pageOf(sent)).items.map((item) => item['receipt_id']);
}

/** The record a row must be shown as, with the names the accounts have now. */
export function viewOf(
  row: ReceiptRow,
  names: { readonly createdBy?: string; readonly reversedBy?: string } = {},
): Record<string, unknown> {
  return {
    receipt_id: row.receipt_id,
    platform: row.platform,
    receipt_date: row.day,
    amount_fen: Number(row.amount_fen),
    method: row.method,
    cash_account: row.cash_account,
    voucher_id: row.voucher_id,
    note: row.note,
    created_by: row.created_by,
    created_by_name: names.createdBy ?? null,
    created_at: row.created_at.getTime(),
    reversed_at: row.reversed_at === null ? null : row.reversed_at.getTime(),
    reversed_by: row.reversed_by,
    reversed_by_name: names.reversedBy ?? null,
    reversal_voucher_id: row.reversal_voucher_id,
  };
}

/** The 20902 of a record already reversed. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'union_receipt' });
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
