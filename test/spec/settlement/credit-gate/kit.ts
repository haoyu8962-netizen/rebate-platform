// B2-04re rule-test kit (claude-independent, SPEC_REF 081b177): 08 BR-FUND-16 细则「加锁流程」第 0 步 —
// the platform settle credit gate. Every item transaction of the batch executor first takes the
// gate of its (app, platform) in shared mode; the supplement launch (BR-FUND-04 ⑧) and the bill-day
// job (BR-FUND-04 ③) take the same gate in exclusive mode and hold it to commit; both before any
// order key lock. The key spelling lives in the skeleton (apps/api/.../batch/credit-gate.ts,
// creditGateKey); this kit only reads it back to find the lock in pg_locks.
//
// Real pieces: the supplement command (createSupplementCommand) and the bill job (createBillJob)
// over the production bill source reader (createBillSourceReader), commission's snapshot reader and
// ledger's registerReconDiff; the batch executor with the R5 credit order and the R5a beneficiary
// credit through SettlementModule.forWorker (../worker/credit-kit.ts); confirmation and SB8 resume
// through the batch command service; orders' lockOrderKey for every order key lock held here.
// Synthetic: the bill row and the admin account, the old CONFIRMED batches and their items (as the
// bill job and a confirmation leave them), commission snapshot version 2 (see candidate()), the
// configuration map (the switches; the config port every piece reads), a test witness of the
// per-order results (event_log on the launching transaction), and the waits used to hold a
// transaction "in flight": an order key lock held on another connection (rolled back to release),
// a pause in a wrapper of the bill job's source port, and a pause after one statement of the launch
// (a Kysely plugin, like ../credit/kit.ts failAfter).
// Round 2 (任务书 §10.2): more barriers inside a run (barrier(): the supplement's 1st / 2nd source
// read, the bill job's onGenerated hook, the executor's switch read between two items, the caller's
// outer transaction around launchInTransaction); row lock waits from pg_stat_activity; every barrier
// (reachedBefore) and every finally (finish) bounded at 30 s, after which the lock waits of the test
// database are cancelled so that the stuck run ends, and the case asserts on what was not reached.
//
// Amounts (自拟, on the B2-04m harness defaults, same as ../supplement-locked-recheck/kit.ts):
// N = 1000 fen (seq 1 STATEMENT decides the amount; seq 2 is an API record), reserve 1500 bp:
// B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base 850 → candidate (tolerance 0).
// Shares self 5000 / direct 1000 / indirect 500 bp of 850 → 425 / 85 / floor(42.5) = 42, users 552,
// PLATFORM:CREDIT 850 − 552 + 150 = 448. A full credit: 4 vouchers, 8 entry lines; with a frozen
// direct: 3 vouchers, 6 entry lines and one first_credit obligation of 85.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createDb, destroyDb, type DB } from '@couli/db';
import { addFen } from '@couli/money';
import {
  PostgresQueryCompiler,
  sql,
  type Kysely,
  type PostgresPool,
  type QueryId,
  type Transaction,
} from 'kysely';
import { expect, vi } from 'vitest';
import { creditGateKey } from '../../../../apps/api/src/modules/settlement/batch/credit-gate.ts';
import type { SettlementWorkerPorts } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import { createBatchCommandService } from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';
import { createBillSourceReader } from '../../../../apps/api/src/modules/settlement/bill/infra/bill-source.ts';
import {
  createBillJob,
  type BillJobDependencies,
  type BillJobResult,
  type BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  createSupplementCommand,
  type SupplementDependencies,
  type SupplementResult,
} from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  appendVersion,
  commission,
  type Fixture as SnapshotFixture,
} from '../../commission/snapshot-read/fixtures.ts';
import { ledger } from '../bill/kit.ts';
import {
  BEFORE,
  deferred,
  harness,
  shareOf,
  type CompiledQuery,
  type OrderSpec,
  type SeededOrder,
} from '../credit/kit.ts';
import { lockKey, lockOrderKey, type Tracked } from '../supplement-locked-recheck/kit.ts';
import { withWorker, workerPorts } from '../worker/credit-kit.ts';
import { EXECUTE, receivedJob } from '../worker/kit.ts';

export {
  creditKey,
  databaseFixture,
  failAfter,
  platformKey,
  userCreditLines,
} from '../credit/kit.ts';
export type { SeededOrder } from '../credit/kit.ts';
export {
  BATCH_WRITE,
  FROZEN_DIRECT,
  ITEM_WRITE,
  generated,
  track,
} from '../supplement-locked-recheck/kit.ts';
export type { Outcome, Tracked } from '../supplement-locked-recheck/kit.ts';

export const TIMEOUT = 240_000;
export const MONTH = '2032-06';
export const TAOBAO = 'taobao';
export const JD = 'jd';
/** When the bill job generated the bill, and when the old batches were confirmed. */
const GENERATED_AT = '2032-07-24T08:00:00+08:00';
const CONFIRMED_AT = '2032-07-24T09:00:00+08:00';
/** The injected Clock during every case: finance's launch moment (not a bill day). */
export const LAUNCH = '2032-07-26T10:00:00+08:00';
/** LAUNCH + 11 s: past the 10-second bound on a cached switch value (BR-FUND-04 ⑦). */
export const PAST_SWITCH_CACHE = '2032-07-26T10:00:11+08:00';
/** The bill job's nominal run_at: bill day 24 (default settle.bill_day) of 2032-07 → bill 2032-06. */
export const BILL_RUN_AT = '2032-07-24T00:00:00+08:00';
const SETTLE_FEN = 1000n;
const BASE_FEN = 850n;
/** Test witness only (not a production event name). */
const VALIDATION_EVENT = 'test.credit-gate.validation';

