// B2-12c: manual balance adjustments of the admin console (contracts/openapi.yaml
// adminListAdjustments, adminGetAdjustment, adminCreateAdjustment; 08 BR-FUND-24 with 细则
// 「红冲只按原单整笔」「后台入口」 and D10-590 ④, BR-FUND-10, BR-FUND-16; specs/ledger-templates.csv
// ADMIN_ADJUST:*). The controller (http/admin/adjustments.controller.ts) only authorises through the
// AdminOperationGuard, takes the parameters and calls in here.
//
// One submission saves and approves at once: the form is born APPROVED (reviewed_by = created_by)
// and its ADMIN_ADJUST voucher (`ADJ:{adjust_id}`; a reversal `ADJ:{original}:REVERSE` with the
// trusted voucher kind ADMIN_ADJUST_REV, B2-12b) is posted in the same transaction under the
// member's locks (identity's users row → ledger.lockBalances), with the audit record and, on a
// decrease, the member's in-app message. Under platform idempotency (transactional mode, subject
// a:<admin_users.id>); 2xxxx refusals are not stored and roll back everything.
//
// Order of checks after the route schema and the guard (contract): the body (refs by reason code,
// note, contra subject) → the member / the original (unknown or of another app) → the linked
// documents (adjust_ref_invalid) → an original already reversed (20902 admin_adjustment) → the
// guards (reverse_not_allowed, adjust_user_deleted).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { addFen, fenToJsonNumber, parseFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import {
  fieldsErrorEnvelope,
  newUuidV7,
  type AuditPort,
  type Clock,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
} from '../../platform/index.ts';
import {
  countAdminAdjustments,
  findAdminAdjustment,
  findReversalOf,
  insertApprovedAdjustment,
  pageAdminAdjustments,
  readReconDiffSources,
  type AdminAdjustmentRow,
  type AdminAdjustmentRowWithReversal,
} from '../infra/admin-adjustments-store.ts';
import type { AccountBalance, Ledger, PostingEntry } from './ledger.ts';

export type AdminAdjustmentDirection = 'increase' | 'decrease';
export type AdminAdjustmentReasonCode =
  'RESTORE' | 'RECON_FIX' | 'PAYOUT_RECOVERY' | 'ACCOUNT_CLOSED' | 'OTHER';
export type AdminAdjustmentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type AdminAdjustmentRefType = 'recon_diff' | 'withdrawal' | 'order' | 'account_deletion';

export interface AdminAdjustmentRef {
  readonly ref_type: AdminAdjustmentRefType;
  readonly ref_id: string;
}

/** GET /admin/v1/adjustments after the route schema (filters combine with AND). */
export interface AdminAdjustmentListQuery {
  readonly appId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly reasonCode: AdminAdjustmentReasonCode | null;
  readonly status: AdminAdjustmentStatus | null;
  readonly userId: string | null;
}

/** A new form of POST /admin/v1/adjustments after the route schema. */
export interface AdminAdjustmentNewInput {
  readonly kind: 'new';
  readonly userId: string;
  readonly direction: AdminAdjustmentDirection;
  readonly amountFen: bigint;
  readonly reasonCode: 'RECON_FIX' | 'PAYOUT_RECOVERY' | 'OTHER';
  /** null when the request carries no refs. */
  readonly refs: readonly AdminAdjustmentRef[] | null;
  readonly note: string | null;
  readonly contraSubject: string | null;
  readonly contraPlatform: string | null;
}

/** A whole-form reversal of POST /admin/v1/adjustments after the route schema. */
export interface AdminAdjustmentReversalInput {
  readonly kind: 'reversal';
  readonly reversesAdjustId: string;
  readonly note: string;
}

export interface AdminAdjustmentCreateRequest {
  readonly appId: string;
  /** admin_users.id of the caller (filer and reviewer of the form). */
  readonly adminId: string;
  readonly ip: string | null;
  readonly body: AdminAdjustmentNewInput | AdminAdjustmentReversalInput;
  /** The raw request body (the idempotency hash). */
  readonly rawBody: unknown;
  /** The Idempotency-Key header, or undefined (→ 20001 by the idempotency module). */
  readonly key: string | undefined;
  readonly traceId: string;
}

