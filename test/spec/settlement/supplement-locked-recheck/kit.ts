// B2-04rd rule-test kit (claude-independent, SPEC_REF 693f6a6): the supplement launch of
// BR-FUND-04 ⑧ (④ check and candidates, ⑦ re-check under the order lock, ⑫ beneficiary make-up
// items) when another connection commits after the launch has read its source and before it handles
// the order (编排 D10-2679).
// Real pieces: the supplement command (createSupplementCommand) over the production bill source
// reader (createBillSourceReader), commission's snapshot reader and ledger's registerReconDiff; the
// old batch and the supplement batches executed through SettlementModule.forWorker
// (../worker/credit-kit.ts: the real executor, the R5 credit order and the R5a beneficiary credit);
// confirmation through the batch command service (createBatchCommandService.confirmBill); the hold
// through settlement's R11 port (createRebateAdminCommandPort) behind orders' lockOrderKey and a
// FOR UPDATE re-read, the way orders calls it; users, orders, ledger accounts and commission rows
// from the B2-04m harness (../credit/kit.ts).
// Synthetic: the bill row and the admin account, the old CONFIRMED batch and its item (as the bill
// job and a confirmation leave them), commission snapshot version 2 (see candidate()), the
// configuration map, a test witness of the per-order results (event_log on the launch's
// transaction; the production saveBillValidations writes nothing) and the readSource wrapper that
// runs the concurrent action after the real read has returned and before the launch goes on.
//
// Amounts (自拟, on the B2-04m harness defaults): N = 1000 fen (order_settlements seq 1 STATEMENT;
// the harness's seq 2 is an API record, which does not decide the amount), reserve 1500 bp:
// B_settle = floor(1000 × 8500 / 10000) = 850 = snapshot v2 base 850 → candidate (tolerance 0).
// Shares self 5000 / direct 1000 / indirect 500 bp of 850 → 425 / 85 / 42 (floor 42.5), users 552,
// PLATFORM:CREDIT 850 − 552 + 150 = 448. The harness's version 1 is taken on a drifted estimate
// (base 3683, never 850), so version 2 is appended as the current one (BR-CALC-10: the greatest
// commission_version) and orders.commission_version = 2; both credits read the attribution only.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import {
  lockOrderKey,
  orderLockKeyText,
  type AdminHoldInput,
  type RightsCommandPort,
  type RightsRecordInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createBatchCommandService } from '../../../../apps/api/src/modules/settlement/batch/commands/service.ts';
import type { ClawbackOrder } from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import { createRebatePort } from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import { createBillSourceReader } from '../../../../apps/api/src/modules/settlement/bill/infra/bill-source.ts';
import type {
  BillJobDependencies,
  BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  createSupplementCommand,
  type SupplementDependencies,
  type SupplementResult,
} from '../../../../apps/api/src/modules/settlement/bill/supplement/command.ts';
import {
  createRebateAdminCommandPort,
  createRightsCommandPort,
} from '../../../../apps/api/src/modules/settlement/rights/index.ts';
import {
  appendVersion,
  commission,
  type Fixture as SnapshotFixture,
} from '../../commission/snapshot-read/fixtures.ts';
import { ledger } from '../bill/kit.ts';
import {
  BEFORE,
  harness,
  shareOf,
  type OrderSpec,
  type PersonSpec,
  type SeededOrder,
} from '../credit/kit.ts';
import { withWorker, workerPorts } from '../worker/credit-kit.ts';
import { EXECUTE, receivedJob, silentRootLogger } from '../worker/kit.ts';

export {
  creditKey,
  databaseFixture,
  deferred,
  failAfter,
  platformKey,
  tracing,
  userCreditLines,
} from '../credit/kit.ts';
export type { CompiledQuery, SeededOrder } from '../credit/kit.ts';
export { lockOrderKey };

export const TIMEOUT = 240_000;
export const MONTH = '2032-06';
export const PLATFORM = 'taobao';
/** When the bill job generated the bill, and when the old batch was confirmed. */
const GENERATED_AT = '2032-07-24T08:00:00+08:00';
const CONFIRMED_AT = '2032-07-24T09:00:00+08:00';
/** finance launches the supplement: the injected Clock, so also the cut-off. Not a bill day. */
export const LAUNCH = '2032-07-26T10:00:00+08:00';
/** The next round, after the frozen beneficiary was released. */
export const NEXT_LAUNCH = '2032-07-27T10:00:00+08:00';
const SETTLE_FEN = 1000n;
const BASE_FEN = 850n;
/** Test witness only (not a production event name). */
const VALIDATION_EVENT = 'test.supplement-locked-recheck.validation';

