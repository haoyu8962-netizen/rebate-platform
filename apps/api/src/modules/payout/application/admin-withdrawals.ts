// B2-09c: the console's read of withdrawals (contracts/openapi.yaml listAdminWithdrawals and
// getAdminWithdrawal, CT-24y; 08 BR-WDR-10 细则 审核列表与详情). Read only on the given handle, by
// app; the permission check (withdraw.review or fund.view, or user.lookup with user_id, read only)
// is the controller's and appId is always the guard's actor. Nothing is written or audited. The
// display status the console shows (enum admin_withdrawal_display_status) is derived from status +
// review_mode + hold_reason as the BR-WDR-08 细则 table; not stored and not a withdrawal status.
//
// For an account holding user.lookup but neither withdraw.review nor fund.view (B2-09zg, CT-24zzb,
// D10-1042) the internal fields are blanked where the views are built: reject_note, auto_decision
// (with its failed_conditions and warn_values), risk_flags and, on the detail, holds[].source_ref.
//
// Personal data (BR-ID-33): the user's phone comes masked from identity's port; the payee account
// is decrypted through the process port only to be masked at once, the payee name keeps only its
// last character. No response carries a clear value, the cipher or the HMAC; the channel request
// and response bodies of the transfer attempts are never selected.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import type { Kysely, Selectable } from 'kysely';
import type { AdminActor } from '../../platform/index.ts';
import { maskPayeeAccount } from '../domain/mask-payee.ts';
import {
  countAdminWithdrawals,
  findAdminWithdrawal,
  findAdminWithdrawalBatch,
  holdsInEffect,
  pageAdminWithdrawals,
  withdrawalAttempts,
  withdrawalBatchItems,
  type AdminWithdrawalFilter,
} from '../infra/admin-withdrawals-store.ts';

/** The admin_withdrawal_display_status of the contract. */
export type AdminWithdrawalDisplayStatus = Schema<'AdminWithdrawalDisplayStatus'>;

/** The withdrawal columns the display status is derived from (as stored). */
export interface AdminWithdrawalDisplayInput {
  readonly status: string;
  readonly review_mode: string | null;
  readonly hold_reason: string | null;
  readonly needs_manual: boolean;
}

/** The display status of one withdrawal row (BR-WDR-08 细则); needs_manual changes nothing. */
export function adminWithdrawalDisplayStatus(
  row: AdminWithdrawalDisplayInput,
): AdminWithdrawalDisplayStatus {
  switch (row.status) {
    case 'PENDING_REVIEW':
      return 'pending_review';
    case 'APPROVED':
      return row.hold_reason === 'payer_side_after_transfer' ? 'pending_handle' : 'pending_review';
    case 'REJECTED':
      return 'rejected';
    case 'PAID_MANUAL':
      return 'paid_manual';
    case 'PAID_API':
      return row.review_mode === 'auto' ? 'paid_auto_system' : 'paid_auto_review';
    case 'PAYING':
      return 'paying';
    case 'FAILED':
      return 'failed';
    default:
      throw new Error('payout: unknown withdrawal status');
  }
}

/** A 20001 with data.fields (the two ranges; withdrawal_id for an id naming no row of the app). */
export class AdminWithdrawalFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super('payout: admin withdrawal read refused');
    this.name = 'AdminWithdrawalFieldsError';
    this.fields = fields;
  }
}

/**
 * An account let in by user.lookup alone: neither withdraw.review nor fund.view, not a super. A
 * non-super actor without `permissions` counts as one: rather too little than too much (D10-1042).
 * Decides only the blanking; who is let in stays the guard's permission check.
 */
export function isLookupOnly(actor: Pick<AdminActor, 'isSuper' | 'permissions'>): boolean {
  const { isSuper, permissions } = actor;
  if (isSuper) return false;
  if (permissions === undefined) return true;
  return !permissions.includes('withdraw.review') && !permissions.includes('fund.view');
}

