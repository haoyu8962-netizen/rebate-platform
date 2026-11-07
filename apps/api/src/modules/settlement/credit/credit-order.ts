// B2-04m: the single-order credit transaction (rebate transition R5, SETTLE_BATCH_CREDIT).
// BR-FUND-01 R5; BR-FUND-04 ⑦ ⑩ ⑫; BR-FUND-05; BR-FUND-16 细则「加锁流程」; BR-CALC-13.
// B2-04mb (D10-317): the attribution is read through commission's version-independent
// readCommissionAttribution when wired, so an order whose commission_version order-sync moved
// ahead of the stored amount rows still credits (amounts never come from the snapshot).
//
// Everything runs on the caller's transaction (one PG transaction per sub-order, BR-FUND-04 ⑦);
// the service never opens, commits or rolls back a transaction itself. In order:
//   1. pg_advisory_xact_lock(order_key) — the same key as orders' lockOrderKey(platform, sub_order_id);
//   2. re-read the order after the lock: rebate_status = WAITING, hold = false,
//      rights_pending = false, and the greatest order_settlements seq = expectedSettleSeq;
//      otherwise return { outcome: 'skipped' } without writing anything;
//   3. read the attribution (readAttribution, version-independent; else the snapshot at the
//      current commission_version) and the snapshot's tlj_deduct_fen; a
//      tlj_deduct_fen > 0 skips with 'tlj_deduct_unsupported' plus an alert log and writes
//      nothing (编排裁定 D10-272); then lock the users rows of the beneficiaries through the
//      BeneficiaryGate (ascending user_id);
//   4. ledger.lockBalances for those users (ascending account_id);
//   5. re-read each beneficiary's state through the gate (after 3 and 4) and plan the credit with
//      @couli/domain planInitialCredit (B_credit from N per BR-CALC-02, shares per snapshot ratio);
//   6. buildVouchers per planned voucher and ledger.post each one (uniq_key per BR-FUND-05: a replay
//      is a duplicate, never a second credit);
//   7. held beneficiaries with a positive share: open one first_credit obligation each
//      (beneficiary_credits, opened_by R5, opened_ref = input.openedRef) and append a held event;
//      forfeited ones: append a forfeited event with the forfeit reason;
//   8. write booked_base_fen = B_credit and booked_n_fen = max(0, N) together, and move rebate_status
//      WAITING → CREDITED through the generated order-rebate transition() with a CAS on
//      (rebate_status, row_version); a CAS that matches no row throws (the caller's transaction then
//      rolls back as a whole); write the rebate history row;
//   9. B2-04zzc: when the inviteTrigger port is wired and B_credit > 0, hand the order to growth's
//      invite reward trigger on the same transaction (it runs under its own savepoint and never
//      throws on its own failures);
//  10. publish order.credited on the same transaction.
// B2-04lb: N is the settlement commission less the deductions of successful partial rights results
// received at or after the latest settlement record (D10-474 ①; floor 0).
// Amounts only through @couli/money; time only from the injected Clock.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  buildVouchers,
  orderKey,
  planInitialCredit,
  transitionOrderRebate,
  type BuiltVoucher,
  type CreditBeneficiary,
  type CreditBeneficiaryState,
  type CreditForfeitReason,
  type CreditVoucherRequest,
  type InitialCreditDecision,
} from '@couli/domain';
import { applyReserve, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import type { Ledger, PostingEntry, PostingVoucher } from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import type { Clock, EventBus, RootLogger } from '../../platform/index.ts';
import { insertRebateHistory, readRebateOrder } from '../rebate/infra/rebate-store.ts';
import { isForfeitedShare } from '../reads/pending-earnings-rules.ts';
import { readOpenDeductionTotal } from '../rights/rights-store.ts';
import type { BeneficiaryGate } from './beneficiary-gate.ts';
import {
  casCreditOrder,
  insertFirstCreditObligation,
  readLatestSettleSeq,
  readOrderLocator,
} from './credit-store.ts';

export type CreditRole = 'self' | 'share' | 'direct' | 'indirect';

export interface CreditSnapshotSelection {
  readonly appId: string;
  readonly orderId: string;
  /** orders.commission_version: the snapshot's current version. */
  readonly commissionVersion: number;
}

export interface CreditSnapshotBeneficiary {
  readonly userId: string;
  readonly role: CreditRole;
  readonly ratioBp: number;
  readonly initialStatus: 'active' | 'forfeited';
  /** D10-481 ②: commission's answer that an initially forfeited share is no longer forfeited. */
  readonly forfeitLifted?: true;
}

/** Structurally compatible with commission's readCommissionSnapshot result (B2-04i). */
export interface CreditSnapshot {
  readonly reserveBp: number;
  readonly beneficiaries: readonly CreditSnapshotBeneficiary[];
  /** The shares of the order still forfeited (D10-481 ②: their latest event is forfeited). */
  readonly forfeitedEvents: readonly { readonly userId: string; readonly role: CreditRole }[];
}

/** One beneficiary event of BR-CALC-13 (commission_split_beneficiary_events), same transaction. */
export interface BeneficiaryEventInput {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: CreditRole;
  readonly status: 'held' | 'forfeited';
  /** forfeited: banned | deleted | minor; held: null. */
  readonly reason: CreditForfeitReason | null;
}

/**
 * B2-04zzc (编排 D10-805 ②, D10-810; 08 BR-INV-24 ②): growth's InviteRewardTrigger, structurally
 * (settlement never imports growth). It records the order as the trigger of its owner's invite
 * reward qualification; it never posts a voucher and never touches a budget (the payout scan does,
 * after this transaction committed). It catches its own failures under its own savepoint, so a
 * failing trigger never fails the credit.
 */
export interface CreditInviteTrigger {
  onCredited(trx: Transaction<DB>, input: CreditInviteTriggerInput): Promise<void>;
}

export interface CreditInviteTriggerInput {
  readonly app_id: string;
  readonly order_id: string;
  /**
   * The booked base this credit just wrote (orders.booked_base_fen, always > 0 here): D10-810 makes
   * it the B of BR-INV-24 ②'s「B > 0」, in place of the estimated orders.base_fen.
   */
  readonly booked_base_fen: bigint;
}

export interface CreditOrderDependencies {
  /**
   * B2-04zzc: optional. When given, R5 calls it once per credited order on the credit's own
   * transaction, after the CAS to CREDITED and the rebate history row and before order.credited is
   * published, with { app_id, order_id, booked_base_fen } of the order. A skipped order (any CreditSkipReason) does
   * not call it, and an order credited with booked_base_fen = 0 never triggers (D10-810: the B > 0
   * of BR-INV-24 ② is the booked base). Only R5 calls it (R13, the admin restore, does not).
   */
  readonly inviteTrigger?: CreditInviteTrigger;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /**
   * commission readCommissionAttribution: the immutable attribution (reserve ratio, beneficiaries
   * with their ratios, forfeited events) without any amount version; throws when there is none.
   * Preferred over readSnapshot: R5 takes its amounts from N (settle_commission_fen) through the
   * credit plan, and orders.commission_version may run ahead of the stored amount rows (order-sync
   * bumps it). When supplied, readSnapshot is never called (no fallback).
   */
  readonly readAttribution?: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ) => Promise<CreditSnapshot>;
  /**
   * commission readCommissionSnapshot (current commission_version); null when the order has no
   * snapshot (throws then). Used only when readAttribution is not supplied (it asserts the version
   * is the greatest stored one).
   */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** tlj_deduct_fen of the immutable snapshot (BR-CALC-02); not exported by commission yet. */
  readTljDeductFen(trx: Transaction<DB>, input: CreditSnapshotSelection): Promise<bigint>;
  /** Writer of commission_split_beneficiary_events (待编排裁定: commission owns the table). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
  readonly events: Pick<EventBus, 'publish'>;
}

export interface CreditOrderInput {
  readonly appId: string;
  readonly orderId: string;
  /** BR-FUND-04 ⑦: the order_settlements seq the batch was validated on. */
  readonly expectedSettleSeq: number;
  /** Opening reference of the first_credit obligations (the batch item); nonempty. */
  readonly openedRef: string;
}

