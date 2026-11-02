// B2-04s: post-credit clawback orchestration (BR-FUND-01 R8 / R9 / R9b; BR-FUND-08; BR-FUND-10;
// BR-CALC-09). The contract below is what the rule tests (test/spec/settlement/clawback/**) pin.
//
// apply(trx, command): one reverse event on one CREDITED sub-order, on the caller's transaction
// (never opens, commits or rolls back one). In order:
//   1. pg_advisory_xact_lock(order_key) through orders' lockOrderKey, then re-read the order; a
//      rebate_status other than CREDITED → { outcome: 'skipped', reason: 'not_credited' } and
//      nothing is written (a replay of an R8 event lands here).
//   2. rights_event_id (BR-FUND-08): ref rights → `R{orderRightsId}`; ref platform →
//      `P{orders.row_version}` as re-read under the lock (the row_version written by the sync
//      update that carried the platform status change); ref commission →
//      `C{orders.commission_version}` as re-read.
//   3. N_new (BR-FUND-08, @couli/domain selectClawbackCommission): the full causes
//      PLATFORM_INVALID, INVALID_AFTER_SETTLE, REFUND_AFTER_SETTLE and PUNISH → 0; otherwise
//      ① command.newCommissionFen, ② booked_n_fen − command.rightsDeductFen (below 0 → 0),
//      ③ neither → WAIT_COMMISSION (S12): no voucher, no rebate transition; the order_rights row
//      of a rights ref → status WAIT_COMMISSION and orders.rights_pending recomputed in the same
//      transaction; deps.pending.open(reason CLAWBACK_NO_COMMISSION); one warn log line carrying
//      an `alert` field and app_id; result { outcome: 'wait_commission' }.
//   4. cause COMMISSION is a reverse event only when the plan is R8 (N_new positive part 0, or
//      booked_base_fen > 0 and B_new 0); any other result → skipped 'not_reverse', nothing written
//      (left to R10 / BR-FUND-09).
//   5. users rows (gate.lockUsers, ascending) → ledger.lockBalances → gate.readStates after the
//      locks (B2-04m lock flow); beneficiary nets and the platform net from ledger getOrderNets;
//      the plan from @couli/domain planCommissionAdjustment({ event: 'clawback', … }) with the
//      snapshot reserve_bp and ratios (B_new = N_new per BR-CALC-02).
//   6. vouchers (voucher_kind CLAWBACK, ledger_type CLAWBACK, sub_type per the table below):
//      per beneficiary with delta < 0 `{order_key}:{user_id}:{role}:CLAWBACK:{rights_event_id}`
//      (USER_BALANCE.available debit / UNION_RECEIVABLE credit; available may go negative,
//      frozen is never touched; a beneficiary in deletion processing / done → BAD_DEBT debit
//      instead, same key, beneficiary columns kept); platform difference ≠ 0
//      `{order_key}:PLATFORM:CLAWBACK:{rights_event_id}` (DECREASE / INCREASE templates).
//      A stored uniq_key is a duplicate, never a second clawback.
//   7. unfinished obligations (beneficiary_credits): R8 → voided (closed_by R8); R9 → a
//      beneficiary whose remaining amount went to the platform → forfeited (closed_by R9) plus a
//      forfeited beneficiary event; others kept open.
//   8. pending settle_adjustments of this order → voided_by_clawback (decided_at = Clock now).
//   9. booked_base_fen = B_new and booked_n_fen = N_new positive part together, rebate_status
//      through the generated order-rebate transition() with a CAS on (rebate_status, row_version);
//      a rebate history row; R8 also writes orders.reason, R9 writes diff_reason_code PART_REFUND
//      and leaves orders.reason unchanged.
//  10. R8 and R9 publish order.clawed_back on the same transaction (B2-04lb, D10-474 ③): order_id,
//      order_key, rights_event_id, transition, R8 reason, beneficiaries [{ user_id, role,
//      clawback_fen (decimal string) }] for the beneficiaries clawed back from their balance.
//  11. (B2-04l, BR-FUND-06「等联盟回传新佣金后按 R7/R9 处理并关闭」) after an R8 / R9: the WAIT_COMMISSION
//      order_rights rows this event answers are closed as SUCCEEDED (a rights ref: that row; a
//      platform / commission ref: every WAIT_COMMISSION row of the order), orders.rights_pending is
//      recomputed with a CAS, and when no WAIT_COMMISSION row is left the sub-order's open
//      CLAWBACK_NO_COMMISSION pending rows are resolved through deps.pending.resolve (orders' port;
//      settlement never writes order_sync_pending itself).
//
// | cause                | R8 history event                       | R9 history event | sub_type        | R8 reason       |
// | PLATFORM_INVALID     | PLATFORM_INVALID                       | —                | FULL            | REFUND          |
// | INVALID_AFTER_SETTLE | INVALID_AFTER_SETTLE                   | —                | FULL            | REFUND          |
// | REFUND_AFTER_SETTLE  | REFUND_AFTER_SETTLE                    | —                | FULL            | REFUND          |
// | PUNISH               | PUNISH                                 | —                | PUNISH          | PUNISH          |
// | RIGHTS               | RIGHTS_FULL                            | RIGHTS_PARTIAL   | RIGHTS          | RIGHTS          |
// | PARTIAL_REFUND       | COMMISSION_POSITIVE_ZERO / BASE_ZERO   | PARTIAL_REFUND   | FULL / PART_REFUND | COMMISSION_ZERO |
// | COMMISSION           | COMMISSION_POSITIVE_ZERO / BASE_ZERO   | — (not_reverse)  | FULL            | COMMISSION_ZERO |
//
// onUpdated(trx, change, source): orders' sync hook (OrderUpdateDeps['rebate']['onUpdated'])
// for a CREDITED order, on the sync transaction, after orders wrote its columns:
//   - not CREDITED → skipped 'not_credited';
//   - source.event PLATFORM_INVALID (or to_status INVALID) → apply cause INVALID_AFTER_SETTLE
//     when change.from_status is SETTLED (P7), else PLATFORM_INVALID (P6); ref platform;
//   - source.event PLATFORM_PUNISH (P8) → apply cause PUNISH, ref platform;
//   - source.event PLATFORM_RIGHTS → skipped 'not_reverse': the status signal carries no rights
//     record; the rights success entry is settlement's rights.record (B2-04l), which orders calls
//     with the record and which calls apply with ref rights `R{order_rights.id}`;
//   - refunded_quantity increased in this sync, or an order_rights row exists for the order → R9
//     (BR-FUND-01「R9 与 R9b 的判定」), never R9b: N_new per step 3; with the settlement record
//     unchanged and no deduction that is ③ WAIT_COMMISSION (an existing order_rights row →
//     WAIT_COMMISSION). 待编排裁定: change carries no refunded_quantity, so how the increase is
//     detected (orders.refunded_quantity re-read under the lock against
//     refunded_quantity_at_credit, or a new change field) is left to the implementation;
//   - otherwise settlement record unchanged and est_commission_fen changed → R9b: archive only
//     (no voucher, booked pair unchanged); when the estimate's base (BR-CALC-02, snapshot
//     reserve_bp) differs from booked_base_fen and settle.estimate_change_diff.enabled is not off,
//     register one recon diff (ledger registerReconDiff, type estimate_changed_after_credit,
//     ref_id naming the order_key, expected_fen = booked_base_fen, actual_fen = that base,
//     diff_fen = actual − expected) once per sub-order and estimate value, and log one warn line
//     carrying an `alert` field, app_id and the order; result 'estimate_archived'.
// platform jd whose effective commission goes from > 0 to 0 (BR-FUND-08, 口径待 规划/09): R8 full
// clawback as for any platform, plus one open recon diff naming the order_key for manual review
// (编排裁定 D10-313: type union_mismatch, resolution.reason_code = 'COMMISSION_ZERO').
// 待编排裁定 (implementation): a refunded_quantity increase is read as orders.refunded_quantity >
// COALESCE(refunded_quantity_at_credit, 0) under the lock; R9b writes no rebate history row.
// Amounts only through @couli/money; time only from the injected Clock.
import type { DB } from '@couli/db';
import {
  buildVouchers,
  chinaMonth,
  orderKey,
  planCommissionAdjustment,
  selectClawbackCommission,
  transitionBeneficiaryCredit,
  transitionOrderRebate,
  transitionSettleAdjustment,
  type AdjustmentBeneficiary,
  type AdjustmentBeneficiaryResult,
  type AdjustmentPlan,
  type BuildVoucherParams,
  type BuiltVoucher,
  type CreditBeneficiaryState,
  type OrderRebateEvent,
} from '@couli/domain';
import { applyReserve, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import {
  getOrderNets,
  registerReconDiff,
  type Ledger,
  type PostingEntry,
  type PostingVoucher,
} from '../../ledger/index.ts';
import {
  lockOrderKey,
  resolveClawbackNoCommissionPending,
  type ClawbackPendingResolveInput,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type {
  BeneficiaryEventInput,
  BeneficiaryGate,
  CreditRole,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit/index.ts';
import { readLatestSettleSeq, readOrderLocator } from '../credit/credit-store.ts';
import {
  insertRebateHistory,
  readRebateOrder,
  type OrderRow,
} from '../rebate/infra/rebate-store.ts';
import { isForfeitedShare } from '../reads/pending-earnings-rules.ts';
import {
  closeWaitingRights,
  hasWaitingRights,
  hasWaitingRightsBefore,
} from '../rights/rights-store.ts';
import { createSettlementRecords } from '../settlements/index.ts';
import {
  casClawbackOrder,
  casRightsPending,
  closeObligation,
  computeRightsPending,
  hasOrderRights,
  markRightsWaitCommission,
  readOpenObligations,
  voidPendingCandidates,
  type BeneficiaryCreditRow,
} from './clawback-store.ts';

/** The reverse event behind one clawback (BR-FUND-08 细则「sub_type 与订单原因码」). */
export type ClawbackCause =
  | 'PLATFORM_INVALID'
  | 'INVALID_AFTER_SETTLE'
  | 'REFUND_AFTER_SETTLE'
  | 'PUNISH'
  | 'RIGHTS'
  | 'PARTIAL_REFUND'
  | 'COMMISSION';

/** Where the rights_event_id of the uniq_keys comes from (BR-FUND-08). */
export type ClawbackEventRef =
  | { readonly kind: 'rights'; readonly orderRightsId: string }
  | { readonly kind: 'platform' }
  | { readonly kind: 'commission' };

export interface ClawbackCommand {
  readonly appId: string;
  readonly orderId: string;
  readonly cause: ClawbackCause;
  readonly ref: ClawbackEventRef;
  /** ① the union's new effective commission brought by this event (raw, may be ≤ 0); or null. */
  readonly newCommissionFen: bigint | null;
  /** ② the commission to deduct given by the order_rights record; or null. */
  readonly rightsDeductFen: bigint | null;
}

/** One order_sync_pending entry (orders owns the table; written only through deps.pending). */
export interface ClawbackPendingInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly reason: 'CLAWBACK_NO_COMMISSION';
  readonly detail: string | null;
}

export interface ClawbackDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** Writer of commission_split_beneficiary_events (same port as B2-04m). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
  /**
   * orders' CLAWBACK_NO_COMMISSION pending port (orders createClawbackPendingPort). resolve closes the
   * sub-order's open rows; when it is not injected, orders' exported resolveClawbackNoCommissionPending
   * is used (still orders' code, same transaction).
   */
  readonly pending: {
    open(trx: Transaction<DB>, input: ClawbackPendingInput): Promise<void>;
    resolve?(trx: Transaction<DB>, input: ClawbackPendingResolveInput): Promise<void>;
  };
  /** settle.estimate_change_diff.enabled (default on; false / 'false' / 'off' turn it off). */
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
  readonly events: Pick<EventBus, 'publish'>;
}

export type ClawbackSkipReason = 'not_credited' | 'not_reverse';

export type ClawbackResult =
  | {
      readonly outcome: 'clawed_back';
      readonly transition: 'R8' | 'R9';
      readonly orderKey: string;
      readonly rightsEventId: string;
      readonly bookedBaseFen: bigint;
      readonly bookedNFen: bigint;
    }
  | {
      /** B2-04lb: R10 SETTLE_ADJUST answering a WAIT_COMMISSION rights record. */
      readonly outcome: 'settle_adjusted';
      readonly transition: 'R10';
      readonly orderKey: string;
      readonly rightsEventId: string;
      readonly bookedBaseFen: bigint;
      readonly bookedNFen: bigint;
    }
  | {
      /** Recalculated with nothing to write (e.g. a replayed R9 event). */
      readonly outcome: 'no_change';
      readonly orderKey: string;
      readonly rightsEventId: string;
    }
  | {
      readonly outcome: 'wait_commission';
      readonly orderKey: string;
      readonly rightsEventId: string;
    }
  | {
      /** R9b. registered: a recon diff was registered (or already existed for this estimate). */
      readonly outcome: 'estimate_archived';
      readonly orderKey: string;
      readonly reconDiff: 'registered' | 'none' | 'disabled';
    }
  | { readonly outcome: 'skipped'; readonly reason: ClawbackSkipReason };

export interface ClawbackOrder {
  apply(trx: Transaction<DB>, command: ClawbackCommand): Promise<ClawbackResult>;
  onUpdated(
    trx: Transaction<DB>,
    change: OrderUpdateChange,
    source: OrderStatusSource,
  ): Promise<ClawbackResult>;
}

const FROM_STATUS = 'CREDITED';
const BIZ_TYPE = 'ORDER_CLAWBACK';
const ADJUST_BIZ_TYPE = 'ORDER_SETTLE_ADJUST';
const ALERT_ADJUST_HELD = 'rights_settle_adjust_unsupported';
const OPERATOR = 'system';
const DIFF_SWITCH = 'settle.estimate_change_diff.enabled';
const FULL_CAUSES: readonly ClawbackCause[] = [
  'PLATFORM_INVALID',
  'INVALID_AFTER_SETTLE',
  'REFUND_AFTER_SETTLE',
  'PUNISH',
];
const ALERT_WAIT = 'clawback_wait_commission';
const ALERT_ESTIMATE = 'estimate_changed_after_credit';
const ALERT_JD_ZERO = 'clawback_jd_commission_zero';

/** A snapshot beneficiary no longer in app.users: treated as deleted (same as B2-04m). */
const MISSING_USER: CreditBeneficiaryState = Object.freeze({
  risk_state: 'normal',
  deletion_status: 'done',
  is_minor: false,
});

type SubType = 'FULL' | 'PUNISH' | 'RIGHTS' | 'PART_REFUND';

interface CauseRules {
  readonly r8Event: (nPositive: bigint) => OrderRebateEvent;
  readonly r9Event: OrderRebateEvent | null;
  readonly r8SubType: SubType;
  readonly r9SubType: SubType | null;
  readonly r8Reason: string;
}

const zeroEvent = (nPositive: bigint): OrderRebateEvent =>
  nPositive === 0n ? 'COMMISSION_POSITIVE_ZERO' : 'BASE_ZERO';

/** BR-FUND-08 细则「sub_type 与订单原因码」; the table in the file header. */
function rulesOf(cause: ClawbackCause): CauseRules {
  switch (cause) {
    case 'PLATFORM_INVALID':
    case 'INVALID_AFTER_SETTLE':
    case 'REFUND_AFTER_SETTLE':
      return {
        r8Event: () => cause,
        r9Event: null,
        r8SubType: 'FULL',
        r9SubType: null,
        r8Reason: 'REFUND',
      };
    case 'PUNISH':
      return {
        r8Event: () => 'PUNISH',
        r9Event: null,
        r8SubType: 'PUNISH',
        r9SubType: null,
        r8Reason: 'PUNISH',
      };
    case 'RIGHTS':
      return {
        r8Event: () => 'RIGHTS_FULL',
        r9Event: 'RIGHTS_PARTIAL',
        r8SubType: 'RIGHTS',
        r9SubType: 'RIGHTS',
        r8Reason: 'RIGHTS',
      };
    case 'PARTIAL_REFUND':
      return {
        r8Event: zeroEvent,
        r9Event: 'PARTIAL_REFUND',
        r8SubType: 'FULL',
        r9SubType: 'PART_REFUND',
        r8Reason: 'COMMISSION_ZERO',
      };
    case 'COMMISSION':
      return {
        r8Event: zeroEvent,
        r9Event: null,
        r8SubType: 'FULL',
        r9SubType: null,
        r8Reason: 'COMMISSION_ZERO',
      };
    default:
      throw new TypeError('settlement clawback: unknown cause');
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`settlement clawback: ${name} must be a nonempty string`);
  }
  return value;
}

