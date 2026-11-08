// B2-04q: execution of one beneficiary credit item (受益人补记项, rebate self-transition R5a
// BENEFICIARY_RELEASE). BR-FUND-01 R5a; BR-FUND-04 ⑫; BR-FUND-19 ⑤; BR-CALC-13; lock flow of
// BR-FUND-16 细则「加锁流程」 (same as B2-04m).
//
// Everything runs on the caller's transaction (one PG transaction per batch item); the service never
// opens, commits or rolls back a transaction itself. In order:
//   1. pg_advisory_xact_lock(order_key) through orders' lockOrderKey(platform, sub_order_id);
//   2. after the lock, re-read the order and the obligation (beneficiary_credits) and re-verify:
//      rebate_status = CREDITED, rights_pending = false, the greatest order_settlements seq =
//      input.expectedSettleSeq, the obligation's attribution snapshot (split_ref) is still the
//      order's (see attributionUnchanged: an amount-version bump is not an attribution change) and
//      the obligation status = open; a failed check returns { outcome: 'skipped', reason } and
//      writes nothing; amounts always come from the current commission_version and booked pair;
//   3. lock the obligation's beneficiary users row through the BeneficiaryGate, then
//      ledger.lockBalances for that user, then re-read the beneficiary's state through the gate;
//   4. check BR-FUND-19 ⑤ for the whole order before writing (ledger order nets, the snapshot
//      ratios, the order's open obligations, booked_base_fen / booked_n_fen); when it does not hold,
//      skip with 'invariant_mismatch', write nothing and log a warn line with
//      alert = BeneficiaryCreditAlert, app_id, order_id and beneficiary_credit_id;
//   5. amount = the obligation's remaining amount at execution time: max(0, floor(booked_base_fen ×
//      ratio_bp / 10000) − the beneficiary's net), never the snapshot's base_fen;
//   6. by obligation kind and the re-read state (BR-CALC-13):
//      - normal (cooling-off deletion included; a minor's own self share included):
//        first_credit → `{order_key}:{uid}:{role}:CREDIT`; deferred →
//        `{order_key}:{uid}:{role}:ADJ:DEFERRED:{beneficiary_credit_id}` with the ledger type and
//        sub type the obligation was opened with (origin_ledger_type / origin_sub_type);
//        obligation open → done (COMPLETE);
//      - banned, deletion processing / done, minor (promotion shares only) → forfeit with its
//        forfeit_reason: first_credit → `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` plus a forfeited
//        beneficiary event; deferred → `{order_key}:PLATFORM:FORFEIT:{uid}:{role}:DEFERRED:
//        {beneficiary_credit_id}`, no event; obligation open → forfeited (FORFEIT);
//      - frozen / appealing → { outcome: 'deferred' }: no voucher, obligation stays open;
//      an amount of 0 writes no voucher and still closes the obligation (voucher_id null);
//   7. the obligation is closed through the generated beneficiary-credit transition() with a CAS on
//      (status, row_version), row_version + 1, closed_by = 'R5a', closed_ref = input.closedRef,
//      closed_at = the injected Clock, voucher_id = the voucher written (null when none), on the
//      same transaction as the voucher, followed by the rebate history row of the R5a self-step
//      (field rebate, CREDITED → CREDITED, BENEFICIARY_RELEASE, source system).
// Amounts only through @couli/money; time only from the injected Clock.
import type { DB } from '@couli/db';
import {
  buildVouchers,
  orderKey,
  planBeneficiaryCredit,
  transitionBeneficiaryCredit,
  transitionOrderRebate,
  type BeneficiaryCreditPlan,
  type BuiltVoucher,
  type CreditBeneficiaryState,
  type CreditForfeitReason,
  type CreditNetPosition,
  type CreditObligation,
  type CreditVoucherRequest,
} from '@couli/domain';
import type { Transaction } from 'kysely';
import {
  creditPostcheckKindOf,
  enqueueCreditPostcheck,
  type CreditPostcheckEnqueue,
  type CreditPostcheckVoucher,
  type Ledger,
  type OrderNetSelection,
  type OrderNets,
  type PostingEntry,
  type PostingVoucher,
} from '../../../ledger/index.ts';
import { lockOrderKey } from '../../../orders/index.ts';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import { insertRebateHistory, readRebateOrder } from '../../rebate/infra/rebate-store.ts';
import { isForfeitedShare } from '../../reads/pending-earnings-rules.ts';
import type { BeneficiaryGate } from '../beneficiary-gate.ts';
import { readLatestSettleSeq, readOrderLocator } from '../credit-store.ts';
import {
  casCloseObligation,
  readObligation,
  readOpenObligationKeys,
  type ObligationRow,
} from './beneficiary-credit-store.ts';
import type {
  BeneficiaryEventInput,
  CreditRole,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit-order.ts';

export interface BeneficiaryCreditDependencies {
  /**
   * B2-02t (BR-FUND-19, D10-1038): optional. When given, a first_credit item that wrote a voucher
   * enqueues the post-credit confirmation on its own transaction, with the net before the voucher
   * (ledger/application/credit-postcheck.ts). Deferred items do not.
   */
  readonly postcheck?: CreditPostcheckEnqueue;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /**
   * commission readCommissionAttribution: the immutable attribution (reserve ratio, beneficiaries
   * with their ratios, forfeited events) without any amount version; throws when there is none.
   * Preferred over readSnapshot: R5a takes its amounts from booked_base_fen / booked_n_fen, and
   * orders.commission_version may run ahead of the stored amount rows (order-sync bumps it).
   */
  readonly readAttribution?: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ) => Promise<CreditSnapshot>;
  /**
   * commission readCommissionSnapshot (current commission_version); null when there is none. Used
   * only when readAttribution is not supplied (it asserts the version is the greatest stored one).
   */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** ledger getOrderNets: beneficiary nets and the ⑤ UNION_RECEIVABLE net of the order. */
  readOrderNets(trx: Transaction<DB>, input: OrderNetSelection): Promise<OrderNets>;
  /** Writer of commission_split_beneficiary_events (same as B2-04m). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
}

export interface BeneficiaryCreditInput {
  readonly appId: string;
  readonly orderId: string;
  /** The obligation the batch item refers to (settle_batch_items.beneficiary_credit_id). */
  readonly beneficiaryCreditId: string;
  /** settle_batch_items.settle_seq: the order_settlements seq when the item was generated. */
  readonly expectedSettleSeq: number;
  /** closed_ref written when this execution closes the obligation (the batch item id); nonempty. */
  readonly closedRef: string;
}