/** pg_locks.mode of a shared / an exclusive advisory lock. */
export const SHARE = 'ShareLock';
export const EXCLUSIVE = 'ExclusiveLock';
export type GateMode = typeof SHARE | typeof EXCLUSIVE;

/** Polls of pg_locks: 500 × 20 ms; the long one (a run expected to finish meanwhile): 1500 × 20 ms. */
const POLLS = 500;
const LONG_POLLS = 1500;
const POLL_MS = 20;
/** Bound of one barrier, and of the end of the runs in one finally: 30 s (round 2, S2). */
const BOUND_MS = 30_000;

export interface SavedValidation extends BillValidation {
  readonly billId: string;
  readonly platform: string;
  readonly runAt: string;
}

export interface OldBatch {
  readonly batchId: string;
  /** settle_batch_items.id by order id. */
  readonly items: ReadonlyMap<string, string>;
}

export interface FixtureOptions {
  /**
   * The platforms whose bill-day run of bill MONTH is already done (settle_bills
   * platform_order_counts names them; the supplement needs it). Default taobao and jd; [] lets the
   * bill job run for taobao.
   */
  readonly billPlatforms?: readonly string[];
}

export interface LaunchOptions {
  /** Executor of the launch (default: the shared pool). */
  readonly via?: Kysely<DB>;
  /** SupplementDependencies.lockChunkSize (default: not passed). */
  readonly lockChunkSize?: number;
}

export interface Pause {
  /** Resolves when the paused statement / read has run and waits. */
  readonly reached: Promise<void>;
  readonly isReached: () => boolean;
  release(): void;
  /**
   * A connection of the test database that reachedBefore uses to cancel lock waits when neither
   * the pause nor the run's end came within the bound (round 2, S2).
   */
  readonly observer?: Kysely<DB>;
}

function sleep(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
}