/** identity's users.status as deletion stages (BR-ID-28): none / processing (deleting) / done. */
export type AdjustUserStatus = 'none' | 'processing' | 'done';

/** What app.module hands in from the other modules (ledger imports none of them). */
export interface AdminAdjustmentPorts {
  /** identity: users row locks (ascending id), returns the IDs locked of the app. */
  lockUsers(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ): Promise<ReadonlySet<string>>;
  /** identity: users.status as deletion stages; IDs not of the app are absent. */
  userStatus(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ): Promise<ReadonlyMap<string, AdjustUserStatus>>;
  /** payout: the linked withdrawals of the app with their member and cash subject. */
  withdrawals(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly withdrawalIds: readonly string[] },
  ): Promise<ReadonlyMap<string, { readonly userId: string; readonly cashSubject: string }>>;
  /** identity: the member of each deletion request of the app. */
  deletionOwners(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly ids: readonly string[] },
  ): Promise<ReadonlyMap<string, string>>;
  /** orders: the order_keys that name a sub-order of the app. */
  orderKeys(
    executor: Kysely<DB> | Transaction<DB>,
    input: { readonly appId: string; readonly orderKeys: readonly string[] },
  ): Promise<ReadonlySet<string>>;
  /** notification: the BALANCE_ADJUSTED inbox message on the adjustment transaction. */
  message(
    trx: Transaction<DB>,
    input: {
      readonly appId: string;
      readonly userId: string;
      readonly adjustId: string;
      readonly facts: {
        readonly direction: AdminAdjustmentDirection;
        readonly amount_fen: bigint;
        readonly reason_code: string;
      };
      readonly now: Date;
    },
  ): Promise<unknown>;
}

export interface AdminAdjustmentReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly ledger: Pick<Ledger, 'getBalances'>;
  readonly userStatus: AdminAdjustmentPorts['userStatus'];
}

export interface AdminAdjustmentCreateDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** admin's audit writer bound to the submission's transaction. */
  readonly auditOn: (trx: Kysely<DB>) => AuditPort;
  /** The entry's ledger with its event bus and payout's recovery hook (D10-587). */
  readonly ledger: Ledger;
  readonly ports: AdminAdjustmentPorts;
}

/** A read refusal: 20001 with data.fields (thrown for the controller's error envelope). */
export class AdminAdjustmentFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`admin adjustment refused: ${fields.join(',')}`);
    this.name = 'AdminAdjustmentFieldsError';
    this.fields = fields;
  }
}

/** The audit actions of the contract (adminCreateAdjustment). */
export const ADJUSTMENT_CREATE_ACTION = 'adjustment_create';
export const ADJUSTMENT_REVERSE_ACTION = 'adjustment_reverse';
export const ADJUSTMENT_DENIED_ACTION = 'adjustment_denied';

export const ADJUSTMENTS_PATH = '/admin/v1/adjustments';
const BIZ_TYPE = 'admin_adjustment';
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
/** BR-TEXT-14 fallback text of 20902 (contracts/texts.default.json error.20902). */
const CONFLICT_MESSAGE = '状态已变化，请刷新后重试';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** specs/ledger-rules.md §6 方案 A: what RECON_FIX and OTHER may choose. */
const CHOOSABLE_SUBJECTS: ReadonlySet<string> = new Set([
  'COMMISSION_REVENUE',
  'UNION_RECEIVABLE',
  'BAD_DEBT',
  'MKT_EXPENSE',
]);

// ---------------------------------------------------------------------------------------------
// Views.

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

function refsOf(value: unknown): Schema<'AdminAdjustmentRef'>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) => {
    const ref = item as { ref_type: unknown; ref_id: unknown };
    return {
      ref_type: ref.ref_type as Schema<'AdminAdjustmentRefType'>,
      ref_id: String(ref.ref_id),
    };
  });
}