/** The direct referrer frozen: R5 holds the 85 and opens a first_credit obligation for it. */
export const FROZEN_DIRECT: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000, state: 'frozen' },
  { role: 'indirect', ratioBp: 500 },
];

/** The statement of orders' lockOrderKey (its one parameter is the key text). */
export const ORDER_LOCK = /pg_advisory_xact_lock\(\s*hashtextextended\(\s*\$1\s*,\s*0\s*\)\s*\)/i;
/** A read of app.orders (the builder's "orders" or the source statement's app.orders). */
export const ORDERS_READ = /\b(?:from|join)\s+(?:"?app"?\s*\.\s*)?"?orders"?(?!\w)/i;
/** A write of a batch or of a batch item. */
export const BATCH_WRITE = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?settle_batch(?:es|_items)"?/i;
/** A write of batch items. */
export const ITEM_WRITE = /insert\s+into\s+(?:"?app"?\s*\.\s*)?"?settle_batch_items"?/i;

const ADVISORY_WAITERS = sql<{ n: number }>`
  SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

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

/** The answer of a launch that generated `batchIds` (none when nothing could be batched). */
export function generated(batchIds: readonly string[]) {
  return { outcome: 'generated', billId: MONTH, platform: PLATFORM, batchIds };
}

/** The key text of orders' lockOrderKey for this sub-order ('orders.order_key:' + order key). */
export function lockKey(o: SeededOrder): string {
  return orderLockKeyText(o.platform, o.subOrderId);
}

export type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface Tracked<T> {
  readonly outcome: Promise<Outcome<T>>;
  readonly settled: boolean;
}

/** A launch whose end can be looked at while it waits; its rejection is kept, never unhandled. */
export function track<T>(promise: Promise<T>): Tracked<T> {
  const state = { settled: false };
  const outcome = promise.then(
    (value): Outcome<T> => {
      state.settled = true;
      return { ok: true, value };
    },
    (error: unknown): Outcome<T> => {
      state.settled = true;
      return { ok: false, error };
    },
  );
  return {
    outcome,
    get settled() {
      return state.settled;
    },
  };
}

/**
 * True once a backend of the test database waits for an advisory lock (pg_locks, not granted);
 * false when `pending` ended first, or after 500 polls 20 ms apart (the caller asserts).
 */
export async function advisoryWaiter(
  observer: Kysely<DB>,
  pending: Tracked<unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await ADVISORY_WAITERS.execute(observer);
    if ((result.rows[0]?.n ?? 0) > 0) return true;
    if (pending.settled) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export async function fixture(db: Kysely<DB>) {
  const h = await harness(db);
  const appId = h.appId;
  h.clock.set(LAUNCH);
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `supplement-recheck-${adminId}`,
      password_hash: 'test-only',
      is_super: true,
      status: 'active',
    })
    .execute();
  // The bill job has generated bill 2032-06 for taobao (platform_order_counts names the platform).
  await db
    .insertInto('settle_bills')
    .values({
      app_id: appId,
      bill_id: MONTH,
      generation_started_at: new Date(GENERATED_AT),
      generated_at: new Date(GENERATED_AT),
      platform_order_counts: JSON.stringify({ [PLATFORM]: 0 }),
      created_at: new Date(GENERATED_AT),
    })
    .execute();

  // ---- configuration: credit.enabled.taobao on; settle.auto.enabled unset (default on) ---------
  const switches = new Map<string, unknown>([[`credit.enabled.${PLATFORM}`, true]]);
  const config = { get: vi.fn(async (_appId: string, key: string) => switches.get(key)) };
  const w = workerPorts(h, switches);

  // ---- the supplement command over the production source reader --------------------------------
  const realSource = createBillSourceReader({
    readUnionAuthoritative: async () => new Set<string>(),
  });
  const concurrent: (() => Promise<void>)[] = [];
  const readSource = vi.fn<SupplementDependencies['readSource']>(async (trx, input) => {
    const rows = await realSource(trx, input);
    // The concurrent action runs (and commits) on another connection before the rows go back.
    const action = concurrent.shift();
    if (action !== undefined) await action();
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
  const saveValidations = vi.fn<SupplementDependencies['saveValidations']>(
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
  const deps: SupplementDependencies = {
    clock: h.clock,
    config,
    readSource,
    readSnapshot,
    readTljDeductFen,
    registerDiff,
    saveValidations,
  };
  // Built before any assertion on a rejection, so that a NotImplemented is never swallowed.
  const command = createSupplementCommand(deps);

  /** finance's launch on `via` (default: the shared pool); the nominal moment is the Clock. */
  function launch(via: Kysely<DB> = db): Promise<SupplementResult> {
    return command.launch(via, {
      appId,
      billId: MONTH,
      platform: PLATFORM,
      requestedAt: h.clock.now(),
    });
  }

  /** The next source read returns only after `action` has run and committed. */
  function afterSourceRead(action: () => Promise<void>): void {
    concurrent.push(action);
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

  /** A CONFIRMED main batch of the bill, one order item per order (as a confirmation left it). */
  async function oldBatch(orders: readonly SeededOrder[]): Promise<OldBatch> {
    const batchId = randomUUID();
    await db
      .insertInto('settle_batches')
      .values({
        batch_id: batchId,
        app_id: appId,
        bill_id: MONTH,
        platform: PLATFORM,
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
  /** batch_execute of each batch through SettlementModule.forWorker (its own connections). */
  async function execute(batchIds: readonly string[]): Promise<void> {
    await withWorker(w.ports, h, db, async (handler) => {
      for (const batchId of batchIds) {
        await handler(receivedJob(EXECUTE, { app_id: appId, batch_id: batchId }));
      }
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
    await execute(ids);
    return ids;
  }

  const rebateAdmin = createRebateAdminCommandPort({ clock: h.clock, logger: silentRootLogger() });

  /** R11 as orders runs it: lockOrderKey first, the order re-read FOR UPDATE, then the port. */
  async function holdIn(trx: Transaction<DB>, o: SeededOrder): Promise<void> {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const input: AdminHoldInput = {
      before,
      expected_row_version: before.row_version,
      reason_code: 'RISK',
      reason: 'synthetic note',
      actor: adminId,
      ip: null,
      now: h.clock.now(),
    };
    expect(await rebateAdmin.adminHold(trx, input)).toMatchObject({ kind: 'applied' });
  }

  /** One R11 hold in its own transaction on `via` (committed when this resolves). */
  function hold(via: Kysely<DB>, o: SeededOrder): Promise<void> {
    return via.transaction().execute((trx) => holdIn(trx, o));
  }

  /** order-sync's later record (BR-FUND-09), obtained one minute before the Clock. */
  async function laterSettlement(
    via: Kysely<DB>,
    o: SeededOrder,
    seq: number,
    fen: bigint,
  ): Promise<void> {
    await via
      .insertInto('order_settlements')
      .values({
        app_id: appId,
        order_id: o.orderId,
        seq,
        source: 'API',
        settle_commission_fen: fen,
        settled_at: o.attrAt,
        created_at: new Date(h.clock.now().getTime() - 60_000),
        content_hash: randomUUID(),
      })
      .execute();
  }

  // ---- reads --------------------------------------------------------------------------------------
  function supplementBatches() {
    return db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', appId)
      .where('kind', '=', 'supplement')
      .orderBy('batch_id')
      .execute();
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

  function itemOf(batch: OldBatch, o: SeededOrder) {
    const id = batch.items.get(o.orderId);
    if (id === undefined) throw new Error('no item of this order in the batch');
    return db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  /** The per-order results the launches saved (witness rows of committed launches only). */
  async function validations(): Promise<SavedValidation[]> {
    const rows = await db
      .selectFrom('event_log')
      .select('payload')
      .where('app_id', '=', appId)
      .where('name', '=', VALIDATION_EVENT)
      .orderBy('id')
      .execute();
    return rows.map((row) => row.payload as unknown as SavedValidation);
  }

  function jobs() {
    return db
      .selectFrom('settle_jobs')
      .select(['job', 'platform', 'run_at', 'status', 'processed_count', 'skipped_count'])
      .where('app_id', '=', appId)
      .orderBy('run_at')
      .execute();
  }

  function diffs() {
    return db.selectFrom('recon_diffs').selectAll().where('app_id', '=', appId).execute();
  }

  async function obligationsOf(o: SeededOrder) {
    return (await h.obligations()).filter((row) => row.order_id === o.orderId);
  }

  async function openObligations(o: SeededOrder) {
    return (await obligationsOf(o)).filter((row) => row.status === 'open');
  }

  /** The order's voucher keys and its number of entry lines (keys start with the order key). */
  async function orderLedger(o: SeededOrder) {
    const prefix = `${o.orderKey}:`;
    const vouchers = (await h.voucherKeys()).filter((key) => key.startsWith(prefix));
    const lines = (await h.lines()).filter((line) => line.uniq_key.startsWith(prefix)).length;
    return { vouchers, lines };
  }

  /** R5 rows of the order (each credit writes exactly one). */
  async function creditedHistory(o: SeededOrder): Promise<number> {
    const rows = await h.history(o);
    return rows.filter((r) => r.field === 'rebate' && r.to_status === 'CREDITED').length;
  }

  /** Everything of the app a launch, an execution or a hold may write. */
  async function state() {
    return {
      ...(await h.state()),
      batches: await db
        .selectFrom('settle_batches')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('batch_id')
        .execute(),
      items: await allItems(),
      jobs: await jobs(),
      diffs: await diffs(),
    };
  }

  return {
    h,
    appId,
    adminId,
    readSource,
    readSnapshot,
    registerDiff,
    saveValidations,
    command,
    launch,
    afterSourceRead,
    candidate,
    oldBatch,
    execute,
    settleDrafts,
    holdIn,
    hold,
    laterSettlement,
    supplementBatches,
    allItems,
    itemsIn,
    itemOf,
    validations,
    jobs,
    diffs,
    obligationsOf,
    openObligations,
    orderLedger,
    creditedHistory,
    state,
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

// ---- 第 3 次写测追加（任务书 §11，评审 r1 的覆盖缺口）：只新增，以上导出不变 -----------------------

/** Both referrers frozen: R5 holds 85 and 42 and opens one first_credit obligation for each. */
export const FROZEN_REFERRERS: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000, state: 'frozen' },
  { role: 'indirect', ratioBp: 500, state: 'frozen' },
];

/** A read of app.order_settlements (the builder's "order_settlements" or the source statement's). */
export const SETTLEMENTS_READ =
  /\b(?:from|join)\s+(?:"?app"?\s*\.\s*)?"?order_settlements"?(?!\w)/i;

/** The failure of the outer transaction after launchInTransaction has returned. */
export const OUTER_FAILURE = 'injected failure of the outer transaction';

/** occurred_at of the union's rights records below (before the launch; not the Clock). */
const RIGHTS_AT = '2032-07-25T09:00:00+08:00';

const ADVISORY_GRANTED = sql<{ n: number }>`
  SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

