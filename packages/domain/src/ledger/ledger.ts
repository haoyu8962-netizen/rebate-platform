// Pure domain projections, not database row definitions. No I/O or clock access.
import { addFen, InvalidAmount, subFen } from '@couli/money';

const ROLES: readonly string[] = ['self', 'share', 'direct', 'indirect'];
/** Credit ledger types whose R14 reassignment reversal may push available below zero. */
const CREDIT_TYPES: readonly string[] = ['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT'];
/** BR-FUND-10: types whose negative (available-decreasing) writes may end below zero. */
const NEGATIVE_ALLOWED_TYPES: readonly string[] = ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'];
const REVERSE_SUFFIX = ':REVERSE';
/**
 * BR-FUND-24 ②: the reason codes of an executed ADMIN_ADJUST whose whole reversal may (with the
 * trusted ADMIN_ADJUST_REV context) leave available below zero. RESTORE is a BR-FUND-22 credit:
 * its reversal stays under the ordinary >= 0 rule (BR-FUND-10).
 */
const ADJUST_REVERSIBLE_SUB_TYPES: readonly string[] = [
  'RECON_FIX',
  'PAYOUT_RECOVERY',
  'ACCOUNT_CLOSED',
  'OTHER',
];
/** Exactly `ADJ:{adjust_id}:REVERSE`, adjust_id one id-like component (BR-FUND-24 ⑥). */
const ADJUST_REVERSE_KEY = /^ADJ:[0-9A-Za-z-]+:REVERSE$/;
const REVERSAL_KINDS: readonly string[] = ['REASSIGN_REV', 'ADMIN_ADJUST_REV'];
const USER_BALANCE = 'USER_BALANCE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** One key component: nonempty string without ':'. */
function component(value: unknown, name: string): string {
  if (!isNonEmptyString(value) || value.includes(':')) {
    throw new RangeError(`${name} must be a nonempty string without ':'`);
  }
  return value;
}

/** order_key = exactly two valid components ({platform}:{sub_order_id}). */
function orderKeyComponent(value: unknown): string {
  if (typeof value !== 'string') throw new RangeError('order_key must be a string');
  const parts = value.split(':');
  if (parts.length !== 2) throw new RangeError('order_key must be {platform}:{sub_order_id}');
  component(parts[0], 'platform');
  component(parts[1], 'sub_order_id');
  return value;
}

function roleComponent(value: unknown): LedgerRole {
  if (typeof value !== 'string' || !ROLES.includes(value)) {
    throw new RangeError('role must be one of self|share|direct|indirect');
  }
  return value as LedgerRole;
}

/** bigint fen inside the PG int64 range (checked by @couli/money). */
function isStorageFen(value: unknown): value is bigint {
  if (typeof value !== 'bigint') return false;
  try {
    addFen(value, 0n);
    return true;
  } catch (error) {
    if (error instanceof InvalidAmount) return false;
    throw error;
  }
}

/** Run a money operation, turning its InvalidAmount (e.g. int64 overflow) into RangeError. */
function money(operation: () => bigint): bigint {
  try {
    return operation();
  } catch (error) {
    if (error instanceof InvalidAmount) throw new RangeError(error.message, { cause: error });
    throw error;
  }
}
export type LedgerRole = 'self' | 'share' | 'direct' | 'indirect';

export type UniqKeyInput =
  | { kind: 'CREDIT'; order_key: string; user_id: string; role: LedgerRole }
  | { kind: 'PLATFORM_CREDIT'; order_key: string }
  | {
      kind: 'PLATFORM_FORFEIT';
      order_key: string;
      user_id: string;
      role: LedgerRole;
      reassign_id?: string;
    }
  | {
      kind: 'CLAWBACK';
      order_key: string;
      user_id: string;
      role: LedgerRole;
      rights_event_id: string;
    }
  | { kind: 'PLATFORM_CLAWBACK'; order_key: string; rights_event_id: string }
  | { kind: 'REVERSE'; original_uniq_key: string };

