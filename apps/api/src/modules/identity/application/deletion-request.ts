// Account deletion: apply, cancel, read (task B1-15d; 08 BR-ID-27, BR-ID-08, BR-ID-31; contract
// operations requestDeletion / cancelDeletion / getDeletion).
//
// request(trx, subject) — called inside the idempotency claim's transaction (executeInTransaction,
// wrapped by withStepUp in the controller). Fixed order (§9.2 #3):
//   ① lockUsersForUpdate on the caller; ② the session's re-verification gate → 10010, after the
//      step-up check and before anything below (BR-ID-27, BR-WDR-01 细则「位置与返回码」; a request
//      that waited for the lock is judged on what it finds, manual in a restricted session; only
//      the service-layer call without a session, which has no device, skips it);
//   ③ latest request (apply_at DESC, id DESC) cooling / processing → return it (no new row,
//      cooling_until unchanged); ④ withdrawalInFlight.hasInFlight → 30412 (before 30416);
//   ⑤ balance.availableFen < 0 → 30416, data.amount_fen = -available_fen (positive bigint);
//   ⑥ insert: UUIDv7 id, status 'cooling' (an insert, not a transition), apply_at = clock.now(),
//      cooling_until = apply_at + 604 800 000 ms, balance_snapshot_fen = available_fen, row_version
//      0, created_at / updated_at = the Clock value; then, on the same transaction, the
//      DELETION_PROGRESS requested inbox message (B1-15i, BR-TEXT-23; {cancel_deadline} =
//      cooling_until); ⑦ return the request (can_cancel true).
// cancel(subject) — one transaction: lock the caller, read the latest request:
//   cooling and now < cooling_until → transitionDeletionRequest('cooling', 'CANCEL'), conditional
//   update (id + row_version): cancelled, cancelled_at = now, cancel_reason 'user', then the
//   DELETION_PROGRESS cancelled inbox message on the same transaction (B1-15i, BR-TEXT-23);
//   cooling and now ≥ cooling_until, processing (and done, defensively) → 10007 stage processing;
//   cancelled → returned as it is; none → data null.
// read(subject) — the latest request or null; can_cancel = cooling and clock.now() < cooling_until.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { transitionDeletionRequest } from '@couli/domain';
import { subFen } from '@couli/money';
import type { FactoryProvider } from '@nestjs/common';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import { lockUsersForUpdate } from '../ports/lock-users.ts';
import { instantPlus } from './config-seconds.ts';
import type {
  DeletionReverifyGate,
  DeletionReverifySession,
  ReverifyRefusal,
} from './reverify-gate.ts';
import type { DeletionBalanceReader } from '../ports/deletion-balance.ts';
import type { DeletionProgressNotice } from '../ports/deletion-progress-notice.ts';
import type { WithdrawalInFlightReader } from '../ports/withdrawal-in-flight.ts';

/**
 * The two IdentityModuleOptions entries app.module assembles for this flow (useFactory style like
 * the other options). Missing (undefined or a factory answering null) → POST /v1/me/deletion
 * answers 50001; it never lets an application through unchecked.
 */
export interface DeletionRequestModuleOptions {
  readonly withdrawalInFlight?: Omit<FactoryProvider<WithdrawalInFlightReader | null>, 'provide'>;
  readonly deletionBalance?: Omit<FactoryProvider<DeletionBalanceReader | null>, 'provide'>;
  /**
   * B1-15i: the DELETION_PROGRESS inbox message (BR-TEXT-23), assembled by app.module over
   * notification. Missing → no message is written (the flows themselves are unchanged).
   */
  readonly deletionProgress?: Omit<FactoryProvider<DeletionProgressNotice | null>, 'provide'>;
}

export type DeletionView = components['schemas']['Deletion'];

export interface DeletionSubject {
  readonly appId: string;
  readonly userId: string;
}

export type RequestDeletionResult =
  | { readonly code: 0; readonly data: DeletionView }
  | ReverifyRefusal
  | { readonly code: 30412 }
  | { readonly code: 30416; readonly data: { readonly amount_fen: bigint } };

export type CancelDeletionResult =
  | { readonly code: 0; readonly data: DeletionView | null }
  | { readonly code: 10007; readonly data: { readonly stage: 'processing' } };

