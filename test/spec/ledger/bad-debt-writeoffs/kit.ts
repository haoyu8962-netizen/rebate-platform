// B2-12f rule-test kit (claude-independent, SPEC_REF 18f0015e): 08 BR-FUND-12 负余额坏账核销 (with
// BR-FUND-10, BR-FUND-16), specs/state-machines/bad-debt-writeoff.yaml (BD1 GENERATE, BD2 APPROVE,
// BD3 CANCEL), specs/ledger-templates.csv BAD_DEBT_WRITEOFF, contracts/openapi.yaml
// adminListBadDebtWriteoffs (GET /admin/v1/bad-debt-writeoffs, fund.writeoff or fund.view, read
// only) and adminApproveBadDebtWriteoff (POST /admin/v1/bad-debt-writeoffs/{id}/approve,
// fund.writeoff, step-up sms, Idempotency-Key); task brief §9 (D10-587, D10-590 ⑥ ⑪, D10-727 ③:
// the linked accounts' risk mark is not part of this task and is never asserted here).
//
// Conventions of the generation (fixed by the skeleton, apps/api/src/modules/ledger/application/
// bad-debt-writeoff.ts): LedgerBadDebtWriteoffModule.forWorker, worker entry only; a timer whose
// first tick is at most 15 s after bootstrap and then at most every 60 s; each tick, per app, once
// the daily check (R3) of the day before the Clock's +08:00 accounting day D is recorded done
// (processed_events ledger.daily_check_done, dailyCheckDoneEventId(app, D − 1)), the candidates of
// D are generated: available < 0, D − negative_since ≥ ledger.bad_debt_days (no row: 90),
// |available| ≥ ledger.bad_debt_min_fen (no row: 0), no PENDING candidate of the account, member
// neither deleting nor deleted. created_at is the Clock's now.
//
// Real pieces: the worker entry (AppModule.forEntry through ../asset-snapshot-schedule/kit.ts
// inWorkerTime: a real Nest context, fake timers for setTimeout / setInterval only, a recording job
// queue), the admin entry (createHttpApp('admin'): admin token, session and permission checks, the
// step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
// entry's ledger with its event bus and payout's recovery hook), PostgreSQL through
// @couli/db/testing as couli_app, Redis for the admin sessions and step-up tokens. The sms-tier
// token is issued the way POST /admin/v1/auth/step-up issues it after a correct SMS code
// (createAdminStepUpTokens on the entry's Redis namespace admin-step-up).
// Synthetic (fixtures, never on the path under test): members and their balances (a plain ledger
// with no bus and no hook, its Clock moved to the day the balance went below zero, so the ledger
// itself stamps negative_since), withdrawals with their WITHDRAW:FREEZE, the candidates of the
// admin tests (written directly as the daily job would have generated them; an APPROVED one with
// its BAD_DEBT_WRITEOFF voucher), the R3 completion records, config rows, admin accounts and a
// one-shot fault in the admin entry's database handle. A fixture that cannot be built throws a plain
// Error. Missing pieces fail as assertions (an unregistered admin route answers 404; a worker that
// never generates leaves the table empty). No real user, payee or merchant data.
// Round 2 (Codex rule-test review r1): a second-connection barrier holding only the member's
// balance row (holdBalance, optionally after the users row), the backends a holder blocks
// (blockedBehind, lockWaitOf, from pg_stat_activity and pg_blocking_pids), a watch on the admin
// entry's handle that records its balance-row locking statements and can hold one back right after
// it got the lock (pauseAfterBalanceLock), and reads of account_balances (version, platform rows)
// and of each entry's balance_after_fen / account_version.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type KyselyPlugin,
  type Transaction,
} from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import * as ledgerModule from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createLedger,
  dailyCheckDoneEventId,
  type AccountBalance,
  type PostingEntry,
} from '../../../../apps/api/src/modules/ledger/index.ts';
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
  balanceOf,
  entriesOf,
  expectMentions,
  member,
  seedAdmin,
  seedWithdrawal,
  shift,
  templateEntries,
  voucherByKey,
  type AdjustFixture,
  type AuditRow,
  type MemberStatus,
  type Tracked,
  type VoucherRow,
} from '../admin-adjustments/kit.ts';
import { contractPaths } from '../admin-recon-diffs/kit.ts';
import { setConfig } from '../asset-snapshot-schedule/kit.ts';
import { rootLogger } from '../daily-check-schedule/kit.ts';

export { suite } from '../../payment/orders/kit.ts';
export {
  entriesOf,
  expectMentions,
  holdMember,
  postFreeze,
  templateEntries,
  track,
  waiting,
  withdrawalNow,
  type AdjustFixture,
  type Tracked,
} from '../admin-adjustments/kit.ts';
export { TIMEOUT, inWorkerTime } from '../asset-snapshot-schedule/kit.ts';

