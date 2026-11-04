// B2-09m rule-test harness (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchManualPaid (POST /admin/v1/withdrawals/batch-manual-paid: payout.manual_entry, totp step-up,
// Idempotency-Key, one audit withdrawal_manual_paid per paid item), 08 BR-WDR-16, BR-WDR-09, BR-WDR-17,
// BR-WDR-20, BR-WDR-26, 编排裁定 D10-591, D10-595, D10-596.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks, the
// step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
// started JOB_QUEUE and the event bus, the field cipher of the process), the review and EXECUTE routes
// next to the one under test, the real ledger, notification's withdrawal result consumer, PostgreSQL
// through @couli/db/testing (couli_app for the entry and the seeds, couli_payout for the attempt rows),
// Redis for the admin sessions.
// Synthetic: members with their verified real names, withdrawals (INSERT plus their real WITHDRAW:FREEZE
// voucher, as W1 leaves them), attempts, holds, batches and items, risk states, appeals, W rows and
// config rows, written directly as their writers would have left them (../admin-withdrawal-review/
// review-harness.ts, ../admin-payout-batch/batch-harness.ts); admin accounts; a one-shot fault in the
// entry's database handle. The totp step-up token is issued the way POST /admin/v1/auth/step-up issues
// it after a correct authenticator code. No real user or payee data. Expected amounts are written by
// hand in the tests: amount 12,560 = net 12,347 + fee 125 + tax 88, none divisible by 3 or 7, fee and
// tax different. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Transaction } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createPayoutLanding } from '../../../../apps/api/src/modules/payout/application/payout-landing.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
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
import type { Tracked } from '../../ledger/admin-recon-close/kit.ts';
import {
  contractPaths,
  fixture as writeOffFixture,
  type WriteOffSuite,
} from '../../ledger/admin-recon-write-off/kit.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { BATCH_PATH, world } from '../admin-payout-batch/batch-harness.ts';
import {
  withOffset,
  type Member,
  type Sealer,
  type WithdrawalRow,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';
import {
  APPROVE_PATH,
  ago,
  member,
  newKey,
  seedApproved,
  seedReturned,
  seedReview,
  textOf,
  track,
  waiting,
  type ReviewFixture,
} from '../admin-withdrawal-review/review-harness.ts';
import { randomHmac, seedRealname } from '../tax-ytd/kit.ts';

export { withdrawalVouchers } from '../../ledger/admin-recon-write-off/kit.ts';
export {
  HOUR,
  MINUTE,
  PLENTY,
  heldOnBatch,
  item,
  itemsOf,
  lockWithdrawal,
  moveToPaying,
  payoutJobs,
  seedAppeal,
  seedRisk,
  seedW,
  transferJob,
  auditFacts,
} from '../admin-payout-batch/batch-harness.ts';
export { withOffset } from '../admin-withdrawals/kit.ts';
export {
  ACCOUNT,
  MESSAGE_QUEUE,
  NOTE,
  PAYER_SIDE,
  SWITCH,
  adjust,
  ago,
  approvedItem,
  audits,
  balanceOf,
  changes,
  deliverMessage,
  entries,
  expectNoSecrets,
  fixture,
  frozenMismatches,
  lockUsersRow,
  member,
  messageJobs,
  newKey,
  otherApp,
  rowOf,
  secretsOf,
  seedAttempt,
  seedHold,
  seedQueries,
  seedRiskState,
  setSwitch,
  suite,
  textOf,
  track,
  voucherOf,
  waiting,
  type AttemptResult,
  type Member,
  type ReviewFixture,
  type WithdrawalRow,
} from '../admin-withdrawal-review/review-harness.ts';

export const MANUAL_PAID_PATH = '/admin/v1/withdrawals/batch-manual-paid';
/** specs/permissions.yaml. */
export const ENTRY = 'payout.manual_entry';
export const EXECUTE = 'payout.execute';
export const REVIEW = 'withdraw.review';
export const VIEW = 'fund.view';
/** The audit action of the contract. */
export const ACTION = 'withdrawal_manual_paid';

/** The defaults of a seed, written by hand (see the head of this file). */
export const AMOUNT = 12_560n;
export const NET = 12_347n;
export const FEE = 125n;
export const TAX = 88n;
/** A member's balance, enough for many withdrawals; available after one default withdrawal. */
export const RICH = 9_000_001n;
export const AFTER_FREEZE = 8_987_441n;

const MONEY = { amount_fen: AMOUNT, fee_fen: FEE, tax_fen: TAX } as const;

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// Fixtures and seeds (inside withManualAdmin: the phone and the payee go through the entry's cipher).

/** The review fixture at another instant of the clock (the year boundary cases). */
export function fixtureAt(s: WriteOffSuite, instant: string): ReviewFixture {
  return { ...writeOffFixture(s, instant), s };
}

export interface Payee extends Member {
  /** id_no_hmac of the verified real name: tax_ytd's identity. */
  readonly hmac: string;
}

/** A member with a balance and a verified real name, the precondition of every withdrawal. */
export async function payee(f: ReviewFixture, h: Sealer, balance: bigint = RICH): Promise<Payee> {
  const who = await member(f, h, balance);
  const hmac = randomHmac();
  await seedRealname(f.db, who.appId, who.userId, { status: 'verified', hmac });
  return { ...who, hmac };
}

/** An APPROVED withdrawal, net 12,347, frozen, reviewed by somebody else and never on a batch. */
export function approved(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedApproved(f, h, who, { ...MONEY, ...seed });
}

/** A withdrawal waiting for review, net 12,347, frozen; `status` in the seed gives another state. */
export function reviewing(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedReview(f, h, who, { ...MONEY, ...seed });
}

/**
 * As W9 leaves it after a payer-side failure (BR-WDR-17): APPROVED, hold_reason
 * payer_side_after_transfer, on its batch, one failed transfer attempt, no query.
 */
export function returned(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedReturned(f, h, who, { ...MONEY, ...seed });
}

/** The money of one withdrawal for a chosen net, fee and tax as the defaults. */
export function ofNet(net: bigint): {
  readonly amount_fen: bigint;
  readonly fee_fen: bigint;
  readonly tax_fen: bigint;
} {
  return { amount_fen: net + FEE + TAX, fee_fen: FEE, tax_fen: TAX };
}

/** One kind=query attempt with a chosen id (the tie of `at` falls to `id`), as couli_payout. */
export async function seedQueryWithId(
  f: ReviewFixture,
  row: WithdrawalRow,
  id: string,
  result: 'success' | 'fail' | 'unknown',
  at: Date,
): Promise<void> {
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result,
     latency_ms, at)
    VALUES (${id}, ${row.app_id}, ${row.id}, 'query',
      ${JSON.stringify({ out_biz_no: row.out_biz_no })}::jsonb, ${null}::jsonb, ${null}, ${null},
      ${result}, 12, ${at})`.execute(f.payout);
}

/** Two fresh ids of which the second sorts after the first, in PostgreSQL's uuid order. */
export function lowAndHigh(): { readonly low: string; readonly high: string } {
  const stem = randomUUID().slice(0, -1);
  return { low: `${stem}1`, high: `${stem}9` };
}

/** A tax_ytd row of the member's identity, as earlier paid withdrawals of the year left it. */
export async function seedTaxRow(
  f: ReviewFixture,
  who: Payee,
  year: number,
  incomeFen: bigint,
  withheldFen: bigint,
): Promise<void> {
  const at = ago(f, 60);
  await sql`INSERT INTO app.tax_ytd
    (id, app_id, user_id, year, income_type, identity_hmac, cum_income_fen, cum_withheld_fen,
     continuous_months, created_at, updated_at)
    VALUES (${randomUUID()}, ${who.appId}, ${who.userId}, ${year}, 'SERVICE_FEE', ${who.hmac},
      ${incomeFen}, ${withheldFen}, 0, ${at}, ${at})`.execute(f.db);
}

/** What W5 does for the same money: the real landing on a PAYING row (no tax_ytd, no job). */
export async function landThroughChannel(f: ReviewFixture, row: WithdrawalRow): Promise<void> {
  const landing = createPayoutLanding({
    db: f.db,
    ledger: f.ledger,
    lockUsersForUpdate,
    eventBus: createEventBus({
      clock: f.clock,
      queue: { send: async () => randomUUID() },
      subscriptions: [],
    }),
    logger: { warn: () => undefined },
    conflictMessage: 'b2_09m_w5_conflict',
  });
  const moved = await landing.success(
    row,
    { raw: { code: '10000' }, channelOrderId: `W5${randomBytes(8).toString('hex')}` },
    f.clock.now(),
  );
  expect(moved, `W5 of ${row.id}`).toBe(true);
}

// ---------------------------------------------------------------------------------------------
// Request items and what must come back.

export interface ManualPaidEntry {
  readonly withdrawal_id: string;
  readonly channel_order_id: string;
  readonly paid_at: string;
  readonly paid_fen: number;
}

/** A fresh synthetic channel serial number. */
export function serial(): string {
  return `2026110322${randomBytes(8).toString('hex')}`;
}

/** The item that records `row` as paid correctly, 5 minutes before the clock; `patch` overrides. */
export function entryOf(
  f: ReviewFixture,
  row: { readonly id: string; readonly net_fen: bigint },
  patch: Partial<ManualPaidEntry> = {},
): ManualPaidEntry {
  return {
    withdrawal_id: row.id,
    channel_order_id: serial(),
    paid_at: withOffset(ago(f, 5)),
    paid_fen: Number(row.net_fen),
    ...patch,
  };
}

export type SkipReason =
  | 'not_found'
  | 'not_approved'
  | 'channel_not_allowed'
  | 'amount_mismatch'
  | 'paid_at_invalid'
  | 'has_transfer_attempt'
  | 'query_required'
  | 'query_success'
  | 'member_blocked'
  | 'channel_order_id_taken'
  | 'identity_missing';

export interface ItemResult {
  readonly withdrawal_id: string;
  readonly result: 'paid' | 'skipped';
  readonly reason: SkipReason | null;
}

export function paid(id: string): ItemResult {
  return { withdrawal_id: id, result: 'paid', reason: null };
}

export function skipped(id: string, reason: SkipReason): ItemResult {
  return { withdrawal_id: id, result: 'skipped', reason };
}

/** The row after W8 by `adminId` from `entry`: only the columns the contract lists changed. */
export function asPaidManual(
  f: ReviewFixture,
  row: WithdrawalRow,
  entry: ManualPaidEntry,
  adminId: string,
): WithdrawalRow {
  return {
    ...row,
    status: 'PAID_MANUAL',
    paid_at: new Date(entry.paid_at),
    channel_order_id: entry.channel_order_id,
    manual_entry_by: adminId,
    manual_confirm_by: adminId,
    hold_reason: null,
    hold_at: null,
    row_version: row.row_version + 1,
    updated_at: f.clock.now(),
  };
}

/** One line of the voucher's entries on the member's frozen subaccount. */
export function userLine(amount: bigint, ledgerType: string) {
  return {
    owner_type: 'user',
    subject: 'USER_BALANCE',
    sub_account: 'frozen',
    amount_fen: amount,
    ledger_type: ledgerType,
  };
}

/** One line of the voucher's entries on a platform subject. */
export function platformLine(subject: string, amount: bigint, ledgerType: string) {
  return {
    owner_type: 'platform',
    subject,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: ledgerType,
  };
}

// ---------------------------------------------------------------------------------------------
// What the tests read.

/** The app's tax_ytd rows. */
export function taxRows(f: ReviewFixture, app: string = f.appId) {
  return f.db.selectFrom('tax_ytd').selectAll().where('app_id', '=', app).orderBy('id').execute();
}

/** The member's tax_ytd rows without their ids and times, by year. */
export function taxOf(f: ReviewFixture, who: Member) {
  return f.db
    .selectFrom('tax_ytd')
    .select(['year', 'income_type', 'identity_hmac', 'cum_income_fen', 'cum_withheld_fen'])
    .where('app_id', '=', who.appId)
    .where('user_id', '=', who.userId)
    .orderBy('year')
    .execute();
}

/** Everything of the app W8 could write, for before / after comparisons. */
export async function state(f: ReviewFixture, app: string = f.appId) {
  return { ...(await world(f, app)), tax: await taxRows(f, app) };
}
export type State = Awaited<ReturnType<typeof state>>;

/** Nothing but the idempotency record of the request changed. */
export function expectNothingWritten(before: State, after: State): void {
  expect({ ...after, idempotency: [] }).toEqual({ ...before, idempotency: [] });
}

// ---------------------------------------------------------------------------------------------
// Locks held from outside, and requests that must be seen waiting on them.

export interface Held {
  /** Runs `during` on the holding transaction (the lock still held), then commits it. */
  release(during?: (trx: Transaction<DB>) => Promise<void>): Promise<void>;
}

async function holding(
  f: ReviewFixture,
  take: (trx: Transaction<DB>) => Promise<void>,
): Promise<Held> {
  type During = ((trx: Transaction<DB>) => Promise<void>) | undefined;
  let openGate!: (during: During) => void;
  const gate = new Promise<During>((resolve) => {
    openGate = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.db.transaction().execute(async (trx) => {
    await take(trx);
    locked();
    const during = await gate;
    if (during !== undefined) await during(trx);
  });
  await Promise.race([ready, done]);
  return {
    async release(during) {
      openGate(during);
      await done;
    },
  };
}

/**
 * Holds the member's tax_ytd row: W8 has passed its CAS and written its voucher when it reaches this
 * row, so it stops there with the serial number written but not committed.
 */
export function holdTaxRow(f: ReviewFixture, who: Member): Promise<Held> {
  return holding(f, async (trx) => {
    const rows = await sql`SELECT id FROM app.tax_ytd
      WHERE app_id = ${who.appId} AND user_id = ${who.userId} FOR UPDATE`.execute(trx);
    expect(rows.rows, `tax_ytd of ${who.userId}`).toHaveLength(1);
  });
}

export interface HeldSerial {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Another transaction has written `value` on `row` and not committed: no read sees it, and an insert of
 * the same number into withdrawals_channel_order_id_key waits for the end of that transaction.
 */
export async function holdSerial(
  f: ReviewFixture,
  row: WithdrawalRow,
  value: string,
): Promise<HeldSerial> {
  const rolledBack = new Error('holdSerial: rolled back by the test');
  let openGate!: (commit: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    openGate = resolve;
  });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => {
    written = resolve;
  });
  const done = f.db
    .transaction()
    .execute(async (trx) => {
      const moved = await sql`UPDATE app.withdrawals SET channel_order_id = ${value}
        WHERE app_id = ${row.app_id} AND id = ${row.id}`.execute(trx);
      expect(moved.numAffectedRows, `withdrawal ${row.id}`).toBe(1n);
      written();
      if (!(await gate)) throw rolledBack;
    })
    .catch((error: unknown) => {
      if (error !== rolledBack) throw error;
    });
  await Promise.race([ready, done]);
  return {
    async commit() {
      openGate(true);
      await done;
    },
    async rollback() {
      openGate(false);
      await done;
    },
  };
}

/** Another transaction moves the member's available by `delta` while holding the users row. */
export async function adjustOn(
  trx: Transaction<DB>,
  f: ReviewFixture,
  who: Member,
  delta: bigint,
): Promise<void> {
  const appId = who.appId;
  const [balance] = await f.ledger.lockBalances(trx, { appId, userIds: [who.userId] });
  if (balance === undefined) throw new Error('seed: the member has no balance row');
  const adjustment = voucher(appId, balance.account_id, -delta);
  await f.ledger.post(trx, {
    ...adjustment,
    entries: adjustment.entries.map((line) => ({ ...line, ledger_type: 'ADMIN_ADJUST' })),
  });
}

/** Another transaction adds an effective hold while holding the users row (BR-WDR-07). */
export async function holdOn(trx: Transaction<DB>, f: ReviewFixture, who: Member): Promise<void> {
  await sql`INSERT INTO app.withdraw_holds (id, app_id, user_id, reason, created_by, created_at)
    VALUES (${randomUUID()}, ${who.appId}, ${who.userId}, 'manual', 'system',
      ${f.clock.now()})`.execute(trx);
}

/**
 * Sends `request`, proves it waits on `lock`, runs `during` on the holder and commits it, then
 * returns the answer. When the request does not wait the assertion fails and `during` never runs.
 */
export async function whileHeld(
  f: ReviewFixture,
  lock: Held,
  request: () => Promise<AdminSent>,
  message: string,
  during?: (trx: Transaction<DB>) => Promise<void>,
): Promise<AdminSent> {
  const one = track(request());
  let proven = false;
  try {
    expect(await waiting(f, 1, [one]), message).toBe(true);
    proven = true;
  } finally {
    await lock.release(proven ? during : undefined);
    await Promise.allSettled([one.promise]);
  }
  return one.promise;
}

/**
 * Sends `first` and proves it waits on `lock`, then `second` and proves both wait, then commits the
 * holder and returns both answers. `first` is ahead of `second` in the lock order the test sets up.
 */
export async function bothWaiting(
  f: ReviewFixture,
  lock: Held,
  first: () => Promise<AdminSent>,
  second: () => Promise<AdminSent>,
  firstWaits: string,
  secondWaits: string,
): Promise<readonly [AdminSent, AdminSent]> {
  const one = track(first());
  const started: Tracked<AdminSent>[] = [one];
  try {
    expect(await waiting(f, 1, [one]), firstWaits).toBe(true);
    const two = track(second());
    started.push(two);
    expect(await waiting(f, 2, [one, two]), secondWaits).toBe(true);
  } finally {
    await lock.release();
    await Promise.allSettled(started.map((request) => request.promise));
  }
  return [await one.promise, await started[1]!.promise];
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** Where the next failure is thrown; each is one statement of an item's transaction. */
export type FaultPoint = 'audit' | 'voucher' | 'tax_ytd';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  /** When set, only a statement whose parameters contain this text matches (one id of a request). */
  contains: string | null;
  tripped: number;
}

function insertsInto(text: string, table: string): boolean {
  return new RegExp(String.raw`\binsert\s+into\s+(?:"?app"?\s*\.\s*)?"?${table}\b`, 'i').test(text);
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      const parameters = textOf(compiled.parameters);
      const statement =
        point === 'voucher'
          ? insertsInto(compiled.sql, 'ledger_vouchers')
          : point === 'tax_ytd'
            ? insertsInto(compiled.sql, 'tax_ytd')
            : insertsInto(compiled.sql, 'audit_logs') && parameters.includes(ACTION);
      if (statement && (fault.contains === null || parameters.includes(fault.contains))) {
        fault.point = null;
        fault.contains = null;
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

export type Operation = 'manualPaid' | 'execute' | 'approve';

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

export interface WriteOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: the operation's default account by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface ManualAdmin extends Sealer {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/withdrawals/batch-manual-paid with these items, as `entry` by default. */
  manualPaid(items: readonly ManualPaidEntry[], options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/withdrawals/batch-manual-paid with any JSON body. */
  manualPaidBody(body: unknown, options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/payout-batches with these ids, as `executor` by default. */
  execute(ids: readonly string[], options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/withdrawals/batch-approve with these ids, as `reviewer` by default. */
  approve(ids: readonly string[], options?: WriteOptions): Promise<AdminSent>;
  /** An account with payout.manual_entry only. */
  readonly entry: AdminCaller;
  /** An account with payout.execute only. */
  readonly executor: AdminCaller;
  /** An account with withdraw.review only. */
  readonly reviewer: AdminCaller;
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

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withManualAdmin(
  f: ReviewFixture,
  run: (h: ManualAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-09m-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, contains: null, tripped: 0 };
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
        JWT_KEY_ID: 'b2_09m_test',
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
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: ManualAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `mp_${id}`,
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
    const stepUp: ManualAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const entry = await caller([ENTRY]);
    const executor = await caller([EXECUTE]);
    const reviewer = await caller([REVIEW]);
    const viewer = await caller([VIEW]);
    const post = async (
      op: Operation,
      url: string,
      body: unknown,
      options: WriteOptions,
      fallback: AdminCaller,
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? fallback : options.caller;
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
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      crypto,
      fault,
      caller,
      stepUp,
      entry,
      executor,
      reviewer,
      viewer,
      manualPaid: (items, options = {}) =>
        post('manualPaid', MANUAL_PAID_PATH, { items }, options, entry),
      manualPaidBody: (body, options = {}) =>
        post('manualPaid', MANUAL_PAID_PATH, body, options, entry),
      execute: (ids, options = {}) =>
        post('execute', BATCH_PATH, { withdrawal_ids: ids }, options, executor),
      approve: (ids, options = {}) =>
        post('approve', APPROVE_PATH, { withdrawal_ids: ids }, options, reviewer),
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

const PATHS: Record<Operation, string> = {
  manualPaid: MANUAL_PAID_PATH,
  execute: BATCH_PATH,
  approve: APPROVE_PATH,
};

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

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.['post']?.responses[status]?.content?.[
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

/** The per-item results of a 200: exactly data.items, the contract schema checked. */
export async function itemsIn(sent: AdminSent): Promise<ItemResult[]> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data), sent.body).toEqual(['items']);
  return data['items'] as ItemResult[];
}

/** A 200 with exactly these results, in this order. */
export async function expectItems(sent: AdminSent, want: readonly ItemResult[]): Promise<void> {
  expect(await itemsIn(sent), sent.body).toEqual(want);
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

/** outcome=executed of adminCreatePayoutBatch with exactly these paying and left; returns batch_id. */
export async function expectExecuted(
  sent: AdminSent,
  want: {
    readonly paying?: readonly string[];
    readonly left?: readonly (readonly [string, string])[];
  },
): Promise<string> {
  const data = (await answer(sent, 0)).data as {
    readonly outcome: string;
    readonly batch_id: string;
    readonly paying: readonly string[];
    readonly left: readonly { readonly withdrawal_id: string; readonly reason: string }[];
  };
  expect(data.outcome, sent.body).toBe('executed');
  expect(data.paying, sent.body).toEqual(want.paying ?? []);
  expect(
    data.left.map((row) => [row.withdrawal_id, row.reason]),
    sent.body,
  ).toEqual(want.left ?? []);
  return data.batch_id;
}
