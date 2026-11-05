// B2-07c: the daily chain of the R2 reconciliation (规划/08 BR-WDR-23 每日 T+1; 编排裁定 D10-408).
//
// seedPayoutRecon — the start of the chain, run by the worker after bootstrap and on every heal
//   (payout.module.ts): for every app with an Alipay withdrawal, one `recon` job on queue
//   `payout-recon` for the previous +08:00 accounting day of the clock (@couli/domain), keyed per
//   (app, channel, bill day) (reconJobKey; the queue is exclusive per singletonKey) so a seed again
//   adds no second run, due at the day's run time (at once when it has passed) and never before
//   that bill day is over. An app whose day already ran to the end (payout_recon_runs succeeded)
//   is not sent again; `started` (one per process) remembers the day each app was sent for, so a
//   heal only picks up the apps not started yet. A failure of one app does not stop the others;
//   the first failure is rethrown after all apps were tried.
// The run of a day enqueues the following day itself (jobs/recon-job.ts → scheduleReconDay).
// Pure helpers: reconRunAt (D+1 00:00 +08:00 + RECON_RUN_OFFSET_MS), reconDayAfter, reconDayBefore.
// ①'s hand-over between the two processes (D10-415 ②, D10-416): the run's immediate query carries
// source = PAYOUT_RECON_SOURCE; when the payout process sets needs_manual because of the bill
// (that query not a success, or an ordinary definite failure against a bill success already in
// recon_channel) it sends sendReconManualDiff on its own transaction, and the worker's
// `manual_diff` job registers the one R2 diff and alert of that withdrawal.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';

/** The logger of the reconciliation (pino's two-argument shape; jobs/recon-job.ts re-exports it). */
export interface PayoutReconLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PayoutReconSeedOptions {
  /** couli_app: the apps with withdrawals. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: PayoutReconLogger;
  /** The worker's memory (one per process): app → the bill day it was last sent for. */
  readonly started?: Map<string, string>;
}

/** Queue and job of the daily run (platform/queue catalog and worker plan). */
export const PAYOUT_RECON_QUEUE = 'payout-recon';
export const PAYOUT_RECON_JOB = 'recon';
/** R2 reconciles Alipay only for now (D10-408). */
export const PAYOUT_RECON_CHANNEL = 'alipay';
/** The marker on the payload of ①'s immediate query (queue payout, job query; D10-415 ②). */
export const PAYOUT_RECON_SOURCE = 'recon';
/** The worker's follow-up after the payout process set needs_manual against the bill (D10-416). */
export const PAYOUT_RECON_MANUAL_JOB = 'manual_diff';

export interface PayoutReconManualPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly execute_seq: number;
}

/**
 * ①'s other follow-up (review-money r1 S1): the reconciliation's immediate query found the
 * withdrawal no longer PAYING (another landing came first), or got a success / a fail it could not
 * act on. The worker rereads the withdrawal: FAILED / REJECTED / APPROVED (or PAYING under another
 * execute_seq) against the bill's success → ③; PAID_* or needs_manual → nothing; still PAYING →
 * checked again later (`round` + 1, at most RECON_CHECK_MAX_ROUNDS).
 */
export const PAYOUT_RECON_CHECK_JOB = 'recon_check';

export interface PayoutReconCheckPayload extends PayoutReconManualPayload {
  readonly round: number;
}

/** A withdrawal still PAYING is checked again after this many seconds. */
export const RECON_CHECK_DELAY_SECONDS = 600;
/** At most this many rounds (a day): by then T + manual_after has set needs_manual. */
export const RECON_CHECK_MAX_ROUNDS = 144;

/**
 * B2-09t (D10-628 ②, D10-632): a paid_at written after its bill day may have been reconciled (W8)
 * is never picked by a later daily run, which selects by paid_at. This job reads the bill rows
 * already stored for that one withdrawal; it never downloads a bill or rewrites a row.
 */
export const PAYOUT_RECON_LATE_PAID_JOB = 'late_paid_check';

export interface PayoutReconLatePaidPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly round: number;
}

/** A bill day not yet reconciled is looked at again after this many seconds. */
export const LATE_PAID_CHECK_DELAY_SECONDS = 3_600;
/** At most this many rounds (four days: a day's run is due within two, plus its retries). */
export const LATE_PAID_CHECK_MAX_ROUNDS = 96;

/**
 * The daily run of bill day D: D+1 00:00 +08:00 plus this offset (10:00 +08:00, as the T+1 run of
 * payment's bill.recon; the Alipay bill of the previous day is ready by then — 待实测).
 */
export const RECON_RUN_OFFSET_MS = 10 * 3_600_000;
const MS_PER_DAY = 86_400_000;

/** One queued or active run per (app, channel, bill day). */
export function reconJobKey(appId: string, channel: string, billDate: string): string {
  return `recon:${appId}:${channel}:${billDate}`;
}

/** The instant (ms) bill day `billDate` (YYYY-MM-DD, +08:00) ends. */
export function reconDayEndMs(billDate: string): number {
  return Date.parse(chinaDayRange(billDate).end);
}

/** The instant (ms) bill day `billDate` starts. */
export function reconDayStartMs(billDate: string): number {
  return Date.parse(chinaDayRange(billDate).start);
}

