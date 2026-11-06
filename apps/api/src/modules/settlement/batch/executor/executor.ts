// B2-04p: the settle batch executor (job batch_execute). BR-FUND-04 ⑦ ⑩ ⑫ and 细则「结算批次迁移表」
// SB5–SB9, 「到执行时刻开关为 off 与执行中跨日」; BR-FUND-18 (no batch between 00:00 and the day's
// asset snapshot); BR-FUND-20 (settle.auto.enabled stops a running batch); 规划/12 §4.3.
//
// run({ appId, batchId }) is one delivery of the batch_execute job. It never writes settle_jobs
// (batch progress lives in settle_batches / settle_batch_items, 规划/04 §3.2). Steps:
//   1. Read the batch for appId (another app's batch, or none: outcome 'idle', nothing written).
//      DRAFT, PARTIAL (no automatic resume), DONE, CANCELLED: 'idle', nothing written.
//   2. Executor liveness: at most one live executor per batch. The run holds a session-level
//      PostgreSQL advisory lock on the batch for its whole duration, on one reserved connection of
//      deps.db that also carries every later statement of the run (so a lost connection stops the
//      run, and a run never holds one connection while waiting for another), and releases it when
//      the run ends; a crashed process loses it with its connection. A run that
//      cannot take it at once (another executor is alive) returns 'busy' without waiting and
//      without writing anything.
//   3. CONFIRMED (SB5), in this order:
//        a. paused_by_switch_at set: 'idle', nothing written (only SB10 may start it);
//        b. not yet at the execution instant (SCHEDULED and clock < scheduled_at): 'not_due';
//        c. settle.auto.enabled or credit.enabled.<platform> not on: write paused_by_switch_at =
//           clock.now() (row_version CAS, status stays CONFIRMED), 'switched_off' — before the
//           snapshot check, so also while the snapshot is pending; on the same transaction, under
//           the run lock, settle.run_done as in step 6 (a paused batch counts as stopped by a
//           switch, so this pause may be the run's last move);
//        d. today's asset snapshot (deps.snapshotStatus for D = the day before the +08:00
//           accounting date of clock.now()) neither complete nor timed out: 'snapshot_pending',
//           nothing written;
//        e. CONFIRMED → EXECUTING through the generated settle-batch transition() (event START), CAS
//           on (status, row_version); started_at = clock.now(). A lost CAS: 'busy'.
//      EXECUTING (SB9, no live executor since step 2 succeeded): the snapshot check d (else
//      'snapshot_pending', nothing written), then EXECUTING → EXECUTING (event TAKE_OVER, CAS; does
//      not touch started_at). A lost CAS: 'busy'.
//   4. Item loop: the items whose result is null, in ascending order_key of their order
//      (order_keys: `${platform}:${sub_order_id}`); an item with a result is never executed again.
//      Before each item:
//        - read settle.auto.enabled and credit.enabled.<platform> through deps.config (a value is
//          on only when it is true or 'on'; a missing credit.enabled is off, a missing
//          settle.auto.enabled takes the switch registry default (on); a cached value is at
//          most 10 seconds old by deps.clock): either off → stop, EXECUTING → PARTIAL (SB7, event
//          SWITCH_OFF, CAS), 'partial';
//        - the accounting date of clock.now() differs from the one the run started on and that
//          day's snapshot check d fails → stop, the batch stays EXECUTING, 'day_rollover'.
//      Each item runs in its own transaction on the reserved connection:
//        - item_type order: deps.creditOrder.credit(trx, { appId, orderId, expectedSettleSeq:
//          item.settle_seq, openedRef: item.id }); credited → result 'credited'; skipped → result
//          'skipped' and skip_reason = the returned reason (e.g. 'not_waiting',
//          'tlj_deduct_unsupported'); amount_fen stays null;
//        - item_type beneficiary: deps.creditBeneficiary.execute(trx, …) (B2-04q); result /
//          amount_fen / skip_reason as returned;
//        - the item row is written on the same transaction as the credit. An item whose result is
//          'credited' also adds 1 to the batch's credited_count on that transaction (D10-726; one
//          UPDATE of settle_batches WHERE status = 'EXECUTING', no row_version change, any other
//          row count rolls the item back); skipped and deferred items add nothing. Right before
//          commit the day check above runs again: crossed into a day whose snapshot check d fails
//          → the transaction rolls back (the item and its count stay undone) and the run ends
//          'day_rollover'.
//      An unexpected error of an item transaction rolls it back and run() rejects with that error;
//      the batch stays EXECUTING for a later SB9 take-over.
//   5. No item left: one transaction moves EXECUTING → DONE (SB6, event COMPLETE, CAS), sets
//      finished_at = clock.now() and publishes settle.batch_done (payload with batch_id) through
//      deps.events on that same transaction; 'done'. A failing publish rolls the transaction back
//      (the batch stays EXECUTING) and run() rejects.
//   6. settle.run_done (B2-04zf; D10-467 ③ as corrected by D10-477 and D10-492; BR-TEXT-09): the DONE
//      transaction of step 5, the SB7 transaction of step 4 (the PARTIAL move runs in its own
//      transaction) and the SB5 c pause transaction first take a transaction-level advisory lock
//      on (app, settle_run_id), so the completing transactions of one run run one after another
//      and each sees the others' committed batches. After the batch's own move, when no batch of
//      that run (same app_id and settle_run_id) is EXECUTING, or CONFIRMED without
//      paused_by_switch_at, any more, the run rests: outcome 'partial' when a batch of it was
//      stopped by a switch (PARTIAL, or CONFIRMED with paused_by_switch_at), else 'done'; DRAFT
//      and CANCELLED batches neither count nor block. A batch without settle_run_id has no run.
//      Part and the count watermark live in settlement's own app.settle_runs (migrations 0108,
//      0127), read on the same transaction: a run without a row has published nothing (part 0,
//      watermark 0). Whether this execution credited anything is decided by counts only, never by
//      comparing timestamps (D10-726; worker clocks may differ): total = the sum of
//      credited_count over the run's batches (read by the same query as their statuses); the run
//      publishes only when total > published_credited_count. Equal → nothing credited since the
//      last publish: nothing is published and no part is used up, also when the batch just
//      reached DONE (D10-732, BR-TEXT-09 「0 笔不发」). Smaller cannot happen (counts only grow):
//      an error is logged and nothing is published, without failing the batch's move.
//      Publishing: part = row part + 1; the row moves to that part and outcome,
//      published_credited_count = total, part_started_at = clock.now() (audit only, no decision
//      reads it), row_version + 1 — a CAS on row_version, or the INSERT of the row at the run's
//      first publish (ON CONFLICT DO NOTHING) — then settle.run_done with payload
//      { settle_run_id, bill_id, part, outcome, batch_count } and an event id derived from
//      (app, run, part), all on that same transaction. A lost CAS or INSERT publishes nothing
//      and leaves the watermark (the batch move still commits; those credits count for the next
//      publish); a failing publish rolls the transaction back (the batch keeps its state, the row
//      and its watermark stay as they were). event_log is never read.
// Batch status only through the generated settle-batch transition(), every write a row_version CAS.
// Time only from deps.clock; logs only through deps.logger.
import type { DB } from '@couli/db';
import {
  SETTLE_BATCH_STATES,
  accountingDate,
  transitionSettleBatch,
  type SettleBatchEvent,
  type SettleBatchState,
} from '@couli/domain';
import { sql, type Kysely, type Transaction, type Updateable } from 'kysely';
import { switchSpecOf } from '../../../content/index.ts';
import type { Clock, EventBus, RootLogger } from '../../../platform/index.ts';
import type { CreditOrder, CreditRole } from '../../credit/index.ts';
import {
  compareItems,
  previousDay,
  runDoneEventId,
  runRest,
  runWatermark,
  switchOn,
} from './rules.ts';