export type BeneficiaryCreditSkipReason =
  | 'not_credited'
  | 'rights_pending'
  | 'settlement_changed'
  | 'snapshot_changed'
  | 'obligation_closed'
  | 'invariant_mismatch';

/** The alert field of the warn line logged when BR-FUND-19 ⑤ does not hold before execution. */
export type BeneficiaryCreditAlert = 'beneficiary_credit_invariant_mismatch';

export type BeneficiaryCreditResult =
  | {
      readonly outcome: 'credited';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      /** The remaining amount credited (0: no voucher, obligation done all the same). */
      readonly amountFen: bigint;
      /** ledger_vouchers.id of the voucher written, null when the amount was 0. */
      readonly voucherId: string | null;
    }
  | {
      readonly outcome: 'forfeited';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      readonly amountFen: bigint;
      readonly forfeitReason: CreditForfeitReason;
      readonly voucherId: string | null;
    }
  | {
      readonly outcome: 'deferred';
      readonly beneficiaryCreditId: string;
      readonly userId: string;
      readonly role: CreditRole;
      /** The remaining amount at execution time (kept on the batch item; nothing written). */
      readonly amountFen: bigint;
    }
  | { readonly outcome: 'skipped'; readonly reason: BeneficiaryCreditSkipReason };

export interface BeneficiaryCredit {
  /**
   * Executes one beneficiary credit item on the caller's transaction (see the file header). An
   * order or obligation that does not exist for input.appId / input.orderId throws and writes
   * nothing.
   */
  execute(trx: Transaction<DB>, input: BeneficiaryCreditInput): Promise<BeneficiaryCreditResult>;
}

const FROM_STATUS = 'CREDITED';
const REBATE_EVENT = 'BENEFICIARY_RELEASE';
const CLOSED_BY = 'R5a';
const OPERATOR = 'system';
const ALERT: BeneficiaryCreditAlert = 'beneficiary_credit_invariant_mismatch';

/**
 * A beneficiary who is no longer in app.users for this app: BR-CALC-13 treats a missing
 * beneficiary like a deleted one (forfeited, reason deleted), same as B2-04m.
 */
