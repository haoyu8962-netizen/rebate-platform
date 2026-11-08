// B2-09zc (FU-SETTLE-ADJ-POSITIVE; 08 BR-FUND-09 ②, BR-CALC-02, BR-CALC-09, BR-FUND-15; rulings
// D10-769, D10-770 ①–④; contracts/openapi.yaml adminListSettleAdjustments,
// adminApproveSettleAdjustBatch, adminRejectSettleAdjustBatch, CT-24zv). Skeleton of the rule-test
// round; test/spec/settlement/settle-adjust-approve/** pins the behaviour below.
//
// approveSettleAdjustBatch (fund.settle_adjust, totp step-up, Idempotency-Key; body `{}`):
//   - an unknown batch or one of another app → 20001 data.fields=[batch_id]; a batch with
//     confirmed_at set → 20902 data.resource=settle_adjust_batch;
//   - order by order, each on its own transaction (order key lock → users → balances, the module's
//     fixed order), so one order's outcome never blocks another's; per order:
//       candidates no longer pending because another call decided them → already_decided;
//       voided by a clawback before approval → voided_by_clawback (nothing written);
//       current settlement seq ≠ the candidates' settle_seq → voided_stale_seq (decided_at the
//       Clock, nothing written);
//       otherwise recompute from orders.settle_commission_fen (B_settle with the snapshot
//       reserve_bp) and the current nets (BR-FUND-08), beneficiary states read after the locks
//       (BR-CALC-09: frozen / appealing → a deferred obligation, banned / deleting / deleted /
//       minor promotion share / forfeited → the platform); difference 0 → approved_zero (candidates
//       approved, no voucher); else SETTLE_ADJUST / SETTLE_DIFF vouchers
//       `{order_key}:{user_id}:{role}:ADJ:{seq}` (USER:INCREASE) and `{order_key}:PLATFORM:ADJ:{seq}`
//       (PLATFORM:INCREASE / DECREASE by sign, none when 0), booked_base_fen / booked_n_fen set to
//       the recomputed pair, an open obligation of a member credited now closed, candidates
//       approved (approver the caller, decided_at the Clock) by row_version CAS → approved with
//       credited_fen the members' total;
//   - the batch gets confirmed_by / confirmed_at once none of its candidates is pending;
//   - one audit record settle_adjust_batch_approve per call (batch_id, every order's outcome and
//     amounts, no personal data), never written on a second connection while a request
//     transaction is held (the admin pool has 3 connections).
// rejectSettleAdjustBatch (same guards; body { reason }): every pending candidate → rejected (reason,
//   approver, decided_at), the batch confirmed, no voucher; one audit record
//   settle_adjust_batch_reject (batch_id, rejected count, reason).
// listSettleAdjustments (fund.settle_adjust or fund.view, no step-up, no audit): status / batch_id
//   AND, created_at then id descending, AdminPage, rights_waiting from the order's rights cases
//   still waiting for the union, members as AdminWithdrawalUser (phone masked).
import { randomUUID } from 'node:crypto';
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  buildVouchers,
  orderKey,
  planCommissionAdjustment,
  transitionBeneficiaryCredit,
  transitionOrderRebate,
  transitionSettleAdjustment,
  type AdjustmentBeneficiary,
  type AdjustmentBeneficiaryResult,
  type AdjustmentPlan,
  type BuildVoucherParams,
  type BuiltVoucher,
  type CreditBeneficiaryState,
} from '@couli/domain';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type {
  Ledger,
  OrderNetSelection,
  OrderNets,
  PostingEntry,
  PostingVoucher,
} from '../../ledger/index.ts';
import { lockOrderKey } from '../../orders/index.ts';
import {
  fieldsErrorEnvelope,
  type AuditPort,
  type Clock,
  type FieldCrypto,
  type HandlerResult,
  type Idempotency,
  type RootLogger,
} from '../../platform/index.ts';
import {
  casClawbackOrder,
  closeObligation,
  insertDeferredObligation,
  readOpenObligations,
  type BeneficiaryCreditRow,
} from '../clawback/clawback-store.ts';
import { readLatestSettleSeq, readOrderLocator } from '../credit/credit-store.ts';
import type {
  BeneficiaryEventInput,
  BeneficiaryGate,
  CreditRole,
  CreditSnapshot,
  CreditSnapshotSelection,
} from '../credit/index.ts';
import {
  insertRebateHistory,
  readRebateOrder,
  type OrderRow,
} from '../rebate/infra/rebate-store.ts';
import { isForfeitedShare } from '../reads/pending-earnings-rules.ts';

