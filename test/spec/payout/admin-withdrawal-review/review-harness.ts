// B2-09k rule-test harness (claude-independent, SPEC_REF 6f50a051): contracts/openapi.yaml
// adminBatchApproveWithdrawals (POST /admin/v1/withdrawals/batch-approve) and adminRejectWithdrawal
// (POST /admin/v1/withdrawals/{withdrawal_id}/reject) — withdraw.review, totp step-up, Idempotency-Key,
// audit withdrawal_approve / withdrawal_reject — and 08 BR-WDR-10, BR-WDR-05 (a), BR-WDR-17,
// BR-WDR-08 W3, BR-WDR-09; 编排裁定 D10-591, D10-595.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer, the
// started JOB_QUEUE and the event bus, the field cipher of the process), the real ledger, notification's
// withdrawal result consumer, PostgreSQL through @couli/db/testing (couli_app for the entry and the
// seeds, couli_payout for the attempt rows), Redis for the admin sessions.
// Synthetic: members, withdrawals (INSERT plus their real WITHDRAW:FREEZE voucher, as W1 leaves them),
// attempts, holds, risk states and config rows written directly as their writers would have left them
// (../admin-withdrawals/kit.ts, ../../ledger/admin-recon-write-off/kit.ts); admin accounts; a one-shot
// fault in the entry's database handle. The totp step-up token is issued the way
// POST /admin/v1/auth/step-up issues it after a correct authenticator code. No real user or payee
// data. Expected amounts are written by hand in the tests. Missing pieces fail as assertions (an
// unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import { createPushSendCore } from '../../../../apps/api/src/modules/notification/application/push-send.ts';
import { createWithdrawalResultMessageConsumer } from '../../../../apps/api/src/modules/notification/application/withdrawal-result-message.ts';
import type { PushDeliveryChannel } from '../../../../apps/api/src/modules/notification/ports/push-delivery.ts';
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
import {
  ago,
  contractPaths,
  fixture as writeOffFixture,
  withdrawalRow,
  withdrawalVouchers,
  type WriteOffFixture,
  type WriteOffSuite,
} from '../../ledger/admin-recon-write-off/kit.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { eventOf } from '../../notification/withdrawal-result-message/kit.ts';
import {
  seedAttempt,
  seedBatch,
  seedMember,
  seedWithdrawal,
  type Member,
  type Sealer,
  type WithdrawalRow,
  type WithdrawalSeed,
} from '../admin-withdrawals/kit.ts';
import { fund } from '../apply/kit.ts';

export {
  SWITCH,
  ago,
  audits,
  balanceOf,
  changes,
  chars,
  entries,
  frozenMismatches,
  idempotencyRows,
  lockUsersRow,
  setSwitch,
  suite,
  track,
  voucherOf,
  waiting,
  type WriteOffFixture,
} from '../../ledger/admin-recon-write-off/kit.ts';
export {
  ACCOUNT,
  expectNoSecrets,
  seedAttempt,
  seedHold,
  secretsOf,
  type Member,
  type WithdrawalRow,
} from '../admin-withdrawals/kit.ts';

export const APPROVE_PATH = '/admin/v1/withdrawals/batch-approve';
export const REJECT_PATH = '/admin/v1/withdrawals/{withdrawal_id}/reject';
/** specs/permissions.yaml: withdraw.review (step-up tier totp) writes; fund.view only reads. */
export const REVIEW = 'withdraw.review';
export const VIEW = 'fund.view';
/** The audit actions of the contract. */
export const APPROVE_ACTION = 'withdrawal_approve';
export const REJECT_ACTION = 'withdrawal_reject';
/** 2026-11-03 10:00 +08:00, the clock of every fixture. */
export const REVIEW_AT = '2026-11-03T02:00:00.000Z';
/** BR-WDR-17: the hold W9 leaves after a transfer the channel reported as a payer-side failure. */
export const PAYER_SIDE = 'payer_side_after_transfer';
/** notification's event queue of wallet.withdrawal_changed (B1-12u). */
export const MESSAGE_QUEUE = 'evt.notification-withdrawal-result';

