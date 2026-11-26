import { expect, it } from 'vitest';
import * as impl from './mfen.ts';
import { callCostMfen, InvalidAmount, tokensWithinMfen } from './index.ts';

it('[AC-B3-09m#u1] index exports the mfen functions by reference', () => {
  expect(callCostMfen).toBe(impl.callCostMfen);
  expect(tokensWithinMfen).toBe(impl.tokensWithinMfen);
});

it('[AC-B3-09m#u2] callCostMfen rejects non-bigint operands', () => {
  expect(() => callCostMfen(1 as unknown as bigint, 1n, 1n, 1n)).toThrow(InvalidAmount);
});

it('[AC-B3-09m#u3] tokensWithinMfen floors so the tokens never cost more than the amount', () => {
  expect(tokensWithinMfen(4_100n, 400_000n)).toBe(10_250n);
  expect(tokensWithinMfen(3_480n, 400_000n)).toBe(8_700n);
  expect(tokensWithinMfen(1n, 3n)).toBe(333_333n);
  expect(callCostMfen(0n, tokensWithinMfen(1n, 3n), 0n, 3n)).toBe(1n);
  expect(tokensWithinMfen(0n, 7n)).toBe(0n);
});

it('[AC-B3-09m#u4] tokensWithinMfen rejects a negative amount or a non-positive price', () => {
  expect(() => tokensWithinMfen(-1n, 1n)).toThrow(InvalidAmount);
  expect(() => tokensWithinMfen(1n, 0n)).toThrow(InvalidAmount);
  expect(() => tokensWithinMfen(1n, -1n)).toThrow(InvalidAmount);
});
