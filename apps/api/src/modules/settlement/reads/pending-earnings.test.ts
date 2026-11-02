import { expect, it } from 'vitest';
import { netOfOpenDeduction } from './pending-earnings.ts';

it('[AC-B2-03r-UNIT#2] 减未关闭应扣，下限 0；刚好减完是 0', () => {
  expect(netOfOpenDeduction(1000n, 400n)).toBe(600n);
  expect(netOfOpenDeduction(300n, 400n)).toBe(0n);
  expect(netOfOpenDeduction(400n, 400n)).toBe(0n);
});

it('[AC-B2-03r-UNIT#3] 没有未关闭应扣时原样返回：负佣金不抬到 0，未知仍是 null', () => {
  expect(netOfOpenDeduction(-5n, 0n)).toBe(-5n);
  expect(netOfOpenDeduction(1000n, 0n)).toBe(1000n);
  expect(netOfOpenDeduction(null, 0n)).toBeNull();
  expect(netOfOpenDeduction(null, 400n)).toBeNull();
});