/** 2027-02-19 10:30 +08:00, the instant of the approval example of the contract. */
export const NOW = '2027-02-19T02:30:00.000Z';
/** The +08:00 accounting day of NOW. */
export const DAY = '2027-02-19';
/** BR-FUND-12 例: −800 on 2026-11-20, 90 days on 2027-02-18. */
export const SINCE = '2026-11-20';
export const DAY_89 = '2027-02-17';
export const DAY_90 = '2027-02-18';
export const DAY_91 = '2027-02-19';
/** 2027-02-18 02:00 +08:00, created_at of the list example. */
export const GENERATED_AT = '2027-02-17T18:00:00.000Z';
export const LIST_PATH = '/admin/v1/bad-debt-writeoffs';
export const APPROVE_PATH = '/admin/v1/bad-debt-writeoffs/{id}/approve';
/** specs/permissions.yaml: fund.writeoff (step-up sms) approves; fund.view only reads. */
export const WRITEOFF = 'fund.writeoff';
export const VIEW = 'fund.view';
/** The audit action of the contract (adminApproveBadDebtWriteoff). */
export const APPROVE_ACTION = 'bad_debt_writeoff_approve';
/** The three config keys of BR-FUND-12 (content/domain/config-registry.ts). */
export const DAYS_KEY = 'ledger.bad_debt_days';
export const MIN_FEN_KEY = 'ledger.bad_debt_min_fen';
export const NO_FROZEN_KEY = 'ledger.bad_debt_require_no_frozen.enabled';
/** The processed_events consumer of the daily check's completion record (B2-02s). */
export const R3_DONE_CONSUMER = 'ledger.daily_check_done';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROOT = new URL('../../../../', import.meta.url);
const DAY_MS = 86_400_000;

/** 12:00 +08:00 of an accounting day. */
export function noon(day: string): string {
  return `${day}T04:00:00.000Z`;
}

/** The +08:00 accounting day of an instant. */
export function accountingDay(instant: Date): string {
  return new Date(instant.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS,
  );
}

// ---------------------------------------------------------------------------------------------
// One app on a database.

