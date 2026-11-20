import { recon_diff_type, type ReconDiffStatus, type ReconDiffType } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { InvalidAmount, parseFen } from '@couli/money';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { newUuidV7, type Clock, type JobPayload } from '../../platform/index.ts';
import { LedgerError } from './errors.ts';
import {
  findReconDiffByBusinessKey,
  findReconDiffByDedupeKey,
  findReconDiffByMonthEnd,
  findUnresolvedReconDiff,
  insertReconDiffIfAbsent,
  selectReconDiffs,
} from '../infra/recon-diffs-store.ts';

export type ReconDiff = Selectable<DB['recon_diffs']>;

/** Registration only: no handler, closing, or status transition is accepted. */
export interface RegisterReconDiffInput {
  readonly appId: string;
  readonly type: ReconDiffType;
  readonly source: 'R1' | 'R2' | 'R3' | 'R4';
  readonly period: string;
  readonly refType: string;
  readonly refId: string;
  /** Signed integer fen supplied by the detecting caller; no implicit sign conversion. */
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly diffFen: bigint;
  readonly dedupeKey: string | null;
  readonly resolution: JobPayload | null;
}

export interface ReconDiffSelection {
  readonly appId: string;
  readonly status?: ReconDiffStatus;
  /** Stored as ref_type='order', ref_id=orderKey; recon_diffs has no order_key column. */
  readonly orderKey?: string;
}

const SOURCES: readonly string[] = ['R1', 'R2', 'R3', 'R4'];
const STATUSES: readonly string[] = ['open', 'processing', 'adjusted', 'written_off', 'closed'];
const TYPES: readonly string[] = recon_diff_type;
/** Same shape as the recon_diffs_period_check constraint: YYYY-MM or YYYY-MM-DD. */
const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/;
const MONTH_END: ReconDiffType = 'month_end_unbalanced';
/**
 * B2-02zc (BR-FUND-19 细则「账务自检异常」, D10-2224 B ①): internal self-check types whose unresolved
 * ticket is unique per (app_id, type, ref_id) across periods (recon_diffs_unresolved_internal_key),
 * except an order-level ticket (ref_type order), which keeps one per accounting day (D10-2295).
 */
const UNRESOLVED_UNIQUE: readonly ReconDiffType[] = ['ledger_mismatch'];

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('INVALID_INPUT', `${name} must be a nonempty string`);
  }
  return value;
}