/** In-memory decryption of the payee snapshot; the cleartext is masked before it leaves here. */
export type AdminPayeeDecrypt = (cipher: Buffer, method: 'alipay' | 'bank_card') => string;

/** What the reads need besides the handle (assembled by app.module on the admin entry). */
export interface AdminWithdrawalReadDeps {
  readonly db: Kysely<DB>;
  /** The response instant: the holds in effect are those not yet expired at it. */
  readonly now: () => Date;
  /** identity's masked phones: user_id → 3 + 4, or null without a phone (absent reads as null). */
  readonly phones: (
    appId: string,
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string | null>>;
  readonly decryptPayee: AdminPayeeDecrypt;
}

/** The query of listAdminWithdrawals after the route schema (integers and boolean coerced). */
export interface AdminWithdrawalListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: Schema<'WithdrawalStatus'>;
  readonly display_status?: AdminWithdrawalDisplayStatus;
  readonly review_mode?: Schema<'WithdrawalReviewMode'>;
  readonly payout_channel?: Schema<'AdminPayoutChannelCode'>;
  readonly user_id?: string;
  readonly out_biz_no?: string;
  readonly amount_min_fen?: number;
  readonly amount_max_fen?: number;
  readonly created_from?: string;
  readonly created_to?: string;
  readonly hold_reason?: Schema<'AdminWithdrawalHoldReason'>;
  readonly blocked?: boolean;
  readonly risk_flag?: Schema<'AdminWithdrawalRiskFlagCode'>;
}

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** withdrawals.id and users.id are uuid columns; any other text names no row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WithdrawalRow = Selectable<DB['withdrawals']>;
type ListItem = Schema<'AdminWithdrawalListItem'>;
type Detail = Schema<'AdminWithdrawalDetail'>;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** BR-ID-33 默认脱敏格式 of a name: n − 1 "*" + the last code point (**三); one becomes "*". */
function maskName(name: string): string {
  const chars = [...name];
  return chars.length < 2 ? '*'.repeat(chars.length) : '*'.repeat(chars.length - 1) + chars.at(-1);
}

/** withdrawals.auto_decision as the contract shows it: a key missing in storage reads as null. */
function decisionView(stored: WithdrawalRow['auto_decision']): ListItem['auto_decision'] {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const decision = stored as Record<string, unknown>;
  const decidedAt = decision['decided_at'];
  // The stored instant as written (ISO 8601); anything unreadable reads as null.
  const decided =
    typeof decidedAt === 'string' && Number.isFinite(Date.parse(decidedAt)) ? decidedAt : null;
  return {
    result: decision['result'] as Schema<'WithdrawalReviewMode'>,
    failed_conditions: (decision['failed_conditions'] ?? []) as string[],
    warn_values: (decision['warn_values'] ??
      null) as Schema<'AdminWithdrawalAutoDecision'>['warn_values'],
    rule_version: (decision['rule_version'] ?? null) as number | null,
    decided_at: decided,
    execute_blocked: (decision['execute_blocked'] ?? null) as string | null,
  };
}

function listView(
  row: WithdrawalRow,
  phoneMasked: string | null,
  blankInternal: boolean,
): ListItem {
  return {
    withdrawal_id: row.id,
    out_biz_no: row.out_biz_no,
    user: { user_id: row.user_id, phone_masked: phoneMasked },
    status: row.status as ListItem['status'],
    display_status: adminWithdrawalDisplayStatus(row),
    review_mode: row.review_mode as ListItem['review_mode'],
    payout_channel: row.payout_channel as ListItem['payout_channel'],
    amount_fen: fenToJsonNumber(row.amount_fen),
    fee_fen: fenToJsonNumber(row.fee_fen),
    tax_fen: fenToJsonNumber(row.tax_fen),
    net_fen: fenToJsonNumber(row.net_fen),
    auto_decision: blankInternal ? null : decisionView(row.auto_decision),
    hold_reason: row.hold_reason as ListItem['hold_reason'],
    blocked_reason: row.blocked_reason as ListItem['blocked_reason'],
    needs_manual: row.needs_manual,
    reject_reason_code: row.reject_reason_code as ListItem['reject_reason_code'],
    reject_note: blankInternal ? null : row.reject_note,
    reviewer_id: row.reviewer_id,
    reviewed_at: iso(row.reviewed_at),
    batch_id: row.batch_id,
    risk_flags: (!blankInternal && Array.isArray(row.risk_flags)
      ? row.risk_flags
      : []) as ListItem['risk_flags'],
    risk_flags_at: iso(row.risk_flags_at),
    created_at: row.created_at.toISOString(),
    paid_at: iso(row.paid_at),
  };
}