function optionalFen(value: unknown, name: string): bigint | null {
  if (value === null) return null;
  if (typeof value !== 'bigint') {
    throw new TypeError(`settlement clawback: ${name} must be a bigint or null`);
  }
  return value;
}

function checkCommand(command: ClawbackCommand): void {
  text(command.appId, 'appId');
  text(command.orderId, 'orderId');
  rulesOf(command.cause);
  const ref = command.ref as ClawbackEventRef | undefined;
  if (ref === undefined || ref === null) throw new TypeError('settlement clawback: ref missing');
  if (ref.kind === 'rights') text(ref.orderRightsId, 'ref.orderRightsId');
  else if (ref.kind !== 'platform' && ref.kind !== 'commission') {
    throw new TypeError('settlement clawback: unknown ref kind');
  }
  optionalFen(command.newCommissionFen, 'newCommissionFen');
  optionalFen(command.rightsDeductFen, 'rightsDeductFen');
  if (command.rightsDeductFen !== null && command.rightsDeductFen < 0n) {
    throw new TypeError('settlement clawback: rightsDeductFen must be nonnegative');
  }
}

/** BR-FUND-08 rights_event_id, from the order row re-read under the lock. */
function rightsEventIdOf(ref: ClawbackEventRef, order: OrderRow): string {
  switch (ref.kind) {
    case 'rights':
      return `R${ref.orderRightsId}`;
    case 'platform':
      return `P${String(order.row_version)}`;
    case 'commission':
      return `C${String(order.commission_version)}`;
  }
}