/**
 * The defaults of a seed, none of them round: amount_fen 12,345 = net 12,145 + fee 123 + tax 77, on a
 * member funded with 100,003: frozen 12,345, available 87,658 after the freeze.
 */
export const BALANCE = 100_003n;
export const AMOUNT = 12_345n;
export const FEE = 123n;
export const TAX = 77n;
export const AFTER_FREEZE = 87_658n;

/** The internal note of the default body; must never reach the member. */
export const NOTE = '内部核对记录：合成备注甲';

const ROOT = new URL('../../../../', import.meta.url);

// ---------------------------------------------------------------------------------------------
// One app on the suite's database, at the fixed review time.

/**
 * The write-off fixture with its suite typed in full: the seeds of ../admin-withdrawals/kit.ts need
 * the suite's payout() handle, which the write-off kit's own Fixture type does not promise.
 */
export type ReviewFixture = WriteOffFixture & { readonly s: WriteOffSuite };

export function fixture(s: WriteOffSuite): ReviewFixture {
  return { ...writeOffFixture(s, REVIEW_AT), s };
}

/** The same database and clock under another app id, for the isolation cases. */
export function otherApp(f: ReviewFixture): ReviewFixture {
  return { ...f, appId: `other_${f.appId}` };
}

// ---------------------------------------------------------------------------------------------
// Seeds (inside withReviewAdmin: the phone and the payee account go through the entry's cipher).

/** A member with a phone and a funded ledger account. */
export async function member(
  f: ReviewFixture,
  h: Sealer,
  balance: bigint = BALANCE,
): Promise<Member> {
  const seeded = await seedMember(f, h);
  await fund(f.db, f.ledger, { appId: seeded.appId, userId: seeded.userId }, balance);
  return seeded;
}

/** The real WITHDRAW:FREEZE of a row: frozen +amount, available −amount (`wd:{id}:FREEZE`). */
async function freeze(f: ReviewFixture, row: WithdrawalRow): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    const appId = row.app_id;
    await lockUsersForUpdate(trx, { appId, userIds: [row.user_id] });
    const [balance] = await f.ledger.lockBalances(trx, { appId, userIds: [row.user_id] });
    const [built] = buildVouchers('WITHDRAW:FREEZE', {
      withdrawal_id: row.id,
      user_id: row.user_id,
      withdraw_fen: row.amount_fen,
    });
    if (balance === undefined || built === undefined) {
      throw new Error('seed: the member has no balance row or FREEZE built no voucher');
    }
    const lines: PostingEntry[] = built.entries.map((entry) => ({
      account: { ownerType: 'user', accountId: balance.account_id },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    }));
    await f.ledger.post(trx, {
      appId,
      uniqKey: built.uniq_key,
      bizType: 'withdrawal',
      bizId: row.id,
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries: lines,
    });
  });
}

const OPEN: readonly string[] = ['PENDING_REVIEW', 'APPROVED', 'PAYING'];

/** A withdrawal created 30 minutes ago (PENDING_REVIEW by default), frozen while it is open. */
export async function seedReview(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  const createdAt = ago(f, 30);
  const row = await seedWithdrawal(f, h, who, {
    amount_fen: AMOUNT,
    fee_fen: FEE,
    tax_fen: TAX,
    review_mode: 'manual',
    created_at: createdAt,
    updated_at: createdAt,
    ...seed,
  });
  if (OPEN.includes(row.status)) await freeze(f, row);
  return row;
}

/** An APPROVED withdrawal reviewed 20 minutes ago by somebody else; nothing has been executed. */
export function seedApproved(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  return seedReview(f, h, who, {
    status: 'APPROVED',
    reviewer_id: randomUUID(),
    reviewed_at: ago(f, 20),
    row_version: 1,
    ...seed,
  });
}

