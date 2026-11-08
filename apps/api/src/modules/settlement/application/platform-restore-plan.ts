// B2-09gb: the pure part of the platform restore (08 BR-FUND-22 R12 / R13; contracts/openapi.yaml
// restoreAdminReconDiff, platform_restore; 编排 D10-973, D10-982, D10-986, D10-994):
//   - the difference's ref_id `{order_key}#RESTORE#{entry_id}` (orders' platformRestoreRefId);
//   - R12's target status by the current platform_status and user_id;
//   - the effective union commission (BR-CALC-02 取值阶段: settle_commission_fen when set, else the
//     estimate) and its positive part;
//   - R13's recalculation: B = the positive part through the snapshot's reserve_bp (BR-CALC-02,
//     @couli/money applyReserve), each share floor(B × ratio / 10000) (splitByBp), routed by the
//     beneficiary status rules of BR-CALC-09; the platform's entitlement is N⁺ less what stays with
//     the beneficiaries (reserve included, BR-FUND-05); every difference against the current net
//     (BR-FUND-08). A beneficiary difference ≤ 0 posts nothing and a negative one is only recorded
//     (D10-986 ②); the platform's negative difference likewise (D10-994).
// Amounts only through @couli/money.
import { addFen, applyReserve, splitByBp, subFen } from '@couli/money';

export type PlatformRestoreRole = 'self' | 'share' | 'direct' | 'indirect';

export interface PlatformRestoreRef {
  readonly platform: string;
  readonly subOrderId: string;
  readonly orderKey: string;
  readonly entryId: bigint;
}

const REF_SEPARATOR = '#RESTORE#';
const ENTRY_PATTERN = /^[0-9]{1,19}$/;
/** order_status_history.id is a PostgreSQL bigint. */
const MAX_ENTRY_ID = 9_223_372_036_854_775_807n;

/** The order key and entry a platform_restore difference names; null when malformed. */
export function parsePlatformRestoreRef(
  refType: string | null,
  refId: string | null,
): PlatformRestoreRef | null {
  if (refType !== 'order' || refId === null) return null;
  const at = refId.lastIndexOf(REF_SEPARATOR);
  if (at <= 0) return null;
  const key = refId.slice(0, at);
  const entry = refId.slice(at + REF_SEPARATOR.length);
  if (!ENTRY_PATTERN.test(entry)) return null;
  const entryId = BigInt(entry);
  if (entryId < 1n || entryId > MAX_ENTRY_ID) return null;
  const colon = key.indexOf(':');
  if (colon <= 0 || colon === key.length - 1 || key.includes(':', colon + 1)) return null;
  return {
    platform: key.slice(0, colon),
    subOrderId: key.slice(colon + 1),
    orderKey: key,
    entryId,
  };
}

export type R12Target = 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING';

/**
 * R12: no user_id → UNATTRIBUTED; RECEIVED / SETTLED with a received_at → WAITING; otherwise
 * ESTIMATED (DEPOSIT_PAID / PAID, or RECEIVED / SETTLED without received_at: R4 moves it on later,
 * the contract's default).
 */
export function r12TargetOf(order: {
  readonly user_id: string | null;
  readonly platform_status: string;
  readonly received_at: Date | null;
}): R12Target {
  if (order.user_id === null) return 'UNATTRIBUTED';
  const received = order.platform_status === 'RECEIVED' || order.platform_status === 'SETTLED';
  return received && order.received_at !== null ? 'WAITING' : 'ESTIMATED';
}

/** The positive part of the effective union commission (BR-CALC-02): settle when set, else est. */
export function effectiveCommissionPositive(settle: bigint | null, est: bigint | null): bigint {
  const effective = settle ?? est ?? 0n;
  return effective > 0n ? effective : 0n;
}

/** What the gate read for a beneficiary (CreditBeneficiaryState, structurally). */
export interface R13BeneficiaryState {
  readonly risk_state: string;
  readonly deletion_status: string | null;
  readonly is_minor: boolean;
}

export interface R13Beneficiary {
  readonly userId: string;
  readonly role: PlatformRestoreRole;
  readonly ratioBp: number;
  /** D10-481: the share's latest event (from initial_status, by event_seq) is forfeited. */
  readonly forfeited: boolean;
  readonly state: R13BeneficiaryState;
  /** The role's current net on the order (BR-FUND-08). */
  readonly netFen: bigint;
}

export interface R13Input {
  /** The positive part of the effective union commission (> 0). */
  readonly nFen: bigint;
  readonly reserveBp: number;
  readonly beneficiaries: readonly R13Beneficiary[];
  /** The platform's current net on the order (COMMISSION_REVENUE, BR-FUND-08). */
  readonly platformNetFen: bigint;
}

/**
 * Where a beneficiary's share went: credited to available, deferred (frozen / under appeal), to the
 * platform (banned, being deleted or deleted, promotion share of a minor; or a share already
 * forfeited), or nothing to do (difference ≤ 0).
 */