export async function fixture(db: Kysely<DB>, options: FixtureOptions = {}) {
  const h = await harness(db);
  const appId = h.appId;
  h.clock.set(LAUNCH);
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `credit-gate-${adminId}`,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  const counts = Object.fromEntries((options.billPlatforms ?? [TAOBAO, JD]).map((p) => [p, 0]));
  await db
    .insertInto('settle_bills')
    .values({
      app_id: appId,
      bill_id: MONTH,
      generation_started_at: new Date(GENERATED_AT),
      generated_at: new Date(GENERATED_AT),
      platform_order_counts: JSON.stringify(counts),
      created_at: new Date(GENERATED_AT),
    })
    .execute();

  // ---- configuration: credit.enabled.<platform> on; settle.auto.enabled unset (default on) -------
  const switches = new Map<string, unknown>([
    [`credit.enabled.${TAOBAO}`, true],
    [`credit.enabled.${JD}`, true],
  ]);
  const config = { get: vi.fn(async (_appId: string, key: string) => switches.get(key)) };
  const w = workerPorts(h, switches);

  // ---- the production source reader behind the supplement's and the bill job's ports ------------
  const realSource = createBillSourceReader({
    readUnionAuthoritative: async () => new Set<string>(),
  });
  const readSource = vi.fn<SupplementDependencies['readSource']>((trx, input) =>
    realSource(trx, input),
  );
  const billPauses: (() => Promise<void>)[] = [];
  const billSource = vi.fn<BillJobDependencies['readSource']>(async (trx, input) => {
    const rows = await realSource(trx, input);
    // The bill job is "in flight": it has read the source and waits for the case's signal.
    const pause = billPauses.shift();
    if (pause !== undefined) await pause();
    return rows;
  });
  const readSnapshot = vi.fn<BillJobDependencies['readSnapshot']>(
    commission.readCommissionSnapshot,
  );
  const readTljDeductFen = vi.fn<BillJobDependencies['readTljDeductFen']>(async (trx, input) => {
    const row = await trx
      .selectFrom('commission_splits')
      .select('tlj_deduct_fen')
      .where('app_id', '=', input.appId)
      .where('order_id', '=', input.orderId)
      .executeTakeFirstOrThrow();
    return row.tlj_deduct_fen;
  });
  const registerDiff = vi.fn<BillJobDependencies['registerDiff']>(ledger.registerReconDiff);
  const saveValidations = vi.fn<BillJobDependencies['saveValidations']>(
    async (trx, input, rows) => {
      for (const row of rows) {
        await trx
          .insertInto('event_log')
          .values({
            app_id: input.appId,
            event_id: randomUUID(),
            name: VALIDATION_EVENT,
            payload: JSON.stringify({
              billId: input.billId,
              platform: input.platform,
              runAt: input.runAt.toISOString(),
              ...row,
            }),
            occurred_at: h.clock.now(),
            created_at: h.clock.now(),
          })
          .execute();
      }
    },
  );
  const supplementDeps: SupplementDependencies = {
    clock: h.clock,
    config,
    readSource,
    readSnapshot,
    readTljDeductFen,
    registerDiff,
    saveValidations,
  };

  /** finance's launch for taobao on bill MONTH; the nominal moment is the Clock. */
  function supplement(launch: LaunchOptions = {}): Promise<SupplementResult> {
    const deps: SupplementDependencies =
      launch.lockChunkSize === undefined
        ? supplementDeps
        : { ...supplementDeps, lockChunkSize: launch.lockChunkSize };
    return createSupplementCommand(deps).launch(launch.via ?? db, {
      appId,
      billId: MONTH,
      platform: TAOBAO,
      requestedAt: h.clock.now(),
    });
  }

  const billDeps: BillJobDependencies = {
    clock: h.clock,
    config,
    readSource: billSource,
    readSnapshot,
    readTljDeductFen,
    snapshotStatus: async () => ({
      state: 'complete' as const,
      snapshotId: null,
      waitingComparable: null,
    }),
    registerDiff,
    saveValidations,
  };
  const billJob = createBillJob(billDeps);

  /** The bill-day job of taobao at BILL_RUN_AT (bill MONTH), on the shared pool. */
  function runBill(): Promise<BillJobResult> {
    return billJob.run(db, { appId, platform: TAOBAO, runAt: new Date(BILL_RUN_AT) });
  }

  /** The next bill source read returns only after release() (the real read has run). */
  function pauseBillSource(): Pause {
    const reached = deferred();
    const go = deferred();
    const state = { reached: false };
    billPauses.push(async () => {
      state.reached = true;
      reached.resolve();
      await go.promise;
    });
    return {
      reached: reached.promise,
      isReached: () => state.reached,
      release: () => go.resolve(),
      observer: db,
    };
  }

  // ---- seeding ------------------------------------------------------------------------------------
  /** A WAITING sub-order of bill month 2032-06 whose current snapshot (v2) matches B_settle 850. */
  async function candidate(spec: OrderSpec = {}): Promise<SeededOrder> {
    const o = await h.order({ ...spec, patch: { commission_version: 2, ...spec.patch } });
    const people = o.people.map((p) => ({
      userId: p.userId,
      role: p.role,
      ratioBp: p.ratioBp,
      level: 'L1' as const,
      initialStatus: 'active' as const,
      forfeitReason: null,
    }));
    const amounts = people.map((p) => shareOf(BASE_FEN, p.ratioBp));
    const userTotal = amounts.reduce((sum, a) => addFen(sum, a), 0n);
    const snapshot: SnapshotFixture = {
      input: { appId, orderId: o.orderId, commissionVersion: 2 },
      ruleVersionId: randomUUID(),
      ruleEffectiveFrom: new Date(BEFORE),
      people,
    };
    await appendVersion(
      db,
      snapshot,
      2,
      BASE_FEN,
      SETTLE_FEN,
      amounts,
      userTotal,
      new Date(BEFORE),
    );
    return o;
  }

  /** A CONFIRMED main batch of bill MONTH on `platform`, one order item per order. */
  async function confirmedBatch(
    orders: readonly SeededOrder[],
    platform: string = TAOBAO,
  ): Promise<OldBatch> {
    const batchId = randomUUID();
    await db
      .insertInto('settle_batches')
      .values({
        batch_id: batchId,
        app_id: appId,
        bill_id: MONTH,
        platform,
        kind: 'main',
        status: 'CONFIRMED',
        settle_mode: 'IMMEDIATE',
        scheduled_at: null,
        confirmed_by: adminId,
        confirmed_at: new Date(CONFIRMED_AT),
        cancelled_reason: null,
        settle_run_id: null,
        order_count: orders.length,
        started_at: null,
        finished_at: null,
        paused_by_switch_at: null,
        row_version: 1,
        created_at: new Date(GENERATED_AT),
      })
      .execute();
    const items = new Map<string, string>();
    for (const o of orders) {
      const id = randomUUID();
      items.set(o.orderId, id);
      await db
        .insertInto('settle_batch_items')
        .values({
          id,
          app_id: appId,
          batch_id: batchId,
          item_type: 'order',
          order_id: o.orderId,
          user_id: null,
          role: null,
          beneficiary_credit_id: null,
          settle_seq: o.seq,
          b_settle_fen: BASE_FEN,
          amount_fen: null,
          result: null,
          skip_reason: null,
          created_at: new Date(GENERATED_AT),
        })
        .execute();
    }
    return { batchId, items };
  }

  // ---- production writers -------------------------------------------------------------------------
  /** One batch_execute delivery through SettlementModule.forWorker (the real executor). */
  async function execute(batchId: string): Promise<void> {
    await withWorker(w.ports, h, db, async (handler) => {
      await handler(receivedJob(EXECUTE, { app_id: appId, batch_id: batchId }));
    });
  }

  const commands = createBatchCommandService({
    db,
    clock: h.clock,
    // As the console assembles it (编排裁定 D10-444): every DRAFT of the bill.
    currentRound: async (trx, input) => {
      const rows = await trx
        .selectFrom('settle_batches')
        .select('batch_id')
        .where('app_id', '=', input.appId)
        .where('bill_id', '=', input.billId)
        .where('status', '=', 'DRAFT')
        .execute();
      return rows.map((row) => row.batch_id);
    },
    readiness: async () => ({
      autoEnabled: true,
      creditEnabled: true,
      snapshotCompleted: true,
      snapshotTimedOut: false,
    }),
  });

  /** finance continues a PARTIAL batch (SB8, PARTIAL → EXECUTING); the executor runs it later. */
  async function resume(batchId: string): Promise<void> {
    const row = await batch(batchId);
    expect(row.status).toBe('PARTIAL');
    await commands.resumeBatch({
      appId,
      adminId,
      batchId,
      expectedRowVersion: row.row_version,
    });
  }

  /** Confirms every DRAFT of the bill (IMMEDIATE) and executes them; returns their ids. */
  async function settleDrafts(): Promise<string[]> {
    const drafts = await db
      .selectFrom('settle_batches')
      .select(['batch_id', 'row_version'])
      .where('app_id', '=', appId)
      .where('bill_id', '=', MONTH)
      .where('status', '=', 'DRAFT')
      .orderBy('batch_id')
      .execute();
    expect(drafts.length).toBeGreaterThan(0);
    await commands.confirmBill({
      appId,
      adminId,
      billId: MONTH,
      expectedBatches: drafts.map((d) => ({
        batchId: d.batch_id,
        expectedRowVersion: d.row_version,
      })),
    });
    const ids = drafts.map((d) => d.batch_id);
    for (const id of ids) await execute(id);
    return ids;
  }

  // ---- reads --------------------------------------------------------------------------------------
  function batch(batchId: string) {
    return db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .where('batch_id', '=', batchId)
      .executeTakeFirstOrThrow();
  }

  function batchesOf(kind: 'main' | 'supplement') {
    return db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .where('kind', '=', kind)
      .orderBy('batch_id')
      .execute();
  }

  function supplementBatches() {
    return batchesOf('supplement');
  }

  function allItems() {
    return db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }

  async function itemsIn(batchIds: readonly string[]) {
    if (batchIds.length === 0) return [];
    return db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .where('batch_id', 'in', [...batchIds])
      .orderBy('id')
      .execute();
  }

  function itemOf(old: OldBatch, o: SeededOrder) {
    const id = old.items.get(o.orderId);
    if (id === undefined) throw new Error('no item of this order in the batch');
    return db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  function bill() {
    return db
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', appId)
      .where('bill_id', '=', MONTH)
      .executeTakeFirstOrThrow();
  }

  /** The per-order results of committed runs; `runAt` (ISO) picks one run. */
  async function validations(runAt?: string): Promise<SavedValidation[]> {
    const rows = await db
      .selectFrom('event_log')
      .select('payload')
      .where('app_id', '=', appId)
      .where('name', '=', VALIDATION_EVENT)
      .orderBy('id')
      .execute();
    const all = rows.map((row) => row.payload as unknown as SavedValidation);
    return runAt === undefined ? all : all.filter((v) => v.runAt === runAt);
  }

  function jobs() {
    return db
      .selectFrom('settle_jobs')
      .select(['job', 'platform', 'run_at', 'status', 'processed_count', 'skipped_count'])
      .where('app_id', '=', appId)
      .orderBy('run_at')
      .execute();
  }

  async function openObligations(o: SeededOrder) {
    const rows = await h.obligations();
    return rows.filter((row) => row.order_id === o.orderId && row.status === 'open');
  }

  /** The order's voucher keys and its number of entry lines (keys start with the order key). */
  async function orderLedger(o: SeededOrder) {
    const prefix = `${o.orderKey}:`;
    const vouchers = (await h.voucherKeys()).filter((key) => key.startsWith(prefix));
    const lines = (await h.lines()).filter((line) => line.uniq_key.startsWith(prefix)).length;
    return { vouchers, lines };
  }

  /** R5 rows of the order (each first credit writes exactly one). */
  async function creditedHistory(o: SeededOrder): Promise<number> {
    const rows = await h.history(o);
    return rows.filter((r) => r.field === 'rebate' && r.to_status === 'CREDITED').length;
  }

  async function rebateOf(o: SeededOrder): Promise<string> {
    return (await h.read(o)).rebate_status;
  }

  // ---- 第 2 次写测追加（任务书 §10.2）：只新增，以上成员不变 ---------------------------------------
  /** finance's launch for `platform` on bill MONTH (options as supplement()); moment = the Clock. */
  function supplementOn(platform: string, launch: LaunchOptions = {}): Promise<SupplementResult> {
    const deps: SupplementDependencies =
      launch.lockChunkSize === undefined
        ? supplementDeps
        : { ...supplementDeps, lockChunkSize: launch.lockChunkSize };
    return createSupplementCommand(deps).launch(launch.via ?? db, {
      appId,
      billId: MONTH,
      platform,
      requestedAt: h.clock.now(),
    });
  }

  /**
   * The console's entry (launchAdminSettleSupplement runs it on its idempotency transaction): the
   * taobao launch on bill MONTH on the caller's `trx`, nominal moment = the Clock.
   */
  function supplementInTransaction(trx: Transaction<DB>): Promise<SupplementResult> {
    return createSupplementCommand(supplementDeps).launchInTransaction(trx, {
      appId,
      billId: MONTH,
      platform: TAOBAO,
      requestedAt: h.clock.now(),
    });
  }

  /**
   * The supplement's source read number `nth` (1: the first read; 2: the next one, i.e. the re-read
   * of the first lock chunk) waits at the returned barrier — at its entry, before the production
   * reader runs, or once the production reader has returned. Other reads are the production reader.
   */
  function pauseSupplementSource(nth: 1 | 2, at: 'entry' | 'returned'): Barrier {
    const pause = barrier(db);
    if (nth === 2) readSource.mockImplementationOnce((trx, input) => realSource(trx, input));
    readSource.mockImplementationOnce(async (trx, input) => {
      if (at === 'entry') await pause.wait();
      const rows = await realSource(trx, input);
      if (at === 'returned') await pause.wait();
      return rows;
    });
    return pause;
  }

  /**
   * The bill-day job of taobao at BILL_RUN_AT (bill MONTH) whose onGenerated hook — called on the
   * generating transaction right before it commits — waits at the returned barrier.
   */
  function runBillHeldAtCommit(): HeldRun<BillJobResult> {
    const pause = barrier(db);
    const job = createBillJob({ ...billDeps, onGenerated: () => pause.wait() });
    return {
      run: job.run(db, { appId, platform: TAOBAO, runAt: new Date(BILL_RUN_AT) }),
      pause,
    };
  }

  /**
   * One batch_execute delivery (as execute()) whose configuration reads go through the switch map
   * as usual, except that the first read made once `due()` answers true waits at the returned
   * barrier (`due` is asked before each read until then). The executor reads both switches before
   * every item transaction (BR-FUND-04 ⑦), so a `due` that becomes true when an item has committed
   * holds the delivery after that commit and before the next item transaction begins.
   */
  function executePaused(batchId: string, due: () => Promise<boolean>): HeldRun<void> {
    const pause = barrier(db);
    const state = { armed: true };
    const get = async (_appId: string, key: string): Promise<unknown> => {
      if (state.armed && (await due()) && state.armed) {
        state.armed = false;
        await pause.wait();
      }
      return switches.get(key);
    };
    const ports: SettlementWorkerPorts = { ...w.ports, config: () => ({ get }) };
    const run = withWorker(ports, h, db, async (handler) => {
      await handler(receivedJob(EXECUTE, { app_id: appId, batch_id: batchId }));
    });
    return { run, pause };
  }

  /** Confirms every DRAFT of the bill (IMMEDIATE) through the console's command; no execution. */
  async function confirmDrafts(): Promise<string[]> {
    const drafts = await db
      .selectFrom('settle_batches')
      .select(['batch_id', 'row_version'])
      .where('app_id', '=', appId)
      .where('bill_id', '=', MONTH)
      .where('status', '=', 'DRAFT')
      .orderBy('batch_id')
      .execute();
    expect(drafts.length).toBeGreaterThan(0);
    await commands.confirmBill({
      appId,
      adminId,
      billId: MONTH,
      expectedBatches: drafts.map((d) => ({
        batchId: d.batch_id,
        expectedRowVersion: d.row_version,
      })),
    });
    return drafts.map((d) => d.batch_id);
  }

  async function obligationsOf(o: SeededOrder) {
    return (await h.obligations()).filter((row) => row.order_id === o.orderId);
  }

  /** Rebate history rows ending in CREDITED: from WAITING (R5) and from CREDITED (R5a). */
  async function creditHistoryCounts(o: SeededOrder) {
    const rows = await h.history(o);
    const credited = rows.filter((r) => r.field === 'rebate' && r.to_status === 'CREDITED');
    return {
      firstCredit: credited.filter((r) => r.from_status === 'WAITING').length,
      selfStep: credited.filter((r) => r.from_status === 'CREDITED').length,
    };
  }

  // ---- 第 3 次写测追加（任务书 §11.2）：只新增，以上成员不变 ---------------------------------------
  /**
   * The bill-day job of taobao at BILL_RUN_AT (bill MONTH) run on `via` (e.g. a single connection, or
   * commitPausingDb's executor); `onGenerated`, when given, is the production hook on the generating
   * transaction right before it commits.
   */
  function runBillVia(via: Kysely<DB>, onGenerated?: () => Promise<void>): Promise<BillJobResult> {
    const job = onGenerated === undefined ? billJob : createBillJob({ ...billDeps, onGenerated });
    return job.run(via, { appId, platform: TAOBAO, runAt: new Date(BILL_RUN_AT) });
  }

  return {
    h,
    appId,
    adminId,
    switches,
    readSource,
    billSource,
    supplement,
    runBill,
    pauseBillSource,
    candidate,
    confirmedBatch,
    execute,
    resume,
    settleDrafts,
    batch,
    batchesOf,
    supplementBatches,
    allItems,
    itemsIn,
    itemOf,
    bill,
    validations,
    jobs,
    openObligations,
    orderLedger,
    creditedHistory,
    rebateOf,
    supplementOn,
    supplementInTransaction,
    pauseSupplementSource,
    runBillHeldAtCommit,
    executePaused,
    confirmDrafts,
    obligationsOf,
    creditHistoryCounts,
    runBillVia,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

// ---- holding an order key lock on another connection -----------------------------------------------

class Released extends Error {
  constructor() {
    super('credit-gate kit: the order key lock holder rolled back');
    this.name = 'Released';
  }
}

class ProbeDone extends Error {
  constructor() {
    super('credit-gate kit: probe rolled back');
    this.name = 'ProbeDone';
  }
}

export interface OrderLockHolder {
  /** Rolls the holder's transaction back (the lock is released). */
  release(): void;
  /** Resolves once the holder's transaction has ended. */
  readonly done: Promise<void>;
}

/**
 * orders' lockOrderKey on `conn` in a transaction that stays open until release(), then rolls
 * back. Resolves once the lock is held.
 */
export async function holdOrderLock(conn: Kysely<DB>, o: SeededOrder): Promise<OrderLockHolder> {
  const locked = deferred();
  const go = deferred();
  const done = conn
    .transaction()
    .execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      locked.resolve();
      await go.promise;
      throw new Released();
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof Released)) throw error;
      },
    );
  await Promise.race([locked.promise, done]);
  return { release: () => go.resolve(), done };
}