export function newAppId(): string {
  return `bdw_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/** One app on the suite's database (admin tests). */
export function fixture(s: Suite, instant = NOW): AdjustFixture {
  const clock = new FixedClock(instant);
  return { s, db: s.db(), clock, appId: newAppId(), ledger: createLedger({ clock }) };
}

/**
 * One app on a worker test's database; the clock is new at `clock` (an instant) or shared (a
 * FixedClock, so several apps follow one worker's clock).
 */
export function workerFixture(db: Kysely<DB>, clock: string | FixedClock): AdjustFixture {
  const shared = typeof clock === 'string' ? new FixedClock(clock) : clock;
  const s: Suite = {
    db: () => db,
    holder: () => {
      throw new Error('kit: worker tests have no second pool');
    },
    redisUrl: () => {
      throw new Error('kit: worker tests have no Redis');
    },
  };
  return { s, db, clock: shared, appId: newAppId(), ledger: createLedger({ clock: shared }) };
}

function inApp(f: AdjustFixture, appId: string): AdjustFixture {
  return appId === f.appId ? f : { ...f, appId };
}

export interface Member {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
  /** The APPROVED withdrawal holding `frozen` (null without frozen money). */
  readonly withdrawalId: string | null;
}

export interface NegativeSeed {
  /** available after the seed (below 0 unless `since` is null). */
  readonly available: bigint;
  /** The accounting day available went below 0 (the ledger stamps negative_since). */
  readonly since: string;
  /** Frozen by an APPROVED withdrawal (WITHDRAW:FREEZE), taken before available went below 0. */
  readonly frozen?: bigint;
  /** The withdrawal carries the NEGATIVE_BALANCE block (BR-WDR-05 (a)). */
  readonly blocked?: boolean;
  readonly status?: MemberStatus;
  readonly appId?: string;
  /** The instant available went below 0 (default noon of `since`); the ledger stamps its day. */
  readonly at?: string;
}

async function accountIdOf(f: AdjustFixture, userId: string): Promise<string> {
  const balance = await balanceOf(f, userId);
  if (balance === undefined) throw new Error(`kit: ${userId} has no ledger account`);
  return balance.account_id;
}

/**
 * A synthetic member whose available went below 0 at noon of `since` (or at `at`; on the plain
 * ledger, its Clock moved there and back) and is `available` now, with `frozen` held by an
 * APPROVED withdrawal.
 */
export async function negativeMember(f: AdjustFixture, seed: NegativeSeed): Promise<Member> {
  const g = inApp(f, seed.appId ?? f.appId);
  const frozen = seed.frozen ?? 0n;
  if (seed.available >= 0n) throw new Error('kit: negativeMember needs available below 0');
  const saved = g.clock.now();
  g.clock.set(seed.at ?? noon(seed.since));
  try {
    const userId = await member(g, {
      available: frozen,
      appId: g.appId,
      ...(seed.status === undefined ? {} : { status: seed.status }),
    });
    const withdrawalId =
      frozen > 0n
        ? await seedWithdrawal(g, userId, {
            status: 'APPROVED',
            amount: frozen,
            blocked: seed.blocked === true,
            appId: g.appId,
          })
        : null;
    await shift(g, userId, seed.available, g.appId);
    return { appId: g.appId, userId, accountId: await accountIdOf(g, userId), withdrawalId };
  } finally {
    g.clock.set(saved);
  }
}

/** A member of the app with a balance never below 0 (`available`, default 0). */
export async function plainMember(
  f: AdjustFixture,
  available = 0n,
  appId = f.appId,
): Promise<Member> {
  const g = inApp(f, appId);
  const userId = await member(g, { available, appId });
  return { appId, userId, accountId: await accountIdOf(g, userId), withdrawalId: null };
}

/** A later credit to the member (REBATE_CREDIT on the plain ledger), at `day` when given. */
export async function credit(
  f: AdjustFixture,
  m: Member,
  amount: bigint,
  day?: string,
): Promise<void> {
  const g = inApp(f, m.appId);
  const saved = g.clock.now();
  if (day !== undefined) g.clock.set(noon(day));
  try {
    await shift(g, m.userId, amount, m.appId);
  } finally {
    g.clock.set(saved);
  }
}

/** A later debit of the member (ADMIN_ADJUST OTHER, may end below 0), at `day` when given. */
export function debit(f: AdjustFixture, m: Member, amount: bigint, day?: string): Promise<void> {
  return credit(f, m, -amount, day);
}

/**
 * A REBATE_CREDIT of `amount` on a transaction that already holds the member's balance lock;
 * returns its uniq_key (`uniqKey` when given).
 */
export async function creditOn(
  f: AdjustFixture,
  trx: Transaction<DB>,
  balance: AccountBalance,
  amount: bigint,
  uniqKey?: string,
): Promise<string> {
  const key = uniqKey ?? `SEED:${randomUUID()}`;
  const line = (
    account: PostingEntry['account'],
    amountFen: bigint,
    user: boolean,
  ): PostingEntry => ({
    account,
    sub_account: 'available',
    amount_fen: amountFen,
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
    income_type: user ? 'SERVICE_FEE' : null,
  });
  await f.ledger.post(trx, {
    appId: balance.app_id,
    uniqKey: key,
    bizType: 'TEST_SEED',
    bizId: randomUUID(),
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: [
      line({ ownerType: 'user', accountId: balance.account_id }, -amount, true),
      line({ ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' }, amount, false),
    ],
  });
  return key;
}

/**
 * WITHDRAW:RETURN of `amount` of the member's withdrawal (frozen → available) on a transaction
 * that already holds the member's balance lock, as W3 leaves it when the withdrawal is rejected;
 * the withdrawal row itself is not touched (synthetic).
 */
export async function returnFrozenOn(
  f: AdjustFixture,
  trx: Transaction<DB>,
  m: Member,
  balance: AccountBalance,
  amount: bigint,
): Promise<void> {
  if (m.withdrawalId === null) throw new Error('kit: the member has no withdrawal');
  const withdrawalId = m.withdrawalId;
  const [built] = buildVouchers('WITHDRAW:RETURN', {
    withdrawal_id: withdrawalId,
    user_id: m.userId,
    withdraw_fen: amount,
  });
  if (built === undefined) throw new Error('kit: WITHDRAW:RETURN built no voucher');
  await f.ledger.post(trx, {
    appId: m.appId,
    uniqKey: built.uniq_key,
    bizType: 'withdrawal',
    bizId: withdrawalId,
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: built.entries.map((entry) => ({
      account: { ownerType: 'user', accountId: balance.account_id },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    })),
  });
}

/** returnFrozenOn in a transaction of its own (users row, then balance row). */
export async function returnFrozen(f: AdjustFixture, m: Member, amount: bigint): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId: m.appId, userIds: [m.userId] });
    const [balance] = await f.ledger.lockBalances(trx, { appId: m.appId, userIds: [m.userId] });
    if (balance === undefined) throw new Error(`kit: ${m.userId} has no ledger account`);
    await returnFrozenOn(f, trx, m, balance, amount);
  });
}

// ---------------------------------------------------------------------------------------------
// The member's balance row held from the suite's one-connection holder pool.

export interface BalanceHold {
  /** The holder's backend pid. */
  readonly pid: number;
  /** True once the holder has the balance row (false when it ended first or after 10 s). */
  untilLocked(timeoutMs?: number): Promise<boolean>;
  /** Lets the holder run `beforeCommit` and commit; resolves when it has committed. */
  release(): Promise<void>;
}

function within<T>(promise: Promise<T>, timeoutMs: number, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(otherwise), timeoutMs);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * A transaction on the holder pool that takes the member's balance row through
 * ledger.lockBalances (SELECT … FOR UPDATE OF ab) — and the users row before it only when
 * `users` is set — then waits for release() and runs `beforeCommit` before it commits. Returns
 * once the holder's pid is known; with the row free it gets the lock at once, otherwise it waits
 * in PostgreSQL like any other writer.
 */
export async function holdBalance(
  f: AdjustFixture,
  m: Member,
  beforeCommit?: (trx: Transaction<DB>, balance: AccountBalance) => Promise<void>,
  options: { readonly users?: boolean } = {},
): Promise<BalanceHold> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let gotPid!: (pid: number) => void;
  const pidReady = new Promise<number>((resolve) => {
    gotPid = resolve;
  });
  let gotLock!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    gotLock = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
      gotPid(Number(result.rows[0]?.pid));
      if (options.users === true) {
        await lockUsersForUpdate(trx, { appId: m.appId, userIds: [m.userId] });
      }
      const [balance] = await f.ledger.lockBalances(trx, { appId: m.appId, userIds: [m.userId] });
      if (balance === undefined) throw new Error(`kit: ${m.userId} has no ledger account`);
      gotLock();
      await gate;
      if (beforeCommit !== undefined) await beforeCommit(trx, balance);
    });
  const ended = done.then(
    () => null,
    () => null,
  );
  const pid = await Promise.race([pidReady, ended]);
  if (pid === null) {
    await done;
    throw new Error('kit: the holder ended before it started');
  }
  return {
    pid,
    untilLocked(timeoutMs = 10_000) {
      return within(
        Promise.race([lockReady.then(() => true), ended.then(() => false)]),
        timeoutMs,
        false,
      );
    },
    async release() {
      open();
      await done;
    },
  };
}

/**
 * The statements of the backends waiting on a lock that backend `pid` holds, polled until there is
 * one ([] when a request ended first or after 10 s).
 */
export async function blockedBehind(
  f: AdjustFixture,
  pid: number,
  pending: readonly Tracked<unknown>[],
  timeoutMs = 10_000,
): Promise<string[]> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await sql<{ query: string }>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND ${pid}::int = ANY (pg_blocking_pids(pid))`.execute(f.db);
    if (result.rows.length > 0) return result.rows.map((row) => row.query);
    if (pending.some((request) => request.settled)) return [];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

/** The statement backend `pid` waits on a lock with, polled (null when it never waits in 10 s). */
export async function lockWaitOf(
  f: AdjustFixture,
  pid: number,
  timeoutMs = 10_000,
): Promise<{ readonly query: string; readonly blockers: number } | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await sql<{ query: string; blockers: number }>`
      SELECT query, cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity
      WHERE pid = ${pid}::int AND wait_event_type = 'Lock'`.execute(f.db);
    const row = result.rows[0];
    if (row !== undefined) return { query: row.query, blockers: Number(row.blockers) };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** A balance-row locking statement: account_balances … FOR UPDATE, not the NOWAIT re-lock. */
export function isBalanceLock(text: string): boolean {
  return (
    /\baccount_balances\b/i.test(text) &&
    /\bfor\s+update\b/i.test(text) &&
    !/\bnowait\b/i.test(text)
  );
}

export interface CacheRow {
  readonly account_id: string;
  readonly owner_type: string | null;
  readonly subject: string | null;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly negative_since: string | null;
  readonly version: bigint;
}

/** Every account_balances row of the app with its account's owner, by account_id. */
export async function balanceCache(f: AdjustFixture, appId = f.appId): Promise<CacheRow[]> {
  const result = await sql<CacheRow>`
    SELECT ab.account_id, la.owner_type, la.subject, ab.available_fen, ab.frozen_fen,
      to_char(ab.negative_since, 'YYYY-MM-DD') AS negative_since, ab.version
    FROM app.account_balances ab
    LEFT JOIN app.ledger_accounts la ON la.app_id = ab.app_id AND la.id = ab.account_id
    WHERE ab.app_id = ${appId}
    ORDER BY ab.account_id`.execute(f.db);
  return result.rows;
}

/** The member's row of a balanceCache snapshot. */
export function cacheRowOf(cache: readonly CacheRow[], m: Member): CacheRow {
  const row = cache.find((item) => item.account_id === m.accountId);
  if (row === undefined) throw new Error(`kit: no balance row of ${m.accountId}`);
  return row;
}

export interface LineSnapshot {
  readonly owner_type: string;
  readonly subject: string;
  readonly sub_account: string;
  readonly amount_fen: bigint;
  readonly balance_after_fen: bigint | null;
  readonly account_version: bigint | null;
}

/** The entries of the app's voucher `uniqKey` with their snapshots, platform lines first. */
export async function linesOf(
  f: AdjustFixture,
  uniqKey: string,
  appId = f.appId,
): Promise<LineSnapshot[]> {
  const result = await sql<LineSnapshot>`
    SELECT a.owner_type, a.subject, e.sub_account, e.amount_fen, e.balance_after_fen,
      e.account_version
    FROM app.ledger_entries e
    JOIN app.ledger_vouchers v ON v.app_id = e.app_id AND v.id = e.voucher_id
    JOIN app.ledger_accounts a ON a.app_id = e.app_id AND a.id = e.account_id
    WHERE v.app_id = ${appId} AND v.uniq_key = ${uniqKey}
    ORDER BY a.owner_type, a.subject, e.sub_account, e.amount_fen`.execute(f.db);
  return result.rows;
}

export interface Money {
  readonly available: bigint;
  readonly frozen: bigint;
  readonly negativeSince: string | null;
}

/** The member's balance row now. */
export async function moneyOf(f: AdjustFixture, m: Member): Promise<Money> {
  const [row] = await f.ledger.getBalances(f.db, { appId: m.appId, userIds: [m.userId] });
  if (row === undefined) throw new Error(`kit: ${m.userId} has no balance row`);
  return {
    available: row.available_fen,
    frozen: row.frozen_fen,
    negativeSince: row.negative_since,
  };
}

/** The daily ledger check (R3) of (app, day) recorded done, as its handler records it (B2-02s). */
export async function r3Done(f: AdjustFixture, day: string, appId = f.appId): Promise<void> {
  await f.db
    .withSchema('app')
    .insertInto('processed_events')
    .values({
      consumer: R3_DONE_CONSUMER,
      event_id: dailyCheckDoneEventId(appId, day),
      created_at: f.clock.now(),
    })
    .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
    .execute();
}

/** A config_items row of the app (set before the entry that reads it starts). */
export function configure(f: AdjustFixture, key: string, value: unknown, appId = f.appId) {
  return setConfig(f.db, appId, key, value);
}

// ---------------------------------------------------------------------------------------------
// Candidates.

export type CandidateStatus = 'PENDING' | 'APPROVED' | 'CANCELLED';

export interface CandidateRow {
  readonly id: string;
  readonly app_id: string;
  readonly account_id: string;
  readonly negative_since: string;
  readonly candidate_fen: bigint;
  readonly status: string;
  readonly initiator_id: string | null;
  readonly approver_id: string | null;
  readonly approved_at: Date | null;
  readonly voucher_id: string | null;
  readonly created_at: Date;
}

/** Every candidate of the app, by account_id then created_at then id. */
export async function candidates(f: AdjustFixture, appId = f.appId): Promise<CandidateRow[]> {
  const result = await sql<CandidateRow>`
    SELECT id, app_id, account_id, negative_since::text AS negative_since, candidate_fen, status,
      initiator_id, approver_id, approved_at, voucher_id, created_at
    FROM app.bad_debt_writeoffs WHERE app_id = ${appId}
    ORDER BY account_id, created_at, id`.execute(f.db);
  return result.rows;
}

/** One candidate as it is now. */
export async function candidateNow(f: AdjustFixture, id: string): Promise<CandidateRow> {
  const result = await sql<CandidateRow>`
    SELECT id, app_id, account_id, negative_since::text AS negative_since, candidate_fen, status,
      initiator_id, approver_id, approved_at, voucher_id, created_at
    FROM app.bad_debt_writeoffs WHERE id = ${id}`.execute(f.db);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`kit: candidate ${id} is missing`);
  return row;
}