/** The masked payee snapshot (a WeChat openid is never decrypted: it has no partial form). */
function payeeView(row: WithdrawalRow, decrypt: AdminPayeeDecrypt): Detail['payee'] {
  const method = row.payout_method;
  let maskedAccount: string;
  if (method === 'alipay' || method === 'bank_card') {
    maskedAccount = maskPayeeAccount(method, decrypt(row.payee_account_cipher, method));
  } else {
    maskedAccount = '******';
  }
  return {
    masked_account: maskedAccount,
    masked_name: maskName(row.payee_name),
    bank_name: method === 'bank_card' ? row.bank_name : null,
  };
}

/** One page of the app's withdrawals, created_at then id descending. */
export async function listAdminWithdrawals(
  deps: AdminWithdrawalReadDeps,
  appId: string,
  query: AdminWithdrawalListQuery,
  blankInternal: boolean,
): Promise<Schema<'AdminWithdrawalPage'>> {
  if (
    query.amount_min_fen !== undefined &&
    query.amount_max_fen !== undefined &&
    query.amount_min_fen > query.amount_max_fen
  ) {
    throw new AdminWithdrawalFieldsError(['amount_min_fen', 'amount_max_fen']);
  }
  // Compared as instants: the two ends may carry different offsets.
  const createdFrom = query.created_from;
  const createdTo = query.created_to;
  if (createdFrom !== undefined && !Number.isFinite(Date.parse(createdFrom))) {
    throw new AdminWithdrawalFieldsError(['created_from']);
  }
  if (createdTo !== undefined && !Number.isFinite(Date.parse(createdTo))) {
    throw new AdminWithdrawalFieldsError(['created_to']);
  }
  if (
    createdFrom !== undefined &&
    createdTo !== undefined &&
    Date.parse(createdFrom) > Date.parse(createdTo)
  ) {
    throw new AdminWithdrawalFieldsError(['created_from', 'created_to']);
  }
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  // A user_id that is not a uuid names no user: an empty page, not an error.
  if (query.user_id !== undefined && !UUID.test(query.user_id)) {
    return { items: [], page, page_size: pageSize, total: 0 };
  }
  const filter: AdminWithdrawalFilter = {
    appId,
    status: query.status,
    displayStatus: query.display_status,
    reviewMode: query.review_mode,
    payoutChannel: query.payout_channel,
    userId: query.user_id?.toLowerCase(),
    outBizNo: query.out_biz_no,
    amountMinFen: query.amount_min_fen === undefined ? undefined : BigInt(query.amount_min_fen),
    amountMaxFen: query.amount_max_fen === undefined ? undefined : BigInt(query.amount_max_fen),
    createdFrom,
    createdTo,
    holdReason: query.hold_reason,
    blocked: query.blocked,
    riskFlag: query.risk_flag,
  };
  const total = await countAdminWithdrawals(deps.db, filter);
  const offset = (page - 1) * pageSize;
  const rows = offset >= total ? [] : await pageAdminWithdrawals(deps.db, filter, offset, pageSize);
  const phones = await deps.phones(
    appId,
    rows.map((row) => row.user_id),
  );
  return {
    items: rows.map((row) => listView(row, phones.get(row.user_id) ?? null, blankInternal)),
    page,
    page_size: pageSize,
    total,
  };
}