/**
 * From `conn`, `pg_try_advisory_xact_lock` on the order key of `o` (the same bigint key as
 * lockOrderKey), in a transaction rolled back right away: true when the lock was free.
 */
export async function tryOrderLock(conn: Kysely<DB>, o: SeededOrder): Promise<boolean> {
  const probe = { taken: false };
  await conn
    .transaction()
    .execute(async (trx) => {
      const result = await sql<{ ok: boolean }>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(o)}, 0)) AS ok`.execute(trx);
      probe.taken = result.rows[0]?.ok === true;
      throw new ProbeDone();
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof ProbeDone)) throw error;
      },
    );
  return probe.taken;
}

// ---- a pause after one statement of a run ---------------------------------------------------------

/**
 * The first statement run through the returned executor that `match`es is executed by PostgreSQL;
 * its result is handed back only after release() (the transaction stays open meanwhile).
 */
export function pauseAfter(db: Kysely<DB>, match: (query: CompiledQuery) => boolean) {
  const reached = deferred();
  const go = deferred();
  const pending = new Set<QueryId>();
  const state = { armed: true, reached: false };
  const paused = db.withPlugin({
    transformQuery(args) {
      const query = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
      if (state.armed && match(query)) {
        state.armed = false;
        pending.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (pending.delete(args.queryId)) {
        state.reached = true;
        reached.resolve();
        await go.promise;
      }
      return args.result;
    },
  });
  const pause: Pause = {
    reached: reached.promise,
    isReached: () => state.reached,
    release: () => go.resolve(),
    observer: db,
  };
  return { db: paused, pause };
}

/**
 * true once `pause` is reached; false when `pending` ended first. Bounded (round 2, S2): when
 * neither happens within BOUND_MS, the lock waits of the test database are cancelled through
 * `pause.observer` (so the stuck run fails and its transaction rolls back, and the caller's finally
 * can end), the end is awaited once more within the bound, and false is returned — the caller's
 * `expect(reached).toBe(true)` then names the barrier that was not reached.
 */
export async function reachedBefore(pause: Pause, pending: Tracked<unknown>): Promise<boolean> {
  const met = await settlesBy(Promise.race([pause.reached, pending.outcome]), BOUND_MS);
  if (!met && pause.observer !== undefined) {
    // Round 3 (r2 S2): the cancel itself is bounded, and escalates (see unblock).
    await unblock(pause.observer, () => Promise.race([pause.reached, pending.outcome]));
  }
  return pause.isReached();
}

// ---- 第 2 次写测追加（任务书 §10.2 第 9 点，评审 r1 S2）：屏障与收尾的上限 ---------------------------

/** true when `promise` settles (either way) within `ms`; the timer is always cleared. */
async function settlesBy(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const late = new Promise<false>((resolve) => {
    timer.handle = setTimeout(() => resolve(false), ms);
  });
  const ended = promise.then(settled, settled);
  try {
    return await Promise.race([ended, late]);
  } finally {
    clearTimeout(timer.handle);
  }
}

function settled(): true {
  return true;
}

/**
 * Cancels every statement of the test database (one database per test file) that waits for a
 * lock, other than the observer's own; returns how many were cancelled. A cancelled statement
 * fails, so its transaction rolls back and the run that issued it ends.
 */
export async function cancelLockWaits(observer: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM (
      SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    ) AS cancelled`.execute(observer);
  return result.rows[0]?.n ?? 0;
}

