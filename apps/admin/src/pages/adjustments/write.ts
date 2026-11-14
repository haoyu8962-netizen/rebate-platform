// 新建调账与红冲的数据辅助（adminCreateAdjustment，BR-FUND-24）：新建表单的本地校验（金额按元输入、
// 只经 @couli/money 换成整数分，不设上限；原因码三选一；关联单据 ≤ 10、不重复，按原因码的最低要求；
// 对方科目只 RECON_FIX / OTHER 有，联盟应收另选平台）、两种封闭请求体、红冲方向（原单方向的相反）、
// 写入失败的提示与 Idempotency-Key 是否沿用。这里不放文案。
import { fenToJsonNumber, formatYuanAdmin, yuanStrToFen } from '@couli/money';
import { platform, type Schema } from '@couli/contracts-ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { fieldsOf, type Adjustment } from './model.ts';

const e = adjustmentsTexts.write.errors;

export type CreateNew = Schema<'AdminAdjustmentCreateNew'>;
export type CreateReversal = Schema<'AdminAdjustmentCreateReversal'>;
export type CreateRequest = Schema<'AdminAdjustmentCreateRequest'>;
export type Executed = Schema<'AdminAdjustmentExecuted'>;
export type Direction = Adjustment['direction'];
export type ChoosableReason = CreateNew['reason_code'];
export type ChoosableSubject = NonNullable<CreateNew['contra_subject']>;
export type PlatformCode = NonNullable<CreateNew['contra_platform']>;
export type RefType = Schema<'AdminAdjustmentRefType'>;
export type Ref = Schema<'AdminAdjustmentRef'>;

/** The reason codes a person may choose (RESTORE and ACCOUNT_CLOSED never; contract order). */
export const CHOOSABLE_REASONS: readonly ChoosableReason[] = [
  'RECON_FIX',
  'PAYOUT_RECOVERY',
  'OTHER',
];
/** contracts/enums/fund.yaml admin_adjustment_ref_type, in contract order. */
export const REF_TYPES: readonly RefType[] = [
  'recon_diff',
  'withdrawal',
  'order',
  'account_deletion',
];
/** 对方科目 RECON_FIX and OTHER choose from (BR-FUND-24 ⑥), in contract order. */
export const CHOOSABLE_SUBJECTS: readonly ChoosableSubject[] = [
  'COMMISSION_REVENUE',
  'UNION_RECEIVABLE',
  'BAD_DEBT',
  'MKT_EXPENSE',
];
/** contracts/enums/platform.yaml, in contract order. */
export const PLATFORMS: readonly PlatformCode[] = platform;

export const MAX_REFS = 10;
export const MAX_REF_ID = 128;
export const MAX_NOTE = 500;

/** The reason needs a 对方科目 chosen by the operator. */
export const needsSubject = (reason: ChoosableReason | undefined): boolean =>
  reason === 'RECON_FIX' || reason === 'OTHER';

/** The direction of the reversal of `original`: always the opposite of the original's. */
export const oppositeOf = (direction: Direction): Direction =>
  direction === 'increase' ? 'decrease' : 'increase';

/** A form that can still be reversed: APPROVED, not a reversal, not reversed yet. */
export const reversible = (item: Adjustment): boolean =>
  item.status === 'APPROVED' &&
  item.reverses_adjust_id === null &&
  item.reversed_by_adjust_id === null;

// 金额按元输入：大于 0、最多两位小数的十进制（不收负号、科学计数、空白）；不设上限。
const YUAN = /^[0-9]+(?:\.[0-9]{1,2})?$/;

/** Integer fen of the typed yuan, or undefined when it is not > 0 with at most two decimals. */
export function amountFen(text: string): bigint | undefined {
  const value = text.trim();
  if (!YUAN.test(value)) return undefined;
  let fen: bigint;
  try {
    fen = yuanStrToFen(value);
  } catch {
    return undefined;
  }
  if (fen <= 0n) return undefined;
  try {
    fenToJsonNumber(fen);
  } catch {
    return undefined;
  }
  return fen;
}

