// B1-10j: the pure parts of the console's claim review reads (GET /admin/v1/claims and
// /admin/v1/claims/{claim_id}; BR-ATTR-30, BR-ATTR-18; contract adminListClaims / adminGetClaim):
// the q normalisation, the per-status counts, the field-by-field comparison of what the user
// submitted with what the union reported, and the evidence link list. No database, clock or
// logging here.
import type { Schema } from '@couli/contracts-ts';
import { accountingDate } from '@couli/domain';
import { claimCompareValue } from './claim-rules.ts';

/** What blanking reads of the admin actor; `permissions` is absent when they could not be read. */
export interface AdminFieldAccess {
  readonly isSuper: boolean;
  readonly permissions?: readonly string[];
}

/** A super admin holds every point; absent points count as none. Narrows, never lets in. */
export function holdsPoint(access: AdminFieldAccess, point: string): boolean {
  return access.isSuper || (access.permissions?.includes(point) ?? false);
}

/**
 * adminGetClaim (D10-1048 ②; BR-TEXT-08 internal note): `reason` is null for an account without
 * order.claim; items[].reject_reason, matches and evidence_links are untouched.
 */
export function blankAdminClaimDetail(
  detail: Schema<'AdminClaimDetail'>,
  access: AdminFieldAccess,
): Schema<'AdminClaimDetail'> {
  return holdsPoint(access, 'order.claim') ? detail : { ...detail, reason: null };
}

/** claim_status values in the contract's counts order. */
export const ADMIN_CLAIM_STATUSES = [
  'submitted',
  'auto_matched',
  'manual_review',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type AdminClaimStatus = (typeof ADMIN_CLAIM_STATUSES)[number];
export type AdminClaimCounts = Record<AdminClaimStatus, number>;

/** Contract AdminClaimQuery: 1–64 characters after trimming and removing inner spaces. */
export const ADMIN_CLAIM_QUERY_MAX = 64;

/**
 * q as matched: surrounding whitespace trimmed, every U+0020 inside removed; null when the result
 * is empty or longer than 64 characters (code points), which the caller answers with 20001 [q].
 */
export function normalizeClaimQuery(q: string): string | null {
  const value = q.trim().replaceAll(' ', '');
  const length = [...value].length;
  return length >= 1 && length <= ADMIN_CLAIM_QUERY_MAX ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is UUID-shaped (any case). user_id, claim_id and claims.id are uuid columns: a
 * value that is not one is answered before the database, never cast there (22P02 would be a 500).
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Six zero-or-more counts from (status, n) rows; a status outside the enum is a broken database. */
export function claimCounts(
  rows: readonly { readonly status: string; readonly n: number }[],
): AdminClaimCounts {
  const counts: AdminClaimCounts = {
    submitted: 0,
    auto_matched: 0,
    manual_review: 0,
    approved: 0,
    rejected: 0,
    cancelled: 0,
  };
  for (const row of rows) {
    if (!(ADMIN_CLAIM_STATUSES as readonly string[]).includes(row.status)) {
      throw new Error('orders: unknown claim status');
    }
    counts[row.status as AdminClaimStatus] += row.n;
  }
  return counts;
}

/** What the comparison reads of the claim. */
export interface ClaimMatchClaim {
  readonly platform: string;
  /** As submitted, spaces removed. */
  readonly order_no: string;
  readonly order_no_type: string;
  /** YYYY-MM-DD (+08:00) as submitted. */
  readonly paid_date: string;
}

/** What the comparison reads of the child order's orders row (null when the row is missing). */
export interface ClaimMatchOrder {
  readonly sub_order_id: string;
  readonly parent_order_id: string | null;
  readonly is_presale: boolean;
  readonly deposit_paid_at: Date | null;
  readonly paid_at: Date | null;
}

export interface ClaimMatch {
  readonly field: 'order_no' | 'paid_date';
  readonly user_value: string | null;
  readonly union_value: string | null;
  readonly matched: boolean;
}

/**
 * The evidence view's comparison of one child order: the order number (the parent number for a
 * parent submission, the child number for a child submission; compared after BR-ATTR-17's
 * normalisation, pdd without hyphens) and the payment date (+08:00; a pre-sale order's union side
 * is the deposit date). A missing union value never matches.
 */
export function claimMatches(claim: ClaimMatchClaim, order: ClaimMatchOrder | null): ClaimMatch[] {
  const unionNo =
    order === null
      ? null
      : claim.order_no_type === 'parent'
        ? order.parent_order_id
        : order.sub_order_id;
  const paidAt = order === null ? null : order.is_presale ? order.deposit_paid_at : order.paid_at;
  const unionDate = paidAt === null ? null : accountingDate(paidAt);
  return [
    {
      field: 'order_no',
      user_value: claim.order_no,
      union_value: unionNo,
      matched:
        unionNo !== null &&
        claimCompareValue(claim.platform, unionNo) ===
          claimCompareValue(claim.platform, claim.order_no),
    },
    {
      field: 'paid_date',
      user_value: claim.paid_date,
      union_value: unionDate,
      matched: unionDate !== null && unionDate === claim.paid_date,
    },
  ];
}

export interface EvidenceMoment {
  readonly at: Date;
  readonly scene: string | null;
}

export interface EvidenceLink {
  readonly at: string;
  readonly scene: string | null;
}

/**
 * The child order's evidence records, newest first (same time: larger id first). Every record the
 * child counts is listed, a null scene included; a scene outside `knownScenes` is shown as null
 * (unknown channel) rather than as a value the contract does not have. Ids the reader did not
 * find (another app) are left out.
 */
export function evidenceLinks(
  ids: readonly bigint[] | null,
  moments: ReadonlyMap<string, EvidenceMoment>,
  knownScenes: ReadonlySet<string>,
): EvidenceLink[] {
  if (ids === null) return [];
  const found: { id: bigint; moment: EvidenceMoment }[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const moment = moments.get(key);
    if (moment !== undefined) found.push({ id, moment });
  }
  found.sort((a, b) => {
    const diff = b.moment.at.getTime() - a.moment.at.getTime();
    if (diff !== 0) return diff;
    return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
  });
  return found.map(({ moment }) => ({
    at: moment.at.toISOString(),
    scene: moment.scene !== null && knownScenes.has(moment.scene) ? moment.scene : null,
  }));
}
