// @couli/money: integer-fen (bigint) amounts and basis-point ratios.
//
// Pure arithmetic primitives; commission split policies belong to packages/domain (B2-03).
// Rules: 规划/08 BR-CALC-01, 02, 08, 26 (text in the task brief).

import { InvalidAmount, InvalidRatio } from './errors.ts';

export { addFen, subFen, type SubFenOptions } from './add-sub.ts';
export { floorToStepFen } from './floor-to-step.ts';
export { formatYuan, formatYuanAdmin, formatYuanRange } from './display.ts';
export { InvalidAmount, InvalidRatio } from './errors.ts';
export { callCostMfen, tokensWithinMfen } from './mfen.ts';
export { mulBpBpFloor } from './mul-bp-bp.ts';

/** Result of splitByBp: one floor amount per input ratio (same order) and what is left. */
export type SplitResult = {
  /** shares[i] = floor(base_fen * shares_bp[i] / 10000), each computed on its own. */
  shares: bigint[];
  /** base_fen - sum(shares); undistributed remainder returned to the caller. */
  remainder: bigint;
};

/** Result of applyReserve (BR-CALC-02, before any tlj_deduct_fen). */
export type ReserveResult = {
  /** floor(max(0, n_base_fen) * (10000 - reserve_bp) / 10000). */
  after_reserve_fen: bigint;
  /** max(0, n_base_fen) - after_reserve_fen; the rounding tail goes here (platform). */
  reserve_fen: bigint;
};

const BP = 10000n;
const MAX_JSON_FEN = 9007199254740991n;
const MIN_STORAGE_FEN = -9223372036854775808n;
const MAX_STORAGE_FEN = 9223372036854775807n;

/** Validate parsed fen after rounding; intermediate arithmetic remains arbitrary precision. */
function checkedParsedFen(fen: bigint): bigint {
  if (fen < MIN_STORAGE_FEN || fen > MAX_STORAGE_FEN) {
    throw new InvalidAmount('Amount exceeds the PG bigint range');
  }
  return fen;
}

/** Bound validated integer digits before BigInt conversion, ignoring leading zeros. */
function boundedIntegerDigits(
  digits: string,
  ErrorType: typeof InvalidAmount | typeof InvalidRatio,
): string {
  const significant = digits.replace(/^0+/, '');
  if (significant.length > 19) throw new ErrorType('Integer part exceeds the int64 digit limit');
  return significant || '0';
}

function assertAmount(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount('Amount must be bigint fen');
}

function assertNonNegativeAmount(value: unknown): asserts value is bigint {
  assertAmount(value);
  if (value < 0n) throw new InvalidAmount('Amount must be non-negative');
}

function assertRatio(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > BP) {
    throw new InvalidRatio('Ratio must be bigint basis points in 0..10000');
  }
}

function assertDenominator(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new InvalidRatio('Denominator must be a positive bigint');
  }
}

/** Parse the full decimal literal, then floor to hundredths, including for negative values. */
function decimalToHundredths(
  text: string,
  ErrorType: typeof InvalidAmount | typeof InvalidRatio,
): { value: bigint; hasTail: boolean } {
  if (typeof text !== 'string') throw new ErrorType('Decimal input must be a string');
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  // `$` also matches before a final newline; require the entire input to be consumed.
  if (!match || match[0] !== text) throw new ErrorType('Invalid decimal string');
  const whole = match[2];
  if (whole === undefined) throw new ErrorType('Missing decimal integer part');
  const fraction = match[3] ?? '';
  const magnitude =
    BigInt(boundedIntegerDigits(whole, ErrorType)) * 100n +
    BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  const hasTail = /[1-9]/.test(fraction.slice(2));
  const value = match[1] === '-' ? -magnitude - (hasTail ? 1n : 0n) : magnitude;
  return { value, hasTail };
}

/**
 * Strict amount parser for values coming from JSON, the database driver or config.
 * All parsed amounts must fit the signed PG bigint (int64) range, else InvalidAmount.
 * - bigint: returned unchanged (any sign, within int64).
 * - number: only a safe integer (|n| <= 2^53 - 1) is accepted; fractions, NaN, Infinity and
 *   unsafe integers throw InvalidAmount.
 * - string: only a plain base-10 integer, optional leading "-" (e.g. "1452", "-320",
 *   "9007199254740993"); anything else ("", "1.5", "1e3", "0x10", " 12", "NaN") throws.
 * - any other type throws InvalidAmount.
 */
export function parseFen(value: unknown): bigint {
  if (typeof value === 'bigint') return checkedParsedFen(value);
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return checkedParsedFen(BigInt(value));
  if (typeof value === 'string' && /^-?[0-9]+$/.exec(value)?.[0] === value) {
    const negative = value.startsWith('-');
    const magnitude = BigInt(
      boundedIntegerDigits(negative ? value.slice(1) : value, InvalidAmount),
    );
    return checkedParsedFen(negative ? -magnitude : magnitude);
  }
  throw new InvalidAmount('Expected bigint, safe integer, or decimal integer string');
}