export interface DeletionRequestServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** Null when app.module assembled none: POST /v1/me/deletion fails closed (50001). */
  readonly withdrawalInFlight: WithdrawalInFlightReader | null;
  /** Null when app.module assembled none: POST /v1/me/deletion fails closed (50001). */
  readonly balance: DeletionBalanceReader | null;
  /** B1-15i: written on the business transaction; absent or null → no message. */
  readonly notice?: DeletionProgressNotice | null;
  /** B1-02zq: step ②. Absent: POST /v1/me/deletion fails closed (50001, canRequest false). */
  readonly reverify?: DeletionReverifyGate;
}

export interface DeletionRequestService {
  /** False when a port of the application is missing: request() would refuse (50001). */
  readonly canRequest: boolean;
  read(subject: DeletionSubject): Promise<DeletionView | null>;
  request(
    trx: Transaction<DB>,
    subject: DeletionSubject,
    session?: DeletionReverifySession,
  ): Promise<RequestDeletionResult>;
  cancel(subject: DeletionSubject): Promise<CancelDeletionResult>;
}

/** BR-ID-27: the cooling period, 7×24 hours. */
const COOLING_MS = 7 * 24 * 60 * 60 * 1000;

type RequestRow = Pick<
  Selectable<DB['deletion_requests']>,
  | 'id'
  | 'status'
  | 'apply_at'
  | 'cooling_until'
  | 'cancelled_at'
  | 'cancel_reason'
  | 'processed_at'
  | 'row_version'
>;

const COLUMNS = [
  'id',
  'status',
  'apply_at',
  'cooling_until',
  'cancelled_at',
  'cancel_reason',
  'processed_at',
  'row_version',
] as const;

const STATUSES: ReadonlySet<string> = new Set(['cooling', 'processing', 'done', 'cancelled']);
const REASONS: ReadonlySet<string> = new Set(['user', 'negative_balance']);