export interface BatchExecuteInput {
  readonly appId: string;
  readonly batchId: string;
}

/**
 * done: SB6 reached by this run. partial: SB7 (a switch was off before an item). day_rollover:
 * stopped after crossing into a day whose snapshot is not ready (the batch stays EXECUTING).
 * not_due / snapshot_pending: nothing written. switched_off: CONFIRMED at its execution instant
 * with a switch off, paused_by_switch_at written. idle: nothing to execute, nothing written.
 * busy: another executor is alive or won the CAS, nothing written.
 */
export type BatchExecuteOutcome =
  | 'done'
  | 'partial'
  | 'day_rollover'
  | 'not_due'
  | 'snapshot_pending'
  | 'switched_off'
  | 'idle'
  | 'busy';

export interface BatchExecuteResult {
  readonly outcome: BatchExecuteOutcome;
}

/** A beneficiary item of BR-FUND-04 ⑫, handed to the B2-04q executor on the item transaction. */
export interface BeneficiaryItemInput {
  readonly appId: string;
  readonly batchId: string;
  /** settle_batch_items.id */
  readonly itemId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly beneficiaryCreditId: string;
  /** settle_batch_items.settle_seq: the order_settlements seq when the item was generated. */
  readonly expectedSettleSeq: number;
}