/**
 * A withdrawal as W9 leaves it after a payer-side failure (BR-WDR-17): APPROVED, hold_reason
 * payer_side_after_transfer, batch and execute_seq kept, one failed transfer attempt, no query.
 */
export async function seedReturned(
  f: ReviewFixture,
  h: Sealer,
  who: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  const batch = await seedBatch(f, { kind: 'manual', created_at: ago(f, 25) });
  const row = await seedApproved(f, h, who, {
    batch_id: batch.id,
    execute_seq: 1,
    hold_reason: PAYER_SIDE,
    row_version: 3,
    ...seed,
  });
  await seedAttempt(f, row, {
    kind: 'transfer',
    result: 'fail',
    at: ago(f, 15),
    respCode: '40004',
    respSubCode: 'TEST_PAYER_SIDE',
  });
  return row;
}

export type AttemptResult = 'pending' | 'success' | 'fail' | 'unknown';

/** Query attempts of `row`, in the order given: [result, minutes before the fixture's clock]. */
export async function seedQueries(
  f: ReviewFixture,
  row: WithdrawalRow,
  queries: readonly (readonly [AttemptResult, number])[],
): Promise<void> {
  for (const [result, minutes] of queries) {
    await seedAttempt(f, row, { kind: 'query', result, at: ago(f, minutes) });
  }
}

/** Moves the member's available by `delta` (an adjustment voucher, as ../state/kit.ts). */
export async function adjust(f: ReviewFixture, who: Member, delta: bigint): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    const appId = who.appId;
    await lockUsersForUpdate(trx, { appId, userIds: [who.userId] });
    const [balance] = await f.ledger.lockBalances(trx, { appId, userIds: [who.userId] });
    if (balance === undefined) throw new Error('seed: the member has no balance row');
    const adjustment = voucher(appId, balance.account_id, -delta);
    await f.ledger.post(trx, {
      ...adjustment,
      entries: adjustment.entries.map((line) => ({ ...line, ledger_type: 'ADMIN_ADJUST' })),
    });
  });
}

/** The member's risk state as risk would have left it (BR-WDR-05 (b)). */
export async function seedRiskState(
  f: ReviewFixture,
  who: Member,
  state: 'frozen' | 'banned',
): Promise<void> {
  await sql`INSERT INTO app.user_risk_state
    (user_id, app_id, state, reason_category, changed_by, changed_at)
    VALUES (${who.userId}, ${who.appId}, ${state}, 'other', 'system', ${ago(f, 40)})`.execute(f.db);
}

/** Another transaction approves the row: status, row_version + 1, updated_at; one row must move. */
export async function moveBehind(
  trx: Transaction<DB>,
  row: WithdrawalRow,
  at: Date,
): Promise<void> {
  const result = await sql`UPDATE app.withdrawals
    SET status = 'APPROVED', row_version = row_version + 1, updated_at = ${at}
    WHERE app_id = ${row.app_id} AND id = ${row.id} AND status = ${row.status}`.execute(trx);
  expect(result.numAffectedRows, `withdrawal ${row.id} moved behind the request`).toBe(1n);
}

// ---------------------------------------------------------------------------------------------
// What the tests read.

/** One withdrawal as it is now. */
export function rowOf(f: ReviewFixture, row: WithdrawalRow): Promise<WithdrawalRow> {
  return withdrawalRow(f.db, row.app_id, row.id);
}