/** The AdminAdjustment of a row; `reversedBy` from the reversal row. */
export function adjustmentView(
  row: AdminAdjustmentRow,
  reversedBy: string | null,
): Schema<'AdminAdjustment'> {
  return {
    adjust_id: row.adjust_id,
    user_id: row.user_id,
    direction: row.direction as AdminAdjustmentDirection,
    amount_fen: row.amount_fen === null ? null : fenToJsonNumber(row.amount_fen),
    reason_code: row.reason_code as AdminAdjustmentReasonCode,
    refs: refsOf(row.refs),
    contra_subject: row.contra_subject as Schema<'AdminAdjustmentContraSubject'>,
    contra_platform: row.contra_platform as Schema<'AdminAdjustment'>['contra_platform'],
    note: row.note,
    status: row.status as AdminAdjustmentStatus,
    reverses_adjust_id: row.reverses_adjust_id,
    reversed_by_adjust_id: reversedBy,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    reviewed_by: row.reviewed_by,
    reviewed_at: iso(row.reviewed_at),
    reject_note: row.reject_note,
    voucher_id: row.voucher_id,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads.

/** One page of the app's forms, created_at then adjust_id descending. */
export async function listAdminAdjustments(
  deps: AdminAdjustmentReadDeps,
  query: AdminAdjustmentListQuery,
): Promise<Schema<'AdminAdjustmentPage'>> {
  if (query.userId !== null && !UUID.test(query.userId)) {
    throw new AdminAdjustmentFieldsError(['user_id']);
  }
  const page = query.page;
  const pageSize = query.pageSize;
  const filter = {
    appId: query.appId,
    reasonCode: query.reasonCode,
    status: query.status,
    userId: query.userId === null ? null : query.userId.toLowerCase(),
  };
  const total = await countAdminAdjustments(deps.db, filter);
  const offset = (page - 1) * pageSize;
  const rows = offset >= total ? [] : await pageAdminAdjustments(deps.db, filter, offset, pageSize);
  return {
    items: rows.map((row) => adjustmentView(row, row.reversed_by)),
    page,
    page_size: pageSize,
    total,
  };
}

export function listQueryOf(
  appId: string,
  raw: {
    readonly page?: number;
    readonly page_size?: number;
    readonly reason_code?: string;
    readonly status?: string;
    readonly user_id?: string;
  },
): AdminAdjustmentListQuery {
  return {
    appId,
    page: raw.page ?? DEFAULT_PAGE,
    pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
    reasonCode: (raw.reason_code ?? null) as AdminAdjustmentReasonCode | null,
    status: (raw.status ?? null) as AdminAdjustmentStatus | null,
    userId: raw.user_id ?? null,
  };
}

function preview(
  direction: AdminAdjustmentDirection,
  amount: bigint,
  available: bigint,
): Schema<'AdminAdjustmentBalancePreview'> {
  const after = direction === 'increase' ? addFen(available, amount) : subFen(available, amount);
  return {
    direction,
    amount_fen: fenToJsonNumber(amount),
    available_before_fen: fenToJsonNumber(available),
    available_after_fen: fenToJsonNumber(after),
  };
}

/** One form of the app with its balance preview (BR-FUND-24 ④). */
export async function getAdminAdjustment(
  deps: AdminAdjustmentReadDeps,
  input: { readonly appId: string; readonly adjustId: string },
): Promise<Schema<'AdminAdjustmentDetail'>> {
  if (!UUID.test(input.adjustId)) throw new AdminAdjustmentFieldsError(['adjust_id']);
  const row = await findAdminAdjustment(deps.db, input.appId, input.adjustId.toLowerCase());
  if (row === undefined) throw new AdminAdjustmentFieldsError(['adjust_id']);
  return {
    adjustment: adjustmentView(row, row.reversed_by),
    balance_preview: await previewOf(deps, input.appId, row),
  };
}

async function previewOf(
  deps: AdminAdjustmentReadDeps,
  appId: string,
  row: AdminAdjustmentRowWithReversal,
): Promise<Schema<'AdminAdjustmentBalancePreview'> | null> {
  const pending = row.status === 'PENDING';
  const reversible =
    row.status === 'APPROVED' &&
    row.reverses_adjust_id === null &&
    row.reversed_by === null &&
    row.amount_fen !== null;
  if (!pending && !reversible) return null;
  if (reversible) {
    const status = await deps.userStatus(deps.db, { appId, userIds: [row.user_id] });
    if (status.get(row.user_id) === 'done') return null;
  }
  const [balance] = await deps.ledger.getBalances(deps.db, { appId, userIds: [row.user_id] });
  const available = balance?.available_fen ?? 0n;
  if (pending) {
    const direction = row.direction as AdminAdjustmentDirection;
    // ⑧: the amount of a prefilled ACCOUNT_CLOSED form is taken from available at approval
    // (0 when available is not above 0, see POST .../approve).
    const amount =
      row.reason_code === 'ACCOUNT_CLOSED' || row.amount_fen === null
        ? available > 0n
          ? available
          : 0n
        : row.amount_fen;
    return preview(direction, amount, available);
  }
  return preview(opposite(row.direction as AdminAdjustmentDirection), row.amount_fen!, available);
}

function opposite(direction: AdminAdjustmentDirection): AdminAdjustmentDirection {
  return direction === 'increase' ? 'decrease' : 'increase';
}

// ---------------------------------------------------------------------------------------------
// The one-step submission.

type Refusal = HandlerResult;

function fieldsRefusal(fields: readonly string[], traceId: string, reason?: string): Refusal {
  const refused = fieldsErrorEnvelope(fields, traceId);
  if (reason === undefined) return { status: refused.statusCode, envelope: refused.body };
  const body = refused.body as { data?: Record<string, unknown> };
  return {
    status: refused.statusCode,
    envelope: { ...refused.body, data: { ...(body.data ?? {}), reason } },
  };
}

function conflictRefusal(traceId: string): Refusal {
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

/** Trimmed note, or undefined when blank. */
function trimmedNote(note: string | null): string | null | undefined {
  if (note === null) return null;
  const trimmed = note.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** BR-FUND-24 ②③: the document check of the body (20001 fields=[refs], no reason). */
function refsShapeOk(
  reason: AdminAdjustmentNewInput['reasonCode'],
  refs: readonly AdminAdjustmentRef[],
): boolean {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.ref_type}\u0000${ref.ref_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  const count = (type: AdminAdjustmentRefType) => refs.filter((r) => r.ref_type === type).length;
  if (reason === 'RECON_FIX') return count('recon_diff') >= 1;
  if (reason === 'PAYOUT_RECOVERY') return count('recon_diff') >= 1 && count('withdrawal') === 1;
  return true;
}

interface Plan {
  readonly userId: string;
  readonly direction: AdminAdjustmentDirection;
  readonly amountFen: bigint;
  readonly reasonCode: string;
  readonly refs: readonly AdminAdjustmentRef[];
  readonly contraSubject: string;
  readonly contraPlatform: string | null;
  readonly note: string;
  readonly original: AdminAdjustmentRow | null;
}

/** The ledger template of the form (specs/ledger-templates.csv ADMIN_ADJUST:*). */
function templateOf(plan: Plan): string {
  const reversal = plan.original !== null;
  const originalDirection = reversal ? plan.original!.direction : plan.direction;
  const base =
    plan.reasonCode === 'ACCOUNT_CLOSED'
      ? 'ADMIN_ADJUST:ACCOUNT_CLOSED'
      : `ADMIN_ADJUST:${plan.reasonCode}:${plan.contraSubject}:${originalDirection.toUpperCase()}`;
  return reversal ? `${base}:REVERSE` : base;
}

function voucherParams(plan: Plan, adjustId: string): Record<string, string | bigint> {
  const params: Record<string, string | bigint> = {
    adjust_id: plan.original?.adjust_id ?? adjustId,
    user_id: plan.userId,
  };
  if (plan.reasonCode === 'ACCOUNT_CLOSED') params['closing_balance_fen'] = plan.amountFen;
  else params['admin_adjust_fen'] = plan.amountFen;
  if (plan.contraSubject === 'UNION_RECEIVABLE') params['platform'] = plan.contraPlatform ?? '';
  return params;
}

/** Validates the body of a new form; a refusal or the partial plan (member not yet checked). */
function checkNewBody(body: AdminAdjustmentNewInput, traceId: string): Refusal | Plan {
  const refs = body.refs ?? [];
  if (!refsShapeOk(body.reasonCode, refs)) return fieldsRefusal(['refs'], traceId);
  const note = trimmedNote(body.note);
  if (note === undefined) return fieldsRefusal(['note'], traceId);
  if (body.reasonCode === 'OTHER' && note === null) return fieldsRefusal(['note'], traceId);
  let contraSubject: string;
  let contraPlatform: string | null = null;
  if (body.reasonCode === 'PAYOUT_RECOVERY') {
    if (body.contraSubject !== null) return fieldsRefusal(['contra_subject'], traceId);
    if (body.contraPlatform !== null) return fieldsRefusal(['contra_platform'], traceId);
    contraSubject = ''; // taken from the withdrawal's channel below
  } else {
    if (body.contraSubject === null || !CHOOSABLE_SUBJECTS.has(body.contraSubject)) {
      return fieldsRefusal(['contra_subject'], traceId);
    }
    contraSubject = body.contraSubject;
    if ((contraSubject === 'UNION_RECEIVABLE') !== (body.contraPlatform !== null)) {
      return fieldsRefusal(['contra_platform'], traceId);
    }
    contraPlatform = body.contraPlatform;
  }
  return {
    userId: body.userId.toLowerCase(),
    direction: body.direction,
    amountFen: body.amountFen,
    reasonCode: body.reasonCode,
    refs,
    contraSubject,
    contraPlatform,
    note: note ?? '',
    original: null,
  };
}

/**
 * BR-FUND-24 ③: every linked document is of the app and, for a withdrawal or a deletion, of the
 * member; a difference is not of source R4. Returns the cash subject of the (one) withdrawal.
 */
async function checkRefs(
  deps: AdminAdjustmentCreateDeps,
  trx: Transaction<DB>,
  appId: string,
  userId: string,
  refs: readonly AdminAdjustmentRef[],
): Promise<{ readonly ok: false } | { readonly ok: true; readonly cashSubject: string | null }> {
  const idsOf = (type: AdminAdjustmentRefType) =>
    refs.filter((ref) => ref.ref_type === type).map((ref) => ref.ref_id);
  const diffs = idsOf('recon_diff');
  const withdrawals = idsOf('withdrawal');
  const deletions = idsOf('account_deletion');
  const orders = idsOf('order');
  if ([...diffs, ...withdrawals, ...deletions].some((id) => !UUID.test(id))) return { ok: false };

  const diffSources = await readReconDiffSources(
    trx,
    appId,
    diffs.map((id) => id.toLowerCase()),
  );
  for (const id of diffs) {
    const source = diffSources.get(id.toLowerCase());
    if (source === undefined || source === 'R4') return { ok: false };
  }
  let cashSubject: string | null = null;
  if (withdrawals.length > 0) {
    const found = await deps.ports.withdrawals(trx, { appId, withdrawalIds: withdrawals });
    for (const id of withdrawals) {
      const ref = found.get(id.toLowerCase());
      if (ref === undefined || ref.userId !== userId) return { ok: false };
      cashSubject = ref.cashSubject;
    }
  }
  if (deletions.length > 0) {
    const owners = await deps.ports.deletionOwners(trx, { appId, ids: deletions });
    for (const id of deletions) {
      if (owners.get(id.toLowerCase()) !== userId) return { ok: false };
    }
  }
  if (orders.length > 0) {
    const known = await deps.ports.orderKeys(trx, { appId, orderKeys: orders });
    for (const key of orders) if (!known.has(key)) return { ok: false };
  }
  return { ok: true, cashSubject };
}

/** Locks the member (users row, then the balance row) and returns the balance. */
async function lockMember(
  deps: AdminAdjustmentCreateDeps,
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<{ readonly locked: boolean; readonly balance: AccountBalance | undefined }> {
  const locked = await deps.ports.lockUsers(trx, { appId, userIds: [userId] });
  if (!locked.has(userId)) return { locked: false, balance: undefined };
  const [balance] = await deps.ledger.lockBalances(trx, { appId, userIds: [userId] });
  return { locked: true, balance };
}

async function submit(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentCreateRequest,
  trx: Transaction<DB>,
): Promise<HandlerResult> {
  const { appId, adminId, traceId } = request;
  const body = request.body;
  let plan: Plan;
  let balance: AccountBalance | undefined;

  if (body.kind === 'new') {
    const checked = checkNewBody(body, traceId);
    if ('status' in checked) return checked;
    if (!UUID.test(checked.userId)) return fieldsRefusal(['user_id'], traceId);
    const member = await lockMember(deps, trx, appId, checked.userId);
    if (!member.locked) return fieldsRefusal(['user_id'], traceId);
    const refs = await checkRefs(deps, trx, appId, checked.userId, checked.refs);
    if (!refs.ok) return fieldsRefusal(['refs'], traceId, 'adjust_ref_invalid');
    const status = await deps.ports.userStatus(trx, { appId, userIds: [checked.userId] });
    // A member in deletion takes no new manual form (D10-590 ④); a deleted one none at all.
    if ((status.get(checked.userId) ?? 'none') !== 'none') {
      return fieldsRefusal(['user_id'], traceId, 'adjust_user_deleted');
    }
    plan =
      checked.reasonCode === 'PAYOUT_RECOVERY'
        ? { ...checked, contraSubject: refs.cashSubject ?? '' }
        : checked;
    if (plan.contraSubject === '')
      throw new Error('ledger: PAYOUT_RECOVERY without a cash subject');
    balance = member.balance;
  } else {
    const note = trimmedNote(body.note);
    if (note === undefined || note === null) return fieldsRefusal(['note'], traceId);
    if (!UUID.test(body.reversesAdjustId)) return fieldsRefusal(['reverses_adjust_id'], traceId);
    const originalId = body.reversesAdjustId.toLowerCase();
    const first = await findAdminAdjustment(trx, appId, originalId);
    if (first === undefined) return fieldsRefusal(['reverses_adjust_id'], traceId);
    const member = await lockMember(deps, trx, appId, first.user_id);
    // Re-read under the member's lock: a concurrent reversal has committed or not.
    const original = await findAdminAdjustment(trx, appId, originalId);
    if (original === undefined || !member.locked) {
      return fieldsRefusal(['reverses_adjust_id'], traceId);
    }
    if (
      original.reversed_by !== null ||
      (await findReversalOf(trx, appId, originalId)) !== undefined
    ) {
      return conflictRefusal(traceId);
    }
    if (
      original.status !== 'APPROVED' ||
      original.reverses_adjust_id !== null ||
      original.amount_fen === null
    ) {
      return fieldsRefusal(['reverses_adjust_id'], traceId, 'reverse_not_allowed');
    }
    const status =
      (await deps.ports.userStatus(trx, { appId, userIds: [original.user_id] })).get(
        original.user_id,
      ) ?? 'none';
    // D10-590 ④: a member in deletion only gets the reversal of an ACCOUNT_CLOSED decrease.
    const closingReversal =
      original.reason_code === 'ACCOUNT_CLOSED' && original.direction === 'decrease';
    if (status === 'done' || (status === 'processing' && !closingReversal)) {
      return fieldsRefusal(['reverses_adjust_id'], traceId, 'adjust_user_deleted');
    }
    plan = {
      userId: original.user_id,
      direction: opposite(original.direction as AdminAdjustmentDirection),
      amountFen: original.amount_fen,
      reasonCode: original.reason_code,
      refs: [],
      contraSubject: original.contra_subject,
      contraPlatform: original.contra_platform,
      note,
      original,
    };
    balance = member.balance;
  }

  if (balance === undefined) throw new Error('ledger: the member has no balance account');
  const now = deps.clock.now();
  const adjustId = newUuidV7(now);
  const before = balance.available_fen;
  const after =
    plan.direction === 'increase' ? addFen(before, plan.amountFen) : subFen(before, plan.amountFen);

  const [built, ...extra] = buildVouchers(templateOf(plan), voucherParams(plan, adjustId));
  if (built === undefined || extra.length > 0) {
    throw new Error('ledger: an adjustment template must build exactly one voucher');
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
    voucherKind: plan.original === null ? 'ADMIN_ADJUST' : 'ADMIN_ADJUST_REV',
    entries,
  });
  if (posted.kind !== 'posted') {
    // `ADJ:{original}:REVERSE` exists: the original was reversed meanwhile (BR-FUND-16).
    if (plan.original !== null) return conflictRefusal(traceId);
    throw new Error('ledger: a new adjustment found its voucher already posted');
  }

  const row = await insertApprovedAdjustment(trx, {
    adjustId,
    appId,
    userId: plan.userId,
    direction: plan.direction,
    amountFen: plan.amountFen,
    reasonCode: plan.reasonCode,
    refs: plan.refs,
    contraSubject: plan.contraSubject,
    contraPlatform: plan.contraPlatform,
    note: plan.note,
    reversesAdjustId: plan.original?.adjust_id ?? null,
    adminId,
    at: now,
    voucherId: posted.voucherId,
  });

  await deps.auditOn(trx).append({
    appId,
    actor: adminId,
    action: plan.original === null ? ADJUSTMENT_CREATE_ACTION : ADJUSTMENT_REVERSE_ACTION,
    target: adjustId,
    before: { available_fen: before.toString() },
    after: {
      adjust_id: adjustId,
      user_id: plan.userId,
      direction: plan.direction,
      amount_fen: plan.amountFen.toString(),
      reason_code: plan.reasonCode,
      contra_subject: plan.contraSubject,
      contra_platform: plan.contraPlatform,
      reverses_adjust_id: plan.original?.adjust_id ?? null,
      voucher_id: posted.voucherId,
      available_fen: after.toString(),
    },
    ip: request.ip,
  });

  if (plan.direction === 'decrease') {
    await deps.ports.message(trx, {
      appId,
      userId: plan.userId,
      adjustId,
      facts: {
        direction: plan.direction,
        amount_fen: plan.amountFen,
        reason_code: plan.reasonCode,
      },
      now,
    });
  }

  const data: Schema<'AdminAdjustmentExecuted'> = {
    adjustment: adjustmentView(row, null),
    available_before_fen: fenToJsonNumber(before),
    available_after_fen: fenToJsonNumber(after),
  };
  return { status: 200, envelope: { code: 0, msg: '', data, trace_id: traceId } };
}

/** Submits a manual adjustment or a whole-form reversal of the operator's app, in one step. */
export function createAdminAdjustment(
  deps: AdminAdjustmentCreateDeps,
  request: AdminAdjustmentCreateRequest,
): Promise<IdempotentResponse> {
  return deps.idempotency.executeInTransaction(
    {
      appId: request.appId,
      actor: { userId: null, deviceId: null, phoneHmac: null, adminUserId: request.adminId },
      method: 'POST',
      path: ADJUSTMENTS_PATH,
      key: request.key,
      body: request.rawBody,
      traceId: request.traceId,
    },
    (trx) => submit(deps, request, trx),
  );
}

/** The schema-checked body of POST /admin/v1/adjustments as one of the two shapes. */
export function createInputOf(
  raw: unknown,
): AdminAdjustmentNewInput | AdminAdjustmentReversalInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (name: string): string | null =>
    typeof body[name] === 'string' ? (body[name] as string) : null;
  if (Object.hasOwn(body, 'reverses_adjust_id')) {
    return {
      kind: 'reversal',
      reversesAdjustId: text('reverses_adjust_id') ?? '',
      note: text('note') ?? '',
    };
  }
  const refs = Array.isArray(body['refs'])
    ? (body['refs'] as unknown[]).map((item) => {
        const ref = item as { ref_type: unknown; ref_id: unknown };
        return {
          ref_type: ref.ref_type as AdminAdjustmentRefType,
          ref_id: String(ref.ref_id),
        };
      })
    : null;
  return {
    kind: 'new',
    userId: text('user_id') ?? '',
    direction: body['direction'] as AdminAdjustmentDirection,
    amountFen: parseFen(body['amount_fen']),
    reasonCode: body['reason_code'] as AdminAdjustmentNewInput['reasonCode'],
    refs,
    note: text('note'),
    contraSubject: text('contra_subject'),
    contraPlatform: text('contra_platform'),
  };
}