/** Advisory locks granted in the test database right now (any backend). */
export async function advisoryGranted(observer: Kysely<DB>): Promise<number> {
  const result = await ADVISORY_GRANTED.execute(observer);
  return result.rows[0]?.n ?? 0;
}

/**
 * The console's entry (launchAdminSettleSupplement calls it on its idempotency transaction): the
 * launch on the caller's transaction `trx`, nominal moment = the Clock, as the console takes it.
 */
export function launchInTransaction(f: Fixture, trx: Transaction<DB>): Promise<SupplementResult> {
  return f.command.launchInTransaction(trx, {
    appId: f.appId,
    billId: MONTH,
    platform: PLATFORM,
    requestedAt: f.h.clock.now(),
  });
}

/** order-sync's later record (BR-FUND-09), built like laterSettlement but obtained at `createdAt`. */
export async function settlementAt(
  f: Fixture,
  via: Kysely<DB>,
  o: SeededOrder,
  seq: number,
  fen: bigint,
  createdAt: Date,
): Promise<void> {
  await via
    .insertInto('order_settlements')
    .values({
      app_id: f.appId,
      order_id: o.orderId,
      seq,
      source: 'API',
      settle_commission_fen: fen,
      settled_at: o.attrAt,
      created_at: createdAt,
      content_hash: randomUUID(),
    })
    .execute();
}

