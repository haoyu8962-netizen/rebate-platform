// B2-18 (BR-FUND-04 ④ 2026-11-21, BR-FUND-01 R7, BR-CALC-02 / 10 / 15): the port the bill job and the
// supplement command call when B_settle and the base of the current commission version differ by
// more than the tolerance. It appends one amount version valued on the union's settlement (version =
// the greatest one + 1, orders.commission_version moved to it, beneficiaries / roles / ratio_bp /
// reserve_bp copied from the snapshot, the older rows left as they are) on the caller's transaction;
// the caller then validates once more. Skeleton only (test stage): the shape of the dependencies is
// not pinned by the rule tests, the port type is.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface BillSnapshotRegenerationInput {
  readonly appId: string;
  readonly orderId: string;
  /** The current (greatest) commission_version the amounts were compared on. */
  readonly commissionVersion: number;
  /** The union settlement commission (N) of the deciding settlement record. */
  readonly settleCommissionFen: bigint;
  /** B_settle of that settlement (BR-CALC-02 on the snapshot's reserve_bp and 淘礼金扣减). */
  readonly bSettleFen: bigint;
}

export interface BillSnapshotRegenerationResult {
  /** The version appended, which orders.commission_version now names. */
  readonly commissionVersion: number;
}

/** Optional on the bill job's dependencies: absent, a mismatch is handled as a failed regeneration. */
export interface BillSnapshotRegeneration {
  regenerate(
    trx: Transaction<DB>,
    input: BillSnapshotRegenerationInput,
  ): Promise<BillSnapshotRegenerationResult>;
}

export interface BillSnapshotRegenerationOrderRef {
  readonly appId: string;
  readonly orderId: string;
  readonly attrAt: Date;
}

export interface BillSnapshotRegenerationDependencies {
  readonly clock: Clock;
  /**
   * commission's estimates port refresh with an explicit value (as R7 of B2-03r calls it): writes
   * the amount and totals rows of orders' current commission_version valued on `value`.
   */
  refresh(
    trx: Transaction<DB>,
    ref: BillSnapshotRegenerationOrderRef,
    value: { readonly commissionFen: bigint },
  ): Promise<void>;
}

export function createBillSnapshotRegeneration(
  dependencies: BillSnapshotRegenerationDependencies,
): BillSnapshotRegeneration {
  void dependencies;
  throw new Error('NotImplemented: createBillSnapshotRegeneration');
}
