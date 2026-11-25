// B2-18 (BR-FUND-04 ④ 2026-11-21, BR-FUND-01 R7, BR-CALC-02 / 10 / 15): the port the bill job and the
// supplement command call when B_settle and the base of the current commission version differ by
// more than the tolerance. It appends one amount version valued on the union's settlement (version =
// the greatest one + 1, orders.commission_version moved to it, beneficiaries / roles / ratio_bp /
// reserve_bp copied from the snapshot, the older rows left as they are) on the caller's transaction;
// the caller then validates once more.
//
// How (the caller holds the order key advisory lock and has re-read the order after it):
// 1. re-read the order row; it must still be WAITING on input.commissionVersion, else throw (the
//    caller rolls its savepoint back and judges again);
// 2. orders.commission_version = input.commissionVersion + 1 through settlement's rebate CAS (the
//    same writer as R7's version bump, BR-CALC-15 optimistic guard on the old version and row_version);
// 3. commission's estimates refresh with the explicit value N = the union settlement commission:
//    commission writes the totals and amount rows of the new current version over the frozen terms
//    (beneficiaries, roles, ratio_bp, reserve_bp, 淘礼金扣减 of the snapshot; splitCommission with its
//    floor and remainder rule), created_at = the injected Clock. Older versions are never touched.
// The caller re-reads the snapshot at the returned version (commission asserts it is the greatest) and
// validates again. Nothing here touches vouchers, balances or recon_diffs.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { readOrderLocator } from '../credit/credit-store.ts';
import { casUpdateRebate, readRebateOrder } from '../rebate/infra/rebate-store.ts';

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

const WAITING = 'WAITING';

export function createBillSnapshotRegeneration(
  dependencies: BillSnapshotRegenerationDependencies,
): BillSnapshotRegeneration {
  const { clock, refresh } = dependencies;
  return {
    async regenerate(trx, input) {
      const { appId, orderId, commissionVersion } = input;
      if (!Number.isSafeInteger(commissionVersion) || commissionVersion < 1) {
        throw new RangeError('settlement bill regeneration: commissionVersion must be >= 1');
      }
      const locator = await readOrderLocator(trx, appId, orderId);
      if (locator === undefined) throw new Error('settlement bill regeneration: order not found');
      const ref = { appId, orderId, attrAt: locator.attr_at };
      const order = await readRebateOrder(trx, ref);
      if (order === undefined) throw new Error('settlement bill regeneration: order not found');
      if (order.rebate_status !== WAITING) {
        throw new Error('settlement bill regeneration: order is no longer WAITING');
      }
      if (order.commission_version !== commissionVersion) {
        throw new Error('settlement bill regeneration: commission_version moved');
      }
      const next = commissionVersion + 1;
      const moved = await casUpdateRebate(
        trx,
        order,
        { commission_version: next },
        { commissionVersion },
        clock.now(),
      );
      if (!moved) throw new Error('settlement bill regeneration: concurrent order update');
      await refresh(trx, ref, { commissionFen: input.settleCommissionFen });
      return { commissionVersion: next };
    },
  };
}