interface Keyed {
  readonly orderKey: string;
}

function descendingKey(a: Keyed, b: Keyed): number {
  if (a.orderKey === b.orderKey) return 0;
  return a.orderKey < b.orderKey ? 1 : -1;
}

/**
 * The launch's first source read still reads the database (the production reader), but hands its
 * rows back in descending order key; later reads are the fixture's own (ascending, as produced).
 */
export function reverseFirstSourceRead(f: Fixture): void {
  const real = createBillSourceReader({
    readUnionAuthoritative: async () => new Set<string>(),
  });
  f.readSource.mockImplementationOnce(async (trx, input) => {
    const rows = await real(trx, input);
    return [...rows].sort(descendingKey);
  });
}

/**
 * settlement's rights command (orders' rights.record) with the real B2-04j rebate port behind it.
 * Commission's valuation boundary is a constant (850 / 850; R6 PUNISH does not read it, PROCESSING
 * stops before the rebate port) and the system hold audit is not exercised. The clawback is only
 * reached for CREDITED orders; these records land on WAITING ones, so it throws if ever called.
 */
function rightsCommand(f: Fixture): RightsCommandPort {
  const logger = silentRootLogger();
  const unreachable = async (): Promise<never> => {
    throw new Error('supplement-locked-recheck kit: clawback reached on a WAITING order');
  };
  const clawback: ClawbackOrder = { apply: unreachable, onUpdated: unreachable };
  const rebate = createRebatePort({
    clock: f.h.clock,
    logger,
    events: { publish: f.h.publish },
    config: { get: async () => undefined },
    estimates: {
      bases: async () => ({ before: BASE_FEN, after: BASE_FEN }),
      refresh: async () => undefined,
    },
    audit: { append: async () => undefined },
  });
  return createRightsCommandPort({
    clock: f.h.clock,
    logger,
    events: { publish: f.h.publish },
    clawback,
    rebate,
  });
}

