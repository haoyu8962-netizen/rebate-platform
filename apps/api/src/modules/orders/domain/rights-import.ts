// B1-09g: the form of POST /admin/v1/rights-imports (contract adminCreateRightsImport,
// AdminRightsImportByOrder / AdminRightsImportChannel; 08 BR-FUND-06 细则「维权导入任务」,
// BR-ATTR-26 细则「渠道单导入」) and the five tallies of an import task. Pure: no Nest, no data access.
// Enumerations are contracts/enums/order.yaml (CT-24n): rights_import_kind, rights_import_status,
// rights_import_time_basis, rights_import_failure_reason.
//
// checkRightsImportForm judges the text parts as sent (undefined = part absent), each refusal naming
// the one field of the contract's 20001 data.fields:
//   - kind outside rights / punish / channel (or absent) → [kind]; platform outside the platform
//     enum (or absent) → [platform];
//   - rights / punish: a window needs both ends and time_basis — from or to without time_basis →
//     [time_basis]; one end without the other names the missing [from] / [to]; an end that is not an
//     ISO 8601 instant with offset names itself; from not before to is refused (rights_imports
//     window check). time_basis outside paid / received → [time_basis]; time_basis alone is
//     accepted and ignored (no window, no filtering). union_account_id is not a part of these kinds
//     → [union_account_id];
//   - channel: union_account_id required (a UUID) → [union_account_id]; any of time_basis, from,
//     to → that field.
//   - reason_sub (B1-09v; 08 BR-TEXT-05 子原因 写入来源 ②, D10-819 ①②, CT-24zw): punish only, one
//     of the 12 PUNISH sub-reasons of enum order_reason_sub or `none` (「无」), exact spelling;
//     anything else, or the part sent with kind=rights / channel (维权单 has no manual choice) →
//     [reason_sub]. Not sent: null (the automatic mapping decides).
// The file part is judged by the use case (application/rights-imports.ts), not here.
// TODO(规划/11 §4.5): Excel column templates per (kind, platform) — blocked on the owner's samples
// (K-3); until registered, rights / punish rows are invalid_row (application/rights-import-ports.ts).
import {
  platform as PLATFORM_CODES,
  rights_import_kind,
  rights_import_time_basis,
  type Schema,
} from '@couli/contracts-ts';

export type RightsImportKind = Schema<'AdminRightsImportKind'>;
export type RightsImportStatus = Schema<'AdminRightsImportStatus'>;
export type RightsImportTimeBasis = Schema<'AdminRightsImportTimeBasis'>;
export type RightsImportFailureReason = Schema<'AdminRightsImportFailureReason'>;
export type RightsImportPlatform = Schema<'PlatformCode'>;

/** The text parts of the multipart form as sent; undefined = the part is absent. */
export interface RightsImportFormFields {
  readonly kind?: string | undefined;
  readonly platform?: string | undefined;
  readonly time_basis?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly union_account_id?: string | undefined;
  /** B1-09v: punish only; one of PUNISH_REASON_SUBS or `none`. */
  readonly reason_sub?: string | undefined;
}

/** The sub-reasons of the parent reason PUNISH (contract AdminOrderPunishReasonSub, BR-TEXT-05). */
export const PUNISH_REASON_SUBS = [
  'VIOLATION_PROMO',
  'SHOP_TK',
  'INSITE_PROMO',
  'PROXY_BUY',
  'FAKE_TRADE',
  'INSITE_RESALE',
  'OVER_LIMIT',
  'MARKET_DISRUPT',
  'MULTI_TRADE_ABNORMAL',
  'SINGLE_TRADE_ABNORMAL',
  'RISK_ORDER',
  'PUNISH_ORDER',
] as const satisfies readonly Schema<'AdminOrderPunishReasonSub'>[];

/** 「无」: the choice made by hand that writes no sub-reason (contract AdminOrderReasonSubNone). */
export const REASON_SUB_NONE = 'none' satisfies Schema<'AdminOrderReasonSubNone'>;

/** The reason_sub part of a punish import as stored in rights_imports (`none` as sent). */
export type RightsImportReasonSub = Schema<'AdminRightsImportReasonSub'>;

/** A filtering window: rows whose paid / received time lies in [from, to). */
export interface RightsImportWindow {
  readonly time_basis: RightsImportTimeBasis;
  /** The instant as sent (ISO 8601 with offset), inclusive. */
  readonly from: string;
  /** The instant as sent (ISO 8601 with offset), exclusive. */
  readonly to: string;
}

