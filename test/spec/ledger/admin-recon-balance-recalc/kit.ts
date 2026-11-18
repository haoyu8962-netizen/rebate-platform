// B2-02x rule-test kit (claude-independent, SPEC_REF ba6655b1): contracts/openapi.yaml
// recalcBalanceAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc,
// CT-24zzn + CT-24zzna: fund.recon, step-up sms, no Idempotency-Key; only an open / processing
// ledger_mismatch of source R3 registered on one member's USER_BALANCE account, ref_type
// ledger_account, ref_id `{invariant}:{account_id}`; under the users row then the account_balances
// row FOR UPDATE the cache becomes the member-sign entry sums; a negative frozen sum or a sum
// outside bigint is refused with an audit record; version + 1 on a change, nothing written when
// equal; negative_since and 跨零 as the posting path; no voucher, no entry, no wallet push; the
// difference is not closed and no withdraw_holds row is released) with 08 BR-FUND-19 细则「差异以
// 分录为准修正」, BR-FUND-16 细则「加锁流程」, BR-ID-34 (短信档), BR-FUND-12, BR-WDR-05 (a).
//
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, admin's audit writer, the entry's ledger with
// its event bus and payout's recovery hook), PostgreSQL through @couli/db/testing as couli_app,
// Redis for the admin sessions and step-up tokens. The sms-tier token is issued the way
// POST /admin/v1/auth/step-up issues it after a correct SMS code (createAdminStepUpTokens on the
// entry's Redis namespace admin-step-up).
// Synthetic (fixtures, never on the path under test): members and their entries (a plain ledger
// with no bus and no hook, ../admin-adjustments/kit.ts), a cache made to disagree with the entries
// by writing account_balances directly (couli_app may UPDATE available_fen, frozen_fen and
// negative_since; version is left as it was), entries that cannot be a balance written directly
// as vouchers (couli_app may INSERT), recon_diffs and withdraw_holds rows written directly as the
// daily check would have left them, withdrawals, admin accounts, a one-shot fault in the entry's
// database handle and a watch on its balance-row locking statement. A fixture that cannot be built
// throws a plain Error. Missing pieces fail as assertions (an unregistered admin route answers
// 404). No real user, payee or merchant data.
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
import { createLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
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
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';
import {
  expectMentions,
  member as seedUser,
  type AdjustFixture,
  type AuditRow,
  type MemberStatus,
} from '../admin-adjustments/kit.ts';
import { contractPaths, seedDiff, type DiffRow, type DiffSeed } from '../admin-recon-diffs/kit.ts';
import { balanceCache, cacheRowOf, type CacheRow, type Member } from '../bad-debt-writeoffs/kit.ts';

export { suite } from '../../payment/orders/kit.ts';
export {
  expectMentions,
  seedWithdrawal,
  shift,
  wentNegative,
  withdrawalNow,
  type AdjustFixture,
  type AuditRow,
} from '../admin-adjustments/kit.ts';
export {
  allHolds,
  diffNow,
  holdRow,
  seedHold,
  track,
  waiting,
  type HoldRow,
  type Tracked,
} from '../admin-recon-close/kit.ts';
export {
  balanceCache,
  blockedBehind,
  cacheRowOf,
  creditOn,
  holdBalance,
  isBalanceLock,
  linesOf,
  plainMember,
  type CacheRow,
  type Member,
} from '../bad-debt-writeoffs/kit.ts';

/** 2026-11-18 10:30 +08:00. */
export const NOW = '2026-11-18T02:30:00.000Z';
/** The +08:00 accounting day of NOW. */
export const DAY = '2026-11-18';
/** The accounting day the daily check (R3) found the difference on (D − 1). */
export const PERIOD = '2026-11-17';
/** An earlier day, a negative_since the entries themselves cannot explain. */
export const EARLIER = '2026-10-02';
export const RECALC_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/balance-recalc';
/** specs/permissions.yaml: fund.recon (operation fund.recon.balance_recalc, step-up sms). */
export const RECON = 'fund.recon';
export const VIEW = 'fund.view';
/** The audit action of the contract (success and refusal alike). */
export const RECALC_ACTION = 'recon_diff_balance_recalc';
/** The ledger's platform event when available crosses below zero (BR-WDR-05 (a)). */
export const WENT_NEGATIVE_EVENT = 'account.went_negative';
export const BIGINT_MAX = 9_223_372_036_854_775_807n;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOT = new URL('../../../../', import.meta.url);

export function newAppId(): string {
  return `brc_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** One app on the suite's database. */
export function fixture(s: Suite, instant = NOW): AdjustFixture {
  const clock = new FixedClock(instant);
  return { s, db: s.db(), clock, appId: newAppId(), ledger: createLedger({ clock }) };
}

function inApp(f: AdjustFixture, appId: string): AdjustFixture {
  return appId === f.appId ? f : { ...f, appId };
}

/** A member whose users.status is `status` (entries and cache as plainMember leaves them). */
export async function memberWithStatus(
  f: AdjustFixture,
  status: MemberStatus,
  available: bigint,
): Promise<Member> {
  const userId = await seedUser(f, { available, status });
  const [row] = await f.ledger.getBalances(f.db, { appId: f.appId, userIds: [userId] });
  if (row === undefined) throw new Error(`kit: ${userId} has no ledger account`);
  return { appId: f.appId, userId, accountId: row.account_id, withdrawalId: null };
}

// ---------------------------------------------------------------------------------------------
// The cache and the entries.

export interface Cache {
  readonly available: bigint;
  readonly frozen: bigint;
  readonly negativeSince: string | null;
}

/**
 * Overwrites the member's account_balances row (available_fen, frozen_fen, negative_since) as a
 * cache drift would have left it; version and the entries stay as they are.
 */
export async function tamper(f: AdjustFixture, m: Member, cache: Cache): Promise<CacheRow> {
  const result = await sql`UPDATE app.account_balances
    SET available_fen = ${cache.available}, frozen_fen = ${cache.frozen},
      negative_since = ${cache.negativeSince}::date
    WHERE app_id = ${m.appId} AND account_id = ${m.accountId}`.execute(f.db);
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw new Error(`kit: no balance row of ${m.accountId}`);
  }
  return cacheRowOf(await balanceCache(f, m.appId), m);
}

/** The member's balance row now (balanceCache view). */
export async function cacheOf(f: AdjustFixture, m: Member): Promise<CacheRow> {
  return cacheRowOf(await balanceCache(f, m.appId), m);
}

/** The member-sign sums of the account's entries: 0 − Σ amount_fen per sub-account (exact). */
export async function entrySums(
  f: AdjustFixture,
  m: Member,
): Promise<{ readonly available: bigint; readonly frozen: bigint }> {
  const result = await sql<{ available: string; frozen: string }>`
    SELECT
      COALESCE(SUM(amount_fen) FILTER (WHERE sub_account = 'available'), 0)::text AS available,
      COALESCE(SUM(amount_fen) FILTER (WHERE sub_account = 'frozen'), 0)::text AS frozen
    FROM app.ledger_entries WHERE app_id = ${m.appId} AND account_id = ${m.accountId}`.execute(
    f.db,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('kit: no sums');
  return { available: 0n - BigInt(row.available), frozen: 0n - BigInt(row.frozen) };
}

async function platformAccount(f: AdjustFixture, appId: string, subject: string): Promise<string> {
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${randomUUID()}, ${appId}, 'platform', 'platform', ${subject})
    ON CONFLICT (app_id, owner_type, owner_id, subject) DO NOTHING`.execute(f.db);
  const result = await sql<{ id: string }>`SELECT id FROM app.ledger_accounts
    WHERE app_id = ${appId} AND owner_type = 'platform' AND owner_id = 'platform'
      AND subject = ${subject}`.execute(f.db);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`kit: no platform account ${subject}`);
  return id;
}

