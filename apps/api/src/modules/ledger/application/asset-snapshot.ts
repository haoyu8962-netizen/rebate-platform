// Asset daily snapshot (BR-FUND-18, BR-FUND-20; settlement-plan §2.3, S3 A, S15 A). The run of
// nominal time D+1 00:01 +08:00 writes D once per app: balances from entries dated ≤ D, union
// receivables per platform, and waiting / estimated from the PendingEarningsSource port at run
// time. A snapshot row is its own completion mark; lateness is judged against D+1 00:30 +08:00.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import {
  findSnapshot,
  insertReceivables,
  insertSnapshotIfAbsent,
  lockSnapshot,
  markComparable,
  sumReceivables,
  sumUserBalances,
} from '../infra/asset-snapshot-store.ts';
import { isPastDeadline, snapshotDayOf, snapshotDeadlineMs } from './asset-snapshot-days.ts';
import {
  confirmSnapshotDay,
  writeSnapshotDay,
  type AssetSnapshotAlert,
  type AssetSnapshotAlertQueue,
  type SnapshotReads,
  type SnapshotWriteContext,
  type SnapshotWriteStore,
  type Transact,
} from './asset-snapshot-write.ts';
import { LedgerError } from './errors.ts';

export type {
  AssetSnapshotAlert,
  AssetSnapshotAlertKind,
  AssetSnapshotAlertQueue,
} from './asset-snapshot-write.ts';

export interface PendingEarningsTotals {
  readonly total_waiting_fen: bigint;
  readonly total_estimated_fen: bigint;
}

export interface PendingUserEarnings {
  readonly estimated_fen: bigint;
  readonly pending_credit_fen: bigint;
  readonly pending_credit_paused_fen: bigint;
  readonly next_credit_period: string | null;
  readonly credit_overdue: boolean;
}

/** S3: declared by ledger, implemented by settlement and injected at assembly time.
 * Reads current order state, including beneficiaries without a ledger account.
 * The supplied database is the snapshot's read-only REPEATABLE READ transaction: read through it,
 * so the totals share one consistent view with the ledger sums. No historical date filter.
 */
