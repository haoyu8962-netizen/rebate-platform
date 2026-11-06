// B2-04l: settlement's rights command — orders' RightsCommandPort.record (B1-09c), the only writer
// of order_rights and orders.rights_pending (BR-FUND-01). Rule tests: test/spec/settlement/rights/**.
//
// record(trx, input): on the caller's transaction (never opens, commits or rolls one back); the
// caller already holds orders' lockOrderKey for the sub-order and re-read `before` FOR UPDATE. In
// order (decide before writing, BR-FUND-01):
//   1. platform_status of the order outside {PAID, RECEIVED, SETTLED} (the from-states of P7 / P8)
//      → { kind: 'not_applicable' }, nothing written.
//   2. K-2 key (app_id, order_id, type, platform_rights_no), NULLS NOT DISTINCT:
//      - no stored row → insert one (source, type, status, amount_fen, deduction_commission_fen,
//        occurred_at, platform_rights_no as given; created_at = updated_at = input.now) → applied;
//      - a stored PROCESSING row and an incoming SUCCEEDED / FAILED, or a stored WAIT_COMMISSION
//        row and an incoming SUCCEEDED that carries deduction_commission_fen → the result of that
//        same record (BR-FUND-06「维权结果」): the row is updated in place (same id; status,
//        amounts, row_version + 1, updated_at = input.now) → applied;
//      - D10-699 (B1-04zza money r1 S0): a stored FAILED row of source API and an incoming API
//        record whose stored status is SUCCEEDED (the union reports success after the record was
//        closed without charging us, e.g. Taobao refund_status 14 / 15 then 12 / 13) → the same
//        in-place result as above (applied), plus one system audit row and one alert, reason
//        union_reported_success_after_closed;
//      - anything else on a stored key (a replay, a closed SUCCEEDED row, an ADMIN / IMPORT FAILED
//        row, FAILED → PROCESSING / WAIT_COMMISSION, FAILED again) → duplicate, nothing written,
//        never a second clawback.
//      (In-place result kept as reported to the orchestrator; BR-FUND-06 needs it for platforms
//      that report PROCESSING first.)
//   3. by the row's status after step 2:
//      - PROCESSING: nothing more (BR-FUND-06: blocks crediting through rights_pending only);
//      - FAILED: record closed, amounts unchanged;
//      - SUCCEEDED, rebate_status UNATTRIBUTED / ESTIMATED / WAITING (BR-FUND-07, R6 / R7 through
//        the generated transition()): PUNISH → R6 PUNISH (VOID, reason PUNISH);
//        INVALID_AFTER_SETTLE / REFUND_AFTER_SETTLE → R6 PLATFORM_INVALID (VOID, reason REFUND);
//        RIGHTS: N_new = effective union commission (BR-CALC-02: settle_commission_fen, else
//        est_commission_fen) − deduction_commission_fen; positive part 0 → R6 RIGHTS_FULL (VOID,
//        reason RIGHTS); otherwise R7 RIGHTS_PARTIAL (status unchanged; R7 is not from
//        UNATTRIBUTED); no deduction → the row becomes WAIT_COMMISSION, status unchanged
//        (BR-FUND-06 例「部分成功、佣金未更新」). VOID publishes order.invalidated on the same
//        transaction; never a voucher;
//      - SUCCEEDED, rebate_status CREDITED: the clawback's rights success entry (BR-FUND-08, same
//        rules as B2-04s): cause by type (RIGHTS → RIGHTS, PUNISH → PUNISH, INVALID_AFTER_SETTLE,
//        REFUND_AFTER_SETTLE), rights_event_id `R{order_rights.id}`, N_new ② = booked_n_fen −
//        deduction_commission_fen (below 0 → 0); no deduction → ③ WAIT_COMMISSION (row
//        WAIT_COMMISSION, order_sync_pending CLAWBACK_NO_COMMISSION, alert). Lock order as B2-04m /
//        B2-04s: order_key advisory lock → identity users rows → ledger.lockBalances;
//      - SUCCEEDED, rebate_status VOID / CLAWED_BACK: recorded only (terminal; BR-FUND-01 细则
//        「订单锁定」: order_rights are still recorded); status, booked pair and ledger unchanged.
//   4. orders.rights_pending recomputed in the same transaction (some row of the order PROCESSING
//      or WAIT_COMMISSION) and written with a CAS (row_version + 1, updated_at = input.now) only
//      when it changes.
// BR-FUND-06 is 待验证 (which platforms send a「处理中」signal): no platform signal is invented
// here; a platform without one only reaches record with the result.
// Time only from input.now / the injected Clock; amounts only through @couli/money.
import type { DB } from '@couli/db';
import { subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import type {
  RightsCommandPort,
  RightsRecordInput,
  RightsRecordResult,
} from '../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import type { ClawbackCause, ClawbackOrder } from '../clawback/index.ts';
import { computeRightsPending, casRightsPending } from '../clawback/clawback-store.ts';
import type { PrecreditEvent, RebatePort } from '../rebate/application/rebate.ts';
import { isPrecredit } from '../rebate/domain/rules.ts';
import { readRebateOrder } from '../rebate/infra/rebate-store.ts';
import {
  findRights,
  insertRights,
  insertSystemAudit,
  readOpenDeductionTotal,
  updateRightsResult,
  type OrderRightsRow,
  type RightsSystemAuditInput,
} from './rights-store.ts';

/** D10-699: the reason (audit and alert) of a closed API record the union later reports successful. */
export const RIGHTS_SUCCESS_AFTER_CLOSED = 'union_reported_success_after_closed';
/** The audit action of that change (target order_rights:<id>). */
export const RIGHTS_REOPEN_AUDIT_ACTION = 'order_rights_success_after_closed';
/**
 * The system identity of the audit row. contracts/enums/admin.yaml audit_system_actor has no
 * order-sync value yet; system:risk is the existing value the row is stored under.
 * TODO(规划/11 §7.1): a dedicated order-sync system actor — blocked on the contract enum.
 */
const RIGHTS_AUDIT_ACTOR = 'system:risk';

/** admin's system audit on the caller's transaction, by shape (settlement imports no admin code). */
export interface RightsSystemAudit {
  appendAction(trx: Transaction<DB>, input: RightsSystemAuditInput): Promise<void>;
}

export interface RightsCommandDependencies {
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly events: Pick<EventBus, 'publish'>;
  /** B2-04s clawback orchestration; its rights success entry handles CREDITED orders. */
  readonly clawback: ClawbackOrder;
  /** B2-04j rebate port: R6 / R7 commands before credit (apply). */
  readonly rebate: Pick<RebatePort, 'apply'>;
  /**
   * D10-699: the system audit of a closed API record reopened as successful (production: admin's
   * createSystemAuditWriter). Absent, the row is inserted on the same transaction by this module's
   * store with the same columns (system actor, admin_id null, at from the injected Clock).
   */
  readonly audit?: RightsSystemAudit;
}

type StoredStatus = 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED';

/** P7 / P8 from-states: only these platform states take a rights record. */
function acceptsRights(platformStatus: string): boolean {
  return platformStatus === 'PAID' || platformStatus === 'RECEIVED' || platformStatus === 'SETTLED';
}

function isTerminal(rebateStatus: string): boolean {
  return rebateStatus === 'VOID' || rebateStatus === 'CLAWED_BACK';
}

/**
 * The status the record is stored with. A successful partial rights result without the deduction
 * (BR-FUND-06 例「部分成功、佣金未更新」, BR-FUND-08 ③) waits for the union: WAIT_COMMISSION,
 * except on a terminal order, where it is only recorded.
 */
function storedStatusOf(input: RightsRecordInput): StoredStatus {
  if (input.status === 'PROCESSING' || input.status === 'FAILED') return input.status;
  if (
    input.type === 'RIGHTS' &&
    input.deduction_commission_fen === null &&
    !isTerminal(input.before.rebate_status)
  ) {
    // Before credit the rebate port's sync hook closes it once the union's new commission arrives
    // (B2-04lb); after credit the clawback does.
    return 'WAIT_COMMISSION';
  }
  return 'SUCCEEDED';
}

function checkInput(input: RightsRecordInput): void {
  const fen = input.deduction_commission_fen;
  if (fen !== null && (typeof fen !== 'bigint' || fen < 0n)) {
    throw new TypeError('settlement rights: deduction_commission_fen must be a nonnegative bigint');
  }
  if (input.before.order_id !== input.order_id) {
    throw new TypeError('settlement rights: before row does not match order_id');
  }
}

/** The clawback cause of a successful record on a CREDITED order (BR-FUND-08 sub_type table). */
function causeOf(type: RightsRecordInput['type']): ClawbackCause {
  switch (type) {
    case 'RIGHTS':
      return 'RIGHTS';
    case 'PUNISH':
      return 'PUNISH';
    case 'INVALID_AFTER_SETTLE':
      return 'INVALID_AFTER_SETTLE';
    case 'REFUND_AFTER_SETTLE':
      return 'REFUND_AFTER_SETTLE';
    default:
      throw new TypeError('settlement rights: unknown order_rights type');
  }
}

/**
 * D10-699: the only transition out of a closed record — stored FAILED from the union (source API),
 * the union now reporting success (an API record stored as SUCCEEDED, i.e. with its deduction).
 */
function reopensAsSucceeded(
  stored: OrderRightsRow,
  input: RightsRecordInput,
  status: StoredStatus,
): boolean {
  return (
    stored.status === 'FAILED' &&
    stored.source === 'API' &&
    input.source === 'API' &&
    status === 'SUCCEEDED'
  );
}

export function createRightsCommandPort(deps: RightsCommandDependencies): RightsCommandPort {
  const { logger, clawback, rebate, clock } = deps;
  const audit: RightsSystemAudit = deps.audit ?? {
    appendAction: (trx, input) => insertSystemAudit(trx, input, clock.now()),
  };

  /** BR-FUND-06 / 07 before credit: R6 / R7 through the rebate port (generated transition()). */
  async function precredit(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    status: StoredStatus,
  ): Promise<void> {
    if (status !== 'SUCCEEDED') return;
    const order = input.before;
    const ref = { appId: order.app_id, orderId: order.order_id, attrAt: order.attr_at };
    const unchanged = {
      ...ref,
      estBefore: order.est_commission_fen,
      estAfter: order.est_commission_fen,
      settleCommissionFen: order.settle_commission_fen,
    };
    const base = { app_id: order.app_id, platform: order.platform, type: input.type };
    let event: PrecreditEvent;
    let change = unchanged;
    if (input.type === 'PUNISH') event = 'PUNISH';
    else if (input.type === 'INVALID_AFTER_SETTLE' || input.type === 'REFUND_AFTER_SETTLE') {
      event = 'PLATFORM_INVALID';
    } else {
      const deduction = input.deduction_commission_fen;
      // BR-CALC-02 effective union commission: settlement first, else the estimate.
      const effective = order.settle_commission_fen ?? order.est_commission_fen;
      if (deduction === null) return;
      if (effective === null) {
        logger.warn(
          { ...base, alert: 'rights_commission_unknown', outcome: 'recorded' },
          'rights deduction on an order without any union commission; recorded only',
        );
        return;
      }
      // D10-474 ① / D10-483: every deduction the union has not answered yet (answered_at empty)
      // adds up; this record is already stored, so it is among them. N_new = effective − total,
      // at or below 0 → the full side (R6).
      const open = await readOpenDeductionTotal(trx, order.app_id, order.order_id);
      const nNew = subFen(effective, open > deduction ? open : deduction);
      if (nNew <= 0n) {
        event = 'RIGHTS_FULL';
      } else {
        if (order.rebate_status === 'UNATTRIBUTED') {
          // R7 has no UNATTRIBUTED source: the partial result is recorded only.
          logger.info({ ...base, outcome: 'recorded' }, 'partial rights on an unattributed order');
          return;
        }
        event = 'RIGHTS_PARTIAL';
        // The effective commission becomes N_new for commission's valuation (R7 重算预估). N_new is
        // not a column: the stored order_rights rows carry it, and the credit (R5) subtracts the
        // deductions still open (answered_at empty) from the settlement record (B2-04lb).
        change =
          order.settle_commission_fen === null
            ? { ...unchanged, estAfter: nNew }
            : { ...unchanged, settleCommissionFen: nNew };
      }
    }
    await rebate.apply(trx, change, event);
  }

  /** BR-FUND-08 on a CREDITED order: the clawback's rights success entry (ref R{order_rights.id}). */
  async function credited(
    trx: Transaction<DB>,
    input: RightsRecordInput,
    status: StoredStatus,
    rightsId: string,
  ): Promise<void> {
    if (status !== 'SUCCEEDED' && status !== 'WAIT_COMMISSION') return;
    const result = await clawback.apply(trx, {
      appId: input.before.app_id,
      orderId: input.order_id,
      cause: causeOf(input.type),
      ref: { kind: 'rights', orderRightsId: rightsId },
      newCommissionFen: null,
      rightsDeductFen: input.type === 'RIGHTS' ? input.deduction_commission_fen : null,
    });
    logger.info(
      {
        app_id: input.before.app_id,
        platform: input.before.platform,
        type: input.type,
        outcome: result.outcome,
      },
      'rights result routed to the clawback',
    );
  }

  /** rights_pending recomputed on the row as it stands now (BR-FUND-01), written only on change. */
  async function syncRightsPending(trx: Transaction<DB>, input: RightsRecordInput): Promise<void> {
    const ref = {
      appId: input.before.app_id,
      orderId: input.order_id,
      attrAt: input.before.attr_at,
    };
    const order = await readRebateOrder(trx, ref);
    if (order === undefined) throw new Error('settlement rights: order not found for app');
    const pending = await computeRightsPending(trx, ref.appId, ref.orderId);
    if (pending === order.rights_pending) return;
    const ok = await casRightsPending(trx, order, pending, input.now);
    if (!ok) throw new Error('settlement rights: rights_pending CAS matched no row');
  }

  async function record(
    trx: Transaction<DB>,
    input: RightsRecordInput,
  ): Promise<RightsRecordResult> {
    checkInput(input);
    const order = input.before;
    const base = { app_id: order.app_id, platform: order.platform, type: input.type };
    if (!acceptsRights(order.platform_status)) {
      logger.info({ ...base, outcome: 'not_applicable' }, 'rights record outside P7 / P8 states');
      return { kind: 'not_applicable' };
    }

    const status = storedStatusOf(input);
    const key = {
      appId: order.app_id,
      orderId: input.order_id,
      type: input.type,
      platformRightsNo: input.platform_rights_no,
    };
    const result = {
      status,
      amountFen: input.amount_fen,
      deductionFen: input.deduction_commission_fen,
      occurredAt: input.occurred_at,
      now: input.now,
    };
    let rightsId: string;
    let reopened: OrderRightsRow | undefined;
    const stored = await findRights(trx, key);
    if (stored === undefined) {
      const id = await insertRights(trx, { ...key, ...result, source: input.source });
      if (id === null) {
        // The unique index already holds this key (never under the order lock; kept safe).
        logger.info({ ...base, outcome: 'duplicate' }, 'rights record key already stored');
        return { kind: 'duplicate' };
      }
      rightsId = id;
    } else {
      const reopens = reopensAsSucceeded(stored, input, status);
      const resolves =
        (stored.status === 'PROCESSING' && status !== 'PROCESSING') ||
        (stored.status === 'WAIT_COMMISSION' && status === 'SUCCEEDED') ||
        reopens;
      if (!resolves) {
        logger.info({ ...base, outcome: 'duplicate' }, 'rights record replayed');
        return { kind: 'duplicate' };
      }
      const ok = await updateRightsResult(trx, stored, result);
      if (!ok) throw new Error('settlement rights: order_rights CAS matched no row');
      rightsId = stored.id;
      if (reopens) reopened = stored;
    }

    if (reopened !== undefined) {
      // D10-699: on this transaction, so the audit commits or rolls back with the result.
      await audit.appendAction(trx, {
        appId: order.app_id,
        actor: RIGHTS_AUDIT_ACTOR,
        action: RIGHTS_REOPEN_AUDIT_ACTION,
        target: `order_rights:${reopened.id}`,
        before: { order_rights_id: reopened.id, status: reopened.status, source: reopened.source },
        after: {
          order_rights_id: reopened.id,
          status,
          source: input.source,
          reason: RIGHTS_SUCCESS_AFTER_CLOSED,
        },
      });
      logger.warn(
        {
          ...base,
          alert: RIGHTS_SUCCESS_AFTER_CLOSED,
          reason: RIGHTS_SUCCESS_AFTER_CLOSED,
          rebate_status: order.rebate_status,
          outcome: 'reopened',
        },
        'closed rights record reported successful by the union; handled as succeeded',
      );
    }

    if (isPrecredit(order.rebate_status)) await precredit(trx, input, status);
    else if (order.rebate_status === 'CREDITED') await credited(trx, input, status, rightsId);
    // VOID / CLAWED_BACK: recorded only (BR-FUND-01 细则「订单锁定」).

    await syncRightsPending(trx, input);
    logger.info({ ...base, status, outcome: 'applied' }, 'rights record applied');
    return { kind: 'applied' };
  }

  return Object.freeze({ record });
}