/**
 * tlj_deduct_unsupported: the snapshot's tlj_deduct_fen is > 0. 淘礼金 is not credited this period
 * (编排裁定 D10-272): skip without writing anything and log a warn line with
 * alert = 'credit_tlj_deduct_unsupported', app_id and order_id; the batch item keeps the reason
 * (BR-FUND-04 ⑦).
 */
export type CreditSkipReason =
  'not_waiting' | 'hold' | 'rights_pending' | 'settlement_changed' | 'tlj_deduct_unsupported';

export interface CreditBeneficiaryOutcome {
  readonly userId: string;
  readonly role: CreditRole;
  readonly shareFen: bigint;
  readonly action: 'credit' | 'held' | 'forfeited';
  readonly forfeitReason: CreditForfeitReason | null;
  /** The first_credit obligation opened for a held beneficiary, else null. */
  readonly beneficiaryCreditId: string | null;
}

export type CreditOrderResult =
  | {
      readonly outcome: 'credited';
      readonly orderKey: string;
      readonly bCreditFen: bigint;
      readonly bookedNFen: bigint;
      /** Platform retain + reserve (the PLATFORM:CREDIT voucher; 0 when none was written). */
      readonly platformCreditFen: bigint;
      readonly beneficiaries: readonly CreditBeneficiaryOutcome[];
    }
  | { readonly outcome: 'skipped'; readonly reason: CreditSkipReason };