/** The PENDING candidate the daily job must have generated for `m` at the clock's `at`. */
export function generatedFor(
  m: Member,
  expected: { readonly fen: bigint; readonly since: string; readonly at: string },
): Record<string, unknown> {
  return {
    id: expect.stringMatching(UUID),
    app_id: m.appId,
    account_id: m.accountId,
    negative_since: expected.since,
    candidate_fen: expected.fen,
    status: 'PENDING',
    initiator_id: null,
    approver_id: null,
    approved_at: null,
    voucher_id: null,
    created_at: new Date(expected.at),
  };
}

/**
 * Posts the BAD_DEBT_WRITEOFF voucher `BADDEBT:{account_id}:{candidateId}` of an earlier approval
 * (debit BAD_DEBT, credit USER_BALANCE.available by −available) on the plain ledger.
 */
async function postWriteoff(
  f: AdjustFixture,
  m: Member,
  candidateId: string,
): Promise<{ readonly voucherId: string; readonly amount: bigint }> {
  return f.db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId: m.appId, userIds: [m.userId] });
    const [balance] = await f.ledger.lockBalances(trx, { appId: m.appId, userIds: [m.userId] });
    if (balance === undefined) throw new Error(`kit: ${m.userId} has no ledger account`);
    const amount = -balance.available_fen;
    if (amount <= 0n) throw new Error('kit: an APPROVED seed needs available below 0');
    const line = (account: PostingEntry['account'], amountFen: bigint): PostingEntry => ({
      account,
      sub_account: 'available',
      amount_fen: amountFen,
      ledger_type: 'BAD_DEBT_WRITEOFF',
      sub_type: null,
      income_type: null,
    });
    const posted = await f.ledger.post(trx, {
      appId: m.appId,
      uniqKey: `BADDEBT:${m.accountId}:${candidateId}`,
      bizType: 'bad_debt_writeoff',
      bizId: candidateId,
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries: [
        line({ ownerType: 'user', accountId: balance.account_id }, -amount),
        line({ ownerType: 'platform', subject: 'BAD_DEBT' }, amount),
      ],
    });
    return { voucherId: posted.voucherId, amount };
  });
}