const MISSING_USER: CreditBeneficiaryState = Object.freeze({
  risk_state: 'normal',
  deletion_status: 'done',
  is_minor: false,
});

/** The ADJ:DEFERRED template of each origin sub type, and the ledger type it must come with. */
const DEFERRED_ORIGINS: ReadonlyMap<
  string,
  { readonly ledgerType: string; readonly template: DeferredTemplate }
> = new Map([
  ['SETTLE_DIFF', { ledgerType: 'SETTLE_ADJUST', template: 'ADJ:DEFERRED:SETTLE_DIFF' }],
  ['PRICE_COMPARE', { ledgerType: 'SETTLE_ADJUST', template: 'ADJ:DEFERRED:PRICE_COMPARE' }],
  ['PRICE_PROTECT', { ledgerType: 'SETTLE_ADJUST', template: 'ADJ:DEFERRED:PRICE_PROTECT' }],
  ['RESTORE', { ledgerType: 'ADMIN_ADJUST', template: 'ADJ:DEFERRED:RESTORE' }],
]);

type DeferredTemplate = Extract<CreditObligation, { kind: 'deferred' }>['credit_template'];

const SKIP_REASONS: Readonly<
  Record<NonNullable<BeneficiaryCreditPlan['skip_reason']>, BeneficiaryCreditSkipReason>
> = {
  order_not_credited: 'not_credited',
  rights_pending: 'rights_pending',
  settlement_changed: 'settlement_changed',
  snapshot_changed: 'snapshot_changed',
  obligation_closed: 'obligation_closed',
  invariant_mismatch: 'invariant_mismatch',
};

const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`settlement beneficiary credit: ${name} must be a nonempty string`);
  }
  return value;
}

function checkInput(input: BeneficiaryCreditInput): void {
  text(input.appId, 'appId');
  text(input.orderId, 'orderId');
  text(input.beneficiaryCreditId, 'beneficiaryCreditId');
  text(input.closedRef, 'closedRef');
  if (!Number.isSafeInteger(input.expectedSettleSeq)) {
    throw new TypeError('settlement beneficiary credit: expectedSettleSeq must be an integer');
  }
}

function roleOf(value: string): CreditRole {
  if (!ROLES.includes(value)) {
    throw new Error(`settlement beneficiary credit: unknown role ${value}`);
  }
  return value as CreditRole;
}

const SPLIT_REF = /^commission_version:([1-9][0-9]{0,8})$/;

/**
 * BR-FUND-04 ⑫「归属快照未变」: the obligation's split_ref names the attribution snapshot it was
 * opened on, `commission_version:{K}` as B2-04m writes it. The attribution (who the beneficiaries
 * are and their ratios) lives in the order's single immutable commission_splits row; a later
 * commission_version only re-states amounts (order-sync bumps it on a CREDITED order when the
 * estimate changes, BR-CALC-10) and keeps the attribution, so K ≤ the current version is still the
 * same attribution. The only attribution change is a reassignment (R14), which is not open
 * (2026-10-18) and would void the open obligations itself. A K that is not a version of this order
 * (malformed, or above the current version) is treated as changed.
 */
export function attributionUnchanged(splitRef: string, commissionVersion: number): boolean {
  const match = SPLIT_REF.exec(splitRef);
  if (match === null || !Number.isSafeInteger(commissionVersion)) return false;
  const opened = Number(match[1]);
  return opened >= 1 && opened <= commissionVersion;
}

function identity(userId: string, role: string): string {
  return JSON.stringify([userId, role]);
}

/** The planner's view of the stored obligation (kind and, for deferred, the fixed template). */
function obligationOf(row: ObligationRow): CreditObligation {
  const base = {
    beneficiary_credit_id: row.beneficiary_credit_id,
    user_id: row.user_id,
    role: roleOf(row.role),
    snapshot_id: row.split_ref,
    status: row.status === 'done' ? ('completed' as const) : statusOf(row.status),
  };
  if (row.kind === 'first_credit') return { ...base, kind: 'initial' };
  if (row.kind === 'deferred') {
    const origin =
      row.origin_sub_type === null ? undefined : DEFERRED_ORIGINS.get(row.origin_sub_type);
    if (origin === undefined || origin.ledgerType !== row.origin_ledger_type) {
      throw new Error('settlement beneficiary credit: deferred obligation with an unknown origin');
    }
    return { ...base, kind: 'deferred', credit_template: origin.template };
  }
  // reassign_credit (R14) is not open (2026-10-18): its REASSIGN keys are never produced here.
  throw new Error(`settlement beneficiary credit: obligation kind ${row.kind} is not supported`);
}

