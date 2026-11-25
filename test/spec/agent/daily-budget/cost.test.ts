import { callCostMfen, InvalidAmount } from '@couli/money';
import { expect, it } from 'vitest';

it('[AC-B3-09m#1] 规则示例的 2,000 入和 300 出合计 320 mfen', () => {
  expect(callCostMfen(2_000n, 300n, 100_000n, 400_000n)).toBe(320n);
});

it('[AC-B3-09m#2] 输入和输出各自向上取整，整除部分不多收', () => {
  expect(callCostMfen(1n, 1n, 100_000n, 400_000n)).toBe(2n);
  expect(callCostMfen(10n, 5n, 100_000n, 400_000n)).toBe(3n);
  expect(callCostMfen(11n, 6n, 100_000n, 400_000n)).toBe(5n);
});

it('[AC-B3-09m#3] 零 token 的成本为 0', () => {
  expect(callCostMfen(0n, 0n, 100_000n, 400_000n)).toBe(0n);
});

it('[AC-B3-09m#4] 任一 token 数或单价为负数时抛 InvalidAmount', () => {
  expect(() => callCostMfen(-1n, 1n, 1n, 1n)).toThrow(InvalidAmount);
  expect(() => callCostMfen(1n, -1n, 1n, 1n)).toThrow(InvalidAmount);
  expect(() => callCostMfen(1n, 1n, -1n, 1n)).toThrow(InvalidAmount);
  expect(() => callCostMfen(1n, 1n, 1n, -1n)).toThrow(InvalidAmount);
});