export interface CreditOrder {
  /**
   * Credits one WAITING sub-order on the caller's transaction (see the file header). An order or
   * snapshot that does not exist for input.appId throws and writes nothing.
   */
  credit(trx: Transaction<DB>, input: CreditOrderInput): Promise<CreditOrderResult>;
}

const FROM_STATUS = 'WAITING';
const EVENT = 'SETTLE_BATCH_CREDIT';
const BIZ_TYPE = 'ORDER_CREDIT';
const OPERATOR = 'system';
const TLJ_ALERT = 'credit_tlj_deduct_unsupported';

/**
 * A snapshot beneficiary who is no longer in app.users for this app: BR-CALC-13 treats a missing
 * beneficiary like a deleted one (forfeited, reason deleted).
 */
const MISSING_USER: CreditBeneficiaryState = Object.freeze({
  risk_state: 'normal',
  deletion_status: 'done',
  is_minor: false,
});

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`settlement credit: ${name} must be a nonempty string`);
  }
  return value;
}

function checkInput(input: CreditOrderInput): void {
  text(input.appId, 'appId');
  text(input.orderId, 'orderId');
  text(input.openedRef, 'openedRef');
  if (!Number.isSafeInteger(input.expectedSettleSeq)) {
    throw new TypeError('settlement credit: expectedSettleSeq must be an integer');
  }
}

/** One voucher kind per template (BR-FUND-05; BR-FUND-19 ⑤ counts them by this column). */
function voucherKindOf(request: CreditVoucherRequest): 'CREDIT' | 'FORFEIT' {
  if (request.template_id === 'FORFEIT') return 'FORFEIT';
  if (request.template_id.startsWith('CREDIT:')) return 'CREDIT';
  throw new Error(`settlement credit: unexpected template ${request.template_id}`);
}

/** The beneficiary key of a user CREDIT voucher; platform vouchers (incl. FORFEIT) carry none. */
function beneficiaryOf(
  request: CreditVoucherRequest,
): { readonly userId: string; readonly role: CreditRole } | null {
  if (request.template_id === 'CREDIT:PLATFORM' || request.template_id === 'FORFEIT') return null;
  const userId = request.params['user_id'];
  const role = request.params['role'];
  if (typeof userId !== 'string' || typeof role !== 'string') {
    throw new Error(`settlement credit: ${request.template_id} without a beneficiary`);
  }
  return { userId, role: role as CreditRole };
}