/** What the item row records: credited with amount_fen, deferred, or skipped with skip_reason. */
export type BeneficiaryItemResult =
  | { readonly result: 'credited'; readonly amountFen: bigint }
  | { readonly result: 'deferred' }
  | { readonly result: 'skipped'; readonly reason: string };

/** Port of the beneficiary supplement credit (B2-04q, R5a); runs on the caller's transaction. */
export interface BeneficiaryItemCredit {
  execute(trx: Transaction<DB>, input: BeneficiaryItemInput): Promise<BeneficiaryItemResult>;
}

export interface BatchExecutorDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  /** content config reader: settle.auto.enabled, credit.enabled.<platform>. */
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  /** ledger getAssetSnapshotStatus (B2-04w); D is the snapshot's own accounting date. */
  snapshotStatus(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly accountingDate: string },
    clock: Clock,
  ): Promise<{
    readonly state: 'pending' | 'complete' | 'timed_out';
    readonly snapshotId: string | null;
    readonly waitingComparable: boolean | null;
  }>;
  /** B2-04m single-order credit. */
  readonly creditOrder: Pick<CreditOrder, 'credit'>;
  // TODO(规划/11 §4.2): 接入 B2-04q 的受益人补记执行 — blocked on B2-04q 未合并（先声明端口）
  /** B2-04q beneficiary supplement credit. */
  readonly creditBeneficiary: BeneficiaryItemCredit;
  readonly events: Pick<EventBus, 'publish'>;
}

export interface BatchExecutor {
  run(input: BatchExecuteInput): Promise<BatchExecuteResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** First key of the two-int advisory lock: a key space apart from the bigint order_key locks. */
const LOCK_NAMESPACE = 'settlement.batch_execute';
const AUTO_SWITCH = 'settle.auto.enabled';
const DONE_EVENT = 'settle.batch_done';
const RUN_DONE_EVENT = 'settle.run_done';
/** First key of the transaction-level run lock (B2-04zf), apart from the batch liveness lock. */
const RUN_LOCK_NAMESPACE = 'settlement.settle_run';
const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];

interface BatchRow {
  readonly batch_id: string;
  readonly app_id: string;
  readonly bill_id: string;
  readonly platform: string;
  readonly kind: string;
  readonly status: string;
  readonly settle_mode: string;
  readonly scheduled_at: Date | null;
  readonly paused_by_switch_at: Date | null;
  readonly settle_run_id: string | null;
  readonly row_version: number;
}

/** The run's app.settle_runs row as step 6 reads it. */
interface RunRow {
  readonly part: number;
  /** published_credited_count: the credit count of the last publish (D10-726). */
  readonly published_credited_count: number;
  readonly row_version: number;
}

interface ItemRow {
  readonly id: string;
  readonly item_type: string;
  readonly order_id: string;
  readonly user_id: string | null;
  readonly role: string | null;
  readonly beneficiary_credit_id: string | null;
  readonly settle_seq: number;
  readonly platform: string;
  readonly sub_order_id: string;
}

interface ItemWrite {
  readonly result: 'credited' | 'skipped' | 'deferred';
  readonly amount_fen: bigint | null;
  readonly skip_reason: string | null;
}