/** The daily run time of bill day `billDate`; `like` is only copied, never read. */
export function reconRunAt(billDate: string, like: Date): Date {
  const at = structuredClone(like);
  at.setTime(reconDayEndMs(billDate) + RECON_RUN_OFFSET_MS);
  return at;
}

/** The bill day after `billDate`; `like` is only copied. */
export function reconDayAfter(billDate: string, like: Date): string {
  const at = structuredClone(like);
  at.setTime(reconDayEndMs(billDate));
  return accountingDate(at);
}

/** The bill day before `billDate`; `like` is only copied. */
export function reconDayBefore(billDate: string, like: Date): string {
  const at = structuredClone(like);
  at.setTime(reconDayStartMs(billDate) - 1);
  return accountingDate(at);
}

/** The +08:00 accounting day before the one `now` is in (the T+1 run's bill day). */
export function previousReconDay(now: Date): string {
  const before = structuredClone(now);
  before.setTime(now.getTime() - MS_PER_DAY);
  return accountingDate(before);
}

/**
 * Sends the daily run of (app, alipay, billDate), due at its run time (at once when passed), on
 * `trx` when given. A run queued or active under the same key absorbs it (returns null then).
 */
export function scheduleReconDay(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  appId: string,
  billDate: string,
  now: Date,
): Promise<string | null> {
  const dueMs = reconRunAt(billDate, now).getTime();
  const delaySeconds = Math.max(0, Math.ceil((dueMs - now.getTime()) / 1000));
  return queue.send(
    PAYOUT_RECON_QUEUE,
    PAYOUT_RECON_JOB,
    { app_id: appId, channel: PAYOUT_RECON_CHANNEL, bill_date: billDate },
    { trx, singletonKey: reconJobKey(appId, PAYOUT_RECON_CHANNEL, billDate), delaySeconds },
  );
}

/**
 * The worker's `manual_diff` of a withdrawal, on the caller's transaction (the payout process's
 * couli_payout one, with the needs_manual update). One queued job per withdrawal; the diff itself
 * is deduplicated per withdrawal by its dedupe_key.
 */
export function sendReconManualDiff(
  queue: JobQueue,
  trx: Transaction<DB>,
  payload: PayoutReconManualPayload,
): Promise<string | null> {
  return queue.send(
    PAYOUT_RECON_QUEUE,
    PAYOUT_RECON_MANUAL_JOB,
    { ...payload },
    {
      trx,
      singletonKey: `manual_diff:${payload.app_id}:${payload.withdrawal_id}`,
      delaySeconds: 0,
    },
  );
}

/**
 * The worker's `recon_check` of a withdrawal on the caller's transaction (the payout process's
 * couli_payout one, or the worker's own for the next round). One queued job per withdrawal and
 * round; the diff itself is deduplicated by its dedupe_key.
 */
export function sendReconCheck(
  queue: JobQueue,
  trx: Transaction<DB>,
  payload: PayoutReconCheckPayload,
  delaySeconds: number,
): Promise<string | null> {
  return queue.send(
    PAYOUT_RECON_QUEUE,
    PAYOUT_RECON_CHECK_JOB,
    { ...payload },
    {
      trx,
      singletonKey: `recon_check:${payload.app_id}:${payload.withdrawal_id}:${payload.round}`,
      delaySeconds,
    },
  );
}

/** The withdrawal's late_paid_check on the caller's transaction: it commits with the paid_at. */
export function sendLatePaidCheck(
  queue: Pick<JobQueue, 'send'>,
  trx: Transaction<DB>,
  payload: PayoutReconLatePaidPayload,
  delaySeconds?: number,
): Promise<string | null> {
  return queue.send(
    PAYOUT_RECON_QUEUE,
    PAYOUT_RECON_LATE_PAID_JOB,
    { ...payload },
    {
      trx,
      singletonKey: `late_paid_check:${payload.app_id}:${payload.withdrawal_id}:${payload.round}`,
      ...(delaySeconds === undefined ? {} : { delaySeconds }),
    },
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function seedPayoutRecon(options: PayoutReconSeedOptions): Promise<void> {
  const { db, clock, queue, logger } = options;
  const now = clock.now();
  const billDate = previousReconDay(now);
  const apps = await db
    .withSchema('app')
    .selectFrom('withdrawals')
    .select('app_id')
    .distinct()
    .where('payout_channel', '=', PAYOUT_RECON_CHANNEL)
    .orderBy('app_id')
    .execute();
  const done = await db
    .withSchema('app')
    .selectFrom('payout_recon_runs')
    .select('app_id')
    .where('channel', '=', PAYOUT_RECON_CHANNEL)
    .where('bill_date', '=', sql<Date>`${billDate}::date`)
    .where('status', '=', 'succeeded')
    .execute();
  const succeeded = new Set(done.map((row) => row.app_id));
  let failure: { readonly error: unknown } | null = null;
  for (const { app_id: appId } of apps) {
    if (succeeded.has(appId) || options.started?.get(appId) === billDate) continue;
    try {
      await scheduleReconDay(queue, null, appId, billDate, now);
      options.started?.set(appId, billDate);
      logger.info({ app_id: appId, bill_date: billDate }, 'payout_recon_seeded');
    } catch (error: unknown) {
      failure ??= { error };
      logger.warn(
        { app_id: appId, bill_date: billDate, error_name: errorName(error) },
        'payout_recon_seed_failed',
      );
    }
  }
  if (failure !== null) throw failure.error;
}