export interface CandidateSeed {
  readonly status?: CandidateStatus;
  /** candidate_fen; default −available of the member now. */
  readonly fen?: bigint;
  /** negative_since; default the member's balance's. */
  readonly since?: string;
  readonly createdAt?: Date;
  readonly initiatorId?: string | null;
}

/**
 * A candidate of `m` written directly, as the daily job (or an earlier approval) left it. An
 * APPROVED one first writes the member's available off with its BAD_DEBT_WRITEOFF voucher (the
 * member must be below 0) and has a seeded approver.
 */
export async function seedCandidate(
  f: AdjustFixture,
  m: Member,
  seed: CandidateSeed = {},
): Promise<CandidateRow> {
  const g = inApp(f, m.appId);
  const id = randomUUID();
  const money = await moneyOf(g, m);
  const status = seed.status ?? 'PENDING';
  const fen = seed.fen ?? -money.available;
  const since = seed.since ?? money.negativeSince;
  if (since === null) throw new Error('kit: a candidate needs a negative_since');
  const createdAt = seed.createdAt ?? new Date(GENERATED_AT);
  let approverId: string | null = null;
  let approvedAt: Date | null = null;
  let voucherId: string | null = null;
  if (status === 'APPROVED') {
    approverId = await seedAdmin(g, m.appId);
    approvedAt = new Date(createdAt.getTime() + 60 * 60_000);
    voucherId = (await postWriteoff(g, m, id)).voucherId;
  }
  await sql`INSERT INTO app.bad_debt_writeoffs
    (id, app_id, account_id, negative_since, candidate_fen, status, initiator_id, approver_id,
     approved_at, voucher_id, created_at)
    VALUES (${id}, ${m.appId}, ${m.accountId}, ${since}::date, ${fen}, ${status},
      ${seed.initiatorId ?? null}, ${approverId}, ${approvedAt}, ${voucherId}, ${createdAt})`.execute(
    g.db,
  );
  return candidateNow(g, id);
}

