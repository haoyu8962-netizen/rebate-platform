// Scheduled processing of deletion requests whose cooling period has ended (task B1-15f; 08 BR-ID-27,
// BR-ID-01; orchestrator brief §9.2 #1-#7 and «已定» 2026-10-21).
//
// One round (runOnce):
//   a. Expired requests: across apps, `status = 'cooling' AND cooling_until <= now`, keyset batches
//      of batchSize (default 100) on (cooling_until, id) until none is left — a deferred request
//      stays in cooling, so reading the first batch only would starve the later ones. Only app_id,
//      id and user_id are selected (the cursor's values are read by the database from the last
//      id); the scan takes no lock. A request that throws is one warn line
//      (error_name only) and the round goes on; a stop request is honoured between requests.
//   b. One request = one transaction, `now` read once from the Clock and used for the decision and
//      the writes: ① lockUsersForUpdate (users before deletion_requests, as B1-15d and the funds
//      lane); ② reread the request (id, app_id, status 'cooling', cooling_until <= now) FOR NO KEY
//      UPDATE — none → return (withdrawn, advanced by another worker, repeated run);
//      ③ balance.availableFen on the transaction; ④ available_fen < 0 → transition('cooling',
//      'CANCEL'): cancelled, cancel_reason negative_balance, cancelled_at = now, row_version + 1,
//      updated_at = now (CAS on status and row_version), users untouched,
//      then, same transaction, the DELETION_PROGRESS cancelled_negative inbox message (B1-15i,
//      BR-TEXT-23; amount = −available_fen as read in ③, never reread);
//      ⑤ ≥ 0 and withdrawals.hasNonTerminal → nothing is written, one deferred warn
//      `identity_deletion_deferred` {app_id, deletion_request_id, cooling_until};
//      ⑥ ≥ 0 and every withdrawal terminal → users CAS normal → deleting (row_version + 1,
//      updated_at = now), then transition('cooling', 'PROCESS') → processing (row_version + 1,
//      updated_at = now), same transaction; users.status not normal → nothing written, warn, skip.
//      B2-12d: available > 0 → the optional prefill port writes the PENDING ACCOUNT_CLOSED decrease
//      on the same transaction (BR-FUND-24 ⑧).
//      processed_at (time of done) and balance_snapshot_fen (fixed at application) are not written.
//   c. Overdue: requests in cooling or processing with apply_at <= now - 15 days (coarse filter),
//      keyset batches on (apply_at, id); deadline = 24:00 (+08:00) of the 15th working day after
//      the +08:00 civil date of apply_at (risk's resolveWorkingDayDeadline, calendar read once per
//      (app_id, year) per round); now >= deadline → warn `identity_deletion_overdue`
//      {app_id, deletion_request_id, status, apply_at, deadline_at}.
//   d. Alarm dedup: in-process, key `kind:request_id`, cleared at the +08:00 day change.
//
// The timer (startDeletionExpiry): every 60 s, unref'd, no immediate round, rounds never overlap,
// stop cancels the timer and waits for the current request. A stop already requested, a resolve
// that throws or answers null → no timer, no log line.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import { transitionDeletionRequest } from '@couli/domain';
import { subFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import { resolveWorkingDayDeadline } from '../../risk/index.ts';
import { lockUsersForUpdate } from '../ports/lock-users.ts';
import type { DeletionBalanceReader } from '../ports/deletion-balance.ts';
import type { DeletionClosingAdjustmentPrefill } from '../ports/closing-adjustment-prefill.ts';
import type { DeletionProgressNotice } from '../ports/deletion-progress-notice.ts';
import type { WithdrawalNonTerminalReader } from '../ports/withdrawal-in-flight.ts';
import { instantPlus } from './config-seconds.ts';
import { createDailyDedup } from './daily-dedup.ts';

/** The working-day calendar's configuration (calendar.cn_holidays.<year>, ...cn_makeup_workdays.<year>). */
export interface DeletionCalendarConfigReader {
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

export interface DeletionExpiryOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly withdrawals: WithdrawalNonTerminalReader;
  readonly balance: DeletionBalanceReader;
  readonly calendar: DeletionCalendarConfigReader;
  /** B1-15i: written on the cancellation's transaction; absent or null → no message. */
  readonly notice?: DeletionProgressNotice | null;
  /**
   * B2-12d (BR-FUND-24 ⑧): the system-prefilled ACCOUNT_CLOSED decrease, written on ⑥'s
   * transaction right after the request moved to processing when available > 0; absent or null →
   * no form.
   */
  readonly prefill?: DeletionClosingAdjustmentPrefill | null;
  readonly batchSize?: number;
}

export interface DeletionExpiry {
  /** The timer passes its stop predicate so shutdown can finish the current request only. */
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

export interface DeletionExpiryControl {
  stop(): Promise<void>;
}

export type DeletionExpirySchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => { stop(): void };

/** Brief §9.2 #1: one round a minute. */
export const DELETION_EXPIRY_INTERVAL_MS = 60_000;
/** Brief §9.2 #2: keyset page size of both scans. */
const DEFAULT_BATCH_SIZE = 100;
/** BR-ID-27: done within 15 working days of the application. */
const OVERDUE_WORKING_DAYS = 15;
const DAY_MS = 86_400_000;

const TOKEN = Symbol('IDENTITY_DELETION_EXPIRY');

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function batchSizeOf(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BATCH_SIZE;
}

/**
 * Keyset condition `(column, id) > (that of the request lastId)`, the cursor's own values read by
 * the database (both columns are fixed at insert): no timestamp goes through a JS Date, so a value
 * with microseconds can never repeat or skip a row.
 */
function afterRequest(column: 'cooling_until' | 'apply_at', lastId: string) {
  return sql<boolean>`(${sql.ref(column)}, ${sql.ref('id')}) > (SELECT c.${sql.ref(column)}, c.id
    FROM app.deletion_requests c WHERE c.id = ${lastId})`;
}

type Outcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'processing' }
  | { readonly kind: 'deferred'; readonly coolingUntil: Date }
  | { readonly kind: 'user_not_normal' };

interface Due {
  readonly app_id: string;
  readonly id: string;
  readonly user_id: string;
}

export function createDeletionExpiry(options: DeletionExpiryOptions): DeletionExpiry {
  const { db, clock, logger, withdrawals, balance, calendar } = options;
  const batchSize = batchSizeOf(options.batchSize);
  const notice = options.notice ?? null;
  const prefill = options.prefill ?? null;
  const dedup = createDailyDedup();

  /** One request, one transaction; `now` read once and used for the decision and the writes. */
  async function processOne(due: Due): Promise<Outcome> {
    return db.transaction().execute(async (trx: Transaction<DB>): Promise<Outcome> => {
      const now = clock.now();
      const subject = { appId: due.app_id, userId: due.user_id };
      // ① users before deletion_requests (B1-15d and the funds lane): postings and the user's
      // withdrawal of the request wait here, so the balance read below stays valid until commit.
      await lockUsersForUpdate(trx, { appId: due.app_id, userIds: [due.user_id] });
      // ② The request again, under the lock: withdrawn, advanced by another worker or a repeated
      // run → nothing to do.
      const row = await trx
        .withSchema('app')
        .selectFrom('deletion_requests')
        .select(['id', 'row_version', 'cooling_until'])
        .where('app_id', '=', due.app_id)
        .where('id', '=', due.id)
        .where('status', '=', 'cooling')
        .where('cooling_until', '<=', now)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'skipped' };
      // ③ The balance on this transaction (bigint fen).
      const available = await balance.availableFen(trx, subject);
      if (available < 0n) {
        // ④ BR-ID-27: recovered during cooling → the system cancels the request.
        const moved = transitionDeletionRequest('cooling', 'CANCEL');
        if (!moved.ok) throw new Error('identity: deletion expiry cancel transition refused');
        const cancelled = await trx
          .withSchema('app')
          .updateTable('deletion_requests')
          .set({
            status: moved.to,
            cancel_reason: 'negative_balance',
            cancelled_at: now,
            row_version: row.row_version + 1,
            updated_at: now,
          })
          .where('app_id', '=', due.app_id)
          .where('id', '=', row.id)
          .where('status', '=', 'cooling')
          .where('row_version', '=', row.row_version)
          .executeTakeFirst();
        if (cancelled.numUpdatedRows !== 1n) {
          throw new Error('identity: deletion request changed concurrently');
        }
        // B1-15i: the cancelled_negative inbox message on this transaction, its amount the
        // −available_fen read in ③ (never reread); a failure rolls the cancellation back.
        await notice?.write(trx, {
          app_id: due.app_id,
          user_id: due.user_id,
          deletion_request_id: row.id,
          variant: 'cancelled_negative',
          amount_fen: subFen(0n, available),
        });
        return { kind: 'cancelled' };
      }
      // ⑤ Any withdrawal not terminal, a ban-frozen one included → processing waits (no
      // transition, nothing written; the request stays cooling and can no longer be withdrawn).
      if (await withdrawals.hasNonTerminal(trx, subject)) {
        return { kind: 'deferred', coolingUntil: row.cooling_until };
      }
      // ⑥ users.status = deleting first, then the request → processing, same transaction.
      // When identity caches account states, the cache must be invalidated here (BR-ID-01).
      const user = await trx
        .withSchema('app')
        .updateTable('users')
        .set((eb) => ({
          status: 'deleting',
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', due.app_id)
        .where('id', '=', due.user_id)
        .where('status', '=', 'normal')
        .executeTakeFirst();
      if (user.numUpdatedRows !== 1n) return { kind: 'user_not_normal' };
      const moved = transitionDeletionRequest('cooling', 'PROCESS');
      if (!moved.ok) throw new Error('identity: deletion expiry process transition refused');
      const processed = await trx
        .withSchema('app')
        .updateTable('deletion_requests')
        .set({ status: moved.to, row_version: row.row_version + 1, updated_at: now })
        .where('app_id', '=', due.app_id)
        .where('id', '=', row.id)
        .where('status', '=', 'cooling')
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (processed.numUpdatedRows !== 1n) {
        throw new Error('identity: deletion request changed concurrently');
      }
      // B2-12d (BR-FUND-24 ⑧): a positive balance gets its ACCOUNT_CLOSED decrease on this very
      // transaction (available as read in ③, the users row still locked); a failure rolls the
      // move to processing back with it.
      if (available > 0n && prefill !== null) {
        await prefill.prefill(trx, {
          appId: due.app_id,
          userId: due.user_id,
          deletionRequestId: row.id,
          at: now,
        });
      }
      return { kind: 'processing' };
    });
  }

  /** a. The due cooling requests, every keyset page; returns how many were read and whether a stop cut it. */
  async function expire(
    roundNow: Date,
    stopping: () => boolean,
  ): Promise<{ scanned: number; stopped: boolean }> {
    let scanned = 0;
    let after: string | undefined;
    for (;;) {
      const cursor = after;
      let query = db
        .withSchema('app')
        .selectFrom('deletion_requests')
        .select(['app_id', 'id', 'user_id'])
        .where('status', '=', 'cooling')
        .where('cooling_until', '<=', roundNow);
      if (cursor !== undefined) query = query.where(afterRequest('cooling_until', cursor));
      const rows = await query.orderBy('cooling_until').orderBy('id').limit(batchSize).execute();
      for (const row of rows) {
        if (stopping()) return { scanned, stopped: true };
        scanned += 1;
        try {
          const outcome = await processOne(row);
          if (outcome.kind === 'deferred') {
            if (dedup.first(`deferred:${row.id}`, clock.now())) {
              logger.warn(
                {
                  app_id: row.app_id,
                  deletion_request_id: row.id,
                  cooling_until: outcome.coolingUntil,
                },
                'identity_deletion_deferred',
              );
            }
          } else if (outcome.kind === 'user_not_normal') {
            logger.warn(
              { app_id: row.app_id, deletion_request_id: row.id },
              'identity_deletion_expiry_user_not_normal',
            );
          }
        } catch (error) {
          // The row's content and the error message stay out of the log.
          logger.warn({ error_name: errorName(error) }, 'identity_deletion_expiry_row_failed');
        }
      }
      const last = rows.at(-1);
      if (rows.length < batchSize || last === undefined) return { scanned, stopped: false };
      after = last.id;
    }
  }

  /** c. Requests still open 15 working days after the application (cooling or processing). */
  async function overdue(roundNow: Date, stopping: () => boolean): Promise<void> {
    // One read per (app_id, key) per round: each app's year calendar is read once.
    const reads = new Map<string, Promise<{ readonly value: unknown } | null>>();
    const config: DeletionCalendarConfigReader = {
      configValue(appId, key) {
        const k = `${appId}\u0000${key}`;
        let read = reads.get(k);
        if (read === undefined) {
          read = calendar.configValue(appId, key);
          reads.set(k, read);
        }
        return read;
      },
    };
    // The unconfigured-year line once per (app_id, year) and +08:00 day, not once per request.
    const calendarLogger = {
      warn(fields: { readonly app_id?: unknown; readonly year?: unknown }, msg: string): void {
        const k = `calendar:${String(fields.app_id)}:${String(fields.year)}:${msg}`;
        if (dedup.first(k, roundNow)) logger.warn(fields, msg);
      },
    } as unknown as Pick<RootLogger, 'warn'>;
    const coarse = instantPlus(roundNow, -OVERDUE_WORKING_DAYS * DAY_MS);
    let after: string | undefined;
    for (;;) {
      const cursor = after;
      let query = db
        .withSchema('app')
        .selectFrom('deletion_requests')
        .select(['app_id', 'id', 'status', 'apply_at'])
        .where('status', 'in', ['cooling', 'processing'])
        .where('apply_at', '<=', coarse);
      if (cursor !== undefined) query = query.where(afterRequest('apply_at', cursor));
      const rows = await query.orderBy('apply_at').orderBy('id').limit(batchSize).execute();
      for (const row of rows) {
        if (stopping()) return;
        try {
          const deadline = await resolveWorkingDayDeadline({
            appId: row.app_id,
            from: row.apply_at,
            workingDays: OVERDUE_WORKING_DAYS,
            config,
            logger: calendarLogger,
          });
          if (roundNow.getTime() < deadline.getTime()) continue;
          if (!dedup.first(`overdue:${row.id}`, roundNow)) continue;
          logger.warn(
            {
              app_id: row.app_id,
              deletion_request_id: row.id,
              status: row.status,
              apply_at: row.apply_at,
              deadline_at: deadline,
            },
            'identity_deletion_overdue',
          );
        } catch (error) {
          logger.warn({ error_name: errorName(error) }, 'identity_deletion_overdue_row_failed');
        }
      }
      const last = rows.at(-1);
      if (rows.length < batchSize || last === undefined) return;
      after = last.id;
    }
  }

  return Object.freeze({
    async runOnce(stopping: () => boolean = () => false): Promise<{ scanned: number }> {
      const roundNow = clock.now();
      const expired = await expire(roundNow, stopping);
      if (!expired.stopped && !stopping()) await overdue(clock.now(), stopping);
      return { scanned: expired.scanned };
    },
  });
}

function isExpiry(value: unknown): value is DeletionExpiry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runOnce?: unknown }).runOnce === 'function'
  );
}