/** One rights.record the way orders runs it: lockOrderKey, the order re-read FOR UPDATE, the port. */
async function recordRights(
  f: Fixture,
  via: Kysely<DB>,
  o: SeededOrder,
  record: Pick<RightsRecordInput, 'type' | 'status'>,
): Promise<void> {
  const port = rightsCommand(f);
  await via.transaction().execute(async (trx) => {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    const before = await trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const result = await port.record(trx, {
      before,
      order_id: o.orderId,
      source: 'API',
      type: record.type,
      status: record.status,
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: new Date(RIGHTS_AT),
      platform_rights_no: `rights-${o.subOrderId}`,
      now: f.h.clock.now(),
    });
    expect(result).toMatchObject({ kind: 'applied' });
  });
}

/** The union opens a rights case (RIGHTS, PROCESSING): rights_pending true, O stays WAITING. */
export function openRights(f: Fixture, via: Kysely<DB>, o: SeededOrder): Promise<void> {
  return recordRights(f, via, o, { type: 'RIGHTS', status: 'PROCESSING' });
}

/** A successful union punishment (PUNISH, SUCCEEDED): R6 PUNISH, WAITING → VOID. */
export function punish(f: Fixture, via: Kysely<DB>, o: SeededOrder): Promise<void> {
  return recordRights(f, via, o, { type: 'PUNISH', status: 'SUCCEEDED' });
}

// ---- 第 4 次写测追加（任务书 §12，编排 D10-2690）：只新增，以上导出不变 ------------------------------

/** The order's rebate history rows ending in CREDITED, split by where they start. */
export interface CreditHistoryCounts {
  /** WAITING → CREDITED (R5, the first credit). */
  readonly firstCredit: number;
  /** CREDITED → CREDITED (R5a, the beneficiary credit's self-step). */
  readonly selfStep: number;
}

/** app.order_status_history of the order, field = 'rebate', counted by from_status / to_status. */
export async function creditHistoryCounts(
  f: Fixture,
  o: SeededOrder,
): Promise<CreditHistoryCounts> {
  const rows = await f.h.history(o);
  const credited = rows.filter((r) => r.field === 'rebate' && r.to_status === 'CREDITED');
  return {
    firstCredit: credited.filter((r) => r.from_status === 'WAITING').length,
    selfStep: credited.filter((r) => r.from_status === 'CREDITED').length,
  };
}