export interface RawLine {
  readonly sub_account: 'available' | 'frozen';
  /** Stored sign: debit positive (lowers the member's balance), credit negative. */
  readonly amount_fen: bigint;
}

/**
 * A voucher written directly (uniq_key RAW:…, ADMIN_ADJUST OTHER) with these lines on the
 * member's account and, per user line, one COMMISSION_REVENUE line of the opposite amount; no
 * balance_after_fen, the cache untouched. Entries that no posting would write (a negative frozen
 * sum, sums beyond bigint) come only from here.
 */
export async function rawVoucher(
  f: AdjustFixture,
  m: Member,
  lines: readonly RawLine[],
): Promise<string> {
  const voucherId = randomUUID();
  const platform = await platformAccount(f, m.appId, 'COMMISSION_REVENUE');
  const at = f.clock.now();
  await f.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.ledger_vouchers
      (id, app_id, biz_type, biz_id, uniq_key, accounting_date, operator, memo, order_key,
       beneficiary_user_id, role, voucher_kind)
      VALUES (${voucherId}, ${m.appId}, 'TEST_RAW', ${randomUUID()}, ${`RAW:${voucherId}`},
        ${PERIOD}::date, 'system', NULL, NULL, NULL, NULL, NULL)`.execute(trx);
    for (const line of lines) {
      for (const [accountId, subAccount, amount] of [
        [m.accountId, line.sub_account, line.amount_fen],
        [platform, 'available', -line.amount_fen],
      ] as const) {
        await sql`INSERT INTO app.ledger_entries
          (app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type, sub_type,
           income_type, balance_after_fen, account_version, booked_at)
          VALUES (${m.appId}, ${voucherId}, ${accountId}, ${subAccount}, ${amount},
            'ADMIN_ADJUST', 'OTHER', NULL, NULL, NULL, ${at})`.execute(trx);
      }
    }
  });
  return voucherId;
}

/** A difference of type ledger_mismatch (R3) registered on the member's account. */
export function seedMismatch(
  f: AdjustFixture,
  m: Pick<Member, 'accountId'>,
  patch: DiffSeed = {},
  invariant = '01',
): Promise<DiffRow> {
  return seedDiff(f, {
    type: 'ledger_mismatch',
    source: 'R3',
    period: PERIOD,
    ref_type: 'ledger_account',
    ref_id: `${invariant}:${m.accountId}`,
    expected_fen: 4900n,
    actual_fen: 5000n,
    diff_fen: -100n,
    dedupe_key: `R3:${PERIOD}:${invariant}:${m.accountId}:${randomUUID()}`,
    resolution: { source: 'ledger_daily_check', accounting_date: PERIOD, invariant },
    ...patch,
  });
}

/** A user ledger account of the app with no account_balances row (fixture only). */
export async function accountWithoutBalance(f: AdjustFixture): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
    VALUES (${id}, ${f.appId}, 'user', ${randomUUID()}, 'USER_BALANCE')`.execute(f.db);
  return id;
}

