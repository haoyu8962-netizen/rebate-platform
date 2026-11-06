// B2-12d (contracts/openapi.yaml adminApproveAdjustment, adminRejectAdjustment; 08 BR-FUND-24
// ①⑥⑧, 细则「驳回与撤回不需二次验证」「注销调减单被驳回与注销中的调账」; BR-ID-28; D10-590 ③⑦): the
// system-prefilled ACCOUNT_CLOSED decrease of a deletion — its prefill, the closing gate the
// deletion completion asks, and its approval / rejection on the admin console.
//
// - prefill (identity's DeletionClosingAdjustmentPrefill, on identity's transaction with the users
//   row locked): one PENDING decrease ACCOUNT_CLOSED without amount, filer or note, contra
//   COMMISSION_REVENUE, refs the deletion request; only while available > 0, no PENDING one exists
//   (partial unique key admin_adjustments_account_closed_pending_key as the last word) and no
//   ACCOUNT_CLOSED form of the member was created or reviewed on the accounting day of `at` (at most
//   one new form per accounting day; a form rejected, approved or reversed today is rebuilt the
//   next day, D10-590 ③). The row's status comes from the generated transition (PREFILL from no
//   row); only when the insert actually lands, one system audit record (system:ledger,
//   adjustment_prefill: brand, member, form, deletion request) on the same transaction — a skip on
//   the partial unique key writes none. The rebuild after a rejection goes the same way.
// - gate (identity's DeletionClosingAdjustmentReader, in the completion transaction, users row
//   locked): the balance row is locked too (users → balances, the funds order); a PENDING
//   ACCOUNT_CLOSED form or available ≠ 0 → pending; otherwise done when an APPROVED ACCOUNT_CLOSED
//   decrease exists, none_needed when not. Never only "an APPROVED form exists": a reversal brings
//   the balance back.
// - approve: under platform idempotency (transactional), users row then balance row then the form
//   row locked (lockUsers → ledger.lockBalances → SELECT … FOR UPDATE on admin_adjustments), the
//   form re-read under its own lock so a rejection (which locks the same row) runs strictly before
//   or after; the status comes from the generated transition (APPROVE); a form no longer PENDING →
//   20902, which the idempotency module does not store, so the whole transaction (voucher and
//   balance included) rolls back; the amount is the available
//   read under the balance lock; voucher ADJ:{adjust_id} (ADMIN_ADJUST:ACCOUNT_CLOSED), the form
//   APPROVED, the adjustment_approve audit record, one transaction. No in-app message (⑧).
// - reject: no step-up (the controller runs the guard read-only), reason trimmed 1–200 characters,
//   the form row locked (SELECT … FOR UPDATE, the same lock the approval takes) and re-read, the
//   generated transition (REJECT) decides, a conditional update PENDING → REJECTED, the
//   adjustment_reject audit record; no voucher. Lost race → 20902, nothing kept.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import {
  accountingDate,
  buildVouchers,
  chinaDayRange,
  transitionAdminAdjustment,
  type AdminAdjustmentEvent,
  type AdminAdjustmentState,
} from '@couli/domain';
import { fenToJsonNumber, subFen } from '@couli/money';
import { sql, type Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type HandlerResult,
  type IdempotentResponse,
} from '../../platform/index.ts';
import { findAdminAdjustment } from '../infra/admin-adjustments-store.ts';
import { lockBalancesByUser, readBalancesByUser } from '../infra/store.ts';
import {
  ADJUSTMENTS_PATH,
  adjustmentView,
  type AdminAdjustmentCreateDeps,
} from './admin-adjustment.ts';
import type { PostingEntry } from './ledger.ts';

/** identity's ClosingAdjustmentState (none_needed / pending / done). */
export type ClosingAdjustmentGateState = 'none_needed' | 'pending' | 'done';

export interface ClosingAdjustmentSubject {
  readonly appId: string;
  readonly userId: string;
}

export interface ClosingAdjustmentPrefillRequest extends ClosingAdjustmentSubject {
  /** deletion_requests.id, the form's one ref (ref_type account_deletion). */
  readonly deletionRequestId: string;
  readonly at: Date;
}

