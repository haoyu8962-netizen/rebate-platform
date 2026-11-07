// B2-04ze (D10-443): the settle queue of the worker entry (02 §11: `settle` 月结出账、批次执行;
// exclusive, worker only). One handler for the queue, dispatching on the job name:
// - `bill` (settle_jobs.job): payload { app_id, platform, accounting_date: D }, singletonKey
//   `bill:<app_id>:<platform>:<D>`; runs the bill job (bill/job.ts) for (app, platform) with the
//   nominal run_at = D 00:00 +08:00 (settleBillRunAt), the same on every delivery and re-seed of
//   that day. Seeded every day for every app × platform; on a day that is not settle.bill_day the
//   bill job itself answers not_due. Every outcome completes the delivery, deferred included (the
//   asset snapshot of the run day is not ready, B2-04zg / D10-476): a deferred bill is not a
//   failure and uses no queue retry; the catch-up (catch-up.ts) sends the same period again on a
//   later tick of the module's timer until the bill month is generated. The run that generates
//   (app, platform, D) sends that key's `settle_adjust` job in its own transaction (B2-09zb;
//   bill/job.ts onGenerated, wired in assemble.ts), so it is queued exactly when the run is done.
// - `settle_adjust` (settle_jobs.job): payload { app_id, platform, accounting_date: D },
//   singletonKey `settle_adjust:<app_id>:<platform>:<D>`; runs the positive-difference candidate
//   generation (adjust/run-job.ts, BR-FUND-09 R1) for (app, platform) once. Also sent by finance's
//   manual trigger (adminRunSettleAdjust); a job of the key still queued absorbs it.
// - `batch_execute` (not in settle_jobs): payload { app_id, batch_id }, singletonKey
//   `batch_execute:<app_id>:<batch_id>`; runs the batch executor (batch/executor) once. Sent by the
//   scan for every batch that is CONFIRMED and due (IMMEDIATE, or SCHEDULED with scheduled_at ≤
//   now), not stopped by a switch (paused_by_switch_at null), and for every EXECUTING batch (SB9
//   take-over; the executor's own lock keeps one live executor). Every executor outcome completes
//   the delivery: progress lives in settle_batches / settle_batch_items, and the scan re-sends what
//   is still due.
// The seed and the scan decide from the queue (pgboss.job under the key) and the database
// (settle_jobs, settle_batches), never from process memory: a restarted worker decides the same.
// Time only from the injected Clock; days only through @couli/domain.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobHandler, JobPayload, JobQueue } from '../../platform/index.ts';
import type { BatchExecutor } from '../batch/executor/executor.ts';
import type { SettleAdjustJob } from '../adjust/run-job.ts';
import type { BillJob } from '../bill/job.ts';

/** The queue of the bill and the batch execution (platform/queue catalog, exclusive). */
export type SettleQueueName = 'settle';

/** The jobs of that queue. */
export type SettleJobName = 'bill' | 'batch_execute' | 'settle_adjust';

/** Payload of a `bill` job. */
export interface SettleBillJobPayload {
  readonly app_id: string;
  readonly platform: string;
  /** The +08:00 day D the bill job is seeded for (YYYY-MM-DD). */
  readonly accounting_date: string;
}

/** Payload of a `settle_adjust` job (the bill day D of the run). */
export type SettleAdjustJobPayload = SettleBillJobPayload;

/** Payload of a `batch_execute` job. */
export interface SettleBatchExecuteJobPayload {
  readonly app_id: string;
  readonly batch_id: string;
}

export interface SettleBillJobInput {
  readonly appId: string;
  readonly platform: string;
  readonly accountingDate: string;
}

export interface SettleBatchExecuteJobInput {
  readonly appId: string;
  readonly batchId: string;
}

/** pino's two-argument shape. */
export interface SettleScheduleLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

const QUEUE: SettleQueueName = 'settle';
const BILL_JOB: SettleJobName = 'bill';
const EXECUTE_JOB: SettleJobName = 'batch_execute';
const ADJUST_JOB: SettleJobName = 'settle_adjust';

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function nonEmptyText(payload: JobPayload, field: string, job: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`settle ${job}: payload field ${field} is not a nonempty string`);
  }
  return value;
}

/** The (app, platform, D) of a bill / settle_adjust payload and D's nominal run_at. */
function dayPayload(payload: JobPayload, job: string) {
  const appId = nonEmptyText(payload, 'app_id', job);
  const platform = nonEmptyText(payload, 'platform', job);
  const day = nonEmptyText(payload, 'accounting_date', job);
  let runAt: Date;
  try {
    runAt = settleBillRunAt(day);
  } catch {
    throw new Error(`settle ${job}: payload field accounting_date is not a date (YYYY-MM-DD)`);
  }
  return { appId, platform, accountingDate: day, runAt };
}