/** setInterval, unref'd so this timer alone never keeps the process alive. */
const intervalSchedule: DeletionExpirySchedule = (tick, intervalMs) => {
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};

const NO_EXPIRY: DeletionExpiryControl = { stop: () => Promise.resolve() };

/**
 * Worker-only lifecycle hook (entry.ts, after the payout verification recheck). `resolve` returns
 * the provider of deletionExpiryToken() (null without a database). A stop already requested, a
 * resolve that throws or answers anything but a runner → no timer, no log line.
 */
export function startDeletionExpiry(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule: DeletionExpirySchedule = intervalSchedule,
): DeletionExpiryControl {
  if (stopping()) return NO_EXPIRY;
  let resolved: unknown;
  try {
    resolved = resolve();
  } catch {
    return NO_EXPIRY;
  }
  if (!isExpiry(resolved)) return NO_EXPIRY;
  const expiry = resolved;
  let stopped = false;
  let running: Promise<void> | undefined;
  const halted = (): boolean => stopped || stopping();
  const round = async (): Promise<void> => {
    try {
      await expiry.runOnce(halted);
    } catch (error) {
      logger.warn({ error_name: errorName(error) }, 'identity_deletion_expiry_failed');
    }
  };
  const timer = schedule(async () => {
    // A round still running (or a stop): this tick does nothing, rounds never overlap.
    if (running !== undefined || halted()) return;
    const current = round();
    running = current;
    try {
      await current;
    } finally {
      if (running === current) running = undefined;
    }
  }, DELETION_EXPIRY_INTERVAL_MS);
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        timer.stop();
      }
      // The current request finishes (runOnce checks the stop between requests) before the pool
      // closes.
      await running;
    },
  };
}

/** The Nest token of the worker's assembled DeletionExpiry (or null without a database). */
export function deletionExpiryToken(): symbol {
  return TOKEN;
}