/** Admin amount of integer fen (BR-TEXT-10). */
export const yuanOf = (fen: bigint): string => formatYuanAdmin(fen);

/** What the drawer holds (as typed). */
export interface NewDraft {
  readonly user: string;
  readonly direction: Direction | undefined;
  readonly amount: string;
  readonly reason: ChoosableReason | undefined;
  readonly refs: readonly Ref[];
  readonly note: string;
  readonly subject: ChoosableSubject | undefined;
  readonly platform: PlatformCode | undefined;
}

export const EMPTY_NEW: NewDraft = {
  user: '',
  direction: undefined,
  amount: '',
  reason: undefined,
  refs: [],
  note: '',
  subject: undefined,
  platform: undefined,
};

export interface NewErrors {
  readonly user?: string;
  readonly direction?: string;
  readonly amount?: string;
  readonly reason?: string;
  readonly refs?: string;
  readonly note?: string;
  readonly subject?: string;
  readonly platform?: string;
}

function refsError(reason: ChoosableReason | undefined, refs: readonly Ref[]): string | undefined {
  if (refs.length > MAX_REFS) return e.refLimit;
  const count = (type: RefType): number => refs.filter((ref) => ref.ref_type === type).length;
  if (reason === 'RECON_FIX' && count('recon_diff') < 1) return e.reconFixRefs;
  if (reason === 'PAYOUT_RECOVERY' && (count('withdrawal') !== 1 || count('recon_diff') < 1))
    return e.payoutRefs;
  return undefined;
}

function noteError(reason: ChoosableReason | undefined, note: string): string | undefined {
  const value = note.trim();
  if (value.length > MAX_NOTE) return e.noteTooLong;
  if (reason === 'OTHER' && value === '') return e.noteRequired;
  return undefined;
}