/** The item transaction crossed into a day whose snapshot is not ready: roll it back, stop. */
class DayRollover extends Error {
  constructor() {
    super('settle batch execution crossed into a day whose asset snapshot is not ready');
    this.name = 'DayRollover';
  }
}

/** A batch CAS inside a transaction matched no row (someone else moved it): roll back, 'busy'. */
class LostCas extends Error {
  constructor() {
    super('settle batch row_version CAS lost');
    this.name = 'LostCas';
  }
}

function stateOf(status: string): SettleBatchState {
  if (!(SETTLE_BATCH_STATES as readonly string[]).includes(status)) {
    throw new Error(`unknown settle batch status ${JSON.stringify(status)}`);
  }
  return status as SettleBatchState;
}

/** Only through the generated transition(); an event outside the table throws. */
function nextState(status: string, event: SettleBatchEvent): SettleBatchState {
  const result = transitionSettleBatch(stateOf(status), event);
  if (!result.ok) throw new Error(`settle batch ${status} --${event}--> not allowed`);
  return result.to;
}

/**
 * settle.auto.enabled defaults to on (BR-FUND-20; content's switch registry): an app without a
 * stored value runs batches. Only credit.enabled.<platform> treats a missing value as off.
 */
export function autoSwitchValue(stored: unknown): unknown {
  return stored === undefined || stored === null ? switchSpecOf(AUTO_SWITCH)?.defaultValue : stored;
}

function result(outcome: BatchExecuteOutcome): BatchExecuteResult {
  return { outcome };
}