/**
 * For a finally: waits within BOUND_MS for every run to end; if some have not, cancels the lock
 * waits of the test database and waits once more within the bound. Returns the names of the runs
 * that still have not ended (the caller asserts `[]` after the finally, which names the stage).
 */
export async function finish(
  observer: Kysely<DB>,
  runs: Readonly<Record<string, Tracked<unknown> | undefined>>,
): Promise<string[]> {
  const all = () => Promise.all(Object.values(runs).map((run) => run?.outcome));
  if (!(await settlesBy(all(), BOUND_MS))) {
    // Round 3 (r2 S2): the cancel itself is bounded, and escalates (see unblock).
    await unblock(observer, all);
  }
  return Object.entries(runs)
    .filter(([, run]) => run !== undefined && !run.settled)
    .map(([name]) => name);
}

/** A barrier a run waits at: wait() marks it reached and resolves on release(). */
export interface Barrier extends Pause {
  wait(): Promise<void>;
}

/** A run started with a barrier inside it. */
export interface HeldRun<T> {
  readonly run: Promise<T>;
  readonly pause: Barrier;
}

export function barrier(observer: Kysely<DB>): Barrier {
  const reached = deferred();
  const go = deferred();
  const state = { reached: false };
  return {
    reached: reached.promise,
    isReached: () => state.reached,
    release: () => go.resolve(),
    observer,
    async wait() {
      state.reached = true;
      reached.resolve();
      await go.promise;
    },
  };
}