export interface SettleAdjustDecisionDeps {
  /** Each order of a batch runs on its own transaction opened here. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  readonly idempotency: Idempotency;
  readonly ledger: Pick<Ledger, 'openUserAccount' | 'lockBalances' | 'post'>;
  readonly gate: BeneficiaryGate;
  /** commission readCommissionSnapshot (current commission_version). */
  readSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<CreditSnapshot | null>;
  /** ledger getOrderNets. */
  readOrderNets(trx: Transaction<DB>, input: OrderNetSelection): Promise<OrderNets>;
  /** admin's audit writer bound to a transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** commission appendBeneficiaryEvent (a share forfeited at approval, BR-FUND-04 ⑫). */
  appendBeneficiaryEvent(trx: Transaction<DB>, input: BeneficiaryEventInput): Promise<void>;
  /** identity's masked phones (user_id → 3 + 4, null without a phone). */
  maskedPhones(
    appId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

/** What app.module adds to SettlementAdminModule.forAdmin for these routes (B2-09zc). */
export interface AdminSettleAdjustPorts {
  /** commission appendBeneficiaryEvent ((trx, input, { clock })). */
  readonly appendShareEvent: (
    trx: Transaction<DB>,
    input: BeneficiaryEventInput,
    dependencies: { readonly clock: Clock },
  ) => Promise<void>;
  /** identity createMaskedPhoneReader over the entry's handle and field cipher. */
  readonly maskedPhones: (
    db: Kysely<DB>,
    crypto: FieldCrypto | null,
  ) => {
    maskedPhones(
      appId: string,
      userIds: readonly string[],
    ): Promise<ReadonlyMap<string, string | null>>;
  };
}

export interface SettleAdjustOperator {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ApproveSettleAdjustBatchCall {
  readonly batchId: string;
  readonly body: Schema<'AdminEmptyActionRequest'>;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

export interface RejectSettleAdjustBatchCall {
  readonly batchId: string;
  readonly body: Schema<'AdminAdjustmentRejectRequest'>;
  readonly key: string | undefined;
  readonly traceId: string;
}

export interface ListSettleAdjustmentsQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status: Schema<'AdminSettleAdjustmentStatus'> | undefined;
  readonly batchId: string | undefined;
}

/** What the controller sends: the status and the exact bytes (first result on a replay). */
export interface SettleAdjustAnswer {
  readonly status: number;
  readonly body: string;
}

// ---------------------------------------------------------------------------------------------
// Implementation.

const BATCH_RESOURCE = 'settle_adjust_batch';
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
export const APPROVE_AUDIT_ACTION = 'settle_adjust_batch_approve';
export const REJECT_AUDIT_ACTION = 'settle_adjust_batch_reject';
/**
 * A share the approval gave the platform whose reason no voucher carries (money r4 S1): written in
 * the order's own transaction, never only in the batch audit that commits later.
 */
export const FORFEIT_AUDIT_ACTION = 'settle_adjust_share_forfeited';
const ADJUST_BIZ_TYPE = 'ORDER_SETTLE_ADJUST';
const OPERATOR = 'system';
const REBATE_STATUS = 'CREDITED';
/** A user with no identity row any more reads as deleted (clawback-order.ts MISSING_USER). */
const MISSING_USER: CreditBeneficiaryState = Object.freeze({
  risk_state: 'normal',
  deletion_status: 'done',
  is_minor: false,
});

type Outcome = Schema<'AdminSettleAdjustOrderResult'>['outcome'];

interface OrderResult {
  readonly order_id: string;
  readonly outcome: Outcome;
  readonly credited_fen: bigint;
  /** Audit only: the amounts written (members and platform). */
  readonly members?: MemberAmount[];
  readonly forfeits?: ForfeitAmount[];
  readonly platform_fen?: bigint;
}

type FailedOrder = { order_id: string; outcome: 'failed'; error: string };
type MemberAmount = { role: string; amount_fen: string; posting: string };
/** A share the approval gave the platform (BR-CALC-09), recorded with its reason (money r1 S1). */
export type ForfeitAmount = { role: string; amount_fen: string; reason: string };

function identity(userId: string, role: string): string {
  return `${userId}\u0000${role}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function fieldsRefusal(fields: readonly string[], traceId: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return { status: refused.statusCode, envelope: refused.body };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: BATCH_RESOURCE },
      trace_id: traceId,
    },
  };
}

function step(event: 'APPROVE' | 'REJECT' | 'VOID_STALE_SEQ'): string {
  const result = transitionSettleAdjustment('pending', event);
  if (!result.ok) throw new Error(`settlement adjust: illegal candidate transition ${event}`);
  return result.to;
}

interface CandidateRow {
  readonly id: string;
  readonly order_id: string;
  readonly settle_seq: number;
  readonly commission_version: number;
  readonly status: string;
  readonly row_version: number;
}

type BatchRow = { readonly batch_id: string; readonly confirmed_at: Date | null };

async function readBatch(
  db: Kysely<DB> | Transaction<DB>,
  appId: string,
  batchId: string,
): Promise<BatchRow | undefined> {
  return db
    .withSchema('app')
    .selectFrom('settle_adjust_batches')
    .select(['batch_id', 'confirmed_at'])
    .where('app_id', '=', appId)
    .where('batch_id', '=', batchId)
    .executeTakeFirst();
}

/** The batch's orders, each once (the candidates of a batch name one seq per order). */
async function batchOrders(db: Kysely<DB>, appId: string, batchId: string): Promise<string[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('settle_adjustments')
    .select('order_id')
    .distinct()
    .where('app_id', '=', appId)
    .where('batch_id', '=', batchId)
    .orderBy('order_id')
    .execute();
  return rows.map((r) => r.order_id);
}

async function lockedCandidates(
  trx: Transaction<DB>,
  appId: string,
  batchId: string,
  orderId: string,
): Promise<CandidateRow[]> {
  return trx
    .withSchema('app')
    .selectFrom('settle_adjustments')
    .select(['id', 'order_id', 'settle_seq', 'commission_version', 'status', 'row_version'])
    .where('app_id', '=', appId)
    .where('batch_id', '=', batchId)
    .where('order_id', '=', orderId)
    .orderBy('id')
    .forUpdate()
    .execute();
}

/** pending → `to` by row_version CAS; throws when a row moved (the order's lock makes it rare). */
async function decide(
  trx: Transaction<DB>,
  appId: string,
  rows: readonly CandidateRow[],
  set: {
    readonly status: string;
    readonly decided_at: Date;
    readonly approver?: string | null;
    readonly reason?: string | null;
  },
): Promise<void> {
  for (const r of rows) {
    const res = await trx
      .withSchema('app')
      .updateTable('settle_adjustments')
      .set({
        status: set.status,
        decided_at: set.decided_at,
        ...(set.approver === undefined ? {} : { approver: set.approver }),
        ...(set.reason === undefined ? {} : { reason: set.reason }),
        row_version: r.row_version + 1,
      })
      .where('app_id', '=', appId)
      .where('id', '=', r.id)
      .where('status', '=', 'pending')
      .where('row_version', '=', r.row_version)
      .executeTakeFirst();
    if (res.numUpdatedRows !== 1n) throw new Error('settlement adjust: candidate CAS failed');
  }
}

/** The batch is confirmed once none of its candidates is pending (same transaction as the audit). */
async function confirmIfDone(
  trx: Transaction<DB>,
  appId: string,
  batchId: string,
  adminId: string,
  now: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .updateTable('settle_adjust_batches')
    .set({ confirmed_by: adminId, confirmed_at: now })
    .where('app_id', '=', appId)
    .where('batch_id', '=', batchId)
    .where('confirmed_at', 'is', null)
    .where(
      sql<boolean>`not exists (select 1 from app.settle_adjustments c where c.app_id = ${appId} and c.batch_id = ${batchId} and c.status = 'pending')`,
    )
    .execute();
}

/** open → done (an obligation whose difference the approval credited whole, BR-FUND-04 ⑫). */
async function closeDone(
  trx: Transaction<DB>,
  row: BeneficiaryCreditRow,
  closedRef: string,
  voucherId: string | null,
  now: Date,
): Promise<void> {
  const next = transitionBeneficiaryCredit('open', 'COMPLETE');
  if (!next.ok || next.noop || next.to !== 'done') {
    throw new Error('settlement adjust: illegal obligation transition');
  }
  const res = await trx
    .withSchema('app')
    .updateTable('beneficiary_credits')
    .set({
      status: next.to,
      closed_by: 'R10',
      closed_ref: closedRef,
      // The SETTLE_ADJUST voucher that fulfilled it (BC2: closed with the voucher that paid it).
      voucher_id: voucherId,
      closed_at: now,
      row_version: row.row_version + 1,
    })
    .where('app_id', '=', row.app_id)
    .where('beneficiary_credit_id', '=', row.beneficiary_credit_id)
    .where('status', '=', 'open')
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  if (res.numUpdatedRows !== 1n) throw new Error('settlement adjust: obligation CAS failed');
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
    // Approval credits a member whose state is normal now in full, an open obligation included
    // (it closes as done); frozen / appealing defer by their risk state (BR-CALC-09, D10-770 ②).
    const status: AdjustmentBeneficiary['status'] = isForfeitedShare(b, snapshot.forfeitedEvents)
      ? 'forfeited'
      : 'active';
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
  memo: string | null = null,
): PostingVoucher {
  const entries: PostingEntry[] = built.entries.map((entry) => {
    if (entry.account.owner_type === 'user') {
      const accountId = accounts.get(entry.account.owner_id);
      if (accountId === undefined) {
        throw new Error('settlement adjust: a credited beneficiary has no locked balance');
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
    bizType: ADJUST_BIZ_TYPE,
    bizId: key,
    operator: OPERATOR,
    memo,
    orderKey: key,
    beneficiaryUserId: beneficiary?.userId ?? null,
    role: beneficiary?.role ?? null,
    voucherKind: 'SETTLE_ADJUST',
    entries,
  };
}

/** No voucher, no booked change and no obligation to settle: the recomputed difference is 0. */
function isZero(plan: AdjustmentPlan, order: OrderRow): boolean {
  return (
    plan.platform_delta_fen === 0n &&
    plan.beneficiaries.every(
      (b) =>
        b.delta_fen === 0n &&
        b.forfeit_fen === 0n &&
        b.pending_after_fen === b.pending_before_fen &&
        (b.obligation_action === null || b.obligation_action === 'keep'),
    ) &&
    plan.booked_after.booked_base_fen === order.booked_base_fen &&
    plan.booked_after.booked_n_fen === order.booked_n_fen
  );
}

/** The shares a plan gives the platform with their reason (BR-CALC-09; banned / deleted / minor). */
export function forfeitsOf(plan: AdjustmentPlan): ForfeitAmount[] {
  return plan.beneficiaries
    .filter((b) => b.forfeit_fen !== 0n && b.forfeit_reason !== null)
    .map((b) => ({
      role: b.role,
      amount_fen: String(b.forfeit_fen),
      reason: b.forfeit_reason as string,
    }));
}

/**
 * Where an order's forfeit reasons are kept, all inside the order's transaction (BR-CALC-13: with
 * the voucher, in memo): the platform voucher when the platform's difference is not 0; else the
 * first member INCREASE voucher; with neither (the platform's rounding cancelled the forfeited
 * amount, e.g. 1009 → 1010 with one member banned and one frozen) an audit record of its own.
 */
export function forfeitCarrier(
  plan: AdjustmentPlan,
): 'none' | 'platform_voucher' | 'member_voucher' | 'audit' {
  if (forfeitsOf(plan).length === 0) return 'none';
  if (plan.platform_delta_fen !== 0n) return 'platform_voucher';
  return plan.beneficiaries.some((b) => b.delta_fen > 0n) ? 'member_voucher' : 'audit';
}

function makeDecider(deps: SettleAdjustDecisionDeps) {
  const { db, clock, gate, ledger } = deps;

  /** One order of the batch, on its own transaction under the order's lock. */
  async function approveOrder(
    appId: string,
    batchId: string,
    orderId: string,
    adminId: string,
    ip: string | null,
  ): Promise<OrderResult> {
    return db.transaction().execute(async (trx): Promise<OrderResult> => {
      const locator = await readOrderLocator(trx, appId, orderId);
      if (locator === undefined) throw new Error('settlement adjust: order not found for app');
      await lockOrderKey(trx, locator.platform, locator.sub_order_id);
      const key = orderKey(locator.platform, locator.sub_order_id);
      const rows = await lockedCandidates(trx, appId, batchId, orderId);
      const pending = rows.filter((r) => r.status === 'pending');
      const none = { order_id: orderId, credited_fen: 0n } as const;
      if (pending.length === 0) {
        if (rows.length > 0 && rows.every((r) => r.status === 'voided_by_clawback')) {
          return { ...none, outcome: 'voided_by_clawback' };
        }
        if (rows.length > 0 && rows.every((r) => r.status === 'voided_stale_seq')) {
          return { ...none, outcome: 'voided_stale_seq' };
        }
        return { ...none, outcome: 'already_decided' };
      }
      const now = clock.now();
      const order = await readRebateOrder(trx, { appId, orderId, attrAt: locator.attr_at });
      if (order === undefined) throw new Error('settlement adjust: order not found for app');
      const candidateSeq = pending[0]!.settle_seq;
      const seq = await readLatestSettleSeq(trx, appId, orderId);
      if (
        seq !== candidateSeq ||
        pending.some((r) => r.settle_seq !== candidateSeq) ||
        pending.some((r) => r.commission_version !== order.commission_version)
      ) {
        await decide(trx, appId, pending, { status: step('VOID_STALE_SEQ'), decided_at: now });
        return { ...none, outcome: 'voided_stale_seq' };
      }
      if (
        order.rebate_status !== REBATE_STATUS ||
        order.settle_commission_fen === null ||
        order.booked_base_fen === null ||
        order.booked_n_fen === null
      ) {
        // Left CREDITED without its candidates being voided (a clawback voids them, 决-10 A):
        // nothing to approve on this order.
        throw new Error('settlement adjust: candidate order is no longer CREDITED');
      }
      const snapshot = await deps.readSnapshot(trx, {
        appId,
        orderId,
        commissionVersion: order.commission_version,
      });
      if (snapshot === null) throw new Error('settlement adjust: order has no commission snapshot');
      const reserveBp = BigInt(snapshot.reserveBp);

      // users rows → balance rows → states after the locks (B2-04m lock flow).
      const userIds = [...new Set(snapshot.beneficiaries.map((b) => b.userId))].sort();
      const locked =
        userIds.length === 0 ? new Set<string>() : await gate.lockUsers(trx, { appId, userIds });
      const present = userIds.filter((id) => locked.has(id));
      for (const userId of present) await ledger.openUserAccount(trx, { appId, userId });
      const balances =
        present.length === 0 ? [] : await ledger.lockBalances(trx, { appId, userIds: present });
      const accounts = new Map(balances.map((row) => [row.user_id, row.account_id]));
      const states =
        present.length === 0
          ? new Map<string, CreditBeneficiaryState>()
          : await gate.readStates(trx, { appId, userIds: present });
      const stored = await deps.readOrderNets(trx, { appId, orderKey: key });
      const nets = new Map(
        stored.beneficiaries.map((b) => [identity(b.beneficiary_user_id, b.role), b.net_fen]),
      );
      const obligations = new Map(
        (await readOpenObligations(trx, appId, orderId)).map((r) => [
          identity(r.user_id, r.role),
          r,
        ]),
      );
      const plan = planCommissionAdjustment({
        event: 'settlement',
        n_new_fen: order.settle_commission_fen,
        reserve_bp: reserveBp,
        booked_base_fen: order.booked_base_fen,
        booked_n_fen: order.booked_n_fen,
        platform_net_fen: stored.platform_net_fen,
        beneficiaries: beneficiariesOf(snapshot, states, nets, obligations),
      });
      const approved = step('APPROVE');
      if (isZero(plan, order)) {
        await decide(trx, appId, pending, { status: approved, decided_at: now, approver: adminId });
        return { ...none, outcome: 'approved_zero' };
      }
      if (plan.route !== 'approval' || plan.transition !== 'R10') {
        throw new Error(
          `settlement adjust: approval recomputed a ${String(plan.transition)}/${plan.route} plan`,
        );
      }
      const rebate = transitionOrderRebate(REBATE_STATUS, 'SETTLE_POSITIVE_DIFF_APPROVED');
      if (!rebate.ok || rebate.id !== 'R10' || rebate.to !== REBATE_STATUS) {
        throw new Error('settlement adjust: SETTLE_POSITIVE_DIFF_APPROVED is not a legal R10');
      }

      const base = { order_key: key, platform: order.platform, seq: String(seq) };
      // BR-CALC-13: a share the approval gives the platform keeps its forfeit_reason with the
      // voucher, in this order's transaction (no column: in memo, as credit-order.ts does), so a
      // failure of the batch audit afterwards never loses it (money r2 S1). On the platform
      // voucher; when the platform's difference is 0 (rounding), on the first member voucher.
      const forfeits = forfeitsOf(plan);
      const forfeitMemo =
        forfeits.length === 0
          ? null
          : forfeits
              .map((f) => `forfeit_reason=${f.reason} role=${f.role} forfeit_fen=${f.amount_fen}`)
              .join('; ');
      const delta = plan.platform_delta_fen;
      let memberMemo = delta === 0n ? forfeitMemo : null;
      let credited = 0n;
      const members: MemberAmount[] = [];
      const memberVouchers = new Map<string, string>();
      for (const b of plan.beneficiaries) {
        if (b.delta_fen === 0n) continue;
        if (b.delta_fen < 0n || b.posting !== 'user_available') {
          throw new Error('settlement adjust: the positive route posts member increases only');
        }
        const params: BuildVoucherParams = {
          ...base,
          user_id: b.user_id,
          role: b.role,
          adjust_fen: b.delta_fen,
        };
        const beneficiary = { userId: b.user_id, role: b.role as CreditRole };
        for (const built of buildVouchers('SETTLE_ADJUST:SETTLE_DIFF:USER:INCREASE', params)) {
          const posted = await ledger.post(
            trx,
            postingOf(appId, key, built, beneficiary, accounts, memberMemo),
          );
          // A stored `…:ADJ:{seq}` would mean an unpaid duplicate (both routes of BR-FUND-09 share
          // the key): fail this order instead of approving it without its money (review F1).
          if (posted.kind !== 'posted') {
            throw new Error(`settlement adjust: voucher ${built.uniq_key} already exists`);
          }
          memberVouchers.set(identity(b.user_id, b.role), posted.voucherId);
          memberMemo = null;
        }
        credited = addFen(credited, b.delta_fen);
        members.push({ role: b.role, amount_fen: String(b.delta_fen), posting: 'user_available' });
      }
      if (memberMemo !== null) {
        // No voucher to carry the reason (forfeitCarrier 'audit'): keep it in this transaction
        // with an audit record of its own (money r4 S1); amounts, vouchers, booked and
        // obligations are as before.
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: FORFEIT_AUDIT_ACTION,
          target: `orders:${orderId}`,
          before: null,
          after: { batch_id: batchId, order_id: orderId, settle_seq: seq, forfeits },
          ip,
        });
        memberMemo = null;
      }
      let platformVoucherId: string | null = null;
      if (delta !== 0n) {
        const template = `SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:${delta < 0n ? 'DECREASE' : 'INCREASE'}`;
        const params: BuildVoucherParams = {
          ...base,
          adjust_fen: delta < 0n ? subFen(0n, delta) : delta,
        };
        for (const built of buildVouchers(template, params)) {
          const posted = await ledger.post(
            trx,
            postingOf(appId, key, built, null, accounts, forfeitMemo),
          );
          if (posted.kind !== 'posted') {
            throw new Error(`settlement adjust: voucher ${built.uniq_key} already exists`);
          }
          platformVoucherId = posted.voucherId;
        }
      }
      // The answer's credited_fen leaves as a JSON number: an amount beyond the safe integer range
      // fails this order here, before anything of it commits (money r2 S2).
      fenToJsonNumber(credited);

      await settleObligations(
        trx,
        order,
        batchId,
        plan.beneficiaries,
        obligations,
        memberVouchers,
        platformVoucherId,
        now,
      );

      const written = await casClawbackOrder(trx, order, {
        to: rebate.to,
        booked_base_fen: plan.booked_after.booked_base_fen,
        booked_n_fen: plan.booked_after.booked_n_fen,
        at: now,
      });
      if (!written) throw new Error('settlement adjust: order CAS matched no row');
      await insertRebateHistory(
        trx,
        { app_id: appId, order_id: orderId },
        [{ from: REBATE_STATUS, event: 'SETTLE_POSITIVE_DIFF_APPROVED', to: rebate.to }],
        'system',
        now,
      );
      await decide(trx, appId, pending, { status: approved, decided_at: now, approver: adminId });
      return {
        order_id: orderId,
        outcome: 'approved',
        credited_fen: credited,
        members,
        forfeits,
        platform_fen: delta,
      };
    });
  }

  /** BR-FUND-04 ⑫: the obligations the approval disposes of, same transaction. */
  async function settleObligations(
    trx: Transaction<DB>,
    order: OrderRow,
    batchId: string,
    rows: readonly AdjustmentBeneficiaryResult[],
    obligations: ReadonlyMap<string, BeneficiaryCreditRow>,
    vouchers: ReadonlyMap<string, string>,
    platformVoucherId: string | null,
    now: Date,
  ): Promise<void> {
    for (const b of rows) {
      const action = b.obligation_action;
      if (action === null || action === 'keep') continue;
      if (action === 'open') {
        // Frozen / appealing at approval: the difference waits as a deferred obligation (D10-770 ②).
        await insertDeferredObligation(trx, {
          beneficiary_credit_id: randomUUID(),
          app_id: order.app_id,
          order_id: order.order_id,
          user_id: b.user_id,
          role: b.role as CreditRole,
          opened_ref: `settle_adjust_batch:${batchId}`,
          split_ref: `commission_version:${String(order.commission_version)}`,
          opened_at: now,
        });
        continue;
      }
      const row = obligations.get(identity(b.user_id, b.role));
      if (row === undefined) throw new Error('settlement adjust: obligation not found');
      if (action === 'done') {
        await closeDone(
          trx,
          row,
          `settle_adjust_batch:${batchId}`,
          vouchers.get(identity(b.user_id, b.role)) ?? null,
          now,
        );
        continue;
      }
      if (action !== 'forfeited') {
        throw new Error(`settlement adjust: unexpected obligation action ${action}`);
      }
      const next = transitionBeneficiaryCredit('open', 'FORFEIT');
      if (!next.ok || next.noop || next.to !== 'forfeited') {
        throw new Error('settlement adjust: illegal obligation transition');
      }
      const closed = await closeObligation(trx, {
        app_id: order.app_id,
        beneficiary_credit_id: row.beneficiary_credit_id,
        row_version: row.row_version,
        status: 'forfeited',
        closed_by: 'R10',
        closed_ref: `settle_adjust_batch:${batchId}`,
        // B2-04zzb (BR-FUND-04 ⑫): the platform voucher this transaction wrote; null when the
        // platform's difference is 0 (closed_ref then names the batch).
        voucher_id: platformVoucherId,
        closed_at: now,
      });
      if (!closed) throw new Error('settlement adjust: obligation CAS matched no row');
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

  return { approveOrder };
}

/** int64 fen as a JSON number; beyond the safe integer range it throws (never rounds). */
const json = (value: bigint): number => fenToJsonNumber(value);

export async function approveSettleAdjustBatch(
  deps: SettleAdjustDecisionDeps,
  operator: SettleAdjustOperator,
  call: ApproveSettleAdjustBatchCall,
): Promise<SettleAdjustAnswer> {
  const { appId, adminId, ip } = operator;
  const { batchId, traceId } = call;
  const decider = makeDecider(deps);
  // Standard mode (not the transactional one): each order runs on its own transaction and the
  // audit on another, one connection at a time per request (the admin pool holds 3, B2-09x).
  const answer = await deps.idempotency.execute(
    {
      appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
      method: 'POST',
      path: `/admin/v1/settle-adjust-batches/${batchId}/approve`,
      key: call.key,
      body: call.body,
      traceId,
    },
    async (): Promise<HandlerResult> => {
      const batch = await readBatch(deps.db, appId, batchId);
      if (batch === undefined) return fieldsRefusal(['batch_id'], traceId);
      if (batch.confirmed_at !== null) return conflictRefusal(traceId);
      const results: OrderResult[] = [];
      const failed: FailedOrder[] = [];
      for (const orderId of await batchOrders(deps.db, appId, batchId)) {
        try {
          results.push(await decider.approveOrder(appId, batchId, orderId, adminId, ip));
        } catch (error: unknown) {
          // One order's failure never blocks another's; it stays pending (rolled back).
          failed.push({ order_id: orderId, outcome: 'failed', error: errorName(error) });
          deps.logger.error(
            { app_id: appId, batch_id: batchId, order_id: orderId, error_name: errorName(error) },
            'settle adjust approval: order failed, nothing of it was written',
          );
        }
      }
      const now = deps.clock.now();
      await deps.db.transaction().execute(async (trx) => {
        await confirmIfDone(trx, appId, batchId, adminId, now);
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: APPROVE_AUDIT_ACTION,
          target: batchId,
          before: null,
          after: {
            batch_id: batchId,
            results: [
              ...results.map((r) => ({
                order_id: r.order_id,
                outcome: r.outcome,
                credited_fen: String(r.credited_fen),
                ...(r.outcome === 'approved_zero' ? { note: '批准时差额为 0' } : {}),
                ...(r.members === undefined ? {} : { members: r.members }),
                ...(r.forfeits === undefined || r.forfeits.length === 0
                  ? {}
                  : { forfeits: r.forfeits }),
                ...(r.platform_fen === undefined ? {} : { platform_fen: String(r.platform_fen) }),
              })),
              ...failed,
            ],
          },
          ip,
        });
      });
      if (failed.length > 0) {
        // The orders written stay written (each committed on its own); the call fails as a whole
        // and is not stored, so the next approval of the batch takes the failed orders again.
        throw new Error(`settle adjust approval: ${String(failed.length)} order(s) failed`);
      }
      const data: Schema<'AdminSettleAdjustBatchApproveResponse'>['data'] = {
        batch_id: batchId,
        results: results.map((r) => ({
          order_id: r.order_id,
          outcome: r.outcome,
          credited_fen: json(r.credited_fen),
        })),
      };
      return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
    },
  );
  return { status: answer.status, body: answer.body };
}

export async function rejectSettleAdjustBatch(
  deps: SettleAdjustDecisionDeps,
  operator: SettleAdjustOperator,
  call: RejectSettleAdjustBatchCall,
): Promise<SettleAdjustAnswer> {
  const { appId, adminId, ip } = operator;
  const { batchId, traceId, body } = call;
  return deps.idempotency
    .executeInTransaction(
      {
        appId,
        actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: adminId },
        method: 'POST',
        path: `/admin/v1/settle-adjust-batches/${batchId}/reject`,
        key: call.key,
        body,
        traceId,
      },
      async (trx): Promise<HandlerResult> => {
        const batch = await trx
          .withSchema('app')
          .selectFrom('settle_adjust_batches')
          .select(['batch_id', 'confirmed_at'])
          .where('app_id', '=', appId)
          .where('batch_id', '=', batchId)
          .forUpdate()
          .executeTakeFirst();
        if (batch === undefined) return fieldsRefusal(['batch_id'], traceId);
        if (batch.confirmed_at !== null) return conflictRefusal(traceId);
        const pending = await trx
          .withSchema('app')
          .selectFrom('settle_adjustments')
          .select(['id', 'order_id', 'settle_seq', 'commission_version', 'status', 'row_version'])
          .where('app_id', '=', appId)
          .where('batch_id', '=', batchId)
          .where('status', '=', 'pending')
          .orderBy('id')
          .forUpdate()
          .execute();
        const now = deps.clock.now();
        await decide(trx, appId, pending, {
          status: step('REJECT'),
          decided_at: now,
          approver: adminId,
          reason: body.reason,
        });
        await confirmIfDone(trx, appId, batchId, adminId, now);
        await deps.auditOn(trx).append({
          appId,
          actor: adminId,
          action: REJECT_AUDIT_ACTION,
          target: batchId,
          before: null,
          after: { batch_id: batchId, rejected_count: pending.length, reason: body.reason },
          ip,
        });
        const data: Schema<'AdminSettleAdjustBatchRejectResponse'>['data'] = {
          batch_id: batchId,
          rejected_count: pending.length,
        };
        return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
      },
    )
    .then(answerFrom);
}

function answerFrom(answer: {
  readonly status: number;
  readonly body: string;
}): SettleAdjustAnswer {
  return { status: answer.status, body: answer.body };
}

export async function listSettleAdjustments(
  deps: Pick<SettleAdjustDecisionDeps, 'db' | 'maskedPhones'>,
  appId: string,
  query: ListSettleAdjustmentsQuery,
): Promise<Schema<'AdminSettleAdjustmentPage'>> {
  const { db } = deps;
  let filtered = db.withSchema('app').selectFrom('settle_adjustments').where('app_id', '=', appId);
  if (query.status !== undefined) filtered = filtered.where('status', '=', query.status);
  if (query.batchId !== undefined) filtered = filtered.where('batch_id', '=', query.batchId);
  const counted = await filtered
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirstOrThrow();
  const rows = await filtered
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const waiting = new Set(
    orderIds.length === 0
      ? []
      : (
          await db
            .withSchema('app')
            .selectFrom('order_rights')
            .select('order_id')
            .distinct()
            .where('app_id', '=', appId)
            .where('order_id', 'in', orderIds)
            // 08 E-32: a rights case the union has not answered yet.
            .where('status', 'in', ['PROCESSING', 'WAIT_COMMISSION'])
            .execute()
        ).map((r) => r.order_id),
  );
  const userIds = [...new Set(rows.flatMap((r) => (r.user_id === null ? [] : [r.user_id])))];
  const phones = await deps.maskedPhones(appId, userIds);
  return {
    items: rows.map((r) => ({
      id: r.id,
      batch_id: r.batch_id,
      order_id: r.order_id,
      user:
        r.user_id === null
          ? null
          : { user_id: r.user_id, phone_masked: phones.get(r.user_id) ?? null },
      role: r.role as Schema<'AdminSettleAdjustment'>['role'],
      settle_seq: r.settle_seq,
      diff_fen: json(r.diff_fen),
      status: r.status as Schema<'AdminSettleAdjustment'>['status'],
      rights_waiting: waiting.has(r.order_id),
      reason: r.reason,
      approver_id: r.approver,
      decided_at: r.decided_at === null ? null : r.decided_at.toISOString(),
      created_at: r.created_at.toISOString(),
    })),
    page: query.page,
    page_size: query.pageSize,
    total: Number(counted.total),
  };
}