export function createBatchExecutor(deps: BatchExecutorDependencies): BatchExecutor {
  const { db, clock, logger } = deps;

  function readBatch(on: Kysely<DB>, input: BatchExecuteInput): Promise<BatchRow | undefined> {
    return on
      .withSchema('app')
      .selectFrom('settle_batches')
      .select([
        'batch_id',
        'app_id',
        'bill_id',
        'platform',
        'kind',
        'status',
        'settle_mode',
        'scheduled_at',
        'paused_by_switch_at',
        'settle_run_id',
        'row_version',
      ])
      .where('app_id', '=', input.appId)
      .where('batch_id', '=', input.batchId)
      .executeTakeFirst();
  }

  /** One row_version CAS on (status, row_version); true when exactly one row matched. */
  async function casBatch(
    on: Kysely<DB>,
    batch: BatchRow,
    from: SettleBatchState,
    rowVersion: number,
    set: Updateable<DB['settle_batches']>,
  ): Promise<boolean> {
    const updated = await on
      .withSchema('app')
      .updateTable('settle_batches')
      .set({ ...set, row_version: rowVersion + 1 })
      .where('app_id', '=', batch.app_id)
      .where('batch_id', '=', batch.batch_id)
      .where('status', '=', from)
      .where('row_version', '=', rowVersion)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  /** BR-FUND-18: the snapshot of the day before `today` is complete or timed out. */
  async function snapshotReady(on: Kysely<DB>, appId: string, today: string): Promise<boolean> {
    const status = await deps.snapshotStatus(
      on,
      { appId, accountingDate: previousDay(today) },
      clock,
    );
    return status.state === 'complete' || status.state === 'timed_out';
  }

  /** BR-FUND-04 ⑦: read fresh before every item (no cache, within the 10-second bound). */
  async function switchesOn(appId: string, platform: string): Promise<boolean> {
    const auto = autoSwitchValue(await deps.config.get(appId, AUTO_SWITCH));
    const credit = await deps.config.get(appId, `credit.enabled.${platform}`);
    return switchOn(auto) && switchOn(credit);
  }

  /**
   * 细则「执行中跨日」: still the day the run is on, or a new day whose snapshot is ready (the run
   * then moves to that day); null when the new day's snapshot is not ready.
   */
  async function dayCheck(on: Kysely<DB>, appId: string, day: string): Promise<string | null> {
    const today = accountingDate(clock.now());
    if (today === day) return day;
    return (await snapshotReady(on, appId, today)) ? today : null;
  }

  async function loadItems(on: Kysely<DB>, input: BatchExecuteInput): Promise<ItemRow[]> {
    const rows = await on
      .withSchema('app')
      .selectFrom('settle_batch_items as i')
      .innerJoin('orders as o', (join) =>
        join.onRef('o.app_id', '=', 'i.app_id').onRef('o.order_id', '=', 'i.order_id'),
      )
      .select([
        'i.id',
        'i.item_type',
        'i.order_id',
        'i.user_id',
        'i.role',
        'i.beneficiary_credit_id',
        'i.settle_seq',
        'o.platform',
        'o.sub_order_id',
      ])
      .where('i.app_id', '=', input.appId)
      .where('i.batch_id', '=', input.batchId)
      .where('i.result', 'is', null)
      .execute();
    return rows.sort(compareItems);
  }

  async function unprocessedCount(trx: Transaction<DB>, batch: BatchRow): Promise<number> {
    const row = await trx
      .withSchema('app')
      .selectFrom('settle_batch_items')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('app_id', '=', batch.app_id)
      .where('batch_id', '=', batch.batch_id)
      .where('result', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function executeItem(
    trx: Transaction<DB>,
    batch: BatchRow,
    item: ItemRow,
  ): Promise<ItemWrite> {
    if (item.item_type === 'order') {
      const credited = await deps.creditOrder.credit(trx, {
        appId: batch.app_id,
        orderId: item.order_id,
        expectedSettleSeq: item.settle_seq,
        openedRef: item.id,
      });
      if (credited.outcome === 'credited') {
        return { result: 'credited', amount_fen: null, skip_reason: null };
      }
      return { result: 'skipped', amount_fen: null, skip_reason: credited.reason };
    }
    if (item.item_type !== 'beneficiary') {
      throw new Error(`settle batch item ${item.id} has an unknown item_type`);
    }
    const { user_id: userId, role, beneficiary_credit_id: beneficiaryCreditId } = item;
    if (userId === null || role === null || beneficiaryCreditId === null || !ROLES.includes(role)) {
      throw new Error(`settle batch item ${item.id} is not a well-formed beneficiary item`);
    }
    const answer = await deps.creditBeneficiary.execute(trx, {
      appId: batch.app_id,
      batchId: batch.batch_id,
      itemId: item.id,
      orderId: item.order_id,
      userId,
      role: role as CreditRole,
      beneficiaryCreditId,
      expectedSettleSeq: item.settle_seq,
    });
    switch (answer.result) {
      case 'credited':
        if (typeof answer.amountFen !== 'bigint' || answer.amountFen < 0n) {
          throw new Error(`settle batch item ${item.id}: credited amount is not a fen amount`);
        }
        return { result: 'credited', amount_fen: answer.amountFen, skip_reason: null };
      case 'deferred':
        return { result: 'deferred', amount_fen: null, skip_reason: null };
      case 'skipped':
        if (typeof answer.reason !== 'string' || answer.reason === '') {
          throw new Error(`settle batch item ${item.id}: skipped without a reason`);
        }
        return { result: 'skipped', amount_fen: null, skip_reason: answer.reason };
      default:
        throw new Error(`settle batch item ${item.id}: unknown beneficiary result`);
    }
  }

  /** 规划/12 §4.4: the item result on the credit's transaction, only while it is unprocessed. */
  async function writeItem(
    trx: Transaction<DB>,
    batch: BatchRow,
    item: ItemRow,
    write: ItemWrite,
  ): Promise<void> {
    const updated = await trx
      .withSchema('app')
      .updateTable('settle_batch_items')
      .set({ result: write.result, amount_fen: write.amount_fen, skip_reason: write.skip_reason })
      .where('app_id', '=', batch.app_id)
      .where('batch_id', '=', batch.batch_id)
      .where('id', '=', item.id)
      .where('result', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new Error(`settle batch item ${item.id} was already processed`);
    }
  }

  /**
   * D10-726: one credited item, +1 on the batch's credited_count on the item transaction. Not a
   * row_version move (the later SB7 / SB6 CAS use the version this run holds).
   */
  async function countCredit(trx: Transaction<DB>, batch: BatchRow): Promise<void> {
    const updated = await trx
      .withSchema('app')
      .updateTable('settle_batches')
      .set((eb) => ({ credited_count: eb('credited_count', '+', 1) }))
      .where('app_id', '=', batch.app_id)
      .where('batch_id', '=', batch.batch_id)
      .where('status', '=', 'EXECUTING')
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new Error(`settle batch ${batch.batch_id} credited_count not counted`);
    }
  }

  /** Step 6, first statement of a completing transaction: serialise the run's completions. */
  async function lockRun(trx: Transaction<DB>, batch: BatchRow): Promise<void> {
    if (batch.settle_run_id === null) return;
    const key = `${batch.app_id}:${batch.settle_run_id}`;
    await sql`
      select pg_advisory_xact_lock(hashtext(${RUN_LOCK_NAMESPACE}), hashtext(${key}))
    `.execute(trx);
  }

  function readRunRow(
    trx: Transaction<DB>,
    appId: string,
    runId: string,
  ): Promise<RunRow | undefined> {
    return trx
      .withSchema('app')
      .selectFrom('settle_runs')
      .select(['part', 'published_credited_count', 'row_version'])
      .where('app_id', '=', appId)
      .where('settle_run_id', '=', runId)
      .executeTakeFirst();
  }

  /**
   * The publish's row move on `trx`: INSERT at the run's first publish, else a row_version CAS.
   * false when another writer got there first (nothing is published then).
   */
  async function saveRunPart(
    trx: Transaction<DB>,
    batch: BatchRow,
    runId: string,
    row: RunRow | undefined,
    part: number,
    outcome: 'done' | 'partial',
    total: number,
  ): Promise<boolean> {
    const now = clock.now();
    if (row === undefined) {
      const inserted = await trx
        .withSchema('app')
        .insertInto('settle_runs')
        .values({
          settle_run_id: runId,
          app_id: batch.app_id,
          bill_id: batch.bill_id,
          part,
          last_outcome: outcome,
          published_credited_count: total,
          part_started_at: now,
          row_version: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('settle_run_id').doNothing())
        .executeTakeFirst();
      if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 1n) return true;
      // The id is taken: by a row of this app written outside the run lock (lost), or by another
      // app's run (settle_run_id is generated per confirmation and must not repeat).
      const owner = await trx
        .withSchema('app')
        .selectFrom('settle_runs')
        .select('app_id')
        .where('settle_run_id', '=', runId)
        .executeTakeFirst();
      if (owner !== undefined && owner.app_id !== batch.app_id) {
        throw new Error(`settle run ${runId} belongs to another app`);
      }
      return false;
    }
    const updated = await trx
      .withSchema('app')
      .updateTable('settle_runs')
      .set({
        part,
        last_outcome: outcome,
        published_credited_count: total,
        part_started_at: now,
        row_version: row.row_version + 1,
        updated_at: now,
      })
      .where('app_id', '=', batch.app_id)
      .where('settle_run_id', '=', runId)
      .where('row_version', '=', row.row_version)
      .executeTakeFirst();
    return updated.numUpdatedRows === 1n;
  }

  /** Step 6, after the batch's own move on `trx` (the run lock is held). */
  async function publishRunRest(trx: Transaction<DB>, batch: BatchRow): Promise<void> {
    const runId = batch.settle_run_id;
    if (runId === null) return;
    const rows = await trx
      .withSchema('app')
      .selectFrom('settle_batches')
      .select(['status', 'paused_by_switch_at', 'credited_count'])
      .where('app_id', '=', batch.app_id)
      .where('settle_run_id', '=', runId)
      .execute();
    const rest = runRest(
      rows.map((r) => ({ status: r.status, pausedBySwitch: r.paused_by_switch_at !== null })),
    );
    if (!rest.settled) return;
    const total = rows.reduce((sum, r) => sum + Number(r.credited_count), 0);
    const row = await readRunRow(trx, batch.app_id, runId);
    const watermark = Number(row?.published_credited_count ?? 0);
    // D10-726 / D10-732: only counts decide; nothing credited since the last publish → no event,
    // no part used up.
    const decision = runWatermark(total, watermark);
    if (decision === 'behind') {
      logger.error(
        {
          app_id: batch.app_id,
          settle_run_id: runId,
          total,
          watermark,
          event: 'settle_run_behind',
        },
        'settle run credit count below its published watermark',
      );
      return;
    }
    if (decision === 'nothing_new') return;
    const part = (row?.part ?? 0) + 1;
    const fields = { app_id: batch.app_id, settle_run_id: runId, part };
    if (!(await saveRunPart(trx, batch, runId, row, part, rest.outcome, total))) {
      logger.warn({ ...fields, event: 'settle_run_cas_lost' }, 'settle run part already taken');
      return;
    }
    await deps.events.publish(trx, {
      appId: batch.app_id,
      name: RUN_DONE_EVENT,
      eventId: runDoneEventId(batch.app_id, runId, part),
      payload: {
        settle_run_id: runId,
        bill_id: batch.bill_id,
        part,
        outcome: rest.outcome,
        batch_count: rest.batchCount,
      },
    });
    logger.info(
      { ...fields, outcome: rest.outcome, event: 'settle_run_rest' },
      'settle run event published',
    );
  }

  /**
   * Steps 3–5, with the liveness lock held by `conn`. Every statement of the run (batch CAS, item
   * transactions, snapshot reads) goes over that one connection: losing it loses the lock and
   * fails the run at its next statement, and a run never waits for a second pool connection while
   * holding one. Inside a transaction only `trx` is used (`conn` is busy until it ends).
   */
  async function owned(conn: Kysely<DB>, input: BatchExecuteInput): Promise<BatchExecuteResult> {
    // Re-read after the lock: an executor that just finished may have moved the batch on.
    const batch = await readBatch(conn, input);
    if (batch === undefined) return result('idle');
    const fields = { app_id: batch.app_id, batch_id: batch.batch_id };
    let version = batch.row_version;

    if (batch.status === 'CONFIRMED') {
      // SB5 a: only SB10 may start a batch stopped by a switch.
      if (batch.paused_by_switch_at !== null) return result('idle');
      // SB5 b: the execution instant.
      if (batch.settle_mode === 'SCHEDULED') {
        if (batch.scheduled_at === null) {
          throw new Error(`settle batch ${batch.batch_id} is SCHEDULED without scheduled_at`);
        }
        if (clock.now().getTime() < batch.scheduled_at.getTime()) return result('not_due');
      }
      // SB5 c: the switches, before the snapshot check.
      if (!(await switchesOn(batch.app_id, batch.platform))) {
        // The pause and settle.run_done (step 6) on one transaction: a paused batch no longer
        // blocks its run, so this pause may be the run's last move.
        try {
          await conn.transaction().execute(async (trx) => {
            await lockRun(trx, batch);
            const marked = await casBatch(trx, batch, 'CONFIRMED', version, {
              paused_by_switch_at: clock.now(),
            });
            if (!marked) throw new LostCas();
            await publishRunRest(trx, batch);
          });
        } catch (error) {
          if (error instanceof LostCas) return result('busy');
          throw error;
        }
        logger.warn({ ...fields, event: 'settle_batch_switched_off' }, 'settle batch not started');
        return result('switched_off');
      }
      // SB5 d: BR-FUND-18.
      if (!(await snapshotReady(conn, batch.app_id, accountingDate(clock.now())))) {
        return result('snapshot_pending');
      }
      // SB5 e.
      const to = nextState(batch.status, 'START');
      if (
        !(await casBatch(conn, batch, 'CONFIRMED', version, {
          status: to,
          started_at: clock.now(),
        }))
      ) {
        return result('busy');
      }
      version += 1;
      logger.info({ ...fields, event: 'settle_batch_started' }, 'settle batch started');
    } else if (batch.status === 'EXECUTING') {
      // SB9: no live executor (the lock was free); the snapshot guard applies again.
      if (!(await snapshotReady(conn, batch.app_id, accountingDate(clock.now())))) {
        return result('snapshot_pending');
      }
      const to = nextState(batch.status, 'TAKE_OVER');
      if (!(await casBatch(conn, batch, 'EXECUTING', version, { status: to }))) {
        return result('busy');
      }
      version += 1;
      logger.info({ ...fields, event: 'settle_batch_taken_over' }, 'settle batch taken over');
    } else {
      return result('idle');
    }

    let day = accountingDate(clock.now());
    for (const item of await loadItems(conn, input)) {
      // BR-FUND-04 ⑦: both switches before every item; either off → SB7.
      if (!(await switchesOn(batch.app_id, batch.platform))) {
        const to = nextState('EXECUTING', 'SWITCH_OFF');
        // SB7 and settle.run_done (step 6) on one transaction.
        try {
          await conn.transaction().execute(async (trx) => {
            await lockRun(trx, batch);
            if (!(await casBatch(trx, batch, 'EXECUTING', version, { status: to }))) {
              throw new LostCas();
            }
            await publishRunRest(trx, batch);
          });
        } catch (error) {
          if (error instanceof LostCas) return result('busy');
          throw error;
        }
        logger.warn(
          { ...fields, event: 'settle_batch_partial' },
          'settle batch stopped by a switch',
        );
        return result('partial');
      }
      const before = await dayCheck(conn, batch.app_id, day);
      if (before === null) {
        logger.warn({ ...fields, event: 'settle_batch_day_rollover' }, 'settle batch paused');
        return result('day_rollover');
      }
      day = before;
      try {
        await conn.transaction().execute(async (trx) => {
          const write = await executeItem(trx, batch, item);
          await writeItem(trx, batch, item, write);
          if (write.result === 'credited') await countCredit(trx, batch);
          // Right before commit: crossing into a day whose snapshot is not ready rolls back.
          const after = await dayCheck(trx, batch.app_id, day);
          if (after === null) throw new DayRollover();
          day = after;
        });
      } catch (error) {
        if (error instanceof DayRollover) {
          logger.warn({ ...fields, event: 'settle_batch_day_rollover' }, 'settle batch paused');
          return result('day_rollover');
        }
        logger.error(
          { ...fields, item_id: item.id, event: 'settle_batch_item_failed' },
          'settle batch item transaction failed',
        );
        throw error;
      }
    }

    // SB6 and settle.batch_done on one transaction.
    try {
      await conn.transaction().execute(async (trx) => {
        await lockRun(trx, batch);
        if ((await unprocessedCount(trx, batch)) > 0) {
          throw new Error(`settle batch ${batch.batch_id} still has unprocessed items`);
        }
        const to = nextState('EXECUTING', 'COMPLETE');
        const done = await casBatch(trx, batch, 'EXECUTING', version, {
          status: to,
          finished_at: clock.now(),
        });
        if (!done) throw new LostCas();
        await deps.events.publish(trx, {
          appId: batch.app_id,
          name: DONE_EVENT,
          payload: {
            batch_id: batch.batch_id,
            bill_id: batch.bill_id,
            platform: batch.platform,
            kind: batch.kind,
          },
        });
        await publishRunRest(trx, batch);
      });
    } catch (error) {
      if (error instanceof LostCas) return result('busy');
      throw error;
    }
    logger.info({ ...fields, event: 'settle_batch_done' }, 'settle batch done');
    return result('done');
  }

  return {
    async run(input) {
      if (typeof input.appId !== 'string' || input.appId === '') return result('idle');
      if (typeof input.batchId !== 'string' || !UUID.test(input.batchId)) return result('idle');
      const seen = await readBatch(db, input);
      if (seen === undefined || (seen.status !== 'CONFIRMED' && seen.status !== 'EXECUTING')) {
        return result('idle');
      }
      const lockText = `${input.appId}:${input.batchId}`;
      return db.connection().execute(async (conn) => {
        const taken = await sql<{ locked: boolean }>`
          select pg_try_advisory_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${lockText})) as locked
        `.execute(conn);
        if (taken.rows[0]?.locked !== true) return result('busy');
        try {
          return await owned(conn, input);
        } finally {
          try {
            await sql`
              select pg_advisory_unlock(hashtext(${LOCK_NAMESPACE}), hashtext(${lockText}))
            `.execute(conn);
          } catch {
            // A dead connection already dropped the session lock with it.
            logger.warn(
              { app_id: input.appId, batch_id: input.batchId, event: 'settle_batch_unlock_failed' },
              'settle batch executor lock release failed',
            );
          }
        }
      });
    },
  };
}