/** Everything of the app the two operations could write, for before / after comparisons. */
export async function everything(f: ReviewFixture, app: string = f.appId) {
  const jobs = await sql<{ name: string; data: unknown }>`
    SELECT name, data FROM pgboss.job WHERE data->'payload'->>'app_id' = ${app}
    ORDER BY name, created_on, id`.execute(f.db);
  const rows = {
    withdrawals: f.db.selectFrom('withdrawals').selectAll().where('app_id', '=', app).orderBy('id'),
    attempts: f.db
      .selectFrom('payout_attempts')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id'),
    batches: f.db.selectFrom('payout_batches').selectAll().where('app_id', '=', app).orderBy('id'),
    holds: f.db.selectFrom('withdraw_holds').selectAll().where('app_id', '=', app).orderBy('id'),
    vouchers: f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id'),
    entries: f.db.selectFrom('ledger_entries').selectAll().where('app_id', '=', app).orderBy('id'),
    balances: f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('account_id'),
    events: f.db.selectFrom('event_log').selectAll().where('app_id', '=', app).orderBy('id'),
    audits: f.db.selectFrom('audit_logs').selectAll().where('app_id', '=', app).orderBy('id'),
    idempotency: f.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id'),
  };
  return {
    withdrawals: await rows.withdrawals.execute(),
    attempts: await rows.attempts.execute(),
    batches: await rows.batches.execute(),
    holds: await rows.holds.execute(),
    vouchers: await rows.vouchers.execute(),
    entries: await rows.entries.execute(),
    balances: await rows.balances.execute(),
    events: await rows.events.execute(),
    audits: await rows.audits.execute(),
    idempotency: await rows.idempotency.execute(),
    jobs: jobs.rows,
  };
}

/** The queue of every job of the app, sorted. */
export async function jobQueues(f: ReviewFixture): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pgboss.job WHERE data->'payload'->>'app_id' = ${f.appId}
    ORDER BY name`.execute(f.db);
  return result.rows.map((row) => row.name);
}

/** The event data of the app's jobs on notification's queue, in order. */
export async function messageJobs(f: ReviewFixture): Promise<unknown[]> {
  const result = await sql<{ data: unknown }>`
    SELECT data->'payload'->'data' AS data FROM pgboss.job
    WHERE name = ${MESSAGE_QUEUE} AND data->'payload'->>'app_id' = ${f.appId}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows.map((row) => row.data);
}

/** The uniq keys of the app's WITHDRAW:RETURN vouchers. */
export async function returnVouchers(f: ReviewFixture): Promise<string[]> {
  const keys = await withdrawalVouchers(f.db, f.appId);
  return keys.filter((key) => key.endsWith(':RETURN'));
}