/** One withdrawal of the app with its batch, attempts and the user's holds in effect. */
export async function getAdminWithdrawal(
  deps: AdminWithdrawalReadDeps,
  appId: string,
  withdrawalId: string,
  access: { readonly userId: string | undefined; readonly blankInternal: boolean },
): Promise<Detail> {
  const { userId, blankInternal } = access;
  // Before the database: the answer must not depend on whether the withdrawal exists.
  if (userId !== undefined && !UUID.test(userId)) {
    throw new AdminWithdrawalFieldsError(['user_id']);
  }
  // Unknown, another app's and (given user_id) another user's answer alike: no 404, no hint which.
  if (!UUID.test(withdrawalId)) throw new AdminWithdrawalFieldsError(['withdrawal_id']);
  const row = await findAdminWithdrawal(deps.db, appId, withdrawalId.toLowerCase());
  if (
    row === undefined ||
    (userId !== undefined && row.user_id.toLowerCase() !== userId.toLowerCase())
  ) {
    throw new AdminWithdrawalFieldsError(['withdrawal_id']);
  }
  const now = deps.now();
  const [phones, batch, items, attempts, holds] = await Promise.all([
    deps.phones(appId, [row.user_id]),
    row.batch_id === null
      ? Promise.resolve(undefined)
      : findAdminWithdrawalBatch(deps.db, appId, row.batch_id),
    withdrawalBatchItems(deps.db, appId, row.id),
    withdrawalAttempts(deps.db, appId, row.id),
    holdsInEffect(deps.db, appId, row.user_id, now),
  ]);
  return {
    ...listView(row, phones.get(row.user_id) ?? null, blankInternal),
    payout_method: row.payout_method as Detail['payout_method'],
    review_deadline: iso(row.review_deadline),
    fail_code: row.fail_code,
    executor_id: row.executor_id,
    executed_at: iso(row.executed_at),
    execute_seq: row.execute_seq,
    manual_resolution: row.manual_resolution as Detail['manual_resolution'],
    resolver_ids: (Array.isArray(row.resolver_ids) ? row.resolver_ids : []) as string[],
    manual_entry_by: row.manual_entry_by,
    manual_confirm_by: row.manual_confirm_by,
    hold_at: iso(row.hold_at),
    channel_state: row.channel_state as Detail['channel_state'],
    confirm_deadline: iso(row.confirm_deadline),
    channel_order_id: row.channel_order_id,
    updated_at: row.updated_at.toISOString(),
    row_version: row.row_version,
    payee: payeeView(row, deps.decryptPayee),
    batch:
      batch === undefined
        ? null
        : {
            batch_id: batch.id,
            kind: batch.kind as Schema<'AdminPayoutBatchKind'>,
            created_at: batch.created_at.toISOString(),
          },
    batch_items: items.map((item) => ({
      batch_id: item.batch_id,
      result: item.result as Schema<'AdminPayoutBatchItemResult'>,
      reason: item.reason,
      moved_to_batch_id: item.moved_to_batch_id,
      at: item.at.toISOString(),
    })),
    payout_attempts: attempts.map((attempt) => ({
      attempt_id: attempt.id,
      kind: attempt.kind as Schema<'AdminPayoutAttemptKind'>,
      result: attempt.result as Schema<'AdminPayoutAttemptResult'>,
      resp_code: attempt.resp_code,
      resp_sub_code: attempt.resp_sub_code,
      at: attempt.at.toISOString(),
    })),
    holds: holds.map((hold) => ({
      hold_id: hold.id,
      reason: hold.reason as Schema<'AdminWithdrawHoldKind'>,
      source_ref: blankInternal ? null : hold.source_ref,
      created_at: hold.created_at.toISOString(),
      hold_until: iso(hold.hold_until),
    })),
  };
}