/** The latest request of the subject (apply_at DESC, id DESC), or undefined. */
function latest(
  executor: Kysely<DB> | Transaction<DB>,
  subject: DeletionSubject,
): Promise<RequestRow | undefined> {
  return executor
    .withSchema('app')
    .selectFrom('deletion_requests')
    .select(COLUMNS)
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .orderBy('apply_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The contract's Deletion; can_cancel judged by time alone (BR-ID-27), status as stored. */
function view(row: RequestRow, now: Date): DeletionView {
  if (!STATUSES.has(row.status)) throw new Error('identity: unknown deletion request status');
  if (row.cancel_reason !== null && !REASONS.has(row.cancel_reason)) {
    throw new Error('identity: unknown deletion cancel reason');
  }
  return {
    status: row.status as DeletionView['status'],
    apply_at: row.apply_at.toISOString(),
    cooling_until: row.cooling_until.toISOString(),
    can_cancel: row.status === 'cooling' && now.getTime() < row.cooling_until.getTime(),
    cancelled_at: iso(row.cancelled_at),
    cancel_reason: row.cancel_reason as DeletionView['cancel_reason'],
    processed_at: iso(row.processed_at),
  };
}

async function lockSubject(trx: Transaction<DB>, subject: DeletionSubject): Promise<void> {
  const locked = await lockUsersForUpdate(trx, {
    appId: subject.appId,
    userIds: [subject.userId],
  });
  // The token check resolved this user; a missing row is a server-side inconsistency.
  if (!locked.has(subject.userId)) throw new Error('identity: deletion subject has no user row');
}

export function createDeletionRequestService(
  options: DeletionRequestServiceOptions,
): DeletionRequestService {
  const { db, clock, withdrawalInFlight, balance } = options;
  const notice = options.notice ?? null;
  const reverify = options.reverify;
  return Object.freeze({
    canRequest: withdrawalInFlight !== null && balance !== null && reverify !== undefined,

    async read(subject: DeletionSubject): Promise<DeletionView | null> {
      const row = await latest(db, subject);
      return row === undefined ? null : view(row, clock.now());
    },

    async request(
      trx: Transaction<DB>,
      subject: DeletionSubject,
      session?: DeletionReverifySession,
    ): Promise<RequestDeletionResult> {
      if (withdrawalInFlight === null || balance === null) {
        throw new Error('identity: deletion request needs the in-flight and balance ports');
      }
      // ① The caller's users row first: the posting chain locks users before balances
      // (B1-02zf), so the balance read below cannot interleave with a posting for this user.
      await lockSubject(trx, subject);
      // ② The flag and the device under the lock, before the open request is answered.
      if (session !== undefined) {
        if (reverify === undefined) {
          throw new Error('identity: deletion request needs the re-verification gate');
        }
        const refusal = await reverify.check(trx, subject, session);
        if (refusal !== null) return refusal;
      }
      // ③ An open request is returned as it is (no new row, cooling_until unchanged).
      const open = await latest(trx, subject);
      if (open !== undefined && (open.status === 'cooling' || open.status === 'processing')) {
        return { code: 0, data: view(open, clock.now()) };
      }
      // ④ Withdrawal in flight (the port owns the status rule, BR-ID-31) → 30412, before 30416.
      if (await withdrawalInFlight.hasInFlight(trx, subject)) return { code: 30412 };
      // ⑤ Negative balance → 30416 with the amount still to be recovered (a positive number).
      const available = await balance.availableFen(trx, subject);
      if (available < 0n) return { code: 30416, data: { amount_fen: subFen(0n, available) } };
      // ⑥ The cooling request (an insert, not a state transition).
      const now = clock.now();
      const coolingUntil = instantPlus(now, COOLING_MS);
      const row = await trx
        .withSchema('app')
        .insertInto('deletion_requests')
        .values({
          id: newUuidV7(now),
          app_id: subject.appId,
          user_id: subject.userId,
          status: 'cooling',
          apply_at: now,
          cooling_until: coolingUntil,
          cancelled_at: null,
          cancel_reason: null,
          processed_at: null,
          balance_snapshot_fen: available,
          row_version: 0,
          created_at: now,
          updated_at: now,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      // B1-15i: the requested inbox message on this transaction (a failure rolls the request back).
      await notice?.write(trx, {
        app_id: subject.appId,
        user_id: subject.userId,
        deletion_request_id: row.id,
        variant: 'requested',
        cancel_deadline: row.cooling_until,
      });
      // ⑦
      return { code: 0, data: view(row, now) };
    },

    async cancel(subject: DeletionSubject): Promise<CancelDeletionResult> {
      return db.transaction().execute(async (trx): Promise<CancelDeletionResult> => {
        await lockSubject(trx, subject);
        const row = await latest(trx, subject);
        const now = clock.now();
        // Never applied (规划待补, ruling §12): data null.
        if (row === undefined) return { code: 0, data: null };
        // A repeated cancel (or a negative_balance cancellation) is returned as it is.
        if (row.status === 'cancelled') return { code: 0, data: view(row, now) };
        // Judged by time, not by whether the scheduled job ran (BR-ID-27); processing / done and
        // a cooling request past its cutoff are 10007 stage processing (ruling §12).
        if (row.status !== 'cooling' || now.getTime() >= row.cooling_until.getTime()) {
          return { code: 10007, data: { stage: 'processing' } };
        }
        const moved = transitionDeletionRequest('cooling', 'CANCEL');
        if (!moved.ok) throw new Error('identity: deletion cancel transition refused');
        const updated = await trx
          .withSchema('app')
          .updateTable('deletion_requests')
          .set({
            status: moved.to,
            cancelled_at: now,
            cancel_reason: 'user',
            row_version: row.row_version + 1,
            updated_at: now,
          })
          .where('app_id', '=', subject.appId)
          .where('id', '=', row.id)
          .where('status', '=', 'cooling')
          .where('row_version', '=', row.row_version)
          .returning(COLUMNS)
          .executeTakeFirst();
        if (updated === undefined)
          throw new Error('identity: deletion request changed concurrently');
        // B1-15i: the cancelled inbox message on this transaction (a failure rolls the cancel back).
        await notice?.write(trx, {
          app_id: subject.appId,
          user_id: subject.userId,
          deletion_request_id: updated.id,
          variant: 'cancelled',
        });
        return { code: 0, data: view(updated, now) };
      });
    },
  });
}