export interface PendingEarningsSource {
  readAppTotals(db: Kysely<DB>, input: { readonly appId: string }): Promise<PendingEarningsTotals>;
  readUser(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<PendingUserEarnings>;
}

/** Flat fields are compatible with an injected pino logger / finance alert routing.
 * Events: asset_snapshot_timeout and ledger_advance_exposure; app_id/accounting_date
 * identify the day. Exposure alerts carry union_receivable_fen/advance_alert_fen as
 * decimal strings, preserving bigint precision when serialized.
 */
export interface AssetSnapshotLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface AssetSnapshotDependencies {
  readonly clock: Clock;
  readonly pendingEarnings: PendingEarningsSource;
  readonly logger: AssetSnapshotLogger;
  /** Reads ledger.advance_alert_fen for this app; null means not configured. */
  getAdvanceAlertFen(appId: string): Promise<bigint | null>;
  /**
   * Durable alerts, enqueued on the snapshot's write transaction (BR-FUND-20 once per app per
   * day; BR-FUND-18 timeout). Optional only on this low-level factory (the B2-04w rule tests
   * build it without one; alerts are then log lines only); entries assemble the runner through
   * assembleAssetSnapshot, which requires the EVENT_BUS and builds this port over it (B2-04wa).
   */
  readonly alertQueue?: AssetSnapshotAlertQueue;
}

export interface AssetSnapshotInput {
  readonly appId: string;
  /** D+1 00:01 +08:00, retained on delayed delivery; actual time comes from Clock. */
  readonly nominalRunAt: Date;
}

export interface AssetSnapshotResult {
  readonly snapshotId: string;
  readonly accountingDate: string;
}

export interface AssetSnapshotRunner {
  run(db: Kysely<DB>, input: AssetSnapshotInput): Promise<AssetSnapshotResult>;
}

export interface AssetSnapshotSelection {
  readonly appId: string;
  /** D, the snapshot's own accounting date, not D+1 (the execution day). */
  readonly accountingDate: string;
}

export interface AssetSnapshotStatus {
  /** An existing row is complete, even if its waiting amount is not comparable. */
  readonly state: 'pending' | 'complete' | 'timed_out';
  readonly snapshotId: string | null;
  readonly waitingComparable: boolean | null;
}

const STORE: SnapshotWriteStore = {
  insertSnapshotIfAbsent,
  insertReceivables,
  lockSnapshot,
  markComparable,
  findSnapshot,
};

/** Bounded retries of the read snapshot on a serialization failure (SQLSTATE 40001). */
const READ_ATTEMPTS = 3;

export function createAssetSnapshot(dependencies: AssetSnapshotDependencies): AssetSnapshotRunner {
  const { clock, pendingEarnings, logger } = dependencies;
  const context: SnapshotWriteContext = {
    store: STORE,
    clock,
    newId: randomUUID,
    ...(dependencies.alertQueue === undefined ? {} : { alertQueue: dependencies.alertQueue }),
  };

  /** One read-only REPEATABLE READ transaction: balances, receivables and pending share a view. */
  async function readDay(db: Kysely<DB>, appId: string, day: string): Promise<SnapshotReads> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await db
          .transaction()
          .setIsolationLevel('repeatable read')
          .setAccessMode('read only')
          .execute(async (trx) => {
            const balances = await sumUserBalances(trx, appId, day);
            const receivables = await sumReceivables(trx, appId, day);
            // Run-time order state (BR-FUND-18): no D cutoff on waiting / estimated.
            const pending = await pendingEarnings.readAppTotals(trx, { appId });
            return {
              balances,
              receivables,
              totalWaitingFen: pending.total_waiting_fen,
              totalEstimatedFen: pending.total_estimated_fen,
              readAt: clock.now(),
            };
          });
      } catch (error) {
        if (attempt >= READ_ATTEMPTS || !isSerializationFailure(error)) throw error;
      }
    }
  }

  /** Confirms an unconfirmed committed day (or alerts its timeout), then logs that alert. */
  async function confirm(transact: Transact, appId: string, day: string, snapshotId: string) {
    const confirmed = await confirmSnapshotDay(transact, context, { appId, day, snapshotId });
    for (const alert of confirmed.alerts) logAlert(logger, alert);
  }

  return {
    async run(db, input) {
      const appId = validAppId(input.appId);
      const day = snapshotDayOf(input.nominalRunAt);
      const result = { accountingDate: day };
      const transact = readCommitted(db);
      try {
        // Replay of a written day: same snapshot, no source read, amounts never rewritten. A
        // comparable row is left as is. A row still false was written late or never confirmed
        // (the confirming delivery failed or stopped), or another delivery is confirming it
        // right now: the confirmation locks the row and reads it again, so it waits for that
        // delivery and returns if it made the row comparable; otherwise it confirms now if still
        // before the deadline, else the row stays false and the day's timeout alert is enqueued
        // again under its key (at least once; consumers dedup).
        const existing = await findSnapshot(db, appId, day);
        if (existing !== undefined) {
          if (!existing.waiting_comparable) await confirm(transact, appId, day, existing.id);
          return { ...result, snapshotId: existing.id };
        }
        const threshold = await dependencies.getAdvanceAlertFen(appId);
        const reads = await readDay(db, appId, day);
        const outcome = await transact((trx) =>
          writeSnapshotDay(trx, context, { appId, day, reads, threshold }),
        );
        // Log lines after commit, only by the delivery that wrote the day: one per app per D.
        for (const alert of outcome.alerts) logAlert(logger, alert);
        // A concurrent winner confirms its own row; a written-late row is never confirmed.
        if (outcome.inserted && !outcome.late) {
          await confirm(transact, appId, day, outcome.snapshotId);
        }
        return { ...result, snapshotId: outcome.snapshotId };
      } catch (error) {
        // Not completed, or committed but not confirmed, at or after the deadline: waiters learn
        // it from the status read (or the false mark), finance from this alert. The original
        // error is rethrown unchanged; no placeholder row is written.
        if (isPastDeadline(clock.now(), day)) {
          logger.error(
            { event: 'asset_snapshot_timeout', app_id: appId, accounting_date: day, step: 'run' },
            'asset snapshot not completed by its deadline',
          );
        }
        throw error;
      }
    },
  };
}

/** READ COMMITTED: the platform event bus refuses to publish under a snapshot isolation. */
function readCommitted(db: Kysely<DB>): Transact {
  return (work) => db.transaction().setIsolationLevel('read committed').execute(work);
}

/** S15: read-only, no settle_jobs, no source calls, no placeholder snapshot on timeout. */
export async function getAssetSnapshotStatus(
  db: Kysely<DB>,
  input: AssetSnapshotSelection,
  clock: Clock,
): Promise<AssetSnapshotStatus> {
  const appId = validAppId(input.appId);
  // Validates D and fixes the deadline to D+1 00:30 +08:00, whatever day the read happens on.
  const deadlineMs = snapshotDeadlineMs(input.accountingDate);
  const row = await findSnapshot(db, appId, input.accountingDate);
  if (row !== undefined) {
    return { state: 'complete', snapshotId: row.id, waitingComparable: row.waiting_comparable };
  }
  const state = clock.now().getTime() >= deadlineMs ? 'timed_out' : 'pending';
  return { state, snapshotId: null, waitingComparable: null };
}

function logAlert(logger: AssetSnapshotLogger, alert: AssetSnapshotAlert): void {
  const fields = { event: alert.kind, ...alert.payload };
  if (alert.kind === 'asset_snapshot_timeout') {
    logger.warn(fields, 'asset snapshot completed after its deadline');
  } else {
    logger.warn(fields, 'union receivable exposure above ledger.advance_alert_fen');
  }
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '40001'
  );
}

function validAppId(appId: unknown): string {
  if (typeof appId !== 'string' || appId === '') {
    throw new LedgerError('INVALID_INPUT', 'appId must be a non-empty string');
  }
  return appId;
}