function executePayload(payload: JobPayload) {
  return {
    appId: nonEmptyText(payload, 'app_id', EXECUTE_JOB),
    batchId: nonEmptyText(payload, 'batch_id', EXECUTE_JOB),
  };
}

/** One queued or active bill run per (app, platform, D): `bill:<app_id>:<platform>:<D>`. */
export function settleBillJobKey(appId: string, platform: string, accountingDate: string): string {
  return `${BILL_JOB}:${appId}:${platform}:${accountingDate}`;
}

/** One queued or active candidate run per (app, platform, D): `settle_adjust:<app>:<platform>:<D>`. */
export function settleAdjustJobKey(
  appId: string,
  platform: string,
  accountingDate: string,
): string {
  return `${ADJUST_JOB}:${appId}:${platform}:${accountingDate}`;
}

/** The nominal run_at of D's bill run: D 00:00 +08:00. A malformed or nonexistent D throws. */
export function settleBillRunAt(accountingDate: string): Date {
  // chinaDayRange refuses a malformed or nonexistent D (RangeError). The Date is built from D's own
  // midnight string, never from the current time.
  // eslint-disable-next-line no-restricted-syntax
  return new Date(chinaDayRange(accountingDate).start);
}

/** One queued or active execution per batch: `batch_execute:<app_id>:<batch_id>`. */
export function settleBatchExecuteJobKey(appId: string, batchId: string): string {
  return `${EXECUTE_JOB}:${appId}:${batchId}`;
}

/** Sends the `bill` job of (app, platform, D) on `trx` (null: outside a transaction), at once. */
export function scheduleSettleBill(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  input: SettleBillJobInput,
): Promise<string | null> {
  const payload: SettleBillJobPayload = {
    app_id: input.appId,
    platform: input.platform,
    accounting_date: input.accountingDate,
  };
  return queue.send(
    QUEUE,
    BILL_JOB,
    { ...payload },
    {
      trx,
      singletonKey: settleBillJobKey(input.appId, input.platform, input.accountingDate),
    },
  );
}

/** Sends the `settle_adjust` job of (app, platform, D) on `trx` (null: outside a transaction), at once. */
export function scheduleSettleAdjust(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  input: SettleBillJobInput,
): Promise<string | null> {
  const payload: SettleAdjustJobPayload = {
    app_id: input.appId,
    platform: input.platform,
    accounting_date: input.accountingDate,
  };
  return queue.send(
    QUEUE,
    ADJUST_JOB,
    { ...payload },
    {
      trx,
      singletonKey: settleAdjustJobKey(input.appId, input.platform, input.accountingDate),
    },
  );
}

/** Sends the `batch_execute` job of the batch on `trx` (null: outside a transaction), at once. */
export function scheduleBatchExecute(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  input: SettleBatchExecuteJobInput,
): Promise<string | null> {
  const payload: SettleBatchExecuteJobPayload = { app_id: input.appId, batch_id: input.batchId };
  return queue.send(
    QUEUE,
    EXECUTE_JOB,
    { ...payload },
    {
      trx,
      singletonKey: settleBatchExecuteJobKey(input.appId, input.batchId),
    },
  );
}

export interface SettleJobHandlerDependencies {
  readonly db: Kysely<DB>;
  readonly logger: SettleScheduleLogger;
  readonly bill: Pick<BillJob, 'run'>;
  readonly executor: Pick<BatchExecutor, 'run'>;
  /** The candidate run (B2-09zb); absent in pieces that never receive `settle_adjust`. */
  readonly adjust?: Pick<SettleAdjustJob, 'run'>;
}

/**
 * The handler of queue settle. An unknown job name or a malformed payload is refused before a
 * port is called.
 */
export function createSettleJobHandler(dependencies: SettleJobHandlerDependencies): JobHandler {
  const { db, logger, bill, executor, adjust } = dependencies;
  return async (job) => {
    if (job.name === BILL_JOB) {
      const { appId, platform, accountingDate, runAt } = dayPayload(job.payload, BILL_JOB);
      const result = await bill.run(db, { appId, platform, runAt });
      logger.info(
        {
          job: BILL_JOB,
          app_id: appId,
          platform,
          accounting_date: accountingDate,
          outcome: result.outcome,
        },
        'settle_bill_run',
      );
      // deferred (the asset snapshot of the run day is not complete) completes the delivery as well:
      // no queue retry is used; the catch-up sends the period again on a later tick.
      return;
    }
    if (job.name === ADJUST_JOB) {
      const { appId, platform, accountingDate, runAt } = dayPayload(job.payload, ADJUST_JOB);
      if (adjust === undefined)
        throw new Error('settle settle_adjust: the candidate run is not wired');
      const result = await adjust.run({ appId, platform, accountingDate, runAt });
      logger.info(
        {
          job: ADJUST_JOB,
          app_id: appId,
          platform,
          accounting_date: accountingDate,
          outcome: result.outcome,
          batch_id: result.run.batchId,
          orders: result.run.orders,
          candidates: result.run.candidates,
          superseded: result.run.superseded,
        },
        'settle_adjust_run',
      );
      return;
    }
    if (job.name === EXECUTE_JOB) {
      const { appId, batchId } = executePayload(job.payload);
      const result = await executor.run({ appId, batchId });
      logger.info(
        { job: EXECUTE_JOB, app_id: appId, batch_id: batchId, outcome: result.outcome },
        'settle_batch_execute_run',
      );
      return;
    }
    throw new Error(`settle queue: unknown job name ${JSON.stringify(job.name)}`);
  };
}

