// B2-04zi 源码旁单元测试：新结算额相对 booked 成对值的方向（BR-FUND-01「R9 与 R9b 的判定」、BR-FUND-09 整单分路）。
import { expect, it } from 'vitest';
import { settleDirection } from './settle-direction.ts';

it('[AC-B2-04zi#U1] 正数部分为 0（含负数）不论原基数都是 zero', () => {
  expect(settleDirection(0n, { base: 1000n, n: 1000n }, 0n)).toBe('zero');
  expect(settleDirection(-7n, { base: 1000n, n: 1000n }, 0n)).toBe('zero');
  expect(settleDirection(0n, { base: 0n, n: 2n }, 7500n)).toBe('zero');
});

it('[AC-B2-04zi#U2] 原基数大于 0 而新基数为 0 是 zero；新旧基数都为 0 而佣金仍为正不是', () => {
  // reserve 75%: N 4 → B 1, N 3 → B 0.
  expect(settleDirection(3n, { base: 1n, n: 4n }, 7500n)).toBe('zero');
  // N 2 → B 0, N 1 → B 0: only the platform amount moves.
  expect(settleDirection(1n, { base: 0n, n: 2n }, 7500n)).toBe('down');
  expect(settleDirection(3n, { base: 0n, n: 2n }, 7500n)).toBe('up');
});

it('[AC-B2-04zi#U3] 先比基数：基数低为 down、高为 up', () => {
  expect(settleDirection(800n, { base: 1000n, n: 1000n }, 0n)).toBe('down');
  expect(settleDirection(1200n, { base: 1000n, n: 1000n }, 0n)).toBe('up');
});

it('[AC-B2-04zi#U4] 基数相等再比佣金正数部分：低 down、高 up、相等 same', () => {
  // reserve 50%: N 5 → B 2, N 4 → B 2.
  expect(settleDirection(4n, { base: 2n, n: 5n }, 5000n)).toBe('down');
  expect(settleDirection(5n, { base: 2n, n: 4n }, 5000n)).toBe('up');
  expect(settleDirection(5n, { base: 2n, n: 5n }, 5000n)).toBe('same');
  expect(settleDirection(1000n, { base: 1000n, n: 1000n }, 0n)).toBe('same');
});