/**
 * The pid of a backend waiting for a row lock (pg_stat_activity: wait_event_type Lock, not an
 * advisory lock) in a statement on `table`; null when `pending` ended first, or after the bounded
 * poll (the caller asserts).
 */
export async function rowLockWaiter(
  observer: Kysely<DB>,
  table: string,
  pending: Tracked<unknown>,
): Promise<number | null> {
  for (let attempt = 0; attempt < POLLS; attempt += 1) {
    const result = await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND wait_event <> 'advisory'
        AND position(${table} in query) > 0
      ORDER BY pid LIMIT 1`.execute(observer);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    if (pending.settled) return null;
    await sleep();
  }
  return null;
}

/** pg_blocking_pids of `pid`, ascending. */
export async function blockersOf(observer: Kysely<DB>, pid: number): Promise<number[]> {
  const result = await sql<{ pid: number }>`
    SELECT b AS pid FROM unnest(pg_blocking_pids(${pid})) AS b ORDER BY b`.execute(observer);
  return result.rows.map((row) => row.pid);
}

// ---- pg_locks ---------------------------------------------------------------------------------------

interface LockRow {
  readonly pid: number;
  readonly mode: string;
  readonly granted: boolean;
}

/**
 * pg_locks rows of the credit gate of (appId, platform): advisory, the two-int key form
 * (objsubid 2), classid / objid = hashtext of the skeleton's namespace / key (as unsigned 32 bits).
 */
async function gateLocks(observer: Kysely<DB>, appId: string, platform: string) {
  const gate = creditGateKey(appId, platform);
  const result = await sql<LockRow>`
    SELECT pid, mode, granted FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 2
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid::bigint = (hashtext(${gate.namespace})::bigint & 4294967295)
      AND objid::bigint = (hashtext(${gate.key})::bigint & 4294967295)
    ORDER BY pid`.execute(observer);
  return result.rows;
}

/**
 * pg_locks rows of the order key lock of `o`: advisory, one bigint key (objsubid 1) =
 * hashtextextended(lock key text, 0), high half in classid, low half in objid.
 */
async function orderLocks(observer: Kysely<DB>, o: SeededOrder) {
  const text = lockKey(o);
  const result = await sql<LockRow>`
    SELECT pid, mode, granted FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 1
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid::bigint = ((hashtextextended(${text}, 0) >> 32) & 4294967295)
      AND objid::bigint = (hashtextextended(${text}, 0) & 4294967295)
    ORDER BY pid`.execute(observer);
  return result.rows;
}

/**
 * true once a backend waits (not granted) for the gate of (appId, platform) in `mode`; false when
 * `pending` ended first, or after the bounded poll (the caller asserts).
 */
export async function waitsOnGate(
  observer: Kysely<DB>,
  appId: string,
  platform: string,
  mode: GateMode,
  pending: Tracked<unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < POLLS; attempt += 1) {
    const rows = await gateLocks(observer, appId, platform);
    if (rows.some((r) => !r.granted && r.mode === mode)) return true;
    if (pending.settled) return false;
    await sleep();
  }
  return false;
}

/** Granted locks of the gate of (appId, platform) in `mode`, all backends (or one `pid`). */
export async function gateGranted(
  observer: Kysely<DB>,
  appId: string,
  platform: string,
  mode: GateMode,
  pid?: number,
): Promise<number> {
  const rows = await gateLocks(observer, appId, platform);
  const held = rows.filter((r) => r.granted && r.mode === mode);
  return pid === undefined ? held.length : held.filter((r) => r.pid === pid).length;
}

/** Every pg_locks row of the gate of (appId, platform) held or awaited by `pid`. */
export async function gateRowsOf(
  observer: Kysely<DB>,
  appId: string,
  platform: string,
  pid: number,
): Promise<{ readonly mode: string; readonly granted: boolean }[]> {
  const rows = await gateLocks(observer, appId, platform);
  return rows.filter((r) => r.pid === pid).map((r) => ({ mode: r.mode, granted: r.granted }));
}

/**
 * The pid of the backend that waits (not granted) for the order key lock of `o`; null when
 * `pending` ended first, or after the bounded poll (the caller asserts).
 */
export async function orderLockWaiter(
  observer: Kysely<DB>,
  o: SeededOrder,
  pending: Tracked<unknown>,
): Promise<number | null> {
  for (let attempt = 0; attempt < POLLS; attempt += 1) {
    const waiting = (await orderLocks(observer, o)).find((r) => !r.granted);
    if (waiting !== undefined) return waiting.pid;
    if (pending.settled) return null;
    await sleep();
  }
  return null;
}

/** Order-key-form (single bigint, objsubid 1) advisory locks granted to `pid`. */
export async function grantedOrderKeyLocksOf(observer: Kysely<DB>, pid: number): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND locktype = 'advisory' AND objsubid = 1 AND granted AND pid = ${pid}`.execute(observer);
  return result.rows[0]?.n ?? 0;
}

/** true once `run` has ended; false after the long bounded poll (about 30 s). */
export async function settlesWithin(run: Tracked<unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < LONG_POLLS; attempt += 1) {
    if (run.settled) return true;
    await sleep();
  }
  return run.settled;
}