/** Local checks of the drawer; empty when the form may be sent. */
export function checkNew(draft: NewDraft): NewErrors {
  const subject = needsSubject(draft.reason);
  const errors: Record<string, string | undefined> = {
    user: draft.user.trim() === '' ? e.userRequired : undefined,
    direction: draft.direction === undefined ? e.directionRequired : undefined,
    amount: amountFen(draft.amount) === undefined ? e.amountInvalid : undefined,
    reason: draft.reason === undefined ? e.reasonRequired : undefined,
    refs: refsError(draft.reason, draft.refs),
    note: noteError(draft.reason, draft.note),
    subject: subject && draft.subject === undefined ? e.subjectRequired : undefined,
    platform:
      subject && draft.subject === 'UNION_RECEIVABLE' && draft.platform === undefined
        ? e.platformRequired
        : undefined,
  };
  return Object.fromEntries(
    Object.entries(errors).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export const hasErrors = (errors: NewErrors): boolean => Object.keys(errors).length > 0;

/**
 * The body of a new adjustment (only after checkNew passed): trimmed values; refs always sent
 * (an empty array for OTHER without documents); a blank note and the 对方科目 / 平台 that do not
 * apply to the reason are left out.
 */
export function newBody(draft: NewDraft): CreateNew {
  const fen = amountFen(draft.amount);
  if (draft.direction === undefined || draft.reason === undefined || fen === undefined)
    throw new Error('newBody before checkNew');
  const note = draft.note.trim();
  const subject = needsSubject(draft.reason) ? draft.subject : undefined;
  const union = subject === 'UNION_RECEIVABLE' ? draft.platform : undefined;
  return {
    user_id: draft.user.trim(),
    direction: draft.direction,
    amount_fen: fenToJsonNumber(fen),
    reason_code: draft.reason,
    refs: draft.refs.map((ref) => ({ ref_type: ref.ref_type, ref_id: ref.ref_id })),
    ...(note === '' ? {} : { note }),
    ...(subject === undefined ? {} : { contra_subject: subject }),
    ...(union === undefined ? {} : { contra_platform: union }),
  };
}

/** Why the document typed in 单据类型 / 单据号 cannot be added (undefined: it can). */
export function refAddError(
  refs: readonly Ref[],
  type: RefType | undefined,
  id: string,
): string | undefined {
  const value = id.trim();
  if (type === undefined) return e.refTypeRequired;
  if (value === '') return e.refIdRequired;
  if (value.length > MAX_REF_ID) return e.refIdTooLong;
  if (refs.some((ref) => ref.ref_type === type && ref.ref_id === value)) return e.refDuplicate;
  if (refs.length >= MAX_REFS) return e.refLimit;
  return undefined;
}

/** Form.Item props showing `error` under the control (none without an error). */
export function feedback(
  error: string | undefined,
): { validateStatus: 'error'; help: string } | Record<string, never> {
  return error === undefined ? {} : { validateStatus: 'error', help: error };
}

/** Local check of the reversal reason; undefined when it may be sent. */
export function reverseNoteError(note: string): string | undefined {
  const value = note.trim();
  if (value === '') return e.reverseNoteRequired;
  if (value.length > MAX_NOTE) return e.reverseNoteTooLong;
  return undefined;
}

// ---- answers of the write ------------------------------------------------------------------

function dataOf(cause: unknown): Record<string, unknown> {
  if (!(cause instanceof AdminApiError)) return {};
  const data = cause.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}
/** data.reason of an error envelope. */
export function reasonOf(cause: unknown): string | undefined {
  const reason = dataOf(cause)['reason'];
  return typeof reason === 'string' ? reason : undefined;
}

/** 10003 data.reason=verify_phone_missing: the account has no verify phone (no code is sent). */
export const phoneMissing = (cause: unknown): boolean =>
  cause instanceof AdminApiError &&
  cause.code === 10003 &&
  reasonOf(cause) === 'verify_phone_missing';

/** 20902 data.resource=admin_adjustment: the original was reversed meanwhile. */
export const alreadyReversed = (cause: unknown): boolean =>
  cause instanceof AdminApiError && cause.code === 20902;

/**
 * Whether the outcome of a write is unknown (network failure, unreadable answer, 5xx, 40901):
 * the next submission replays the same Idempotency-Key. Every other answer is final and the next
 * submission takes a new key (a corrected body under the old key would be 20901).
 */
export function outcomeUnknown(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  if (cause.kind !== 'api') return true;
  return cause.httpStatus >= 500 || cause.code === 40901;
}

/**
 * The write got no reply in the unified envelope (network failure, a reply that cannot be read as
 * the envelope): it may have taken effect. The form locks; only a byte-for-byte retry under the
 * same Idempotency-Key, or checking the list, is offered (编排 D10-1731).
 */
export function noEnvelope(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError)) return true;
  return cause.kind === 'network' || cause.kind === 'parse';
}

/** The prompt of a failed write. */
export function writeErrorText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return e.failed;
  if (cause.code === 10403) return e.forbidden;
  if (cause.code === 20902) return e.alreadyReversed;
  if (cause.code === 20001) {
    const reason = reasonOf(cause);
    if (reason === 'adjust_ref_invalid') return e.refInvalid;
    if (reason === 'adjust_user_deleted') return e.userDeleted;
    if (reason === 'reverse_not_allowed') return e.reverseNotAllowed;
    const fields = fieldsOf(cause);
    if (reason === undefined && fields.length === 1 && fields[0] === 'user_id')
      return e.userUnknown;
    if (reason === undefined && fields.length === 1 && fields[0] === 'reverses_adjust_id')
      return e.originalMissing;
    return e.invalid;
  }
  return e.failed;
}

/** A new Idempotency-Key. */
export function newRequestKey(): string {
  return globalThis.crypto.randomUUID();
}