/** POST /admin/v1/adjustments/{adjust_id}/approve after the route schema and the guard. */
export interface AdminAdjustmentApproveRequest {
  readonly appId: string;
  /** admin_users.id of the caller (reviewer of the form). */
  readonly adminId: string;
  readonly ip: string | null;
  readonly adjustId: string;
  /** The raw request body (the idempotency hash). */
  readonly rawBody: unknown;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** POST /admin/v1/adjustments/{adjust_id}/reject after the route schema and the guard. */
export interface AdminAdjustmentRejectRequest extends AdminAdjustmentApproveRequest {
  /** The reason as sent (trimmed and checked here: 1–200 characters). */
  readonly reason: string;
}

/** The audit actions of the contract (adminApproveAdjustment, adminRejectAdjustment). */
export const ADJUSTMENT_APPROVE_ACTION = 'adjustment_approve';
export const ADJUSTMENT_REJECT_ACTION = 'adjustment_reject';
/** The system audit of the prefill (BR-FUND-24 ①「全程写 audit_logs」, ⑧). */
export const ADJUSTMENT_PREFILL_ACTION = 'adjustment_prefill';
export const ADJUSTMENT_PREFILL_ACTOR = 'system:ledger';

/** admin's system audit, by shape: ledger imports nothing from admin (as payout's went-negative). */
export interface ClosingAdjustmentAuditPort {
  appendAction(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly actor: typeof ADJUSTMENT_PREFILL_ACTOR;
      readonly action: typeof ADJUSTMENT_PREFILL_ACTION;
      readonly target: string;
      readonly before: { readonly status: null };
      readonly after: {
        readonly app_id: string;
        readonly adjust_id: string;
        readonly user_id: string;
        readonly deletion_request_id: string;
        readonly reason_code: string;
        readonly direction: 'decrease';
        readonly status: string;
      };
    },
  ): Promise<void>;
}

export interface ClosingAdjustmentPrefillDeps {
  /** The system audit, bound to the caller's transaction (written only for a landed insert). */
  readonly audit: ClosingAdjustmentAuditPort;
}

const CLOSING = 'ACCOUNT_CLOSED';
const CLOSING_TEMPLATE = 'ADMIN_ADJUST:ACCOUNT_CLOSED';
const CLOSING_CONTRA = 'COMMISSION_REVENUE';
const BIZ_TYPE = 'admin_adjustment';
/** contracts AdminUserReason: 1–200 characters after trimming. */
const REASON_MAX = 200;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
/**
 * The generated transition of admin_adjustments.status (AGENTS.md §4.2): the target state, or
 * null when the event is not legal from `from`.
 */
