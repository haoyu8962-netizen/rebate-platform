// B2-02y zero crossings (claude-independent): BR-WDR-05 (a)「扣回或负向调整使 available 由 ≥0 变为 <0 的
// 事务内入队领域事件 account.went_negative」；回正（由 <0 变为 ≥0，细则例：available 由 −300 变为 +200）在
// 同一事务清空 negative_since 与 blocked_reason（恢复钩子）. Pure move out of the posting path
// (D10-2064 ②): ≥0→<0 为变负、<0→≥0 为回正；0 算 ≥0. Unit test: no database; expected values come
// from the rule.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  goesNegative,
  recovers,
} from '../../../../apps/api/src/modules/ledger/application/balance-transitions.ts';

// [before, after, 变负 goesNegative, 回正 recovers]
it.each<[string, bigint, bigint, boolean, boolean]>([
  ['正→正', 100n, 50n, false, false],
  ['正→负', 100n, -1n, true, false],
  ['负→正（细则例 −300 → +200）', -300n, 200n, false, true],
  ['负→负', -800n, -300n, false, false],
])('[AC-B2-02y#8] %s：%s → %s，变负=%s、回正=%s', (_label, before, after, negative, recovered) => {
  expect(goesNegative(before, after)).toBe(negative);
  expect(recovers(before, after)).toBe(recovered);
});

it.each<[string, bigint, bigint, boolean, boolean]>([
  ['0→负 一分（0 算 ≥0）', 0n, -1n, true, false],
  ['负 一分→0（恰好抵平算回正）', -1n, 0n, false, true],
  ['负→0（−800 入账 800 抵平）', -800n, 0n, false, true],
  ['0→0', 0n, 0n, false, false],
  ['0→正', 0n, 5n, false, false],
  ['正→0', 5n, 0n, false, false],
  ['负→负（不变）', -1n, -1n, false, false],
])(
  '[AC-B2-02y#9] 恰为 0 的边界 %s：%s → %s，变负=%s、回正=%s',
  (_label, before, after, negative, recovered) => {
    expect(goesNegative(before, after)).toBe(negative);
    expect(recovers(before, after)).toBe(recovered);
  },
);

const MIN = -(2n ** 63n);
const MAX = 2n ** 63n - 1n;
const negativeArb = fc.bigInt({ min: MIN, max: -1n });
const nonNegativeArb = fc.bigInt({ min: 0n, max: MAX });

it('[AC-B2-02y#10] 任意 ≥0 → <0：只算变负；任意 <0 → ≥0：只算回正', () => {
  fc.assert(
    fc.property(nonNegativeArb, negativeArb, (before, after) => {
      expect(goesNegative(before, after)).toBe(true);
      expect(recovers(before, after)).toBe(false);
      return true;
    }),
    propParams(),
  );
  fc.assert(
    fc.property(negativeArb, nonNegativeArb, (before, after) => {
      expect(goesNegative(before, after)).toBe(false);
      expect(recovers(before, after)).toBe(true);
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B2-02y#11] 不跨零（同为 ≥0 或同为 <0）时既不变负也不回正', () => {
  fc.assert(
    fc.property(nonNegativeArb, nonNegativeArb, (before, after) => {
      expect(goesNegative(before, after)).toBe(false);
      expect(recovers(before, after)).toBe(false);
      return true;
    }),
    propParams(),
  );
  fc.assert(
    fc.property(negativeArb, negativeArb, (before, after) => {
      expect(goesNegative(before, after)).toBe(false);
      expect(recovers(before, after)).toBe(false);
      return true;
    }),
    propParams(),
  );
}, 900_000);