function statusOf(status: string): 'open' | 'forfeited' | 'voided' {
  if (status === 'open' || status === 'forfeited' || status === 'voided') return status;
  throw new Error(`settlement beneficiary credit: unknown obligation status ${status}`);
}

function postingVoucher(
  appId: string,
  key: string,
  row: ObligationRow,
  request: CreditVoucherRequest,
  built: BuiltVoucher,
  accountId: string | null,
): PostingVoucher {
  const forfeit = request.template_id === 'FORFEIT' || request.template_id === 'FORFEIT:DEFERRED';
  const deferredCredit = request.template_id.startsWith('ADJ:DEFERRED:');
  const entries: PostingEntry[] = built.entries.map((entry) => {
    if (entry.account.owner_type === 'user') {
      if (forfeit || entry.account.owner_id !== row.user_id || accountId === null) {
        throw new Error('settlement beneficiary credit: a user entry without a locked balance');
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
  let voucherKind: string;
  if (forfeit) voucherKind = 'FORFEIT';
  else if (deferredCredit) {
    // The deferred credit keeps the type of the transaction that opened it (04, 0066).
    const ledgerType = row.origin_ledger_type;
    if (ledgerType === null) throw new Error('settlement beneficiary credit: no origin type');
    voucherKind = ledgerType;
  } else voucherKind = 'CREDIT';
  return {
    appId,
    uniqKey: built.uniq_key,
    bizType:
      deferredCredit || request.template_id === 'FORFEIT:DEFERRED'
        ? 'ORDER_ADJUST'
        : 'ORDER_CREDIT',
    bizId: key,
    operator: OPERATOR,
    // BR-CALC-13: the FORFEIT voucher carries its forfeit_reason (no column: kept in memo).
    memo: request.forfeit_reason === null ? null : `forfeit_reason=${request.forfeit_reason}`,
    orderKey: key,
    // Platform vouchers (FORFEIT, FORFEIT:DEFERRED) carry no beneficiary key (BR-FUND-19 ④).
    beneficiaryUserId: forfeit ? null : row.user_id,
    role: forfeit ? null : roleOf(row.role),
    voucherKind,
    entries,
  };
}

export function createBeneficiaryCredit(deps: BeneficiaryCreditDependencies): BeneficiaryCredit {
  const { clock, logger, ledger, gate } = deps;

  async function execute(
    trx: Transaction<DB>,
    input: BeneficiaryCreditInput,
  ): Promise<BeneficiaryCreditResult> {
    checkInput(input);
    const { appId, orderId, beneficiaryCreditId } = input;

    // 1. order_key advisory lock (the key columns never change; read only to name the lock).
    const locator = await readOrderLocator(trx, appId, orderId);
    if (locator === undefined) throw new Error('settlement beneficiary credit: order not found');
    await lockOrderKey(trx, locator.platform, locator.sub_order_id);
    const key = orderKey(locator.platform, locator.sub_order_id);

    // 2. re-read the order and the obligation after the lock; a failed check writes nothing.
    const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
    if (order === undefined) throw new Error('settlement beneficiary credit: order not found');
    const row = await readObligation(trx, appId, orderId, beneficiaryCreditId);
    if (row === undefined) {
      throw new Error('settlement beneficiary credit: obligation not found for the order');
    }
    if (order.rebate_status !== FROM_STATUS) return { outcome: 'skipped', reason: 'not_credited' };
    if (order.rights_pending) return { outcome: 'skipped', reason: 'rights_pending' };
    const seq = await readLatestSettleSeq(trx, appId, orderId);
    if (seq === null || seq !== input.expectedSettleSeq) {
      return { outcome: 'skipped', reason: 'settlement_changed' };
    }
    if (!attributionUnchanged(row.split_ref, order.commission_version)) {
      return { outcome: 'skipped', reason: 'snapshot_changed' };
    }
    // The planner compares the obligation's snapshot id with the order's attribution id: both are
    // the verified split_ref here (amounts are taken from the current version below).
    const snapshotId = row.split_ref;
    if (row.status !== 'open') return { outcome: 'skipped', reason: 'obligation_closed' };
    const step = transitionOrderRebate(FROM_STATUS, REBATE_EVENT);
    if (!step.ok || !step.noop) {
      throw new Error('settlement beneficiary credit: R5a is not a legal rebate self-transition');
    }
    const obligation = obligationOf(row);
    const bookedBase = order.booked_base_fen;
    const bookedN = order.booked_n_fen;
    if (bookedBase === null || bookedN === null) {
      throw new Error('settlement beneficiary credit: CREDITED order without booked amounts');
    }

    // Ratios and forfeited events only (amounts are the booked pair): version-independent read.
    const snapshot =
      deps.readAttribution === undefined
        ? await deps.readSnapshot(trx, {
            appId,
            orderId,
            commissionVersion: order.commission_version,
          })
        : await deps.readAttribution(trx, { appId, orderId });
    if (snapshot === null) {
      throw new Error('settlement beneficiary credit: order has no commission snapshot');
    }

    // 3. users row (through the gate), balance row, then the state re-read after both locks.
    const userId = row.user_id;
    const locked = await gate.lockUsers(trx, { appId, userIds: [userId] });
    let accountId: string | null = null;
    let current: CreditBeneficiaryState = MISSING_USER;
    if (locked.has(userId)) {
      await ledger.openUserAccount(trx, { appId, userId });
      const balances = await ledger.lockBalances(trx, { appId, userIds: [userId] });
      accountId = balances.find((b) => b.user_id === userId)?.account_id ?? null;
      if (accountId === null) {
        throw new Error('settlement beneficiary credit: beneficiary balance was not locked');
      }
      const states = await gate.readStates(trx, { appId, userIds: [userId] });
      current = states.get(userId) ?? MISSING_USER;
    }

    // 4. BR-FUND-19 ⑤ inputs: the order's nets, the snapshot ratios and its open obligations.
    const nets: OrderNets = await deps.readOrderNets(trx, { appId, orderKey: key });
    const openKeys = new Set(
      (await readOpenObligationKeys(trx, appId, orderId)).map((k) => identity(k.user_id, k.role)),
    );
    const netOf = new Map(
      nets.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
    );
    const positions: CreditNetPosition[] = [];
    const seen = new Set<string>();
    for (const b of snapshot.beneficiaries) {
      const id = identity(b.userId, b.role);
      if (seen.has(id)) throw new Error('settlement beneficiary credit: duplicate beneficiary');
      seen.add(id);
      positions.push({
        user_id: b.userId,
        role: b.role,
        ratio_bp: BigInt(b.ratioBp),
        // D10-481 ②: the one judgement of a forfeited share.
        snapshot_status: isForfeitedShare(b, snapshot.forfeitedEvents) ? 'forfeited' : 'active',
        net_fen: netOf.get(id) ?? 0n,
        has_open_obligation: openKeys.has(id),
      });
    }
    if (!seen.has(identity(userId, row.role))) {
      // The obligation's beneficiary is not in the order's attribution: it changed.
      return { outcome: 'skipped', reason: 'snapshot_changed' };
    }
    for (const b of nets.beneficiaries) {
      const id = identity(b.beneficiary_user_id, b.role);
      if (seen.has(id)) continue;
      // A net outside the snapshot still counts in Σ nets ≤ booked_base_fen; it owes nothing.
      seen.add(id);
      positions.push({
        user_id: b.beneficiary_user_id,
        role: b.role,
        ratio_bp: 0n,
        snapshot_status: 'active',
        net_fen: b.net_fen,
        has_open_obligation: false,
      });
    }

    // 5–6. the plan: re-verification, ⑤, remaining amount and the verdict (BR-CALC-13).
    const plan = planBeneficiaryCredit({
      platform: locator.platform,
      sub_order_id: locator.sub_order_id,
      rebate_status: FROM_STATUS,
      rights_pending: order.rights_pending,
      settlement_seq: BigInt(seq),
      expected_settlement_seq: BigInt(input.expectedSettleSeq),
      snapshot_id: snapshotId,
      obligation,
      current,
      booked_base_fen: bookedBase,
      booked_n_fen: bookedN,
      union_receivable_net_fen: nets.union_receivable_net_fen,
      positions,
    });
    const role = roleOf(row.role);
    if (plan.action === 'skipped') {
      const reason =
        plan.skip_reason === null ? 'invariant_mismatch' : SKIP_REASONS[plan.skip_reason];
      if (plan.alert) {
        logger.warn(
          {
            alert: ALERT,
            app_id: appId,
            order_id: orderId,
            beneficiary_credit_id: beneficiaryCreditId,
          },
          'beneficiary credit skipped: BR-FUND-19 ⑤ does not hold before execution',
        );
      }
      return { outcome: 'skipped', reason };
    }
    if (plan.action === 'deferred') {
      return {
        outcome: 'deferred',
        beneficiaryCreditId,
        userId,
        role,
        amountFen: plan.remaining_fen,
      };
    }

    // vouchers (uniq_key per BR-FUND-05 / ⑫); a stored key here would mean an unpaid duplicate.
    let voucherId: string | null = null;
    const postchecked: CreditPostcheckVoucher[] = [];
    for (const request of plan.vouchers) {
      for (const built of buildVouchers(request.template_id, request.params)) {
        const posted = await ledger.post(
          trx,
          postingVoucher(appId, key, row, request, built, accountId),
        );
        if (posted.kind !== 'posted') {
          throw new Error(
            `settlement beneficiary credit: voucher ${built.uniq_key} already exists`,
          );
        }
        if (voucherId !== null) {
          throw new Error('settlement beneficiary credit: more than one voucher planned');
        }
        voucherId = posted.voucherId;
        // B2-02t: the first_credit templates only; base and net as this voucher was computed.
        const kind = creditPostcheckKindOf(request.template_id);
        if (kind !== null) {
          postchecked.push({
            voucher_id: posted.voucherId,
            user_id: userId,
            role,
            kind,
            base_fen: bookedBase.toString(),
            net_before_fen: (netOf.get(identity(userId, row.role)) ?? 0n).toString(),
          });
        }
      }
    }
    if (plan.append_forfeited_event) {
      await deps.appendBeneficiaryEvent(trx, {
        appId,
        orderId,
        userId,
        role,
        status: 'forfeited',
        reason: plan.forfeit_reason,
      });
    }

    // 7. close the obligation through the generated transition, same transaction as the voucher.
    const event = plan.obligation_action === 'forfeit' ? 'FORFEIT' : 'COMPLETE';
    const close = transitionBeneficiaryCredit('open', event);
    if (!close.ok || close.noop) {
      throw new Error('settlement beneficiary credit: illegal obligation transition');
    }
    const now = clock.now();
    const written = await casCloseObligation(trx, {
      app_id: appId,
      beneficiary_credit_id: beneficiaryCreditId,
      from: 'open',
      to: close.to,
      row_version: row.row_version,
      closed_by: CLOSED_BY,
      closed_ref: input.closedRef,
      closed_at: now,
      voucher_id: voucherId,
    });
    if (!written) {
      // Under the order_key lock nothing else may move the obligation: never report success.
      throw new Error('settlement beneficiary credit: obligation CAS matched no row');
    }
    // R5a is a self-step (CREDITED → CREDITED): history row on the same transaction (rebate.ts).
    await insertRebateHistory(
      trx,
      { app_id: appId, order_id: orderId },
      [{ from: FROM_STATUS, event: REBATE_EVENT, to: step.to }],
      'system',
      now,
    );
    // B2-02t (BR-FUND-19): the post-credit confirmation of the voucher above, same transaction.
    await enqueueCreditPostcheck(deps.postcheck, trx, {
      app_id: appId,
      order_id: orderId,
      vouchers: postchecked,
    });
    logger.info(
      {
        app_id: appId,
        order_id: orderId,
        beneficiary_credit_id: beneficiaryCreditId,
        action: plan.action,
        amount_fen: String(plan.remaining_fen),
      },
      'beneficiary credit executed',
    );
    if (plan.action === 'forfeited') {
      const forfeitReason: CreditForfeitReason | null = plan.forfeit_reason;
      if (forfeitReason === null) {
        throw new Error('settlement beneficiary credit: forfeit without a reason');
      }
      return {
        outcome: 'forfeited',
        beneficiaryCreditId,
        userId,
        role,
        amountFen: plan.remaining_fen,
        forfeitReason,
        voucherId,
      };
    }
    return {
      outcome: 'credited',
      beneficiaryCreditId,
      userId,
      role,
      amountFen: plan.remaining_fen,
      voucherId,
    };
  }

  return Object.freeze({ execute });
}