/**
 * The actual state of the bill run of (app, platform, D):
 * - 'done': settle_jobs holds a done row for (app, 'bill', platform, settleBillRunAt(D)), or a
 *   `bill` job of the key completed on queue settle;
 * - 'pending': not done, and a job of the key is queued (also delayed), active or waiting for a
 *   retry on queue settle (a copy in settle.dead does not count);
 * - 'absent': neither.
 */
export type SettleBillRunState = 'done' | 'pending' | 'absent';

export interface SettleRunStore {
  /** The state as stored now (no cache across calls, no process memory). */
  billStateOf(appId: string, platform: string, accountingDate: string): Promise<SettleBillRunState>;
}

export interface SettleBillSeedOptions {
  /** couli_app: the apps are the distinct app_id of app.orders. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
  readonly runs: SettleRunStore;
  /** The platforms of every app (union REGISTERED_PLATFORMS). */
  readonly platforms: readonly string[];
}

/**
 * The daily seed (and heal) of the bill: for D = the +08:00 day of clock.now(), every app ×
 * platform whose run state is 'absent' gets its `bill` job (outside a transaction). A failure of
 * one does not stop the others; the first failure is rethrown after all of them.
 */
export async function seedSettleBills(options: SettleBillSeedOptions): Promise<void> {
  const { db, clock, queue, logger, runs, platforms } = options;
  const day = accountingDate(clock.now());
  const apps = await db
    .withSchema('app')
    .selectFrom('orders')
    .select('app_id')
    .distinct()
    .orderBy('app_id')
    .execute();
  const failures: unknown[] = [];
  for (const { app_id: appId } of apps) {
    for (const platform of platforms) {
      try {
        const state = await runs.billStateOf(appId, platform, day);
        if (state !== 'absent') continue;
        await scheduleSettleBill(queue, null, { appId, platform, accountingDate: day });
      } catch (error: unknown) {
        failures.push(error);
        logger.warn(
          {
            job: BILL_JOB,
            app_id: appId,
            platform,
            accounting_date: day,
            error_name: errorName(error),
          },
          'settle_bill_seed_failed',
        );
      }
    }
  }
  if (failures.length > 0) throw failures[0];
}

export interface SettleBatchScanOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
}

/**
 * The scan of due batches (every app): one `batch_execute` send per batch that is CONFIRMED, due
 * by clock.now() and not stopped by a switch, or EXECUTING (see the file header). The queue's
 * singletonKey absorbs a batch already queued or running. A failed send does not stop the others;
 * the first failure is rethrown after all of them.
 */
export async function scanDueBatches(options: SettleBatchScanOptions): Promise<void> {
  const { db, clock, queue, logger } = options;
  const now = clock.now();
  const batches = await db
    .withSchema('app')
    .selectFrom('settle_batches')
    .select(['app_id', 'batch_id'])
    .where((eb) =>
      eb.or([
        eb('status', '=', 'EXECUTING'),
        eb.and([
          eb('status', '=', 'CONFIRMED'),
          eb('paused_by_switch_at', 'is', null),
          eb.or([
            eb('settle_mode', '=', 'IMMEDIATE'),
            eb.and([
              eb('settle_mode', '=', 'SCHEDULED'),
              eb('scheduled_at', 'is not', null),
              eb('scheduled_at', '<=', now),
            ]),
          ]),
        ]),
      ]),
    )
    .orderBy('app_id')
    .orderBy('batch_id')
    .execute();
  const failures: unknown[] = [];
  for (const { app_id: appId, batch_id: batchId } of batches) {
    try {
      await scheduleBatchExecute(queue, null, { appId, batchId });
    } catch (error: unknown) {
      failures.push(error);
      logger.warn(
        { job: EXECUTE_JOB, app_id: appId, batch_id: batchId, error_name: errorName(error) },
        'settle_batch_scan_send_failed',
      );
    }
  }
  if (failures.length > 0) throw failures[0];
}