export type CheckedRightsImportForm =
  | {
      readonly kind: 'rights' | 'punish';
      readonly platform: RightsImportPlatform;
      /** null: no window, no row is filtered (time_basis sent alone is dropped). */
      readonly window: RightsImportWindow | null;
      /**
       * B1-09v: the manual sub-reason of a punish import; the key is absent when the part was not
       * sent (always for rights), so a form without it reads as before.
       */
      readonly reason_sub?: RightsImportReasonSub;
    }
  | {
      readonly kind: 'channel';
      readonly platform: RightsImportPlatform;
      readonly union_account_id: string;
    };

export type RightsImportFormCheck =
  | { readonly ok: true; readonly form: CheckedRightsImportForm }
  | { readonly ok: false; readonly fields: readonly string[] };

/** One processed row as a processor reported it (application/rights-import-ports.ts). */
export type RightsImportRowOutcome =
  | { readonly kind: 'succeeded' }
  /** Outside the time window (skipped_rows); not a failure. */
  | { readonly kind: 'skipped' }
  /** Already imported under the BR-FUND-06 key (duplicate_rows); not a failure, nothing written. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'failed'; readonly reason: RightsImportFailureReason };

/** The five tallies of rights_imports (CT-24n field names). */
export interface RightsImportCounts {
  readonly total_rows: number;
  readonly succeeded_rows: number;
  readonly failed_rows: number;
  readonly skipped_rows: number;
  readonly duplicate_rows: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 instant with an explicit offset (Z or ±hh:mm); seconds and fractions optional. */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const includes = (list: readonly string[], value: string | undefined): boolean =>
  value !== undefined && list.includes(value);

/** Epoch ms of an ISO instant with offset; null when it is not one (calendar fields checked). */
function instantMs(value: string): number | null {
  const m = INSTANT.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi, sec, oh, om] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  const year = Number(y);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (day > days + (month === 2 && leap ? 1 : 0)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(sec ?? '0') > 59) return null;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const refuse = (field: string): RightsImportFormCheck => ({ ok: false, fields: [field] });

/** The reason_sub part as sent: PUNISH's twelve or `none`, exact spelling (no trim, no case fold). */
export function isPunishImportReasonSub(value: string | undefined): value is RightsImportReasonSub {
  return value === REASON_SUB_NONE || includes(PUNISH_REASON_SUBS, value);
}

export function checkRightsImportForm(fields: RightsImportFormFields): RightsImportFormCheck {
  const { kind, platform } = fields;
  if (!includes(rights_import_kind, kind)) return refuse('kind');
  if (!includes(PLATFORM_CODES, platform)) return refuse('platform');
  const code = platform as RightsImportPlatform;
  if (kind === 'channel') {
    const account = fields.union_account_id;
    if (account === undefined || !UUID.test(account)) return refuse('union_account_id');
    for (const field of ['time_basis', 'from', 'to', 'reason_sub'] as const) {
      if (fields[field] !== undefined) return refuse(field);
    }
    return { ok: true, form: { kind, platform: code, union_account_id: account } };
  }
  const byOrder = kind as 'rights' | 'punish';
  if (fields.union_account_id !== undefined) return refuse('union_account_id');
  const sent = fields.reason_sub;
  if (sent !== undefined && (byOrder !== 'punish' || !isPunishImportReasonSub(sent))) {
    return refuse('reason_sub');
  }
  const manual = sent === undefined ? {} : { reason_sub: sent };
  const { time_basis: basis, from, to } = fields;
  if (basis !== undefined && !includes(rights_import_time_basis, basis))
    return refuse('time_basis');
  if (from === undefined && to === undefined) {
    // time_basis alone: accepted and dropped (no window, no filtering).
    return { ok: true, form: { kind: byOrder, platform: code, window: null, ...manual } };
  }
  if (basis === undefined) return refuse('time_basis');
  if (from === undefined) return refuse('from');
  if (to === undefined) return refuse('to');
  const fromMs = instantMs(from);
  if (fromMs === null) return refuse('from');
  const toMs = instantMs(to);
  if (toMs === null) return refuse('to');
  if (fromMs >= toMs) return refuse('to');
  return {
    ok: true,
    form: {
      kind: byOrder,
      platform: code,
      window: { time_basis: basis as RightsImportTimeBasis, from, to },
      ...manual,
    },
  };
}

/** total_rows is the number of outcomes; every outcome counts in exactly one of the other four. */
export function countRightsImportRows(
  outcomes: readonly RightsImportRowOutcome[],
): RightsImportCounts {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let duplicate = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'succeeded') succeeded += 1;
    else if (outcome.kind === 'failed') failed += 1;
    else if (outcome.kind === 'skipped') skipped += 1;
    else duplicate += 1;
  }
  return {
    total_rows: outcomes.length,
    succeeded_rows: succeeded,
    failed_rows: failed,
    skipped_rows: skipped,
    duplicate_rows: duplicate,
  };
}