/** Rows as one text, for "this never appears" checks (bigint columns as digits). */
export function textOf(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

/** target, before and after of an audit record as one text. */
export function auditText(record: {
  readonly target: string | null;
  readonly before: unknown;
  readonly after: unknown;
}): string {
  return JSON.stringify([record.target, record.before, record.after]);
}

/** What notification's worker does with the event: the real consumer, then the push after it. */
export async function deliverMessage(
  f: ReviewFixture,
  data: { readonly withdrawal_id: string; readonly user_id: string; readonly status: string },
): Promise<void> {
  const event = eventOf(f.appId, data);
  const consumer = createWithdrawalResultMessageConsumer({
    clock: f.clock,
    logger: createRootLogger(
      { entry: 'worker', appEnv: 'test', level: 'silent' },
      { write: () => undefined },
    ),
    push: createPushSendCore({
      clock: f.clock,
      channel: {
        send: vi.fn<PushDeliveryChannel['send']>().mockResolvedValue({ status: 'accepted' }),
      },
      sessionValidity: async (_executor: unknown, query: { readonly sids: readonly string[] }) =>
        new Set<string>(query.sids),
    }),
  });
  await f.db.transaction().execute((trx) => consumer.handle(event, trx));
  await consumer.dispatch(f.db, event);
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/** Where the next failure is thrown; each is one statement of the operation's transaction. */
export type FaultPoint = 'approve_audit' | 'reject_audit' | 'voucher';

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  /** When set, only a statement whose parameters contain this text matches (one id of a batch). */
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
          : insertsInto(compiled.sql, 'audit_logs') &&
            parameters.includes(point === 'approve_audit' ? APPROVE_ACTION : REJECT_ACTION);
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

export type Operation = 'approve' | 'reject';

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

export interface ReviewOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `reviewer` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface ReviewAdmin extends Sealer {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/withdrawals/batch-approve with these ids. */
  approve(ids: readonly string[], options?: ReviewOptions): Promise<AdminSent>;
  /** POST /admin/v1/withdrawals/batch-approve with any JSON body. */
  approveBody(body: unknown, options?: ReviewOptions): Promise<AdminSent>;
  /** POST /admin/v1/withdrawals/{withdrawal_id}/reject with the JSON body. */
  reject(withdrawalId: string, body: unknown, options?: ReviewOptions): Promise<AdminSent>;
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

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `wr_${randomBytes(12).toString('hex')}`;
}

/** The body of a rejection; `patch` replaces or adds fields. */
export function rejectBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { reason_code: 'PAYEE_INFO_INVALID', note: NOTE, ...patch };
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin), clock
 * and Redis.
 */
export async function withReviewAdmin(
  f: ReviewFixture,
  run: (h: ReviewAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-09k-'));
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
        JWT_KEY_ID: 'b2_09k_test',
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
    const caller: ReviewAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `wr_${id}`,
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
    const stepUp: ReviewAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const reviewer = await caller([REVIEW]);
    const viewer = await caller([VIEW]);
    const send = async (
      op: Operation,
      url: string,
      body: unknown,
      options: ReviewOptions,
    ): Promise<AdminSent> => {
      const who = options.caller === undefined ? reviewer : options.caller;
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
      reviewer,
      viewer,
      approve: (ids, options = {}) =>
        send('approve', APPROVE_PATH, { withdrawal_ids: ids }, options),
      approveBody: (body, options = {}) => send('approve', APPROVE_PATH, body, options),
      reject: (withdrawalId, body, options = {}) =>
        send(
          'reject',
          `/admin/v1/withdrawals/${encodeURIComponent(withdrawalId)}/reject`,
          body,
          options,
        ),
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

const PATHS: Record<Operation, string> = { approve: APPROVE_PATH, reject: REJECT_PATH };

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

/** The items of a successful batch, exactly data.items. */
export async function itemsOf(sent: AdminSent): Promise<unknown[]> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data), sent.body).toEqual(['items']);
  return data['items'] as unknown[];
}

export function approvedItem(id: string): Record<string, unknown> {
  return { withdrawal_id: id, result: 'approved', reason: null };
}

export type SkipReason = 'not_found' | 'not_pending' | 'negative_balance' | 'blocked';

export function skippedItem(id: string, reason: SkipReason): Record<string, unknown> {
  return { withdrawal_id: id, result: 'skipped', reason };
}

/** A successful rejection: exactly the contract's fields, reviewed_at the fixture's clock. */
export async function rejectedBy(
  f: ReviewFixture,
  sent: AdminSent,
  row: WithdrawalRow,
  adminId: string,
  reasonCode: string,
): Promise<void> {
  const body = await answer(sent, 0);
  const data = { ...(body.data as Record<string, unknown>) };
  const at = data['reviewed_at'];
  expect(typeof at, sent.body).toBe('string');
  data['reviewed_at'] = Date.parse(at as string);
  expect(data, sent.body).toEqual({
    withdrawal_id: row.id,
    status: 'REJECTED',
    reject_reason_code: reasonCode,
    reviewer_id: adminId,
    reviewed_at: f.clock.now().getTime(),
  });
}

/** The 20001 naming exactly these fields. */
export function fieldsError(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

/** The 20001 of a guard of the rejection, with its reason. */
export function refused(sent: AdminSent, reason: string): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['withdrawal_id'], reason });
}

/** The 20902 of a withdrawal no longer rejectable, or changed by another request. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'withdrawal' });
}

/** The 10403 of an account without withdraw.review. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 10003 of a missing or wrong totp-tier step-up token. */
export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}
