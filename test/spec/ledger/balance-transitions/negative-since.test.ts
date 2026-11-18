// B2-02y negative_since rule (claude-independent): BR-FUND-12「账户 available 由 ≥0 变为 <0 时记
// negative_since = 当日会计日（00:00 +08:00 日切），回到 ≥0 时清空」；前后都为负时原值不动（细则例：
// 11-20 扣至 −800 → negative_since=11-20，之后入账 500 至 −300 仍为 11-20；12-01 入账 800 抵平 → 清空）.
// Pure move out of the posting path (D10-2064 ②): 变后 <0 且变前 <0 有值 → 沿用；变后 <0 而变前 ≥0（或变前
// <0 无值）→ 当天；变后 ≥0 → null. Unit test: no database; expected values come from the rule.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { nextNegativeSince } from '../../../../apps/api/src/modules/ledger/application/balance-transitions.ts';

const SINCE = '2026-11-20';
const TODAY = '2026-12-01';

it('[AC-B2-02y#1] 变后 <0、变前 <0 且已有 negative_since → 沿用原值（−800 → −300，仍为 11-20）', () => {
  expect(
    nextNegativeSince({
      availableBefore: -800n,
      availableAfter: -300n,
      negativeSinceBefore: SINCE,
      day: TODAY,
    }),
  ).toBe(SINCE);
});

it.each<[bigint, bigint, string | null]>([
  [0n, -1n, null],
  [200n, -800n, null],
  [1n, -1n, null],
  [0n, -800n, '2026-10-01'],
])(
  '[AC-B2-02y#2] 变前 %s ≥0、变后 %s <0（变前 negative_since=%s）→ 记当天会计日',
  (before, after, since) => {
    expect(
      nextNegativeSince({
        availableBefore: before,
        availableAfter: after,
        negativeSinceBefore: since,
        day: TODAY,
      }),
    ).toBe(TODAY);
  },
);

it.each<[bigint, bigint]>([
  [-800n, -300n],
  [-1n, -1n],
  [-300n, -800n],
])(
  '[AC-B2-02y#3] 变前 %s <0 但 negative_since 为空、变后 %s <0 → 记当天会计日',
  (before, after) => {
    expect(
      nextNegativeSince({
        availableBefore: before,
        availableAfter: after,
        negativeSinceBefore: null,
        day: TODAY,
      }),
    ).toBe(TODAY);
  },
);

it.each<[bigint, bigint, string | null]>([
  [-800n, 0n, SINCE],
  [-300n, 200n, SINCE],
  [-1n, 0n, null],
  [0n, 0n, null],
  [100n, 50n, null],
  [0n, 1n, null],
  [5n, 0n, null],
])(
  '[AC-B2-02y#4] 变前 %s → 变后 %s ≥0（变前 negative_since=%s）→ null（清空）',
  (before, after, since) => {
    expect(
      nextNegativeSince({
        availableBefore: before,
        availableAfter: after,
        negativeSinceBefore: since,
        day: TODAY,
      }),
    ).toBeNull();
  },
);

it('[AC-B2-02y#5] BR-FUND-12 细则例：11-20 扣至 −800 记 11-20，入账 500 至 −300 不动，12-01 入账 800 抵平清空', () => {
  const first = nextNegativeSince({
    availableBefore: 0n,
    availableAfter: -800n,
    negativeSinceBefore: null,
    day: SINCE,
  });
  expect(first).toBe(SINCE);
  const second = nextNegativeSince({
    availableBefore: -800n,
    availableAfter: -300n,
    negativeSinceBefore: first,
    day: '2026-11-25',
  });
  expect(second).toBe(SINCE);
  const settled = nextNegativeSince({
    availableBefore: -800n,
    availableAfter: 0n,
    negativeSinceBefore: SINCE,
    day: TODAY,
  });
  expect(settled).toBeNull();
});

const negative = fc.bigInt({ min: -(2n ** 63n), max: -1n });
const nonNegative = fc.bigInt({ min: 0n, max: 2n ** 63n - 1n });
const pad = (n: number): string => String(n).padStart(2, '0');
const dayArb = fc
  .tuple(
    fc.integer({ min: 2026, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${String(y)}-${pad(m)}-${pad(d)}`);

it('[AC-B2-02y#6] 前后都为负且已有 negative_since 时原值不动（任意金额、任意当天）', () => {
  fc.assert(
    fc.property(negative, negative, dayArb, dayArb, (before, after, since, day) => {
      fc.pre(since !== day);
      expect(
        nextNegativeSince({
          availableBefore: before,
          availableAfter: after,
          negativeSinceBefore: since,
          day,
        }),
      ).toBe(since);
      return true;
    }),
    propParams(),
  );
});

it('[AC-B2-02y#7] 变后 ≥0 一律为 null；变后 <0 而变前 ≥0 一律为当天（任意金额）', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
      nonNegative,
      fc.option(dayArb, { nil: null }),
      dayArb,
      (before, after, since, day) => {
        expect(
          nextNegativeSince({
            availableBefore: before,
            availableAfter: after,
            negativeSinceBefore: since,
            day,
          }),
        ).toBeNull();
        return true;
      },
    ),
    propParams(),
  );
  fc.assert(
    fc.property(
      nonNegative,
      negative,
      fc.option(dayArb, { nil: null }),
      dayArb,
      (before, after, since, day) => {
        expect(
          nextNegativeSince({
            availableBefore: before,
            availableAfter: after,
            negativeSinceBefore: since,
            day,
          }),
        ).toBe(day);
        return true;
      },
    ),
    propParams(),
  );
});