/**
 * BR-FUND-05: preserve the two components exactly, joined by ':'.
 * Each must be a nonempty string without ':'. Invalid input throws RangeError.
 * This is a namespace builder, not a platform registry or an ID-number parser.
 */
export function orderKey(platform: string, subOrderId: string): string {
  return `${component(platform, 'platform')}:${component(subOrderId, 'sub_order_id')}`;
}

/**
 * Only the formats in B2-01h §9. Scalar components are nonempty colon-free strings;
 * order_key must contain exactly two such components; role uses LedgerRole.
 * REVERSE accepts any nonempty original key (including ADJ keys from other callers),
 * but refuses an original ending in ':REVERSE'. Invalid input throws RangeError.
 */
export function uniqKey(input: UniqKeyInput): string {
  if (!isRecord(input)) throw new RangeError('uniqKey input must be an object');
  switch (input.kind) {
    case 'CREDIT':
      return `${orderKeyComponent(input.order_key)}:${component(input.user_id, 'user_id')}:${roleComponent(input.role)}:CREDIT`;
    case 'PLATFORM_CREDIT':
      return `${orderKeyComponent(input.order_key)}:PLATFORM:CREDIT`;
    case 'PLATFORM_FORFEIT': {
      const base = `${orderKeyComponent(input.order_key)}:PLATFORM:FORFEIT:${component(input.user_id, 'user_id')}:${roleComponent(input.role)}`;
      // Absent (undefined) means the BR-CALC-13 forfeit; anything else must be a valid id.
      if (input.reassign_id === undefined) return base;
      return `${base}:REASSIGN:${component(input.reassign_id, 'reassign_id')}`;
    }
    case 'CLAWBACK':
      return `${orderKeyComponent(input.order_key)}:${component(input.user_id, 'user_id')}:${roleComponent(input.role)}:CLAWBACK:${component(input.rights_event_id, 'rights_event_id')}`;
    case 'PLATFORM_CLAWBACK':
      return `${orderKeyComponent(input.order_key)}:PLATFORM:CLAWBACK:${component(input.rights_event_id, 'rights_event_id')}`;
    case 'REVERSE': {
      const original: unknown = input.original_uniq_key;
      if (!isNonEmptyString(original) || original.split(':').some((part) => part === '')) {
        throw new RangeError('original_uniq_key must be nonempty colon-separated components');
      }
      if (original.endsWith(REVERSE_SUFFIX)) {
        throw new RangeError('a REVERSE voucher cannot itself be reversed');
      }
      return `${original}${REVERSE_SUFFIX}`;
    }
    default:
      throw new RangeError('unsupported uniq_key kind');
  }
}

export interface LedgerEntry {
  readonly account_id: string;
  /** Nonempty subject code. USER_BALANCE requires available/frozen; others use null. */
  readonly account_code: string;
  readonly sub_account: 'available' | 'frozen' | null;
  /** BR-FUND-16: debit positive, credit negative; nonzero bigint fen. */
  readonly amount_fen: bigint;
}

export type VoucherValidationCode =
  'ENTRY_COUNT' | 'INVALID_AMOUNT' | 'INVALID_ACCOUNT' | 'INVALID_SUB_ACCOUNT' | 'UNBALANCED';

export interface VoucherValidationError {
  readonly code: VoucherValidationCode;
  /** Zero-based entry position; null for voucher-level errors. */
  readonly entry_index: number | null;
}

export type VoucherValidationResult =
  { ok: true } | { ok: false; errors: readonly VoucherValidationError[] };

/**
 * Returns errors rather than throwing for invalid vouchers, including runtime input.
 * Requires >=2 entries, complete account/sub-account fields, nonzero bigint amounts,
 * and sum zero. Report each malformed entry, without coercing amounts or mutating input.
 * Only calculate UNBALANCED when all amounts are valid. Arithmetic uses @couli/money.
 */