/** The vouchers of the app whose uniq_key starts with BADDEBT:, by uniq_key. */
export async function badDebtVouchers(f: AdjustFixture, appId = f.appId): Promise<VoucherRow[]> {
  const result = await sql<VoucherRow>`
    SELECT id, uniq_key, biz_type, biz_id, operator, accounting_date::text AS accounting_date,
      order_key, beneficiary_user_id, role, voucher_kind
    FROM app.ledger_vouchers WHERE app_id = ${appId} AND uniq_key LIKE 'BADDEBT:%'
    ORDER BY uniq_key`.execute(f.db);
  return result.rows;
}

/** The uniq_key of the write-off of a candidate (BR-FUND-12). */
export function writeoffKey(row: Pick<CandidateRow, 'account_id' | 'id'>): string {
  return `BADDEBT:${row.account_id}:${row.id}`;
}

/** The audit records of the app, in insertion order; only `action` when given. */
export function audits(f: AdjustFixture, action?: string, appId = f.appId): Promise<AuditRow[]> {
  let query = f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', appId);
  if (action !== undefined) query = query.where('action', '=', action);
  return query.orderBy('id').execute();
}

/**
 * Everything an approval may change in the app: candidates, vouchers, entries, balances,
 * withdrawals, events and its bad_debt_writeoff_approve audit records (other actions, such as a
 * denial record some guard may keep, are left out).
 */