function postingVoucher(
  appId: string,
  key: string,
  request: CreditVoucherRequest,
  built: BuiltVoucher,
  accounts: ReadonlyMap<string, string>,
): PostingVoucher {
  const beneficiary = beneficiaryOf(request);
  const entries: PostingEntry[] = built.entries.map((entry) => {
    if (entry.account.owner_type === 'user') {
      const accountId = accounts.get(entry.account.owner_id);
      if (accountId === undefined) {
        throw new Error('settlement credit: a credited beneficiary has no locked balance');
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
      // Platform rows are stored as available (build-vouchers decision 29).
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
    bizType: BIZ_TYPE,
    bizId: key,
    operator: OPERATOR,
    // BR-CALC-13: the FORFEIT voucher carries its forfeit_reason (no column: kept in memo).
    memo: request.forfeit_reason === null ? null : `forfeit_reason=${request.forfeit_reason}`,
    orderKey: key,
    beneficiaryUserId: beneficiary?.userId ?? null,
    role: beneficiary?.role ?? null,
    voucherKind: voucherKindOf(request),
    entries,
  };
}

export function createCreditOrder(deps: CreditOrderDependencies): CreditOrder {
  const { clock, logger, ledger, gate, events } = deps;

  async function credit(trx: Transaction<DB>, input: CreditOrderInput): Promise<CreditOrderResult> {
    checkInput(input);
    const { appId, orderId } = input;

    // 1. order_key advisory lock (the key columns never change; read only to name the lock).
    const locator = await readOrderLocator(trx, appId, orderId);
    if (locator === undefined) throw new Error('settlement credit: order not found for app');
    await lockOrderKey(trx, locator.platform, locator.sub_order_id);
    const key = orderKey(locator.platform, locator.sub_order_id);

    // 2. re-read after the lock; any failed check skips without writing (BR-FUND-04 ⑦).
    const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
    if (order === undefined) throw new Error('settlement credit: order not found for app');
    if (order.rebate_status !== FROM_STATUS) return { outcome: 'skipped', reason: 'not_waiting' };
    if (order.hold) return { outcome: 'skipped', reason: 'hold' };
    if (order.rights_pending) return { outcome: 'skipped', reason: 'rights_pending' };
    const seq = await readLatestSettleSeq(trx, appId, orderId);
    const settled = order.settle_commission_fen;
    if (seq === null || seq !== input.expectedSettleSeq || settled === null) {
      return { outcome: 'skipped', reason: 'settlement_changed' };
    }
    // B2-04lb (D10-463 / D10-474 ①; BR-FUND-06, BR-FUND-08 ②, BR-CALC-15): partial rights results
    // before credit lower N. Deductions the union's updated commission answered (answered_at set on
    // that sync, D10-483) are already in the settlement record; the open ones are subtracted
    // (floor 0).
    const openDeduction = await readOpenDeductionTotal(trx, appId, orderId);
    const reduced = subFen(settled, openDeduction);
    const n = openDeduction === 0n ? settled : reduced > 0n ? reduced : 0n;
    const step = transitionOrderRebate(FROM_STATUS, EVENT);
    if (!step.ok || step.noop || step.to !== 'CREDITED') {
      throw new Error('settlement credit: R5 is not a legal rebate transition');
    }

    // 3. attribution (ratios and forfeited events only; amounts come from N) and the 淘礼金
    // deduction. A throwing attribution read rolls the order back with nothing written.
    const selection: CreditSnapshotSelection = {
      appId,
      orderId,
      commissionVersion: order.commission_version,
    };
    const snapshot =
      deps.readAttribution === undefined
        ? await deps.readSnapshot(trx, selection)
        : await deps.readAttribution(trx, { appId, orderId });
    if (snapshot === null) throw new Error('settlement credit: order has no commission snapshot');
    const tlj = await deps.readTljDeductFen(trx, selection);
    if (typeof tlj !== 'bigint' || tlj < 0n) {
      throw new Error('settlement credit: tlj_deduct_fen must be a nonnegative bigint');
    }
    if (tlj > 0n) {
      // 编排裁定 D10-272: 淘礼金 orders are not credited this period; only stop, never overpay.
      logger.warn(
        { alert: TLJ_ALERT, app_id: appId, order_id: orderId },
        'credit skipped: tlj_deduct_fen > 0 is not supported',
      );
      return { outcome: 'skipped', reason: 'tlj_deduct_unsupported' };
    }

    // users rows (ascending, through the gate), then balance rows (ascending account_id).
    const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
    const locked = await gate.lockUsers(trx, { appId, userIds });
    const present = userIds.filter((id) => locked.has(id));
    for (const userId of present) {
      // Idempotent: a beneficiary without a wallet account gets one before its balance is locked.
      await ledger.openUserAccount(trx, { appId, userId });
    }
    const balances =
      present.length === 0 ? [] : await ledger.lockBalances(trx, { appId, userIds: present });
    const accounts = new Map(balances.map((row) => [row.user_id, row.account_id]));

    // 5. states after the locks, then the plan (B_credit from N per BR-CALC-02, tlj = 0).
    const states =
      present.length === 0
        ? new Map<string, CreditBeneficiaryState>()
        : await gate.readStates(trx, { appId, userIds: present });
    const beneficiaries: CreditBeneficiary[] = snapshot.beneficiaries.map((b) => ({
      user_id: b.userId,
      role: b.role,
      ratio_bp: BigInt(b.ratioBp),
      // D10-481 ②: the one judgement of a forfeited share.
      snapshot_status: isForfeitedShare(b, snapshot.forfeitedEvents) ? 'forfeited' : 'active',
      current: states.get(b.userId) ?? MISSING_USER,
    }));
    const { after_reserve_fen: bCredit, reserve_fen: reserveFen } = applyReserve(
      n,
      BigInt(snapshot.reserveBp),
    );
    const bookedN = n > 0n ? n : 0n;
    const plan = planInitialCredit({
      platform: locator.platform,
      sub_order_id: locator.sub_order_id,
      b_credit_fen: bCredit,
      reserve_fen: reserveFen,
      beneficiaries,
    });

    // 6. vouchers (uniq_key per BR-FUND-05: a stored key is a duplicate, never a second credit).
    for (const request of plan.vouchers) {
      for (const built of buildVouchers(request.template_id, request.params)) {
        await ledger.post(trx, postingVoucher(appId, key, request, built, accounts));
      }
    }

    // 7. first_credit obligations and beneficiary events (BR-CALC-13, BR-FUND-04 ⑫).
    const now = clock.now();
    const splitRef = `commission_version:${String(order.commission_version)}`;
    const outcomes: CreditBeneficiaryOutcome[] = [];
    for (const decision of plan.beneficiaries) {
      outcomes.push(await settleDecision(trx, input, decision, splitRef, now));
    }

    // 8. booked pair and R5 in one CAS, then the rebate history row.
    const written = await casCreditOrder(trx, {
      app_id: appId,
      order_id: orderId,
      attr_at: locator.attr_at,
      from: FROM_STATUS,
      to: step.to,
      row_version: order.row_version,
      booked_base_fen: bCredit,
      booked_n_fen: bookedN,
      at: now,
    });
    if (!written) {
      // Under the order_key lock nothing else may move the row: never report success.
      throw new Error('settlement credit: order CAS matched no row');
    }
    await insertRebateHistory(
      trx,
      { app_id: appId, order_id: orderId },
      [{ from: FROM_STATUS, event: EVENT, to: step.to }],
      'system',
      now,
    );

    // 9. B2-04zzc: the invite reward trigger after the CAS, before order.credited (BR-INV-24 ②;
    //    D10-810: booked base 0 never triggers). growth catches its own failures under a savepoint,
    //    so a failing trigger leaves the credit to commit.
    if (deps.inviteTrigger !== undefined && bCredit > 0n) {
      await deps.inviteTrigger.onCredited(trx, {
        app_id: appId,
        order_id: orderId,
        booked_base_fen: bCredit,
      });
    }

    // 10. order.credited on the same transaction.
    await events.publish(trx, {
      appId,
      name: 'order.credited',
      payload: { order_id: orderId, booked_base_fen: String(bCredit) },
    });
    logger.info(
      { app_id: appId, order_id: orderId, b_credit_fen: String(bCredit) },
      'order credited',
    );
    return {
      outcome: 'credited',
      orderKey: key,
      bCreditFen: bCredit,
      bookedNFen: bookedN,
      platformCreditFen: plan.platform_credit_fen,
      beneficiaries: outcomes,
    };
  }

  async function settleDecision(
    trx: Transaction<DB>,
    input: CreditOrderInput,
    decision: InitialCreditDecision,
    splitRef: string,
    now: Date,
  ): Promise<CreditBeneficiaryOutcome> {
    const role = decision.role as CreditRole;
    let beneficiaryCreditId: string | null = null;
    if (decision.open_initial_obligation) {
      beneficiaryCreditId = randomUUID();
      await insertFirstCreditObligation(trx, {
        beneficiary_credit_id: beneficiaryCreditId,
        app_id: input.appId,
        order_id: input.orderId,
        user_id: decision.user_id,
        role,
        opened_ref: input.openedRef,
        split_ref: splitRef,
        opened_at: now,
      });
      await deps.appendBeneficiaryEvent(trx, {
        appId: input.appId,
        orderId: input.orderId,
        userId: decision.user_id,
        role,
        status: 'held',
        reason: null,
      });
    }
    if (decision.append_forfeited_event) {
      await deps.appendBeneficiaryEvent(trx, {
        appId: input.appId,
        orderId: input.orderId,
        userId: decision.user_id,
        role,
        status: 'forfeited',
        reason: decision.forfeit_reason,
      });
    }
    return {
      userId: decision.user_id,
      role,
      shareFen: decision.share_fen,
      action: decision.action,
      forfeitReason: decision.forfeit_reason,
      beneficiaryCreditId,
    };
  }

  return Object.freeze({ credit });
}