// ---- 第 3 次写测追加（任务书 §11.2，评审 r2）：只新增 -------------------------------------------------

/**
 * Bounded unblocking for reachedBefore / finish (r2 S2): cancels the lock waits of the test database
 * through `observer`, the cancel itself bounded at BOUND_MS; when the cancel does not answer in time,
 * or `ended` still has not settled within BOUND_MS after it, the open transactions of the test
 * database (one database per test file, so they all belong to the running case) other than the
 * observer's own are terminated — their connections close, PostgreSQL rolls them back — and their
 * exit is confirmed by a bounded poll; then `ended` is awaited once more within the bound. A run that
 * is stuck outside the database (JavaScript, a pool wait) is left to the caller's assertion.
 */
async function unblock(observer: Kysely<DB>, ended: () => Promise<unknown>): Promise<void> {
  const cancelled = await settlesBy(cancelLockWaits(observer), BOUND_MS);
  if (cancelled && (await settlesBy(ended(), BOUND_MS))) return;
  await settlesBy(endOpenTransactions(observer), BOUND_MS);
  await settlesBy(ended(), BOUND_MS);
}

/** Terminates the open transactions of the test database except the observer's; true once gone. */
async function endOpenTransactions(observer: Kysely<DB>): Promise<boolean> {
  await sql`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND xact_start IS NOT NULL`.execute(observer);
  for (let attempt = 0; attempt < POLLS; attempt += 1) {
    const result = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND xact_start IS NOT NULL`.execute(observer);
    if ((result.rows[0]?.n ?? 0) === 0) return true;
    await sleep();
  }
  return false;
}

/** The backend pid of a single-connection executor (left / right / control). */
export async function backendPid(conn: Kysely<DB>): Promise<number> {
  const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(conn);
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('credit-gate kit: no backend pid');
  return pid;
}

/**
 * The pid of a backend that waits (not granted) right now for the gate of (appId, platform) in
 * `mode` (one look, no poll: the caller has already seen the wait through waitsOnGate); null if none.
 */
export async function gateWaiter(
  observer: Kysely<DB>,
  appId: string,
  platform: string,
  mode: GateMode,
): Promise<number | null> {
  const rows = await gateLocks(observer, appId, platform);
  return rows.find((r) => !r.granted && r.mode === mode)?.pid ?? null;
}

/**
 * The pid of the backend that sits idle inside a transaction whose last statement mentions `table`
 * (a run held by pauseAfter right after that statement); null if none.
 */
export async function idleInTransactionOn(
  observer: Kysely<DB>,
  table: string,
): Promise<number | null> {
  const result = await sql<{ pid: number }>`
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND state = 'idle in transaction' AND position(${table} in query) > 0
    ORDER BY pid LIMIT 1`.execute(observer);
  return result.rows[0]?.pid ?? null;
}

/**
 * The gate of (appId, platform) in exclusive mode, held on `conn` by the case itself with the
 * skeleton's exclusive statement (`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, keys
 * from creditGateKey) in a transaction that stays open until release(), then rolls back. Resolves
 * once the lock is held.
 */
export async function holdGateExclusive(
  conn: Kysely<DB>,
  appId: string,
  platform: string,
): Promise<OrderLockHolder> {
  const gate = creditGateKey(appId, platform);
  const locked = deferred();
  const go = deferred();
  const done = conn
    .transaction()
    .execute(async (trx) => {
      await sql`
        SELECT pg_advisory_xact_lock(hashtext(${gate.namespace}), hashtext(${gate.key}))
      `.execute(trx);
      locked.resolve();
      await go.promise;
      throw new Released();
    })
    .then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof Released)) throw error;
      },
    );
  await Promise.race([locked.promise, done]);
  return { release: () => go.resolve(), done };
}