/**
 * Canonical yuan string of an amount in fen: optional "-", integer yuan, ".", exactly two
 * digits (1452n -> "14.52", 5n -> "0.05", 0n -> "0.00", -320n -> "-3.20"). Not a UI display
 * format. Inverse of yuanStrToFen. A non-bigint argument throws InvalidAmount.
 */
export function formatFen(fen: bigint): string {
  assertAmount(fen);
  const magnitude = fen < 0n ? -fen : fen;
  return `${fen < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/**
 * BR-CALC-26: decimal yuan string -> fen, without ever going through a JS number.
 * Up to two decimals is exact ("14.5" -> 1450n, "14" -> 1400n, "-3.20" -> -320n); more than two
 * decimals is floored to the fen ("14.526" -> 1452n; "-0.001" -> -1n).
 * Empty, non-numeric, scientific notation,
 * NaN / Infinity, non-string arguments and rounded fen outside int64 throw InvalidAmount.
 */
export function yuanStrToFen(text: string): bigint {
  return checkedParsedFen(decimalToHundredths(text, InvalidAmount).value);
}

/** BR-CALC-26: percentage string -> bigint bp, floored; the raw ratio must be in 0..100%. */
export function pctStrToBp(text: string): bigint {
  const { value, hasTail } = decimalToHundredths(text, InvalidRatio);
  assertRatio(value);
  if (value === BP && hasTail) throw new InvalidRatio('Percentage exceeds 100%');
  return value;
}

/**
 * BR-CALC-01 serialization: the JSON integer for an amount. Throws InvalidAmount when
 * |fen| > 2^53 - 1 (never loses precision silently) or when fen is not a bigint.
 */
export function fenToJsonNumber(fen: bigint): number {
  assertAmount(fen);
  if (fen < -MAX_JSON_FEN || fen > MAX_JSON_FEN) {
    // The service boundary catches this error and emits its alert; this library does no I/O.
    throw new InvalidAmount('Amount exceeds the safe JSON integer range');
  }
  return Number(fen);
}

/**
 * BR-CALC-01 / BR-CALC-08: floor(amount_fen * ratio_bp / denominator), multiply first.
 * amount_fen must be a bigint >= 0 (else InvalidAmount); ratio_bp must be a bigint in 0..10000
 * (else InvalidRatio); denominator must be a positive bigint (callers pass 10000n).
 */
export function mulDivFloor(amount_fen: bigint, ratio_bp: bigint, denominator: bigint): bigint {
  assertNonNegativeAmount(amount_fen);
  assertRatio(ratio_bp);
  assertDenominator(denominator);
  return (amount_fen * ratio_bp) / denominator;
}

/** BR-CALC-01: ceil with the same non-negative amount / ratio / denominator checks as floor. */
export function mulDivCeil(amount_fen: bigint, ratio_bp: bigint, denominator: bigint): bigint {
  assertNonNegativeAmount(amount_fen);
  assertRatio(ratio_bp);
  assertDenominator(denominator);
  return (amount_fen * ratio_bp + denominator - 1n) / denominator;
}

/**
 * Allocate an amount by basis points: each part is floored on its own (BR-CALC-08),
 * and the undistributed remainder is returned to the caller.
 * The commission split itself is a packages/domain function (B2-03) that calls this primitive.
 * base_fen must be a bigint >= 0 (else
 * InvalidAmount); every ratio a bigint in 0..10000 and their sum <= 10000 (else InvalidRatio).
 * The input array is not modified.
 */
export function splitByBp(base_fen: bigint, shares_bp: readonly bigint[]): SplitResult {
  assertNonNegativeAmount(base_fen);
  if (!Array.isArray(shares_bp)) throw new InvalidRatio('Shares must be an array of basis points');
  let totalBp = 0n;
  let remainder = base_fen;
  const shares: bigint[] = [];
  for (const bp of shares_bp) {
    assertRatio(bp);
    totalBp += bp;
    if (totalBp > BP) throw new InvalidRatio('Sum of share ratios exceeds 10000');
    const share = mulDivFloor(base_fen, bp, BP);
    shares.push(share);
    remainder -= share;
  }
  return { shares, remainder };
}

/**
 * BR-CALC-02: platform reserve before the split. N_pos = max(0, n_base_fen) (a negative or zero
 * N gives 0 / 0); after_reserve_fen = floor(N_pos * (10000 - reserve_bp) / 10000);
 * reserve_fen = N_pos - after_reserve_fen. n_base_fen must be a bigint (else InvalidAmount);
 * reserve_bp a bigint in 0..10000 (else InvalidRatio).
 */
export function applyReserve(n_base_fen: bigint, reserve_bp: bigint): ReserveResult {
  assertAmount(n_base_fen);
  assertRatio(reserve_bp);
  const positive = n_base_fen > 0n ? n_base_fen : 0n;
  const after_reserve_fen = mulDivFloor(positive, BP - reserve_bp, BP);
  return { after_reserve_fen, reserve_fen: positive - after_reserve_fen };
}