function positive(fen: bigint): bigint {
  return fen > 0n ? fen : 0n;
}

/** settle.estimate_change_diff.enabled: on unless false / 'false' / 'off'. */
function switchedOff(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'false' || v === 'off';
  }
  return false;
}

function identity(userId: string, role: string): string {
  return JSON.stringify([userId, role]);
}

export function createClawbackOrder(deps: ClawbackDependencies): ClawbackOrder {
  const { clock, logger, ledger, gate, events } = deps;
  const settlements = createSettlementRecords({ clock });

  interface Locked {
    readonly order: OrderRow;
    readonly key: string;
  }

  /** order_key advisory lock (re-entrant within the sync transaction), then re-read the order. */
  async function lockAndRead(
    trx: Transaction<DB>,
    appId: string,
    orderId: string,
  ): Promise<Locked> {
    const locator = await readOrderLocator(trx, appId, orderId);
    if (locator === undefined) throw new Error('settlement clawback: order not found for app');
    await lockOrderKey(trx, locator.platform, locator.sub_order_id);
    const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
    if (order === undefined) throw new Error('settlement clawback: order not found for app');
    return { order, key: orderKey(locator.platform, locator.sub_order_id) };
  }

  async function readSnapshotOf(trx: Transaction<DB>, order: OrderRow): Promise<CreditSnapshot> {
    const snapshot = await deps.readSnapshot(trx, {
      appId: order.app_id,
      orderId: order.order_id,
      commissionVersion: order.commission_version,
    });
    if (snapshot === null) throw new Error('settlement clawback: order has no commission snapshot');
    return snapshot;
  }

  function bookedOf(order: OrderRow): { base: bigint; n: bigint } {
    if (order.booked_base_fen === null || order.booked_n_fen === null) {
      throw new Error('settlement clawback: CREDITED order without booked pair');
    }
    return { base: order.booked_base_fen, n: order.booked_n_fen };
  }

  /** BR-FUND-08 ③ (S12): no voucher, no rebate transition; rights → WAIT_COMMISSION; pending. */
  async function waitCommission(
    trx: Transaction<DB>,
    command: ClawbackCommand,
    order: OrderRow,
    key: string,
    rightsEventId: string,
  ): Promise<ClawbackResult> {
    const now = clock.now();
    const rightsId = command.ref.kind === 'rights' ? command.ref.orderRightsId : null;
    await markRightsWaitCommission(trx, order.app_id, order.order_id, rightsId, now);
    const pending = await computeRightsPending(trx, order.app_id, order.order_id);
    if (pending !== order.rights_pending) {
      const ok = await casRightsPending(trx, order, pending, now);
      if (!ok) throw new Error('settlement clawback: rights_pending CAS matched no row');
    }
    await deps.pending.open(trx, {
      appId: order.app_id,
      orderId: order.order_id,
      platform: order.platform,
      subOrderId: order.sub_order_id,
      reason: 'CLAWBACK_NO_COMMISSION',
      detail: `cause=${command.cause};rights_event_id=${rightsEventId}`,
    });
    logger.warn(
      {
        alert: ALERT_WAIT,
        app_id: order.app_id,
        order_id: order.order_id,
        order_key: key,
        rights_event_id: rightsEventId,
      },
      'clawback waits for the union commission (no new commission, no deduction)',
    );
    return { outcome: 'wait_commission', orderKey: key, rightsEventId };
  }

  function beneficiariesOf(
    snapshot: CreditSnapshot,
    states: ReadonlyMap<string, CreditBeneficiaryState>,
    nets: ReadonlyMap<string, bigint>,
    obligations: ReadonlyMap<string, BeneficiaryCreditRow>,
  ): AdjustmentBeneficiary[] {
    return snapshot.beneficiaries.map((b) => {
      const id = identity(b.userId, b.role);
      const obligation = obligations.get(id) ?? null;
      const current = states.get(b.userId) ?? MISSING_USER;
      let status: AdjustmentBeneficiary['status'] = 'active';
      // D10-481 ②: the one judgement of a forfeited share.
      if (isForfeitedShare(b, snapshot.forfeitedEvents)) status = 'forfeited';
      else if (obligation !== null && obligation.kind !== 'deferred') status = 'held';
      return {
        user_id: b.userId,
        role: b.role,
        ratio_bp: BigInt(b.ratioBp),
        status,
        risk_state: current.risk_state,
        deletion_status: current.deletion_status,
        is_minor: current.is_minor,
        net_fen: nets.get(id) ?? 0n,
        obligation:
          obligation === null
            ? null
            : {
                beneficiary_credit_id: obligation.beneficiary_credit_id,
                kind: obligation.kind as 'first_credit' | 'reassign_credit' | 'deferred',
              },
      };
    });
  }

  function postingOf(
    appId: string,
    key: string,
    built: BuiltVoucher,
    beneficiary: { readonly userId: string; readonly role: CreditRole } | null,
    accounts: ReadonlyMap<string, string>,
    kind: 'CLAWBACK' | 'SETTLE_ADJUST' = 'CLAWBACK',
  ): PostingVoucher {
    const entries: PostingEntry[] = built.entries.map((entry) => {
      if (entry.account.owner_type === 'user') {
        const accountId = accounts.get(entry.account.owner_id);
        if (accountId === undefined) {
          throw new Error('settlement clawback: a clawed-back beneficiary has no locked balance');
        }
        return {
          account: { ownerType: 'user', accountId },
          sub_account: entry.sub_account ?? 'available',
          amount_fen: entry.amount_fen,
          ledger_type: entry.ledger_type,
          sub_type: entry.sub_type,
          income_type: null,
        };
      }
      return {
        account: { ownerType: 'platform', subject: entry.account.subject },
        sub_account: entry.sub_account ?? 'available',
        amount_fen: entry.amount_fen,
        ledger_type: entry.ledger_type,
        sub_type: entry.sub_type,
        income_type: null,
      };
    });
    return {
      appId,
      uniqKey: built.uniq_key,
      bizType: kind === 'CLAWBACK' ? BIZ_TYPE : ADJUST_BIZ_TYPE,
      bizId: key,
      operator: OPERATOR,
      memo: null,
      orderKey: key,
      beneficiaryUserId: beneficiary?.userId ?? null,
      role: beneficiary?.role ?? null,
      voucherKind: kind,
      entries,
    };
  }

  async function postVouchers(
    trx: Transaction<DB>,
    order: OrderRow,
    key: string,
    rightsEventId: string,
    subType: SubType,
    plan: AdjustmentPlan,
    accounts: ReadonlyMap<string, string>,
  ): Promise<void> {
    const base = { order_key: key, platform: order.platform, rights_event_id: rightsEventId };
    for (const b of plan.beneficiaries) {
      if (b.delta_fen === 0n) continue;
      if (b.delta_fen > 0n) {
        // A clawback never pays out (BR-CALC-09: positive differences are deferred or forfeited).
        throw new Error('settlement clawback: positive beneficiary delta in a clawback');
      }
      const template = `CLAWBACK:${subType}:${b.posting === 'bad_debt' ? 'BAD_DEBT' : 'USER'}`;
      const params: BuildVoucherParams = {
        ...base,
        user_id: b.user_id,
        role: b.role,
        clawback_fen: subFen(0n, b.delta_fen),
      };
      const beneficiary = { userId: b.user_id, role: b.role as CreditRole };
      for (const built of buildVouchers(template, params)) {
        await ledger.post(trx, postingOf(order.app_id, key, built, beneficiary, accounts));
      }
    }
    const delta = plan.platform_delta_fen;
    if (delta !== 0n) {
      // platform_delta_fen = new − old: < 0 → DECREASE (debit COMMISSION_REVENUE), > 0 → INCREASE.
      const template = `CLAWBACK:${subType}:PLATFORM:${delta < 0n ? 'DECREASE' : 'INCREASE'}`;
      const params: BuildVoucherParams = {
        ...base,
        clawback_fen: delta < 0n ? subFen(0n, delta) : delta,
      };
      for (const built of buildVouchers(template, params)) {
        await ledger.post(trx, postingOf(order.app_id, key, built, null, accounts));
      }
    }
  }

  async function settleObligations(
    trx: Transaction<DB>,
    order: OrderRow,
    transition: 'R8' | 'R9',
    rightsEventId: string,
    rows: readonly AdjustmentBeneficiaryResult[],
    obligations: ReadonlyMap<string, BeneficiaryCreditRow>,
    now: Date,
  ): Promise<void> {
    for (const b of rows) {
      const action = b.obligation_action;
      if (action === null || action === 'keep') continue;
      if (action !== 'voided' && action !== 'forfeited') {
        // 'open' / 'done' never arise on the clawback path; refuse instead of guessing.
        throw new Error(`settlement clawback: unexpected obligation action ${action}`);
      }
      const row = obligations.get(identity(b.user_id, b.role));
      if (row === undefined) throw new Error('settlement clawback: obligation not found');
      const step = transitionBeneficiaryCredit('open', action === 'voided' ? 'VOID' : 'FORFEIT');
      if (!step.ok || step.noop || step.to !== action) {
        throw new Error('settlement clawback: illegal obligation transition');
      }
      const closed = await closeObligation(trx, {
        app_id: order.app_id,
        beneficiary_credit_id: row.beneficiary_credit_id,
        row_version: row.row_version,
        status: action,
        closed_by: transition,
        closed_ref: rightsEventId,
        closed_at: now,
      });
      if (!closed) throw new Error('settlement clawback: obligation CAS matched no row');
      if (b.append_forfeited_event) {
        await deps.appendBeneficiaryEvent(trx, {
          appId: order.app_id,
          orderId: order.order_id,
          userId: b.user_id,
          role: b.role as CreditRole,
          status: 'forfeited',
          reason: b.forfeit_reason,
        });
      }
    }
  }

  async function voidCandidates(trx: Transaction<DB>, order: OrderRow, now: Date): Promise<void> {
    const step = transitionSettleAdjustment('pending', 'VOID_BY_CLAWBACK');
    if (!step.ok || step.to !== 'voided_by_clawback') {
      throw new Error('settlement clawback: illegal candidate transition');
    }
    await voidPendingCandidates(trx, order.app_id, order.order_id, now);
  }

  /** BR-FUND-08: jd's actual commission > 0 → 0, held for manual review (D10-313). */
  async function registerJdReview(
    trx: Transaction<DB>,
    order: OrderRow,
    key: string,
    rightsEventId: string,
    bookedN: bigint,
    nPositive: bigint,
  ): Promise<void> {
    const refId = `${key}#COMMISSION_ZERO#${rightsEventId}`;
    await registerReconDiff(
      trx,
      {
        appId: order.app_id,
        type: 'union_mismatch',
        source: 'R1',
        period: chinaMonth(clock.now()),
        refType: 'order',
        refId,
        expectedFen: bookedN,
        actualFen: nPositive,
        diffFen: subFen(nPositive, bookedN),
        dedupeKey: `union_mismatch:COMMISSION_ZERO:${key}:${rightsEventId}`,
        resolution: {
          reason_code: 'COMMISSION_ZERO',
          order_key: key,
          rights_event_id: rightsEventId,
        },
      },
      { clock },
    );
    logger.warn(
      {
        alert: ALERT_JD_ZERO,
        app_id: order.app_id,
        order_id: order.order_id,
        order_key: key,
        rights_event_id: rightsEventId,
      },
      'jd commission went to zero after credit: clawed back in full, recon diff for review',
    );
  }

  /** Step 11: WAIT_COMMISSION rows → SUCCEEDED, rights_pending, CLAWBACK_NO_COMMISSION pending. */
  async function closeAnsweredRights(
    trx: Transaction<DB>,
    ref: ClawbackEventRef,
    order: OrderRow,
    now: Date,
  ): Promise<void> {
    const rightsId = ref.kind === 'rights' ? ref.orderRightsId : null;
    await closeWaitingRights(trx, order.app_id, order.order_id, rightsId, now);
    const pending = await computeRightsPending(trx, order.app_id, order.order_id);
    const fresh = await readRebateOrder(trx, {
      appId: order.app_id,
      orderId: order.order_id,
      attrAt: order.attr_at,
    });
    if (fresh === undefined) throw new Error('settlement clawback: order not found for app');
    if (pending !== fresh.rights_pending) {
      const ok = await casRightsPending(trx, fresh, pending, now);
      if (!ok) throw new Error('settlement clawback: rights_pending CAS matched no row');
    }
    if (!(await hasWaitingRights(trx, order.app_id, order.order_id))) {
      const target: ClawbackPendingResolveInput = {
        appId: order.app_id,
        platform: order.platform,
        subOrderId: order.sub_order_id,
        at: now,
      };
      if (deps.pending.resolve !== undefined) await deps.pending.resolve(trx, target);
      else await resolveClawbackNoCommissionPending(trx, target);
    }
  }

  async function apply(trx: Transaction<DB>, command: ClawbackCommand): Promise<ClawbackResult> {
    checkCommand(command);
    const { appId, orderId, cause } = command;
    const rules = rulesOf(cause);

    // 1. lock, re-read.
    const { order, key } = await lockAndRead(trx, appId, orderId);
    if (order.rebate_status !== FROM_STATUS) return { outcome: 'skipped', reason: 'not_credited' };
    const booked = bookedOf(order);

    // 2. rights_event_id.
    const rightsEventId = rightsEventIdOf(command.ref, order);

    // 3. N_new (BR-FUND-08 ① ② ③; full causes → 0).
    const selected = selectClawbackCommission({
      full_invalid: FULL_CAUSES.includes(cause),
      booked_n_fen: booked.n,
      settle_commission_fen: null,
      settlement_seq_changed: false,
      est_commission_fen: command.newCommissionFen,
      estimate_changed: command.newCommissionFen !== null,
      rights_deduct_fen: command.rightsDeductFen,
      adapter_estimate_fen: null,
    });
    if (selected.kind === 'wait_commission') {
      return waitCommission(trx, command, order, key, rightsEventId);
    }
    const nNew = selected.n_new_fen;
    const nPositive = positive(nNew);

    const snapshot = await readSnapshotOf(trx, order);
    const reserveBp = BigInt(snapshot.reserveBp);

    // 4. COMMISSION is a reverse event only when it is R8.
    if (cause === 'COMMISSION') {
      const { after_reserve_fen: baseNew } = applyReserve(nNew, reserveBp);
      const r8 = nPositive === 0n || (booked.base > 0n && baseNew === 0n);
      if (!r8) return { outcome: 'skipped', reason: 'not_reverse' };
    }

    // 5. users rows → balance rows → states after the locks; nets; plan.
    const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
    const locked =
      userIds.length === 0 ? new Set<string>() : await gate.lockUsers(trx, { appId, userIds });
    const present = userIds.filter((id) => locked.has(id));
    for (const userId of present) {
      await ledger.openUserAccount(trx, { appId, userId });
    }
    const balances =
      present.length === 0 ? [] : await ledger.lockBalances(trx, { appId, userIds: present });
    const accounts = new Map(balances.map((row) => [row.user_id, row.account_id]));
    const states =
      present.length === 0
        ? new Map<string, CreditBeneficiaryState>()
        : await gate.readStates(trx, { appId, userIds: present });

    const stored = await getOrderNets(trx, { appId, orderKey: key });
    const nets = new Map(
      stored.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
    );
    const obligations = new Map(
      (await readOpenObligations(trx, appId, orderId)).map((r) => [identity(r.user_id, r.role), r]),
    );
    const plan = planCommissionAdjustment({
      event: 'clawback',
      n_new_fen: nNew,
      reserve_bp: reserveBp,
      booked_base_fen: booked.base,
      booked_n_fen: booked.n,
      platform_net_fen: stored.platform_net_fen,
      beneficiaries: beneficiariesOf(snapshot, states, nets, obligations),
    });
    const now = clock.now();

    if (plan.transition === null) {
      // Nothing to write (e.g. a replayed R9); the clawback still voids pending candidates.
      if (plan.void_pending_candidates) await voidCandidates(trx, order, now);
      return { outcome: 'no_change', orderKey: key, rightsEventId };
    }
    if (plan.transition !== 'R8' && plan.transition !== 'R9') {
      throw new Error(`settlement clawback: unexpected plan transition ${plan.transition}`);
    }
    const transition = plan.transition;
    let event: OrderRebateEvent;
    let subType: SubType;
    if (transition === 'R8') {
      event = rules.r8Event(nPositive);
      subType = rules.r8SubType;
    } else {
      if (rules.r9Event === null || rules.r9SubType === null) {
        throw new Error(`settlement clawback: ${cause} cannot be R9`);
      }
      event = rules.r9Event;
      subType = rules.r9SubType;
    }
    const step = transitionOrderRebate(FROM_STATUS, event);
    if (!step.ok || step.id !== transition || step.to !== plan.rebate_status) {
      throw new Error(`settlement clawback: ${event} is not a legal ${transition}`);
    }

    // 6. vouchers (a stored uniq_key is a duplicate, never a second clawback).
    await postVouchers(trx, order, key, rightsEventId, subType, plan, accounts);

    // 7. obligations; 8. candidates.
    await settleObligations(
      trx,
      order,
      transition,
      rightsEventId,
      plan.beneficiaries,
      obligations,
      now,
    );
    if (plan.void_pending_candidates) await voidCandidates(trx, order, now);

    // 9. booked pair + rebate_status in one CAS, then history.
    const written = await casClawbackOrder(trx, order, {
      to: step.to,
      booked_base_fen: plan.booked_after.booked_base_fen,
      booked_n_fen: plan.booked_after.booked_n_fen,
      ...(transition === 'R8' ? { reason: rules.r8Reason } : { diff_reason_code: 'PART_REFUND' }),
      at: now,
    });
    if (!written) throw new Error('settlement clawback: order CAS matched no row');
    await insertRebateHistory(
      trx,
      { app_id: appId, order_id: orderId },
      [{ from: FROM_STATUS, event, to: step.to }],
      'system',
      now,
    );

    if (
      transition === 'R8' &&
      order.platform === 'jd' &&
      (cause === 'COMMISSION' || cause === 'PARTIAL_REFUND') &&
      nPositive === 0n &&
      booked.n > 0n
    ) {
      await registerJdReview(trx, order, key, rightsEventId, booked.n, nPositive);
    }

    // 11. close the WAIT_COMMISSION rights rows this event answers (BR-FUND-06), same transaction.
    await closeAnsweredRights(trx, command.ref, order, now);

    // 10. order.clawed_back on the same transaction, R8 and R9 (D10-467 ② / D10-474 ③): the order
    // key and each beneficiary's clawback in integer fen as a decimal string (payload 暂定, identity
    // B1-12s to confirm). A beneficiary whose clawback went to BAD_DEBT is not listed.
    await events.publish(trx, {
      appId,
      name: 'order.clawed_back',
      payload: {
        order_id: orderId,
        order_key: key,
        rights_event_id: rightsEventId,
        transition,
        ...(transition === 'R8' ? { reason: rules.r8Reason } : {}),
        beneficiaries: plan.beneficiaries
          .filter((b) => b.delta_fen < 0n && b.posting === 'user_available')
          .map((b) => ({
            user_id: b.user_id,
            role: b.role,
            clawback_fen: String(subFen(0n, b.delta_fen)),
          })),
      },
    });
    logger.info(
      {
        app_id: appId,
        order_id: orderId,
        transition,
        rights_event_id: rightsEventId,
        booked_base_fen: String(plan.booked_after.booked_base_fen),
      },
      'order clawed back',
    );
    return {
      outcome: 'clawed_back',
      transition,
      orderKey: key,
      rightsEventId,
      bookedBaseFen: plan.booked_after.booked_base_fen,
      bookedNFen: plan.booked_after.booked_n_fen,
    };
  }

  /** R9b: archive only; one recon diff per sub-order and estimate value behind the switch. */
  async function archiveEstimate(
    trx: Transaction<DB>,
    order: OrderRow,
    key: string,
    estimate: bigint | null,
  ): Promise<ClawbackResult> {
    const booked = bookedOf(order);
    if (estimate === null)
      return { outcome: 'estimate_archived', orderKey: key, reconDiff: 'none' };
    const snapshot = await readSnapshotOf(trx, order);
    const { after_reserve_fen: base } = applyReserve(estimate, BigInt(snapshot.reserveBp));
    if (base === booked.base) {
      return { outcome: 'estimate_archived', orderKey: key, reconDiff: 'none' };
    }
    if (switchedOff(await deps.config.get(order.app_id, DIFF_SWITCH))) {
      return { outcome: 'estimate_archived', orderKey: key, reconDiff: 'disabled' };
    }
    const refId = `${key}#EST#${String(estimate)}`;
    await registerReconDiff(
      trx,
      {
        appId: order.app_id,
        type: 'estimate_changed_after_credit',
        source: 'R1',
        period: chinaMonth(clock.now()),
        refType: 'order',
        refId,
        expectedFen: booked.base,
        actualFen: base,
        diffFen: subFen(base, booked.base),
        dedupeKey: `estimate_changed_after_credit:${key}:${String(estimate)}`,
        resolution: null,
      },
      { clock },
    );
    logger.warn(
      {
        alert: ALERT_ESTIMATE,
        app_id: order.app_id,
        order_id: order.order_id,
        order_key: key,
        expected_fen: String(booked.base),
        actual_fen: String(base),
      },
      'estimated commission changed after credit (R9b): recon diff registered',
    );
    return { outcome: 'estimate_archived', orderKey: key, reconDiff: 'registered' };
  }

  /**
   * B2-04lb (D10-474 ②; BR-FUND-06「等联盟回传新佣金后按 R7/R9 处理并关闭」, BR-FUND-08「联盟新的结算记录
   * 带来的变化按 BR-FUND-09 与迁移 R10 处理」, BR-CALC-23 (a)): on a CREDITED order whose rights success
   * waits for the union (WAIT_COMMISSION), the union's new settlement record moves the money as R10
   * SETTLE_ADJUST (sub_type SETTLE_DIFF, keys `…:ADJ:{seq}`) and, on the same transaction, closes the
   * WAIT_COMMISSION rows, recomputes rights_pending and resolves the CLAWBACK_NO_COMMISSION pending
   * rows. R8 (new commission's positive part 0, or base > 0 → 0) goes through apply (cause
   * COMMISSION). Only the immediate route is written here: a positive difference (BR-FUND-09 ②
   * candidate) or an obligation to open / close leaves the rows waiting with an alert.
   */
  async function settleAnswer(
    trx: Transaction<DB>,
    order: OrderRow,
    key: string,
    settleFen: bigint,
  ): Promise<ClawbackResult> {
    const { app_id: appId, order_id: orderId } = order;
    const booked = bookedOf(order);
    const snapshot = await readSnapshotOf(trx, order);
    const reserveBp = BigInt(snapshot.reserveBp);
    const nPositive = positive(settleFen);
    const { after_reserve_fen: baseNew } = applyReserve(settleFen, reserveBp);
    if (nPositive === 0n || (booked.base > 0n && baseNew === 0n)) {
      return apply(trx, {
        appId,
        orderId,
        cause: 'COMMISSION',
        ref: { kind: 'commission' },
        newCommissionFen: settleFen,
        rightsDeductFen: null,
      });
    }
    const seq = await readLatestSettleSeq(trx, appId, orderId);
    if (seq === null) throw new Error('settlement clawback: settlement record vanished');
    const rightsEventId = `S${String(seq)}`;

    const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
    const locked =
      userIds.length === 0 ? new Set<string>() : await gate.lockUsers(trx, { appId, userIds });
    const present = userIds.filter((id) => locked.has(id));
    for (const userId of present) {
      await ledger.openUserAccount(trx, { appId, userId });
    }
    const balances =
      present.length === 0 ? [] : await ledger.lockBalances(trx, { appId, userIds: present });
    const accounts = new Map(balances.map((row) => [row.user_id, row.account_id]));
    const states =
      present.length === 0
        ? new Map<string, CreditBeneficiaryState>()
        : await gate.readStates(trx, { appId, userIds: present });
    const stored = await getOrderNets(trx, { appId, orderKey: key });
    const nets = new Map(
      stored.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
    );
    const obligations = new Map(
      (await readOpenObligations(trx, appId, orderId)).map((r) => [identity(r.user_id, r.role), r]),
    );
    const plan = planCommissionAdjustment({
      event: 'settlement',
      n_new_fen: settleFen,
      reserve_bp: reserveBp,
      booked_base_fen: booked.base,
      booked_n_fen: booked.n,
      platform_net_fen: stored.platform_net_fen,
      beneficiaries: beneficiariesOf(snapshot, states, nets, obligations),
    });
    const now = clock.now();
    const unsupported =
      plan.route === 'approval' ||
      (plan.transition !== null && plan.transition !== 'R10') ||
      plan.beneficiaries.some(
        (b) =>
          b.delta_fen > 0n ||
          b.forfeit_fen !== 0n ||
          b.pending_after_fen !== b.pending_before_fen ||
          (b.obligation_action !== null && b.obligation_action !== 'keep'),
      );
    if (unsupported) {
      // TODO(规划/11 §4.2): 入账后维权等待中的正差候选与义务处置 — blocked on BR-FUND-09 ② 候选写入（D10-474 ② 只裁定负差 R10）
      logger.warn(
        {
          alert: ALERT_ADJUST_HELD,
          app_id: appId,
          order_id: orderId,
          order_key: key,
          rights_event_id: rightsEventId,
        },
        'settlement record answering a waiting rights record needs a candidate; left waiting',
      );
      return { outcome: 'wait_commission', orderKey: key, rightsEventId };
    }
    if (plan.transition === null) {
      await closeAnsweredRights(trx, { kind: 'commission' }, order, now);
      return { outcome: 'no_change', orderKey: key, rightsEventId };
    }
    const step = transitionOrderRebate(FROM_STATUS, 'SETTLE_NEGATIVE_DIFF');
    if (!step.ok || step.id !== 'R10' || step.to !== FROM_STATUS) {
      throw new Error('settlement clawback: SETTLE_NEGATIVE_DIFF is not a legal R10');
    }

    const base = { order_key: key, platform: order.platform, seq: String(seq) };
    for (const b of plan.beneficiaries) {
      if (b.delta_fen === 0n) continue;
      const template = `SETTLE_ADJUST:SETTLE_DIFF:${b.posting === 'bad_debt' ? 'BAD_DEBT' : 'USER:DECREASE'}`;
      const params: BuildVoucherParams = {
        ...base,
        user_id: b.user_id,
        role: b.role,
        adjust_fen: subFen(0n, b.delta_fen),
      };
      const beneficiary = { userId: b.user_id, role: b.role as CreditRole };
      for (const built of buildVouchers(template, params)) {
        await ledger.post(
          trx,
          postingOf(appId, key, built, beneficiary, accounts, 'SETTLE_ADJUST'),
        );
      }
    }
    const delta = plan.platform_delta_fen;
    if (delta !== 0n) {
      const template = `SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:${delta < 0n ? 'DECREASE' : 'INCREASE'}`;
      const params: BuildVoucherParams = {
        ...base,
        adjust_fen: delta < 0n ? subFen(0n, delta) : delta,
      };
      for (const built of buildVouchers(template, params)) {
        await ledger.post(trx, postingOf(appId, key, built, null, accounts, 'SETTLE_ADJUST'));
      }
    }

    const written = await casClawbackOrder(trx, order, {
      to: step.to,
      booked_base_fen: plan.booked_after.booked_base_fen,
      booked_n_fen: plan.booked_after.booked_n_fen,
      at: now,
    });
    if (!written) throw new Error('settlement clawback: order CAS matched no row');
    await insertRebateHistory(
      trx,
      { app_id: appId, order_id: orderId },
      [{ from: FROM_STATUS, event: 'SETTLE_NEGATIVE_DIFF', to: step.to }],
      'system',
      now,
    );
    await closeAnsweredRights(trx, { kind: 'commission' }, order, now);
    logger.info(
      {
        app_id: appId,
        order_id: orderId,
        transition: 'R10',
        rights_event_id: rightsEventId,
        booked_base_fen: String(plan.booked_after.booked_base_fen),
      },
      'waiting rights answered by a new settlement record (R10)',
    );
    return {
      outcome: 'settle_adjusted',
      transition: 'R10',
      orderKey: key,
      rightsEventId,
      bookedBaseFen: plan.booked_after.booked_base_fen,
      bookedNFen: plan.booked_after.booked_n_fen,
    };
  }

  async function onUpdated(
    trx: Transaction<DB>,
    change: OrderUpdateChange,
    source: OrderStatusSource,
  ): Promise<ClawbackResult> {
    const appId = text(change.app_id, 'change.app_id');
    const orderId = text(change.order_id, 'change.order_id');
    const { order, key } = await lockAndRead(trx, appId, orderId);
    if (order.rebate_status !== FROM_STATUS) return { outcome: 'skipped', reason: 'not_credited' };
    const base = { appId, orderId, newCommissionFen: null, rightsDeductFen: null } as const;

    if (source.event === 'PLATFORM_INVALID' || change.to_status === 'INVALID') {
      return apply(trx, {
        ...base,
        cause: change.from_status === 'SETTLED' ? 'INVALID_AFTER_SETTLE' : 'PLATFORM_INVALID',
        ref: { kind: 'platform' },
      });
    }
    if (source.event === 'PLATFORM_PUNISH') {
      return apply(trx, { ...base, cause: 'PUNISH', ref: { kind: 'platform' } });
    }
    if (source.event === 'PLATFORM_RIGHTS') {
      // The rights success entry is rights.record (B2-04l): this status signal has no record.
      return { outcome: 'skipped', reason: 'not_reverse' };
    }

    // B2-04lb (D10-474 ②): a new settlement record answering a WAIT_COMMISSION rights record.
    // B2-04zp (BR-FUND-09): only the record that decides the amount answers it. A later API record
    // beside a STATEMENT leaves orders.settle_commission_fen where it was: the union's new commission
    // has not arrived, so a rights record received after that STATEMENT keeps waiting.
    if (change.settle_commission_fen !== null && order.settle_commission_fen !== null) {
      const recordAt = await settlements.latestDecidingRecordAt(trx, { appId, orderId });
      if (recordAt !== null && (await hasWaitingRightsBefore(trx, appId, orderId, recordAt))) {
        return settleAnswer(trx, order, key, order.settle_commission_fen);
      }
    }

    const estChanged = change.est_after !== change.est_before;
    const refundIncreased =
      (order.refunded_quantity ?? 0) > (order.refunded_quantity_at_credit ?? 0);
    const settled = change.settle_commission_fen !== null;
    const r9 = refundIncreased || (estChanged && (await hasOrderRights(trx, appId, orderId)));
    if (r9) {
      // BR-FUND-01「R9 与 R9b 的判定」: never R9b. With a settlement record only a new seq is ①
      // (left to R10), so the estimate does not count and N_new comes from ② or ③.
      return apply(trx, {
        ...base,
        cause: 'PARTIAL_REFUND',
        ref: { kind: 'commission' },
        newCommissionFen: settled ? null : change.est_after,
      });
    }
    if (!estChanged) return { outcome: 'skipped', reason: 'not_reverse' };
    if (!settled) {
      if (change.est_after === null) return { outcome: 'skipped', reason: 'not_reverse' };
      // No settlement record: the estimate is the effective commission (①); only R8 is reverse.
      return apply(trx, {
        ...base,
        cause: 'COMMISSION',
        ref: { kind: 'commission' },
        newCommissionFen: change.est_after,
      });
    }
    return archiveEstimate(trx, order, key, change.est_after);
  }

  return Object.freeze({ apply, onUpdated });
}