function nextStatus(from: string | null, event: AdminAdjustmentEvent): AdminAdjustmentState | null {
  const result = transitionAdminAdjustment(from as AdminAdjustmentState | null, event);
  return result.ok && !result.noop ? result.to : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// Reads on the caller's transaction.

async function availableOf(
  trx: Transaction<DB>,
  subject: ClosingAdjustmentSubject,
  lock: boolean,
): Promise<bigint> {
  const rows = lock
    ? await lockBalancesByUser(trx, subject.appId, [subject.userId])
    : await readBalancesByUser(trx, subject.appId, [subject.userId]);
  const own = rows.find((row) => row.user_id === subject.userId);
  return own === undefined ? 0n : own.available_fen;
}

async function hasPendingClosing(
  trx: Transaction<DB>,
  subject: ClosingAdjustmentSubject,
): Promise<boolean> {
  const row = await trx
    .withSchema('app')
    .selectFrom('admin_adjustments')
    .select('adjust_id')
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('reason_code', '=', CLOSING)
    .where('status', '=', 'PENDING')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * An ACCOUNT_CLOSED form of the member created or reviewed within the +08:00 day [start, end)
 * (chinaDayRange's offset-qualified bounds, cast by the database).
 */
async function closingActivityWithin(
  trx: Transaction<DB>,
  subject: ClosingAdjustmentSubject,
  day: { readonly start: string; readonly end: string },
): Promise<boolean> {
  const start = sql<Date>`${day.start}::timestamptz`;
  const end = sql<Date>`${day.end}::timestamptz`;
  const row = await trx
    .withSchema('app')
    .selectFrom('admin_adjustments')
    .select('adjust_id')
    .where('app_id', '=', subject.appId)
    .where('user_id', '=', subject.userId)
    .where('reason_code', '=', CLOSING)
    .where((eb) =>
      eb.or([
        eb.and([eb('created_at', '>=', start), eb('created_at', '<', end)]),
        eb.and([eb('reviewed_at', '>=', start), eb('reviewed_at', '<', end)]),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Prefill and gate (identity's ports, assembled by app.module).

/**
 * Inserts the PENDING ACCOUNT_CLOSED decrease of the member on the caller's transaction (users row
 * locked): no amount, no filer, contra COMMISSION_REVENUE, refs the deletion request. Nothing when
 * available is not above 0, a PENDING one exists, or an ACCOUNT_CLOSED form of the member was
 * created or reviewed on the accounting day of `at`.
 */
export async function prefillClosingAdjustment(
  trx: Transaction<DB>,
  input: ClosingAdjustmentPrefillRequest,
  deps: ClosingAdjustmentPrefillDeps,
): Promise<{ readonly created: boolean }> {
  const subject = { appId: input.appId, userId: input.userId };
  if (await hasPendingClosing(trx, subject)) return { created: false };
  if ((await availableOf(trx, subject, false)) <= 0n) return { created: false };
  const day = chinaDayRange(accountingDate(input.at));
  if (await closingActivityWithin(trx, subject, day)) {
    return { created: false };
  }
  const status = nextStatus(null, 'PREFILL');
  if (status === null) throw new Error('ledger: PREFILL must be legal from no row');
  const adjustId = newUuidV7(input.at);
  const inserted = await trx
    .withSchema('app')
    .insertInto('admin_adjustments')
    .values({
      adjust_id: adjustId,
      app_id: input.appId,
      user_id: input.userId,
      direction: 'decrease',
      amount_fen: null,
      reason_code: CLOSING,
      refs: JSON.stringify([{ ref_type: 'account_deletion', ref_id: input.deletionRequestId }]),
      contra_subject: CLOSING_CONTRA,
      contra_platform: null,
      note: null,
      status,
      reverses_adjust_id: null,
      created_by: null,
      created_at: input.at,
      reviewed_by: null,
      reviewed_at: null,
      reject_note: null,
      voucher_id: null,
    })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'user_id'])
        .where('reason_code', '=', CLOSING)
        .where('status', '=', 'PENDING')
        .doNothing(),
    )
    .returning(['adjust_id', 'status'])
    .executeTakeFirst();
  if (inserted === undefined) return { created: false };
  await deps.audit.appendAction(trx, {
    appId: input.appId,
    actor: ADJUSTMENT_PREFILL_ACTOR,
    action: ADJUSTMENT_PREFILL_ACTION,
    target: inserted.adjust_id,
    before: { status: null },
    after: {
      app_id: input.appId,
      adjust_id: inserted.adjust_id,
      user_id: input.userId,
      deletion_request_id: input.deletionRequestId,
      reason_code: CLOSING,
      direction: 'decrease',
      status: inserted.status,
    },
  });
  return { created: true };
}

/**
 * The closing gate on the caller's transaction (users row locked; the balance row is locked
 * here): available 0 and no PENDING ACCOUNT_CLOSED form → done (an APPROVED one exists) or
 * none_needed; anything else → pending.
 */
export async function closingAdjustmentGate(
  trx: Transaction<DB>,
  input: ClosingAdjustmentSubject,
): Promise<ClosingAdjustmentGateState> {
  const available = await availableOf(trx, input, true);
  if (await hasPendingClosing(trx, input)) return 'pending';
  if (available !== 0n) return 'pending';
  const approved = await trx
    .withSchema('app')
    .selectFrom('admin_adjustments')
    .select('adjust_id')
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('reason_code', '=', CLOSING)
    .where('direction', '=', 'decrease')
    .where('reverses_adjust_id', 'is', null)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  return approved === undefined ? 'none_needed' : 'done';
}

// ---------------------------------------------------------------------------------------------
// Refusals.

function fieldsRefusal(fields: readonly string[], traceId: string, reason?: string): HandlerResult {
  const refused = fieldsErrorEnvelope(fields, traceId);
  if (reason === undefined) return { status: refused.statusCode, envelope: refused.body };
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(traceId: string): HandlerResult {
  return {
    status: 409,
    envelope: {
      code: 20902,
      msg: CONFLICT_MESSAGE,
      data: { resource: 'admin_adjustment' },
      trace_id: traceId,
    },
  };
}

/**
 * Locks the form row (SELECT … FOR UPDATE) and re-reads it: approval and rejection both take
 * this lock, so one of them runs entirely after the other and sees its committed status.
 */
async function lockForm(trx: Transaction<DB>, appId: string, adjustId: string) {
  const locked = await trx
    .withSchema('app')
    .selectFrom('admin_adjustments')
    .select('adjust_id')
    .where('app_id', '=', appId)
    .where('adjust_id', '=', adjustId)
    .forUpdate()
    .executeTakeFirst();
  if (locked === undefined) return undefined;
  return findAdminAdjustment(trx, appId, adjustId);
}

function actionPathOf(adjustId: string, action: 'approve' | 'reject'): string {
  return `${ADJUSTMENTS_PATH}/${adjustId}/${action}`;
}

/** A PENDING system-prefilled ACCOUNT_CLOSED decrease (the only kind a PENDING form can be). */
function isPendingClosing(row: {
  readonly status: string;
  readonly reason_code: string;
  readonly direction: string;
  readonly reverses_adjust_id: string | null;
}): boolean {
  return (
    row.status === 'PENDING' &&
    row.reason_code === CLOSING &&
    row.direction === 'decrease' &&
    row.reverses_adjust_id === null
  );
}

// ---------------------------------------------------------------------------------------------
// Approval.

async function approve(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentApproveRequest,
  trx: Transaction<DB>,
): Promise<HandlerResult> {
  const { appId, adminId, traceId } = request;
  if (!UUID.test(request.adjustId)) return fieldsRefusal(['adjust_id'], traceId);
  const adjustId = request.adjustId.toLowerCase();
  const first = await findAdminAdjustment(trx, appId, adjustId);
  if (first === undefined) return fieldsRefusal(['adjust_id'], traceId);
  if (!isPendingClosing(first)) return conflictRefusal(traceId);

  // Users row, then the balance row (the funds order), then the form row itself (the lock a
  // rejection takes too), re-read under that lock.
  const locked = await deps.ports.lockUsers(trx, { appId, userIds: [first.user_id] });
  if (!locked.has(first.user_id)) return fieldsRefusal(['adjust_id'], traceId);
  const [balance] = await deps.ledger.lockBalances(trx, { appId, userIds: [first.user_id] });
  const form = await lockForm(trx, appId, adjustId);
  if (form === undefined) return fieldsRefusal(['adjust_id'], traceId);
  if (!isPendingClosing(form)) return conflictRefusal(traceId);
  const approved = nextStatus(form.status, 'APPROVE');
  if (approved === null) return conflictRefusal(traceId);

  // ⑧: the amount is the available read under the balance lock; not above 0 → refused, nothing
  // written, the form stays PENDING.
  const before = balance?.available_fen ?? 0n;
  if (balance === undefined || before <= 0n) {
    return fieldsRefusal(['adjust_id'], traceId, 'adjust_no_balance');
  }
  const amount = before;
  const after = subFen(before, amount);
  const now = deps.clock.now();

  const [built, ...extra] = buildVouchers(CLOSING_TEMPLATE, {
    adjust_id: adjustId,
    user_id: form.user_id,
    closing_balance_fen: amount,
  });
  if (built === undefined || extra.length > 0) {
    throw new Error('ledger: the closing template must build exactly one voucher');
  }
  const entries: PostingEntry[] = built.entries.map((entry) => ({
    account:
      entry.account.owner_type === 'user'
        ? { ownerType: 'user', accountId: balance.account_id }
        : { ownerType: 'platform', subject: entry.account.subject },
    sub_account: entry.sub_account ?? 'available',
    amount_fen: entry.amount_fen,
    ledger_type: entry.ledger_type,
    sub_type: entry.sub_type,
    income_type: null,
  }));
  const posted = await deps.ledger.post(trx, {
    appId,
    uniqKey: built.uniq_key,
    bizType: BIZ_TYPE,
    bizId: adjustId,
    operator: `admin:${adminId}`,
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'ADMIN_ADJUST',
    entries,
  });
  if (posted.kind !== 'posted') {
    throw new Error('ledger: a PENDING closing form found its voucher already posted');
  }

  const row = await trx
    .withSchema('app')
    .updateTable('admin_adjustments')
    .set((eb) => ({
      amount_fen: amount,
      status: approved,
      reviewed_by: adminId,
      reviewed_at: now,
      voucher_id: posted.voucherId,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('adjust_id', '=', adjustId)
    .where('status', '=', 'PENDING')
    .returningAll()
    .executeTakeFirst();
  // Unreachable under the form lock; should it happen, 20902 is not stored by the idempotency
  // module, so the voucher and the balance written above roll back with the transaction.
  if (row === undefined) return conflictRefusal(traceId);

  await deps.auditOn(trx).append({
    appId,
    actor: adminId,
    action: ADJUSTMENT_APPROVE_ACTION,
    target: adjustId,
    before: { status: 'PENDING', available_fen: before.toString() },
    after: {
      adjust_id: adjustId,
      user_id: row.user_id,
      reason_code: CLOSING,
      direction: 'decrease',
      amount_fen: amount.toString(),
      voucher_id: posted.voucherId,
      available_fen: after.toString(),
    },
    ip: request.ip,
  });

  const data: Schema<'AdminAdjustmentExecuted'> = {
    adjustment: adjustmentView(row, null),
    available_before_fen: fenToJsonNumber(before),
    available_after_fen: fenToJsonNumber(after),
  };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/** adminApproveAdjustment under platform idempotency: the exact bytes to send. */
export function approveAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentApproveRequest,
): Promise<IdempotentResponse> {
  return deps.idempotency.executeInTransaction(
    {
      appId: request.appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: request.adminId },
      method: 'POST',
      path: actionPathOf(request.adjustId, 'approve'),
      key: request.key,
      body: request.rawBody,
      traceId: request.traceId,
    },
    (trx) => approve(deps, request, trx),
  );
}

// ---------------------------------------------------------------------------------------------
// Rejection.

async function reject(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentRejectRequest,
  trx: Transaction<DB>,
): Promise<HandlerResult> {
  const { appId, adminId, traceId } = request;
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  const length = [...reason].length;
  if (length < 1 || length > REASON_MAX) return fieldsRefusal(['reason'], traceId);
  if (!UUID.test(request.adjustId)) return fieldsRefusal(['adjust_id'], traceId);
  const adjustId = request.adjustId.toLowerCase();
  // The form row locked (the approval takes the same lock), then re-read.
  const form = await lockForm(trx, appId, adjustId);
  if (form === undefined) return fieldsRefusal(['adjust_id'], traceId);
  if (!isPendingClosing(form)) return conflictRefusal(traceId);
  const rejected = nextStatus(form.status, 'REJECT');
  if (rejected === null) return conflictRefusal(traceId);

  const now = deps.clock.now();
  // Still conditional on PENDING (belt and braces under the lock): a lost race answers 20902.
  const row = await trx
    .withSchema('app')
    .updateTable('admin_adjustments')
    .set((eb) => ({
      status: rejected,
      reject_note: reason,
      reviewed_by: adminId,
      reviewed_at: now,
      row_version: eb('row_version', '+', 1),
    }))
    .where('app_id', '=', appId)
    .where('adjust_id', '=', adjustId)
    .where('status', '=', 'PENDING')
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) return conflictRefusal(traceId);

  await deps.auditOn(trx).append({
    appId,
    actor: adminId,
    action: ADJUSTMENT_REJECT_ACTION,
    target: adjustId,
    before: { status: 'PENDING' },
    after: {
      adjust_id: adjustId,
      user_id: row.user_id,
      reason_code: CLOSING,
      status: row.status,
      reason,
    },
    ip: request.ip,
  });

  const data: Schema<'AdminAdjustmentReject'> = { adjustment: adjustmentView(row, null) };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/** adminRejectAdjustment under platform idempotency: the exact bytes to send. */
export function rejectAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentRejectRequest,
): Promise<IdempotentResponse> {
  return deps.idempotency.executeInTransaction(
    {
      appId: request.appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: request.adminId },
      method: 'POST',
      path: actionPathOf(request.adjustId, 'reject'),
      key: request.key,
      body: request.rawBody,
      traceId: request.traceId,
    },
    (trx) => reject(deps, request, trx),
  );
}