/** Integer fen as given (sign kept): a bigint within int64, checked by @couli/money. */
function fen(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint') {
    throw new LedgerError('INVALID_INPUT', `${name} must be a bigint amount in fen`);
  }
  try {
    return parseFen(value);
  } catch (error) {
    if (error instanceof InvalidAmount) {
      throw new LedgerError('INVALID_INPUT', `${name} is out of range`, { cause: error });
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is JobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkInput(input: RegisterReconDiffInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new LedgerError('INVALID_INPUT', 'recon diff input must be an object');
  }
  text(input.appId, 'appId');
  if (!TYPES.includes(input.type)) {
    throw new LedgerError('INVALID_INPUT', 'type is not a recon_diff_type');
  }
  if (!SOURCES.includes(input.source)) {
    throw new LedgerError('INVALID_INPUT', 'source must be R1|R2|R3|R4');
  }
  if (!PERIOD.test(text(input.period, 'period'))) {
    throw new LedgerError('INVALID_INPUT', 'period must be YYYY-MM or YYYY-MM-DD');
  }
  text(input.refType, 'refType');
  text(input.refId, 'refId');
  fen(input.expectedFen, 'expectedFen');
  fen(input.actualFen, 'actualFen');
  fen(input.diffFen, 'diffFen');
  if (input.dedupeKey !== null) text(input.dedupeKey, 'dedupeKey');
  if (input.resolution !== null && !isPlainObject(input.resolution)) {
    throw new LedgerError('INVALID_INPUT', 'resolution must be a JSON object or null');
  }
}

/**
 * The row already registered under one of the unique keys of recon_diffs, in this order: the
 * nullable dedupe_key, the business key (app_id, type, period, ref_id), the month-end key, and for an
 * internal self-check type the unresolved ticket of (app_id, type, ref_id) in any period (B2-02zc).
 */
async function findExisting(
  trx: Transaction<DB>,
  input: RegisterReconDiffInput,
): Promise<ReconDiff | undefined> {
  if (input.dedupeKey !== null) {
    const byDedupe = await findReconDiffByDedupeKey(trx, input.appId, input.dedupeKey);
    if (byDedupe !== undefined) return byDedupe;
  }
  const byBusiness = await findReconDiffByBusinessKey(trx, input);
  if (byBusiness !== undefined) return byBusiness;
  if (input.type === MONTH_END) return findReconDiffByMonthEnd(trx, input.appId, input.period);
  if (UNRESOLVED_UNIQUE.includes(input.type)) return findUnresolvedReconDiff(trx, input);
  return undefined;
}

/** B2-15n: what one registration did — the stored row, and whether this call inserted it. */
export interface ReconDiffRegistration {
  readonly row: ReconDiff;
  /**
   * true only for the call whose INSERT created the row; false when a row under one of the unique
   * keys already existed or a concurrent registration committed it first.
   */
  readonly inserted: boolean;
}

/**
 * Insert open, or return the existing row under any recon_diffs unique business key.
 *
 * Runs on the caller's transaction only. INSERT … ON CONFLICT DO NOTHING covers every unique
 * index (business key, partial dedupe_key, partial month-end key) and waits for a concurrent
 * uncommitted conflicting insert: when that one commits, nothing is inserted and the committed row
 * is read back (READ COMMITTED: a new statement sees it); when it rolls back, this insert goes
 * through. No unique violation is raised, so the caller's transaction stays usable. A replay never
 * overwrites the stored row (status, resolution, amounts and source stay as first registered).
 */
export async function registerReconDiff(
  trx: Transaction<DB>,
  input: RegisterReconDiffInput,
  dependencies: { readonly clock: Clock },
): Promise<ReconDiff> {
  return (await registerReconDiffOnce(trx, input, dependencies)).row;
}

/**
 * B2-15n: registerReconDiff (same checks, same single INSERT … ON CONFLICT DO NOTHING, same row
 * back) that also tells whether this call inserted the row, so a caller can alert a diff once:
 * only the registration whose INSERT returned the row sees inserted = true; any other — a replay,
 * or a concurrent registration that waited for the first one's commit — sees false.
 */
export async function registerReconDiffOnce(
  trx: Transaction<DB>,
  input: RegisterReconDiffInput,
  dependencies: { readonly clock: Clock },
): Promise<ReconDiffRegistration> {
  checkInput(input);
  const now = dependencies.clock.now();
  const inserted = await insertReconDiffIfAbsent(trx, {
    id: newUuidV7(now),
    app_id: input.appId,
    type: input.type,
    source: input.source,
    period: input.period,
    ref_type: input.refType,
    ref_id: input.refId,
    expected_fen: input.expectedFen,
    actual_fen: input.actualFen,
    diff_fen: input.diffFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
    dedupe_key: input.dedupeKey,
    resolution: input.resolution,
    created_at: now,
    updated_at: now,
  });
  if (inserted !== undefined) return { row: inserted, inserted: true };
  // B2-02zc: a conflicting unresolved ticket concluded by a concurrent transaction between this
  // INSERT and the read-back is found under no key; the error rolls the caller back and the
  // at-least-once job registers again on its retry (the INSERT then goes through).
  const existing = await findExisting(trx, input);
  if (existing === undefined) {
    throw new Error('ledger: recon diff conflicted but no existing row was found');
  }
  return { row: existing, inserted: false };
}

/** Uses the supplied connection/snapshot and never locks or writes. */
export async function getReconDiffs(
  db: Kysely<DB>,
  selection: ReconDiffSelection,
): Promise<readonly ReconDiff[]> {
  if (typeof selection !== 'object' || selection === null) {
    throw new LedgerError('INVALID_INPUT', 'selection must be an object');
  }
  const appId = text(selection.appId, 'appId');
  if (selection.status !== undefined && !STATUSES.includes(selection.status)) {
    throw new LedgerError('INVALID_INPUT', 'status is not a recon_diff_status');
  }
  const orderKey =
    selection.orderKey === undefined ? undefined : text(selection.orderKey, 'orderKey');
  return selectReconDiffs(db, { appId, status: selection.status, orderKey });
}