export function validateVoucher(entries: readonly LedgerEntry[]): VoucherValidationResult {
  if (!Array.isArray(entries)) {
    return { ok: false, errors: [{ code: 'ENTRY_COUNT', entry_index: null }] };
  }
  const list: readonly unknown[] = entries;
  const errors: VoucherValidationError[] = [];
  if (list.length < 2) errors.push({ code: 'ENTRY_COUNT', entry_index: null });
  const amounts: bigint[] = [];
  let amountsValid = true;
  list.forEach((entry: unknown, index) => {
    if (!isRecord(entry)) {
      errors.push({ code: 'INVALID_ACCOUNT', entry_index: index });
      errors.push({ code: 'INVALID_AMOUNT', entry_index: index });
      amountsValid = false;
      return;
    }
    const codeValid = isNonEmptyString(entry.account_code);
    if (!isNonEmptyString(entry.account_id) || !codeValid) {
      errors.push({ code: 'INVALID_ACCOUNT', entry_index: index });
    }
    if (codeValid) {
      const sub = entry.sub_account;
      const subValid =
        entry.account_code === USER_BALANCE
          ? sub === 'available' || sub === 'frozen'
          : 'sub_account' in entry && sub === null;
      if (!subValid) errors.push({ code: 'INVALID_SUB_ACCOUNT', entry_index: index });
    }
    const amount = entry.amount_fen;
    if (!isStorageFen(amount) || amount === 0n) {
      errors.push({ code: 'INVALID_AMOUNT', entry_index: index });
      amountsValid = false;
      return;
    }
    amounts.push(amount);
  });
  if (amountsValid) {
    // Sum debits and credits separately so ordering cannot cause a spurious overflow.
    let debit = 0n;
    let credit = 0n;
    try {
      for (const amount of amounts) {
        if (amount > 0n) debit = addFen(debit, amount);
        else credit = addFen(credit, amount);
      }
      if (addFen(debit, credit) !== 0n) errors.push({ code: 'UNBALANCED', entry_index: null });
    } catch (error) {
      if (!(error instanceof InvalidAmount)) throw error;
      // Total debits or credits exceed PG int64: the voucher cannot be stored.
      errors.push({ code: 'INVALID_AMOUNT', entry_index: null });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface LedgerBalance {
  readonly account_id: string;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
}

/**
 * BR-FUND-16: returns a fresh balance, subtracting this USER_BALANCE account's signed
 * entries separately from available/frozen (via @couli/money addFen/subFen).
 * Other accounts/platform subjects do not affect this cache. Accepts entry slices,
 * including an empty slice, so it does not require a whole balanced voucher.
 * Reject invalid matching entries, malformed balance, or negative final frozen with
 * RangeError. Final frozen is checked after the whole slice, not after each entry.
 * available may be negative here: the writer must separately call mayGoNegative.
 * Caller scopes all inputs to one app_id and handles locks, uniqueness and persistence.
 */
export function applyEntries(
  balance: LedgerBalance,
  entries: readonly LedgerEntry[],
): LedgerBalance {
  if (!isRecord(balance) || !isNonEmptyString(balance.account_id)) {
    throw new RangeError('balance.account_id must be a nonempty string');
  }
  const accountId = balance.account_id;
  const startAvailable: unknown = balance.available_fen;
  const startFrozen: unknown = balance.frozen_fen;
  if (!isStorageFen(startAvailable)) throw new RangeError('available_fen must be bigint fen');
  if (!isStorageFen(startFrozen) || startFrozen < 0n) {
    throw new RangeError('frozen_fen must be nonnegative bigint fen');
  }
  if (!Array.isArray(entries)) throw new RangeError('entries must be an array');
  const list: readonly unknown[] = entries;
  let available = startAvailable;
  let frozen = startFrozen;
  for (const entry of list) {
    if (!isRecord(entry)) throw new RangeError('ledger entry must be an object');
    if (entry.account_id !== accountId) continue;
    // Same account id under another subject code is a caller bug, not something to skip.
    if (entry.account_code !== USER_BALANCE) {
      throw new RangeError('entry for this account must use USER_BALANCE');
    }
    const amount = entry.amount_fen;
    if (!isStorageFen(amount) || amount === 0n) {
      throw new RangeError('amount_fen must be nonzero bigint fen');
    }
    // User liability account: balance = -sum(signed entries), per sub-account.
    if (entry.sub_account === 'available') {
      const current = available;
      available = money(() => subFen(current, amount));
    } else if (entry.sub_account === 'frozen') {
      const current = frozen;
      frozen = money(() => subFen(current, amount));
    } else {
      throw new RangeError('sub_account must be available or frozen');
    }
  }
  if (frozen < 0n) throw new RangeError('frozen_fen would become negative');
  return { account_id: accountId, available_fen: available, frozen_fen: frozen };
}

export interface NegativeBalanceInput {
  /** Contract ledger_type/sub_type values; strings allow unknown types to fail closed. */
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly uniq_key: string;
  readonly resulting_available_fen: bigint;
  /** New available minus old available: necessary to distinguish negative adjustments. */
  readonly available_delta_fen: bigint;
  /**
   * Trusted caller context, NOT a ledger_type/sub_type or a new uniq_key format: REASSIGN_REV for
   * R14 reversals; ADMIN_ADJUST_REV for the whole reversal `ADJ:{adjust_id}:REVERSE` of an
   * executed ADMIN_ADJUST (BR-FUND-24 细则「红冲只按原单整笔」, B2-12b).
   */
  readonly reversal_kind?: 'REASSIGN_REV' | 'ADMIN_ADJUST_REV';
}

/**
 * True means this write's resulting available is permitted by BR-FUND-10 (B2-01h §11).
 * Nonnegative results are permitted. Writes that do not decrease available
 * (available_delta_fen >= 0: credits, positive adjustments, WITHDRAW_RETURN, and also a
 * reversal that raises available, e.g. reversing a mistaken clawback -800 -> -400) are
 * permitted even when the result is still negative: credits offset the debt naturally.
 * A decrease ending below zero is permitted only for CLAWBACK, negative SETTLE_ADJUST /
 * ADMIN_ADJUST, R14 reversals of the three credit types (trusted reversal_kind,
 * never a substring match; its key format belongs to B2-01i), or the whole reversal
 * `ADJ:{adjust_id}:REVERSE` of a manual ADMIN_ADJUST (trusted ADMIN_ADJUST_REV, sub_type one of
 * RECON_FIX / PAYOUT_RECOVERY / ACCOUNT_CLOSED / OTHER; B2-12b). An ordinary ':REVERSE'
 * that decreases available below zero is refused, taking priority over the type list.
 * Any other decrease ending below zero (WITHDRAW_FEE etc.) is refused.
 * Malformed amounts, types or context fail closed (false).
 */
export function mayGoNegative(input: NegativeBalanceInput): boolean {
  if (!isRecord(input)) return false;
  const { ledger_type, sub_type, uniq_key, resulting_available_fen, available_delta_fen } = input;
  const reversalKind: unknown = input.reversal_kind;
  if (typeof resulting_available_fen !== 'bigint' || typeof available_delta_fen !== 'bigint') {
    return false;
  }
  if (typeof ledger_type !== 'string' || typeof uniq_key !== 'string') return false;
  if (sub_type !== null && typeof sub_type !== 'string') return false;
  if (reversalKind !== undefined && !REVERSAL_KINDS.includes(reversalKind as string)) {
    return false;
  }
  if (resulting_available_fen >= 0n) return true;
  // Not decreasing available: later credits offset a negative balance (BR-FUND-10).
  if (available_delta_fen >= 0n) return true;
  if (reversalKind === 'REASSIGN_REV') return CREDIT_TYPES.includes(ledger_type);
  if (reversalKind === 'ADMIN_ADJUST_REV') {
    // BR-FUND-24 细则「红冲只按原单整笔」: only the whole reversal of a manual adjustment.
    return (
      ledger_type === 'ADMIN_ADJUST' &&
      sub_type !== null &&
      ADJUST_REVERSIBLE_SUB_TYPES.includes(sub_type) &&
      ADJUST_REVERSE_KEY.test(uniq_key)
    );
  }
  if (uniq_key.endsWith(REVERSE_SUFFIX)) return false;
  return NEGATIVE_ALLOWED_TYPES.includes(ledger_type);
}
