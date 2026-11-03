// B2-09l rule-test harness (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminCreatePayoutBatch (POST /admin/v1/payout-batches: payout.execute, totp step-up, Idempotency-Key,
// audit payout_batch_execute) and adminGetPayoutOverview (GET /admin/v1/payout-overview: payout.execute
// or fund.view, read only), 08 BR-WDR-11, BR-WDR-12, BR-WDR-18, 编排裁定 D10-285, D10-288, D10-290,
// D10-591, D10-595; the judgement of apps/api/src/modules/payout/application/payout-execute.ts.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks, the
// step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
// started JOB_QUEUE and the event bus, the field cipher of the process), the real createPayoutExecute
// behind the route, the real ledger, risk's readers on their tables, content's configuration on
// config_items, the review and W entry routes, PostgreSQL through @couli/db/testing (couli_app for the
// entry and the seeds, couli_payout for the attempt rows), Redis for the admin sessions.
// Synthetic: members, withdrawals (INSERT plus their real WITHDRAW:FREEZE voucher, as W1 leaves them),
// attempts, holds, batches and their items, risk states, appeals, W rows of the preconditions and
// config rows, written directly as their writers would have left them (../admin-withdrawal-review/
// review-harness.ts, ../admin-withdrawals/kit.ts); admin accounts; a one-shot fault in the entry's
// database handle. The totp step-up token is issued the way POST /admin/v1/auth/step-up issues it after
// a correct authenticator code. No real user or payee data. Expected amounts are written by hand in the
// tests. Missing pieces fail as assertions (an unregistered admin route answers 404).
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
import { contractPaths } from '../../ledger/admin-recon-write-off/kit.ts';
import {
  seedAttempt,
  seedBatch,
  seedItem,
  withOffset,
  type Member,
  type Sealer,
  type WithdrawalRow,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';
import {
  APPROVE_PATH,
  auditText,
  everything,
  member,
  newKey,
  seedApproved,
  seedReview,
  ago,
  textOf,
  type AttemptResult,
  type ReviewFixture,
} from '../admin-withdrawal-review/review-harness.ts';

export {
  ACCOUNT,
  ago,
  adjust,
  approvedItem,
  auditText,
  audits,
  balanceOf,
  changes,
  expectNoSecrets,
  fixture,
  frozenMismatches,
  newKey,
  otherApp,
  rowOf,
  secretsOf,
  seedAttempt,
  seedHold,
  seedReturned,
  seedReview,
  seedRiskState,
  setSwitch,
  suite,
  track,
  waiting,
  type AttemptResult,
  type Member,
  type ReviewFixture,
  type WithdrawalRow,
} from '../admin-withdrawal-review/review-harness.ts';
export { seedBatch, seedItem, withOffset };

export const BATCH_PATH = '/admin/v1/payout-batches';
export const OVERVIEW_PATH = '/admin/v1/payout-overview';
export const FUND_LEDGER_PATH = '/admin/v1/fund-ledger';
export const WATERMARK_PATH = '/admin/v1/payout-watermarks';
/** specs/permissions.yaml. */
export const EXECUTE = 'payout.execute';
export const REVIEW = 'withdraw.review';
export const VIEW = 'fund.view';
export const CASH_ENTRY = 'fund.cash_entry';
/** The audit action of the contract. */
export const ACTION = 'payout_batch_execute';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/**
 * The defaults of a seed, divisible neither by 3 nor by 7: amount 12,547 = net 12,347 + fee 123 + tax
 * 77. W × 9000 / 10000 reaches 12,347 from W = 13,719 on (13,718 × 9000 < 12,347 × 10000).
 */
export const AMOUNT = 12_547n;
export const NET = 12_347n;
export const W_JUST_ENOUGH = 13_719n;
export const W_JUST_SHORT = 13_718n;
/** A W far above anything these tests move (usable 2,700,000.9), with P = 0. */
export const PLENTY = 3_000_001n;
/** A member's balance, enough for many withdrawals. */
export const RICH = 9_000_001n;
/** Inside the 7 natural days before 2026-11-03 (+08:00), the day of the fixture's clock. */
export const IN_WINDOW = new Date('2026-10-30T04:00:00.000Z');
/** BR-WDR-18 例: 近 7 日合计 ¥49,000 → P = ¥21,000. */
export const FORECAST_SOURCE = 4_900_000n;
export const FORECAST = 2_100_000;

export type Channel = 'alipay' | 'bank_card' | 'wechat';

// ---------------------------------------------------------------------------------------------
// Seeds (inside withBatchAdmin: the phone and the payee account go through the entry's cipher).

/** A member with a balance far above the withdrawals of a test. */
export function payee(f: ReviewFixture, h: Sealer, balance: bigint = RICH): Promise<Member> {
  return member(f, h, balance);
}

/** A withdrawal waiting for review, net 12,347, frozen. */
export function pending(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedReview(f, h, who, { amount_fen: AMOUNT, ...seed });
}

/** An APPROVED withdrawal, net 12,347, frozen, reviewed by somebody else and never on a batch. */
export function approved(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedApproved(f, h, who, { amount_fen: AMOUNT, ...seed });
}

/** The money of one withdrawal for a chosen net: amount = net + 123 + 77. */
export function ofNet(net: bigint): { readonly amount_fen: bigint } {
  return { amount_fen: net + 200n };
}

/**
 * An APPROVED withdrawal as W9 leaves it before any transfer (BR-WDR-13 ③): still on the batch it ran
 * in, execute_seq 1, its item of that run kept, no attempt.
 */
export async function heldOnBatch(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  options: {
    readonly kind?: 'auto' | 'manual';
    readonly seed?: WithdrawalSeed;
  } = {},
) {
  const batch = await seedBatch(f, { kind: options.kind ?? 'auto', created_at: ago(f, 25) });
  const row = await approved(f, h, who, {
    batch_id: batch.id,
    execute_seq: 1,
    hold_reason: 'single_cap',
    hold_at: ago(f, 24),
    row_version: 3,
    ...options.seed,
  });
  await seedItem(f, row, batch, { result: 'paying', at: ago(f, 25) });
  return { batch, row };
}

/** An application of the 7-day window, already paid long ago: it only feeds P of its channel. */
export async function seedHistory(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  amountFen: bigint,
  method: Channel = 'alipay',
): Promise<void> {
  await seedReview(f, h, who, {
    status: 'PAID_API',
    method,
    amount_fen: amountFen,
    fee_fen: 0n,
    tax_fen: 0n,
    created_at: IN_WINDOW,
    updated_at: IN_WINDOW,
  });
}

export interface WatermarkSeed {
  readonly fen: bigint;
  /** How long before the fixture's clock W was read (default 30 minutes). */
  readonly ageMs?: number;
  readonly channel?: Channel;
  /** payout_watermarks.entered_by is free text (default a synthetic non-admin value). */
  readonly enteredBy?: string;
}

/** One payout_watermarks row of the fixture's app; returns its measured_at in epoch milliseconds. */
export async function seedW(f: ReviewFixture, seed: WatermarkSeed): Promise<number> {
  const measuredAt = new Date(f.clock.now().getTime() - (seed.ageMs ?? 30 * MINUTE));
  await sql`INSERT INTO app.payout_watermarks
      (id, app_id, channel, available_fen, measured_at, entered_by, created_at)
    VALUES (${randomUUID()}, ${f.appId}, ${seed.channel ?? 'alipay'}, ${seed.fen}, ${measuredAt},
      ${seed.enteredBy ?? 'finance:synthetic'}, ${f.clock.now()})`.execute(f.db);
  return measuredAt.getTime();
}

/** The body of a W entry measured `minutes` ago. */
export function watermarkBody(
  f: ReviewFixture,
  availableFen: number,
  minutes = 30,
): Record<string, unknown> {
  return {
    channel: 'alipay',
    available_fen: availableFen,
    measured_at: withOffset(ago(f, minutes)),
  };
}

/** A risk state beyond what ../admin-withdrawal-review seeds: appealing, or a timed freeze. */
export async function seedRisk(
  f: ReviewFixture,
  who: Member,
  state: 'frozen' | 'appealing',
  frozenUntil: Date | null = null,
): Promise<void> {
  await sql`INSERT INTO app.user_risk_state
    (user_id, app_id, state, reason_category, changed_by, changed_at, frozen_until)
    VALUES (${who.userId}, ${who.appId}, ${state}, 'other', 'system', ${ago(f, 40)},
      ${frozenUntil})`.execute(f.db);
}

/** The member's open account appeal with the state it was filed from. */
export async function seedAppeal(
  f: ReviewFixture,
  who: Member,
  previous: 'frozen' | 'banned',
): Promise<void> {
  await sql`INSERT INTO app.appeals
    (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at)
    VALUES (${randomUUID()}, ${who.appId}, ${who.userId}, 'account', ${who.userId}, ${previous},
      'processing', 'synthetic account appeal', ${new Date(f.clock.now().getTime() + 24 * HOUR)})`.execute(
    f.db,
  );
}

/** A transfer (or query) attempt at `at`. */
export function seedSent(
  f: ReviewFixture,
  row: WithdrawalRow,
  kind: 'transfer' | 'query',
  result: AttemptResult,
  at: Date = ago(f, 10),
) {
  return seedAttempt(f, row, { kind, result, at });
}

/** Another transaction executed the row: status, seq, row_version; one row must move. */
export async function moveToPaying(
  trx: Transaction<DB>,
  row: WithdrawalRow,
  at: Date,
): Promise<void> {
  const result = await sql`UPDATE app.withdrawals
    SET status = 'PAYING', execute_seq = execute_seq + 1, executed_at = ${at},
      row_version = row_version + 1, updated_at = ${at}
    WHERE app_id = ${row.app_id} AND id = ${row.id} AND status = 'APPROVED'`.execute(trx);
  expect(result.numAffectedRows, `withdrawal ${row.id} moved behind the request`).toBe(1n);
}

export interface HeldWithdrawal {
  /** Runs `during` on the holding transaction (the row still locked), then commits it. */
  release(during?: (trx: Transaction<DB>) => Promise<void>): Promise<void>;
}

/** Holds `SELECT … FOR UPDATE` on one withdrawal, the row EXECUTE locks to judge it. */
export async function lockWithdrawal(
  f: ReviewFixture,
  row: WithdrawalRow,
): Promise<HeldWithdrawal> {
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
    const rows = await sql`SELECT id FROM app.withdrawals
      WHERE app_id = ${row.app_id} AND id = ${row.id} FOR UPDATE`.execute(trx);
    expect(rows.rows, `withdrawals ${row.id}`).toHaveLength(1);
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

// ---------------------------------------------------------------------------------------------
// What the tests read.

/** Everything of the app the two operations could write, for before / after comparisons. */
export async function world(f: ReviewFixture, app: string = f.appId) {
  return {
    ...(await everything(f, app)),
    items: await f.db
      .selectFrom('payout_batch_items')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    watermarks: await f.db
      .selectFrom('payout_watermarks')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute(),
    config: await f.db
      .selectFrom('config_items')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('key')
      .execute(),
  };
}
export type World = Awaited<ReturnType<typeof world>>;

/** A refused batch leaves only its audit record and its idempotency record. */
export function expectOnlyTrail(before: World, after: World): void {
  expect({ ...after, audits: [], idempotency: [] }).toEqual({
    ...before,
    audits: [],
    idempotency: [],
  });
}

export interface ItemView {
  readonly batch_id: string;
  readonly withdrawal_id: string;
  readonly result: string;
  readonly reason: string | null;
  readonly moved_to_batch_id: string | null;
}

/** The app's payout_batch_items, without their time, in a stable order. */
export async function itemsOf(f: ReviewFixture): Promise<ItemView[]> {
  const rows = await f.db
    .selectFrom('payout_batch_items')
    .select(['batch_id', 'withdrawal_id', 'result', 'reason', 'moved_to_batch_id'])
    .where('app_id', '=', f.appId)
    .execute();
  return orderedItems(rows);
}

/** The items in the order itemsOf() returns them, for comparing with a list written by hand. */
export function orderedItems(items: readonly ItemView[]): ItemView[] {
  const keyOf = (item: ItemView) => `${item.batch_id}|${item.withdrawal_id}|${item.result}`;
  return [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

export function item(
  batchId: string,
  row: { readonly id: string },
  result: 'paying' | 'skipped' | 'blocked',
  reason: string | null = null,
): ItemView {
  return {
    batch_id: batchId,
    withdrawal_id: row.id,
    result,
    reason,
    moved_to_batch_id: null,
  };
}

export function movedOut(oldBatchId: string, row: { readonly id: string }, to: string): ItemView {
  return {
    batch_id: oldBatchId,
    withdrawal_id: row.id,
    result: 'moved_out',
    reason: null,
    moved_to_batch_id: to,
  };
}

/** One batch row, which must exist. */
export async function batchOf(f: ReviewFixture, batchId: string) {
  const row = await f.db
    .selectFrom('payout_batches')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('id', '=', batchId)
    .executeTakeFirst();
  expect(row, `payout_batches ${batchId}`).toBeDefined();
  return row!;
}

export interface PayoutJob {
  readonly singleton_key: string | null;
  readonly data: unknown;
}

/** Jobs in one order, in JavaScript: the database's collation does not compare like this. */
function orderedJobs(jobs: readonly PayoutJob[]): PayoutJob[] {
  const keyOf = (job: PayoutJob) => job.singleton_key ?? '';
  return [...jobs].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/** The jobs of queue `payout` carrying this app's withdrawals. */
export async function payoutJobs(f: ReviewFixture): Promise<PayoutJob[]> {
  const result = await sql<PayoutJob>`
    SELECT singleton_key, data FROM pgboss.job
    WHERE name = 'payout' AND data->'payload'->>'app_id' = ${f.appId}`.execute(f.db);
  return orderedJobs(result.rows);
}

/** The transfer job of (row, seq), exactly as BR-WDR-12 writes it. */
export function transferJob(
  f: ReviewFixture,
  row: { readonly id: string },
  seq: number,
): PayoutJob {
  return {
    singleton_key: `${row.id}:${seq}`,
    data: {
      name: 'transfer',
      payload: { withdrawal_id: row.id, execute_seq: seq, app_id: f.appId },
    },
  };
}

/** The jobs of several rows in the order payoutJobs() returns them. */
export function transferJobs(
  f: ReviewFixture,
  rows: readonly { readonly id: string; readonly seq: number }[],
): PayoutJob[] {
  return orderedJobs(rows.map((row) => transferJob(f, row, row.seq)));
}

/** The row after W4: only the columns EXECUTE writes changed. */
export function asPaying(
  f: ReviewFixture,
  row: WithdrawalRow,
  batchId: string,
  executorId: string,
): WithdrawalRow {
  return {
    ...row,
    status: 'PAYING',
    execute_seq: row.execute_seq + 1,
    executor_id: executorId,
    batch_id: batchId,
    executed_at: f.clock.now(),
    row_version: row.row_version + 1,
    updated_at: f.clock.now(),
  };
}

/** The row after only being moved to the new batch (BR-WDR-12). */
export function asMoved(f: ReviewFixture, row: WithdrawalRow, batchId: string): WithdrawalRow {
  return {
    ...row,
    batch_id: batchId,
    row_version: row.row_version + 1,
    updated_at: f.clock.now(),
  };
}

export interface AuditFacts {
  /** Every key found in after, then before, at any depth, with its first value. */
  readonly fields: ReadonlyMap<string, unknown>;
  /** Every number found in before / after at any depth. */
  readonly numbers: ReadonlySet<number>;
  /** target, before and after as one text. */
  readonly text: string;
}

/** What an audit record says, wherever the writer put it inside before / after. */
export function auditFacts(record: {
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): AuditFacts {
  const fields = new Map<string, unknown>();
  const numbers = new Set<number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const inner of value) walk(inner);
      return;
    }
    if (typeof value === 'number') {
      numbers.add(value);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if (!fields.has(key)) fields.set(key, inner);
      walk(inner);
    }
  };
  walk(record.after);
  walk(record.before);
  return { fields, numbers, text: auditText(record) };
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** Where the next failure is thrown: the audit record, or the items (EXECUTE's last write). */
export type FaultPoint = 'audit' | 'items';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
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
      const hit =
        point === 'items'
          ? insertsInto(compiled.sql, 'payout_batch_items')
          : insertsInto(compiled.sql, 'audit_logs') &&
            (compiled.sql.includes(ACTION) || textOf(compiled.parameters).includes(ACTION));
      if (hit) {
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

export type Operation = 'execute' | 'overview' | 'fundLedger' | 'approve' | 'watermark';

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
  /** The caller: the operation's default account by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface BatchAdmin extends Sealer {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean; readonly displayName?: string },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/payout-batches with these ids, as `executor` by default. */
  execute(ids: readonly string[], options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/payout-batches with any JSON body. */
  executeBody(body: unknown, options?: WriteOptions): Promise<AdminSent>;
  /** GET /admin/v1/payout-overview without a step-up token, as `executor` by default. */
  overview(caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/fund-ledger, as `viewer` by default. */
  fundLedger(caller?: AdminCaller): Promise<AdminSent>;
  /** POST /admin/v1/withdrawals/batch-approve, as `reviewer` by default. */
  approve(ids: readonly string[], options?: WriteOptions): Promise<AdminSent>;
  /** POST /admin/v1/payout-watermarks, as `cashier` by default. */
  enterWatermark(body: unknown, options?: WriteOptions): Promise<AdminSent>;
  /** An account with payout.execute only. */
  readonly executor: AdminCaller;
  /** An account with withdraw.review only. */
  readonly reviewer: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
  /** An account with fund.cash_entry only. */
  readonly cashier: AdminCaller;
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

const ROOT = new URL('../../../../', import.meta.url);

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withBatchAdmin(
  f: ReviewFixture,
  run: (h: BatchAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-09l-'));
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
        JWT_KEY_ID: 'b2_09l_test',
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
    const caller: BatchAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      const loginName = `pb_${id}`;
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
    const stepUp: BatchAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const executor = await caller([EXECUTE]);
    const reviewer = await caller([REVIEW]);
    const viewer = await caller([VIEW]);
    const cashier = await caller([CASH_ENTRY]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
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
      return sent(
        op,
        await server.inject({
          method: 'POST',
          url,
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        }),
      );
    };
    const get = async (op: Operation, url: string, who: AdminCaller | null): Promise<AdminSent> => {
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
      return sent(
        op,
        await server.inject({ method: 'GET', url, headers, remoteAddress: '127.0.0.1' }),
      );
    };
    await run({
      crypto,
      fault,
      caller,
      stepUp,
      executor,
      reviewer,
      viewer,
      cashier,
      execute: (ids, options = {}) =>
        post('execute', BATCH_PATH, { withdrawal_ids: ids }, options, executor),
      executeBody: (body, options = {}) => post('execute', BATCH_PATH, body, options, executor),
      overview: (who) => get('overview', OVERVIEW_PATH, who === undefined ? executor : who),
      fundLedger: (who = viewer) => get('fundLedger', FUND_LEDGER_PATH, who),
      approve: (ids, options = {}) =>
        post('approve', APPROVE_PATH, { withdrawal_ids: ids }, options, reviewer),
      enterWatermark: (body, options = {}) =>
        post('watermark', WATERMARK_PATH, body, options, cashier),
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

const CONTRACT: Record<Operation, readonly [string, 'get' | 'post']> = {
  execute: [BATCH_PATH, 'post'],
  overview: [OVERVIEW_PATH, 'get'],
  fundLedger: [FUND_LEDGER_PATH, 'get'],
  approve: [APPROVE_PATH, 'post'],
  watermark: [WATERMARK_PATH, 'post'],
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
  const [path, method] = CONTRACT[sent.op];
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

export interface LeftItem {
  readonly withdrawal_id: string;
  readonly reason: string;
}

export interface BatchResult {
  readonly outcome: string;
  readonly batch_id: string | null;
  readonly reason: string | null;
  readonly channel: string | null;
  readonly paying: readonly string[];
  readonly left: readonly LeftItem[];
}

/** data of a 200 of adminCreatePayoutBatch (the contract schema checked). */
export async function resultOf(sent: AdminSent): Promise<BatchResult> {
  return (await answer(sent, 0)).data as BatchResult;
}

function orderedLeft(left: readonly LeftItem[]): LeftItem[] {
  return [...left].sort((a, b) =>
    a.withdrawal_id < b.withdrawal_id ? -1 : a.withdrawal_id > b.withdrawal_id ? 1 : 0,
  );
}

/**
 * outcome=executed with exactly these paying ids and these left [id, reason] pairs (the contract does
 * not order them); returns batch_id.
 */
export async function expectExecuted(
  sent: AdminSent,
  want: {
    readonly paying?: readonly string[];
    readonly left?: readonly (readonly [string, string])[];
  },
): Promise<string> {
  const data = await resultOf(sent);
  expect(data.outcome, sent.body).toBe('executed');
  expect(data.reason, sent.body).toBeNull();
  expect(data.channel, sent.body).toBeNull();
  expect(typeof data.batch_id, sent.body).toBe('string');
  expect([...data.paying].sort(), sent.body).toEqual([...(want.paying ?? [])].sort());
  expect(orderedLeft(data.left), sent.body).toEqual(
    orderedLeft((want.left ?? []).map(([withdrawal_id, reason]) => ({ withdrawal_id, reason }))),
  );
  return data.batch_id as string;
}

/** outcome=rejected: exactly the contract's shape of a refused batch. */
export async function expectRejected(
  sent: AdminSent,
  reason: string,
  channel: Channel | null = null,
): Promise<void> {
  await answer(sent, 0, {
    outcome: 'rejected',
    batch_id: null,
    reason,
    channel,
    paying: [],
    left: [],
  });
}

export interface ShownWatermark {
  readonly available_fen: number;
  readonly measured_at: string;
  readonly entered_by: string | null;
  readonly entered_by_name: string | null;
}

export interface OverviewChannel {
  readonly channel: string;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly watermark: ShownWatermark | null;
  readonly forecast_withdrawal_fen: number;
  readonly water_level: string | null;
}

export interface PayoutOverview {
  readonly as_of: string;
  readonly payout_enabled: boolean;
  readonly queue_paused: boolean;
  readonly single_cap_fen: number;
  readonly daily_cap_fen: number;
  readonly daily_sent_fen: number;
  readonly watermark_usable_bp: number;
  readonly channels: readonly OverviewChannel[];
}

/** data of a 200 of adminGetPayoutOverview (the contract schema checked). */
export async function viewOf(sent: AdminSent): Promise<PayoutOverview> {
  return (await answer(sent, 0)).data as PayoutOverview;
}

/** One channel of an overview, which must be listed. */
export function channelOf(view: PayoutOverview, channel: Channel): OverviewChannel {
  const found = view.channels.find((item) => item.channel === channel);
  expect(found, `channel ${channel} in ${JSON.stringify(view)}`).toBeDefined();
  return found!;
}

/** The shown watermark with measured_at as epoch milliseconds; null when there is none. */
export function shown(watermark: ShownWatermark | null) {
  return watermark === null
    ? null
    : { ...watermark, measured_at: Date.parse(watermark.measured_at) };
}

/** A shown watermark as it must read when no admin of the app entered it. */
export function byNobody(fen: number, measuredAt: number) {
  return { available_fen: fen, measured_at: measuredAt, entered_by: null, entered_by_name: null };
}