/** The platform COMMISSION_REVENUE account of the app (created when missing). */
export function platformAccountOf(f: AdjustFixture): Promise<string> {
  return platformAccount(f, f.appId, 'COMMISSION_REVENUE');
}

/**
 * Everything of the app a recalculation must leave alone: vouchers, entries (with their
 * snapshots), events, inbox messages, notify logs, withdrawals, holds and differences; balances
 * separately.
 */
export async function untouched(f: AdjustFixture, appId = f.appId) {
  const g = inApp(f, appId);
  const entries = await sql<Record<string, unknown>>`
    SELECT id, voucher_id, account_id, sub_account, amount_fen, ledger_type, sub_type,
      balance_after_fen, account_version
    FROM app.ledger_entries WHERE app_id = ${appId} ORDER BY id`.execute(g.db);
  return {
    vouchers: await g.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    entries: entries.rows,
    events: await events(g, appId),
    inbox: await g.db
      .selectFrom('inbox_messages')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('message_id')
      .execute(),
    notifyLogs: await g.db
      .selectFrom('notify_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    withdrawals: await g.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    holds: await g.db
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    diffs: await g.db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

/** The event_log rows of the app (name and payload), in insertion order. */
export function events(f: AdjustFixture, appId = f.appId) {
  return f.db
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

/** The audit records of the app, in insertion order; only `action` when given. */
export function audits(f: AdjustFixture, action?: string): Promise<AuditRow[]> {
  let query = f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', f.appId);
  if (action !== undefined) query = query.where('action', '=', action);
  return query.orderBy('id').execute();
}

/** target, before and after of one audit record as PostgreSQL prints them (exact numbers). */
export async function auditText(f: AdjustFixture, id: AuditRow['id']): Promise<string> {
  const result = await sql<{ text: string }>`
    SELECT concat_ws(' ', target, before::text, after::text) AS text
    FROM app.audit_logs WHERE app_id = ${f.appId} AND id = ${id}`.execute(f.db);
  return result.rows[0]?.text ?? '';
}

const PERSONAL = /phone|nickname|avatar|real_?name|id_no|payee|mobile/i;

/** No personal field name and not the synthetic nickname in the record. */
export function expectNoPersonalData(row: AuditRow): void {
  const text = JSON.stringify([row.target, row.before, row.after]);
  expect(text, 'no personal field').not.toMatch(PERSONAL);
  expect(text, 'not the nickname').not.toContain('"synthetic"');
}

/**
 * The newest recon_diff_balance_recalc record: by `adminId`, naming the difference and the member,
 * with the trimmed reason, `changed` and the four values before and after; no personal data.
 */
export async function expectRecalcAudit(
  f: AdjustFixture,
  e: {
    readonly adminId: string;
    readonly diffId: string;
    readonly userId: string;
    readonly reason: string;
    readonly changed: boolean;
    readonly before: { readonly available: bigint; readonly frozen: bigint };
    readonly after: { readonly available: bigint; readonly frozen: bigint };
  },
): Promise<AuditRow> {
  const recorded = await audits(f, RECALC_ACTION);
  expect(recorded.length, RECALC_ACTION).toBeGreaterThan(0);
  const row = recorded[recorded.length - 1]!;
  expect(row.admin_id).toBe(e.adminId);
  expect(row.system_actor).toBeNull();
  expectMentions(row, {
    ids: [e.diffId, e.userId],
    values: [
      e.reason,
      String(e.changed),
      e.before.available,
      e.before.frozen,
      e.after.available,
      e.after.frozen,
    ],
  });
  expectNoPersonalData(row);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Locks seen from another connection.

/** The statements of the backends of the test database waiting on a lock (polled until `count`). */
export async function lockWaiters(
  f: AdjustFixture,
  count: number,
  pending: readonly { readonly settled: boolean }[],
  timeoutMs = 10_000,
): Promise<string[]> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await sql<{ query: string }>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(f.db);
    if (result.rows.length >= count) return result.rows.map((row) => row.query);
    if (pending.some((request) => request.settled)) return [];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

/**
 * Tries to lock the member's users row or balance row FOR UPDATE NOWAIT on a short transaction:
 * 'ok' when free, the SQLSTATE (55P03 lock_not_available) when another transaction holds it.
 */
export async function tryLock(
  f: AdjustFixture,
  m: Member,
  table: 'users' | 'account_balances',
): Promise<string> {
  try {
    await f.db.transaction().execute(async (trx) => {
      if (table === 'users') {
        await sql`SELECT id FROM app.users WHERE app_id = ${m.appId} AND id = ${m.userId}
          FOR UPDATE NOWAIT`.execute(trx);
      } else {
        await sql`SELECT account_id FROM app.account_balances
          WHERE app_id = ${m.appId} AND account_id = ${m.accountId} FOR UPDATE NOWAIT`.execute(trx);
      }
    });
    return 'ok';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : 'error';
  }
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault and a lock watch in the entry's database handle.

/**
 * Where the next failure is thrown: the INSERT of the recon_diff_balance_recalc audit record, the
 * UPDATE of account_balances, or the INSERT into event_log.
 */
export type FaultPoint = 'audit' | 'balance' | 'event';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

interface Pause {
  readonly reached: () => void;
  readonly gate: Promise<void>;
}

interface LockWatch {
  /** The SQL of every balance-row locking statement the entry sent, in order. */
  readonly issued: string[];
  /** One-shot: the next such statement's result is held back until its gate opens. */
  pause: Pause | null;
}

/** A balance-row locking statement: account_balances … FOR UPDATE, not a NOWAIT re-lock. */
function balanceLock(text: string): boolean {
  return (
    /\baccount_balances\b/i.test(text) &&
    /\bfor\s+update\b/i.test(text) &&
    !/\bnowait\b/i.test(text)
  );
}

function faultPlugin(fault: Fault, watch: LockWatch): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  const held = new WeakMap<object, Pause>();
  return {
    transformQuery({ node, queryId }) {
      const compiled = compiler.compileQuery(node, queryId);
      const text = compiled.sql;
      if (balanceLock(text)) {
        watch.issued.push(text);
        const pause = watch.pause;
        if (pause !== null) {
          watch.pause = null;
          held.set(queryId, pause);
        }
      }
      const point = fault.point;
      if (point === null) return node;
      const params = JSON.stringify(compiled.parameters, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      const hit =
        point === 'audit'
          ? /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?audit_logs\b/i.test(text) &&
            (text.includes(RECALC_ACTION) || params.includes(RECALC_ACTION))
          : point === 'balance'
            ? /\bupdate\s+(?:"?app"?\s*\.\s*)?"?account_balances\b/i.test(text)
            : /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?event_log\b/i.test(text);
      if (hit) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      const pause = held.get(queryId);
      if (pause !== undefined) {
        // The statement has run: this transaction holds the rows it locked while it waits here.
        held.delete(queryId);
        pause.reached();
        await pause.gate;
      }
      return result;
    },
  };
}

function within<T>(promise: Promise<T>, timeoutMs: number, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(otherwise), timeoutMs);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export interface PausedLock {
  /** True once the entry's balance lock statement has returned and is held back. */
  untilReached(pending: Promise<unknown>, timeoutMs?: number): Promise<boolean>;
  /** Lets the held-back statement's result through (and disarms the pause if never reached). */
  resume(): void;
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

export interface CallerOptions {
  readonly superAdmin?: boolean;
  /** A registered verify phone (sms tier); default true. */
  readonly phone?: boolean;
}

export interface RecalcOptions {
  /** The caller: `recon` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh sms-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface RecalcAdmin {
  readonly fault: Fault;
  /** The SQL of every balance-row locking statement the entry sent, in order. */
  readonly balanceLocks: readonly string[];
  /**
   * One-shot: the entry's next balance-row locking statement runs, then its result is held back
   * (its transaction keeps the lock) until resume().
   */
  pauseAfterBalanceLock(): PausedLock;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(permissions: readonly string[], options?: CallerOptions): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier sms by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc with the JSON body. */
  recalc(reconDiffId: string, body: unknown, options?: RecalcOptions): Promise<AdminSent>;
  /** An account with fund.recon only and a registered verify phone. */
  readonly recon: AdminCaller;
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

/** The concrete path of the recalculation of a difference. */
export function recalcPath(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}/balance-recalc`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withRecalcAdmin(
  f: AdjustFixture,
  run: (h: RecalcAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-02x-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const watch: LockWatch = { issued: [], pause: null };
  const store = f.db.withPlugin(faultPlugin(fault, watch));
  const pauseAfterBalanceLock = (): PausedLock => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pause: Pause = { reached, gate };
    watch.pause = pause;
    return {
      untilReached(pending, timeoutMs = 10_000) {
        return within(
          Promise.race([
            arrived.then(() => true),
            pending.then(
              () => false,
              () => false,
            ),
          ]),
          timeoutMs,
          false,
        );
      },
      resume() {
        if (watch.pause === pause) watch.pause = null;
        open();
      },
    };
  };
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
        JWT_KEY_ID: 'b2_02x_test',
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
    const caller: RecalcAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `brc_${id}`,
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
    const stepUp: RecalcAdmin['stepUp'] = async (who, tier = 'sms') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const recon = await caller([RECON]);
    const viewer = await caller([VIEW]);
    await run({
      fault,
      balanceLocks: watch.issued,
      pauseAfterBalanceLock,
      caller,
      stepUp,
      recon,
      viewer,
      async recalc(reconDiffId, body, options = {}) {
        const who = options.caller === undefined ? recon : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        const token =
          options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
        if (token !== null) headers['x-step-up-token'] = token;
        const response = await server.inject({
          method: 'POST',
          url: recalcPath(reconDiffId),
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

// ---------------------------------------------------------------------------------------------
// The contract.

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  50001: 500,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[RECALC_PATH]?.['post']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `post ${RECALC_PATH} ${status}`).toBeDefined();
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

/** 20001 data.fields=[recon_diff_id], no data.reason. */
export function notApplicable(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'] });
}

/** 20001 data.fields=[reason]. */
export function reasonInvalid(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['reason'] });
}

/** 20001 at the route schema: data.fields names `field`. */
export async function schemaRefused(sent: AdminSent, field: string): Promise<void> {
  const body = await answer(sent, 20001);
  const fields = (body.data as { fields?: unknown } | undefined)?.fields;
  expect(Array.isArray(fields), sent.body).toBe(true);
  expect(fields as unknown[], sent.body).toContain(field);
}

/** 10403 of an account without fund.recon. */
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

export interface Values {
  readonly available: bigint;
  readonly frozen: bigint;
}

/**
 * A successful recalculation: exactly user_id, before, after, changed and recalculated_at (the
 * clock), the values as JSON integers.
 */
export async function expectRecalculated(
  f: AdjustFixture,
  sent: AdminSent,
  e: {
    readonly m: Member;
    readonly before: Values;
    readonly after: Values;
    readonly changed: boolean;
  },
): Promise<void> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual([
    'after',
    'before',
    'changed',
    'recalculated_at',
    'user_id',
  ]);
  expect(data, sent.body).toEqual({
    user_id: e.m.userId,
    before: { available_fen: Number(e.before.available), frozen_fen: Number(e.before.frozen) },
    after: { available_fen: Number(e.after.available), frozen_fen: Number(e.after.frozen) },
    changed: e.changed,
    recalculated_at: data['recalculated_at'],
  });
  const at = data['recalculated_at'];
  expect(typeof at, sent.body).toBe('string');
  expect(Date.parse(at as string), 'recalculated_at is the server clock').toBe(
    f.clock.now().getTime(),
  );
}

/** The cache row after a write: the values, negative_since, version + 1; the rest as before. */
export function written(before: CacheRow, after: Cache): CacheRow {
  return {
    ...before,
    available_fen: after.available,
    frozen_fen: after.frozen,
    negative_since: after.negativeSince,
    version: before.version + 1n,
  };
}

/** A reason of `n` CJK characters. */
export function chars(n: number): string {
  return '核'.repeat(n);
}
