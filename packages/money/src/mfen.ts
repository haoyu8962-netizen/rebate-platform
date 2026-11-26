// BR-AI-16 (全局日预算与成本记账): model call cost in mfen (0.001 fen), integers only.
// Prices are mfen per million tokens, input and output priced apart:
//   cost = ceil(input_tokens × in_price / 1e6) + ceil(output_tokens × out_price / 1e6).
// mulDivCeil (index.ts) is not reused: its second operand is a basis-point ratio capped at 10000,
// while a price per million tokens is an unbounded non-negative integer. Same ceil formula here,
// with its own InvalidAmount checks (and no import cycle through index.ts).
import { InvalidAmount } from './errors.ts';

const PER_MILLION = 1_000_000n;

function assertCount(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount(`${name} must be a bigint`);
  if (value < 0n) throw new InvalidAmount(`${name} must be non-negative`);
}

function ceilPerMillion(tokens: bigint, pricePerM: bigint): bigint {
  return (tokens * pricePerM + PER_MILLION - 1n) / PER_MILLION;
}

/**
 * BR-AI-16: one model call's cost in mfen. Every argument must be a non-negative bigint (tokens,
 * mfen per million tokens), else InvalidAmount; each side is rounded up on its own.
 */
export function callCostMfen(
  inputTokens: bigint,
  outputTokens: bigint,
  inMfenPerM: bigint,
  outMfenPerM: bigint,
): bigint {
  assertCount(inputTokens, 'Input tokens');
  assertCount(outputTokens, 'Output tokens');
  assertCount(inMfenPerM, 'Input price');
  assertCount(outMfenPerM, 'Output price');
  return ceilPerMillion(inputTokens, inMfenPerM) + ceilPerMillion(outputTokens, outMfenPerM);
}

/**
 * BR-AI-16 细则「输出上限按剩余额度定」: the most tokens `mfen` pays for at `pricePerM` mfen per
 * million tokens, floor(mfen × 1e6 / price), so that ceil(tokens × price / 1e6) ≤ mfen.
 * `mfen` must be a non-negative bigint and `pricePerM` a positive bigint, else InvalidAmount.
 */
export function tokensWithinMfen(mfen: bigint, pricePerM: bigint): bigint {
  assertCount(mfen, 'Amount');
  assertCount(pricePerM, 'Price');
  if (pricePerM === 0n) throw new InvalidAmount('Price must be positive');
  return (mfen * PER_MILLION) / pricePerM;
}