interface PgClientLike {
  query(text: unknown, params?: unknown): Promise<unknown>;
}
interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** An executor whose next COMMIT, once armed, waits at a barrier before it is sent. */
export interface CommitPausing {
  readonly db: Kysely<DB>;
  /** The next COMMIT sent through `db` waits at `pause` (pause.wait()), then goes to PostgreSQL. */
  arm(pause: Barrier): void;
  /** Closes the pool (bounded at BOUND_MS); true when it closed in time. */
  close(): Promise<boolean>;
}

/**
 * A Kysely executor on its own pg pool (createDb's poolFactory; `pg` resolved through packages/db,
 * as test/spec/platform/idempotency/transaction-failures.int.test.ts does) whose client holds back
 * the first `commit` sent after arm() until the armed barrier is released. Kysely ends every
 * transaction with the raw statement `commit` on the transaction's client, so the barrier sits
 * exactly between the last statement of the transaction (e.g. the bill job's onGenerated hook) and
 * its COMMIT; meanwhile the transaction is open and its transaction-level locks are held.
 */
export function commitPausingDb(connectionString: string): CommitPausing {
  const requireFromDb = createRequire(
    new URL('../../../../packages/db/package.json', import.meta.url),
  );
  const pg = requireFromDb('pg') as { Pool: new (config: unknown) => PgPoolLike };
  const state: { armed: Barrier | undefined } = { armed: undefined };
  const wrapped = new WeakMap<PgClientLike, PgClientLike>();

  function pausingClient(client: PgClientLike): PgClientLike {
    return new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return async (text: unknown, params?: unknown) => {
            const pause = state.armed;
            if (
              pause !== undefined &&
              typeof text === 'string' &&
              text.trim().toLowerCase() === 'commit'
            ) {
              state.armed = undefined;
              await pause.wait();
            }
            return target.query(text, params);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  function pausingPool(config: unknown): PostgresPool {
    const real = new pg.Pool(config);
    real.on('error', () => undefined);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'connect') {
          return async () => {
            const client = await target.connect();
            const known = wrapped.get(client);
            if (known !== undefined) return known;
            const proxy = pausingClient(client);
            wrapped.set(client, proxy);
            return proxy;
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as unknown as PostgresPool;
  }

  const db = createDb({
    max: 2,
    poolFactory: (config) => pausingPool({ ...config, connectionString }),
  });
  return {
    db,
    arm(pause) {
      state.armed = pause;
    },
    close: () => settlesBy(destroyDb(db), BOUND_MS),
  };
}