export type R13Outcome = 'credited' | 'deferred' | 'platform' | 'none';

export interface R13Row {
  readonly userId: string;
  readonly role: PlatformRestoreRole;
  readonly shareFen: bigint;
  /** What stays with the beneficiary after the restore (paid, deferred or already booked). */
  readonly entitlementFen: bigint;
  /** entitlement − current net. */
  readonly differenceFen: bigint;
  readonly outcome: R13Outcome;
  /** Credited or deferred by this restore (0 otherwise). */
  readonly amountFen: bigint;
  /**
   * BR-CALC-13: the reason of the forfeited event appended when part of a share that was not yet
   * forfeited goes to the platform; null otherwise.
   */
  readonly forfeitReason: 'banned' | 'deleted' | 'minor' | null;
}

export interface R13Plan {
  readonly nFen: bigint;
  readonly baseFen: bigint;
  readonly rows: readonly R13Row[];
  readonly platformEntitlementFen: bigint;
  /** platform entitlement − platform net. */
  readonly platformDifferenceFen: bigint;
  /** The platform voucher's amount (the positive difference; 0 → no voucher). */
  readonly platformPostFen: bigint;
  /** Σ credited to beneficiaries' available (the response's restored_fen). */
  readonly restoredFen: bigint;
}

type StateClass =
  | { readonly kind: 'forfeited' }
  | { readonly kind: 'forfeit'; readonly reason: 'banned' | 'deleted' | 'minor' }
  | { readonly kind: 'defer' }
  | { readonly kind: 'normal' };

/** BR-CALC-09 受益人状态规则; permanent states before the ones that can be lifted. */
function classify(b: R13Beneficiary): StateClass {
  if (b.forfeited) return { kind: 'forfeited' };
  if (b.state.deletion_status === 'processing' || b.state.deletion_status === 'done') {
    return { kind: 'forfeit', reason: 'deleted' };
  }
  if (b.state.risk_state === 'banned') return { kind: 'forfeit', reason: 'banned' };
  if (b.state.is_minor && b.role !== 'self') return { kind: 'forfeit', reason: 'minor' };
  if (b.state.risk_state === 'frozen' || b.state.risk_state === 'appealing') {
    return { kind: 'defer' };
  }
  return { kind: 'normal' };
}

function positive(fen: bigint): bigint {
  return fen > 0n ? fen : 0n;
}

function rowOf(b: R13Beneficiary, shareFen: bigint): R13Row {
  const state = classify(b);
  const base = { userId: b.userId, role: b.role, shareFen };
  if (state.kind === 'forfeited') {
    // BR-CALC-09: the new entitlement of a forfeited share is 0; the platform keeps it.
    return {
      ...base,
      entitlementFen: 0n,
      differenceFen: subFen(0n, b.netFen),
      outcome: 'platform',
      amountFen: 0n,
      forfeitReason: null,
    };
  }
  if (state.kind === 'forfeit') {
    // The lesser of the re-split share and what is already booked; the rest goes to the platform.
    const kept = positive(b.netFen);
    const entitlementFen = shareFen < kept ? shareFen : kept;
    return {
      ...base,
      entitlementFen,
      differenceFen: subFen(entitlementFen, b.netFen),
      outcome: 'platform',
      amountFen: 0n,
      forfeitReason: shareFen > entitlementFen ? state.reason : null,
    };
  }
  const differenceFen = subFen(shareFen, b.netFen);
  if (differenceFen <= 0n) {
    return {
      ...base,
      entitlementFen: shareFen,
      differenceFen,
      outcome: 'none',
      amountFen: 0n,
      forfeitReason: null,
    };
  }
  return {
    ...base,
    entitlementFen: shareFen,
    differenceFen,
    outcome: state.kind === 'normal' ? 'credited' : 'deferred',
    amountFen: differenceFen,
    forfeitReason: null,
  };
}

/** R13 of BR-FUND-22 on the current nets (no I/O). */
export function planR13(input: R13Input): R13Plan {
  if (input.nFen <= 0n) throw new RangeError('planR13: the effective commission must be positive');
  const { after_reserve_fen: baseFen } = applyReserve(input.nFen, BigInt(input.reserveBp));
  const { shares } = splitByBp(
    baseFen,
    input.beneficiaries.map((b) => BigInt(b.ratioBp)),
  );
  const rows = input.beneficiaries.map((b, i) => rowOf(b, shares[i] ?? 0n));
  let kept = 0n;
  let restoredFen = 0n;
  for (const row of rows) {
    kept = addFen(kept, row.entitlementFen);
    if (row.outcome === 'credited') restoredFen = addFen(restoredFen, row.amountFen);
  }
  const platformEntitlementFen = subFen(input.nFen, kept);
  const platformDifferenceFen = subFen(platformEntitlementFen, input.platformNetFen);
  return {
    nFen: input.nFen,
    baseFen,
    rows,
    platformEntitlementFen,
    platformDifferenceFen,
    platformPostFen: positive(platformDifferenceFen),
    restoredFen,
  };
}