export async function everything(f: AdjustFixture, appId = f.appId) {
  const entries = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.ledger_entries WHERE app_id = ${appId}`.execute(f.db);
  return {
    candidates: await candidates(f, appId),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    entries: entries.rows[0]?.n ?? '0',
    balances: await f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    withdrawals: await f.db
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    events: await f.db
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audits: await audits(f, APPROVE_ACTION, appId),
  };
}

/** The ledger of the app (vouchers, entry count, balances): the generation must not touch it. */
export async function ledgerState(f: AdjustFixture) {
  const all = await everything(f);
  return { vouchers: all.vouchers, entries: all.entries, balances: all.balances };
}

// ---------------------------------------------------------------------------------------------
// Views.

/** The AdminBadDebtWriteoff a candidate must be shown as (instants as epoch milliseconds). */
export function rowView(
  row: CandidateRow,
  m: Member,
  money: Pick<Money, 'available' | 'frozen'>,
  options: { readonly day: string; readonly blocked: boolean },
): Record<string, unknown> {
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: m.userId,
    negative_since: row.negative_since,
    negative_days: daysBetween(row.negative_since, options.day),
    candidate_fen: Number(row.candidate_fen),
    available_fen: Number(money.available),
    frozen_fen: Number(money.frozen),
    status: row.status,
    approve_blocked: options.blocked,
    initiator_id: row.initiator_id,
    approver_id: row.approver_id,
    approved_at: row.approved_at === null ? null : row.approved_at.getTime(),
    voucher_id: row.voucher_id,
    created_at: row.created_at.getTime(),
  };
}

/** A response AdminBadDebtWriteoff with its date-time strings as epoch milliseconds. */
export function normalizeView(item: unknown): Record<string, unknown> {
  expect(typeof item === 'object' && item !== null, JSON.stringify(item)).toBe(true);
  const out: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of ['created_at', 'approved_at']) {
    const value = out[key];
    if (typeof value === 'string') out[key] = Date.parse(value);
  }
  return out;
}

/** Candidates newest first: created_at descending, then id descending. */
export function newestFirst(rows: readonly CandidateRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const at = b.created_at.getTime() - a.created_at.getTime();
      if (at !== 0) return at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    })
    .map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------
// The worker assembly.

type Entry = 'worker' | 'api' | 'stream' | 'admin' | 'payout';

interface Forwarding {
  forWorker(...args: unknown[]): unknown;
}

/** The module under test, reached through a cast so that its absence is an assertion. */
export function writeoffModule(): Forwarding {
  const target = (ledgerModule as unknown as { LedgerBadDebtWriteoffModule?: Forwarding })
    .LedgerBadDebtWriteoffModule;
  expect(
    typeof target?.forWorker,
    'ledger/index.ts does not export LedgerBadDebtWriteoffModule.forWorker',
  ).toBe('function');
  return target!;
}

/** The forWorker calls of app.module on `entry` (captured; the module is not built). */
export async function assembledBy(entry: Entry): Promise<unknown[][]> {
  const target = writeoffModule();
  const loaded = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi.spyOn(target, 'forWorker').mockReturnValue({ module: target });
  try {
    loaded.AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock(NOW),
      logger: rootLogger().logger,
    });
    return [...forWorker.mock.calls];
  } finally {
    forWorker.mockRestore();
  }
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the admin entry's database handle.

/** The INSERT of the bad_debt_writeoff_approve audit record, or the UPDATE of the candidate. */
export type FaultPoint = 'audit' | 'candidate';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

interface Pause {
  readonly reached: () => void;
  readonly gate: Promise<void>;
}

/** The admin entry's balance-row locking statements (isBalanceLock), and an optional pause. */
interface LockWatch {
  readonly issued: string[];
  /** One-shot: the next such statement's result is held back until its gate opens. */
  pause: Pause | null;
}

function faultPlugin(fault: Fault, watch: LockWatch): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  const held = new WeakMap<object, Pause>();
  return {
    transformQuery({ node, queryId }) {
      const compiled = compiler.compileQuery(node, queryId);
      const text = compiled.sql;
      if (isBalanceLock(text)) {
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
            (text.includes(APPROVE_ACTION) || params.includes(APPROVE_ACTION))
          : /\bupdate\s+(?:"?app"?\s*\.\s*)?"?bad_debt_writeoffs\b/i.test(text);
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

export interface PausedLock {
  /** True once the entry's balance lock statement has returned and is held back. */
  untilReached(pending: Tracked<unknown>, timeoutMs?: number): Promise<boolean>;
  /** Lets the held-back statement's result through (and disarms the pause if never reached). */
  resume(): void;
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'approve';

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
}

export interface CallerOptions {
  readonly superAdmin?: boolean;
  /** A registered verify phone (sms tier); default true. */
  readonly phone?: boolean;
}

export interface ApproveOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `writer` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh sms-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface WriteoffAdmin {
  readonly fault: Fault;
  /** The SQL of every balance-row locking statement the entry sent (isBalanceLock), in order. */
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
  /** POST /admin/v1/bad-debt-writeoffs/{id}/approve with the JSON body ({} by default). */
  approve(id: string, body?: unknown, options?: ApproveOptions): Promise<AdminSent>;
  /** GET /admin/v1/bad-debt-writeoffs with the query, as `viewer` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** An account with fund.writeoff only and a registered verify phone. */
  readonly writer: AdminCaller;
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
  return `bdw_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the approval of a candidate. */
export function approvePath(id: string): string {
  return `${LIST_PATH}/${encodeURIComponent(id)}/approve`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withWriteoffAdmin(
  f: AdjustFixture,
  run: (h: WriteoffAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-12f-'));
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
            pending.promise.then(
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
        JWT_KEY_ID: 'b2_12f_test',
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
    const caller: WriteoffAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `bdw_${id}`,
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
    const stepUp: WriteoffAdmin['stepUp'] = async (who, tier = 'sms') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const writer = await caller([WRITEOFF]);
    const viewer = await caller([VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    await run({
      fault,
      balanceLocks: watch.issued,
      pauseAfterBalanceLock,
      caller,
      stepUp,
      writer,
      viewer,
      async approve(id, body = {}, options = {}) {
        const who = options.caller === undefined ? writer : options.caller;
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
          url: approvePath(id),
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return sent('approve', response);
      },
      async list(query, who) {
        const actor = who === undefined ? viewer : who;
        const text = new URLSearchParams(query ?? {}).toString();
        const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
        if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
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
  list: { path: LIST_PATH, method: 'get' },
  approve: { path: APPROVE_PATH, method: 'post' },
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
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 20001 with exactly these data.fields. */
export function invalid(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

/** 20001 of an unknown candidate or one of another app. */
export function unknownCandidate(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['id'] });
}

/** 20001 writeoff_frozen_pending: frozen money while the switch is on. */
export function frozenPending(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['id'], reason: 'writeoff_frozen_pending' });
}

/** 20902 of a candidate that is no longer PENDING. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'bad_debt_writeoff' });
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

/** 20001 at the route schema: data.fields contains `field`. */
export async function schemaRefused(sent: AdminSent, field: string): Promise<void> {
  const body = await answer(sent, 20001);
  const fields = (body.data as { fields?: unknown } | undefined)?.fields;
  expect(Array.isArray(fields), sent.body).toBe(true);
  expect(fields as unknown[], sent.body).toContain(field);
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response, items normalized. */
export async function pageOf(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual(['items', 'page', 'page_size', 'total']);
  const items = data['items'];
  expect(Array.isArray(items), sent.body).toBe(true);
  return {
    items: (items as unknown[]).map(normalizeView),
    page: data['page'] as number,
    page_size: data['page_size'] as number,
    total: data['total'] as number,
  };
}

export interface Approval {
  /** data.writeoff, its instants as epoch milliseconds. */
  readonly writeoff: Record<string, unknown>;
  readonly written_off_fen: unknown;
}

/** The data of a successful approval: exactly writeoff and written_off_fen. */
export async function approvalOf(sent: AdminSent): Promise<Approval> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual(['writeoff', 'written_off_fen']);
  return { writeoff: normalizeView(data['writeoff']), written_off_fen: data['written_off_fen'] };
}

const PERSONAL = /phone|nickname|avatar|real_?name|id_no|payee|mobile/i;

/**
 * Exactly one bad_debt_writeoff_approve record by `adminId`, naming the candidate and the account,
 * with the resulting status, written_off_fen and available before and after; no personal data
 * (no personal field name, not the member's nickname).
 */
export async function expectApproveAudit(
  f: AdjustFixture,
  expected: {
    readonly adminId: string;
    readonly row: CandidateRow;
    readonly status: 'APPROVED' | 'CANCELLED';
    readonly writtenOff: bigint;
    readonly before: bigint;
    readonly after: bigint;
  },
): Promise<void> {
  const recorded = await audits(f, APPROVE_ACTION);
  expect(recorded, APPROVE_ACTION).toHaveLength(1);
  const row = recorded[0]!;
  expect(row.admin_id).toBe(expected.adminId);
  expectMentions(row, {
    ids: [expected.row.id, expected.row.account_id],
    values: [
      expected.status,
      expected.writtenOff.toString(),
      expected.before.toString(),
      expected.after.toString(),
    ],
  });
  const text = JSON.stringify([row.target, row.before, row.after]);
  expect(text, 'no personal field').not.toMatch(PERSONAL);
  expect(text, 'not the nickname').not.toContain('"synthetic"');
}

/**
 * A write-off in effect (BR-FUND-12, BD2, BR-FUND-16): the answer is the candidate APPROVED by
 * `adminId` at the clock with written_off_fen `amount`; the row is the seed plus status, approver,
 * approved_at and its voucher; the one voucher `BADDEBT:{account_id}:{id}` on the clock's
 * accounting day whose entries are exactly the BAD_DEBT_WRITEOFF template's (debit BAD_DEBT, credit
 * USER_BALANCE.available) and balance; available 0, frozen as it was, negative_since cleared; the
 * user line's balance_after_fen 0 and account_version the member's version now. With `cache` (the
 * app's balanceCache before the request): the member's version is exactly the snapshot's plus
 * `postedBefore` (other postings to the member after the snapshot, before the write-off) plus 1,
 * no other account_balances row of the app changed, and there is no balance row of a platform
 * account (BR-FUND-16: platform subjects have no real-time cache).
 */
export async function expectWrittenOff(
  f: AdjustFixture,
  sent: AdminSent,
  e: {
    readonly row: CandidateRow;
    readonly m: Member;
    readonly adminId: string;
    readonly amount: bigint;
    readonly frozen: bigint;
    readonly cache?: readonly CacheRow[];
    readonly postedBefore?: number;
  },
): Promise<CandidateRow> {
  const done = await approvalOf(sent);
  expect(done.written_off_fen, sent.body).toBe(Number(e.amount));
  const now = await candidateNow(f, e.row.id);
  expect(now.voucher_id, 'voucher_id').not.toBeNull();
  expect(now).toEqual({
    ...e.row,
    status: 'APPROVED',
    approver_id: e.adminId,
    approved_at: f.clock.now(),
    voucher_id: now.voucher_id,
  });
  const g = inApp(f, e.m.appId);
  const key = writeoffKey(e.row);
  const voucher = await voucherByKey(g, key);
  expect(voucher, key).toBeDefined();
  expect(voucher!.id).toBe(now.voucher_id);
  expect(voucher!.accounting_date).toBe(accountingDay(f.clock.now()));
  const entries = await entriesOf(g, key);
  expect(entries, 'BAD_DEBT_WRITEOFF').toEqual(
    templateEntries('BAD_DEBT_WRITEOFF', { userId: e.m.userId, platform: null, amount: e.amount }),
  );
  expect(
    entries.reduce((sum, entry) => sum + entry.amount_fen, 0n),
    'Σ amount_fen',
  ).toBe(0n);
  const ofAccount = (await badDebtVouchers(g)).filter((v) =>
    v.uniq_key.startsWith(`BADDEBT:${e.m.accountId}:`),
  );
  expect(
    ofAccount.map((v) => v.uniq_key),
    'one write-off voucher of the account',
  ).toEqual([key]);
  expect(await moneyOf(g, e.m)).toEqual({ available: 0n, frozen: e.frozen, negativeSince: null });
  const cacheNow = await balanceCache(g);
  const version = cacheRowOf(cacheNow, e.m).version;
  const userLines = (await linesOf(g, key)).filter((line) => line.owner_type === 'user');
  expect(
    userLines.map((line) => ({
      balance_after_fen: line.balance_after_fen,
      account_version: line.account_version,
    })),
    'the user line: balance_after_fen 0, account_version the balance row version',
  ).toEqual([{ balance_after_fen: 0n, account_version: version }]);
  if (e.cache !== undefined) {
    const before = cacheRowOf(e.cache, e.m);
    const expected = before.version + BigInt(e.postedBefore ?? 0) + 1n;
    expect(version, 'account_balances.version: exactly one more for the write-off').toBe(expected);
    expect(cacheNow, 'account_balances: only the member row changed').toEqual(
      e.cache.map((item) =>
        item.account_id === e.m.accountId
          ? { ...item, available_fen: 0n, negative_since: null, version: expected }
          : item,
      ),
    );
    expect(
      cacheNow.filter((item) => item.owner_type !== 'user'),
      'no balance row of a platform account (BAD_DEBT has no real-time cache)',
    ).toEqual([]);
  }
  expect(done.writeoff).toEqual(
    rowView(
      now,
      e.m,
      { available: 0n, frozen: e.frozen },
      {
        day: accountingDay(f.clock.now()),
        blocked: false,
      },
    ),
  );
  return now;
}

/**
 * A cancellation (BD3): HTTP 200 with written_off_fen 0, the candidate CANCELLED with approver_id,
 * approved_at and voucher_id null, no BADDEBT voucher of the account and the balance unchanged.
 */
export async function expectCancelled(
  f: AdjustFixture,
  sent: AdminSent,
  e: { readonly row: CandidateRow; readonly m: Member; readonly money: Money },
): Promise<CandidateRow> {
  const done = await approvalOf(sent);
  expect(done.written_off_fen, sent.body).toBe(0);
  const now = await candidateNow(f, e.row.id);
  expect(now).toEqual({
    ...e.row,
    status: 'CANCELLED',
    approver_id: null,
    approved_at: null,
    voucher_id: null,
  });
  const g = inApp(f, e.m.appId);
  expect(
    (await badDebtVouchers(g)).filter((v) => v.uniq_key.startsWith(`BADDEBT:${e.m.accountId}:`)),
    'no write-off voucher',
  ).toEqual([]);
  expect(await moneyOf(g, e.m)).toEqual(e.money);
  expect(done.writeoff).toEqual(
    rowView(now, e.m, e.money, { day: accountingDay(f.clock.now()), blocked: false }),
  );
  return now;
}
