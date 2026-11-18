import { expect, it } from 'vitest';
import { goesNegative, nextNegativeSince, recovers } from './balance-transitions.ts';

const AMOUNTS: readonly bigint[] = [-(2n ** 63n), -800n, -300n, -1n, 0n, 1n, 200n, 2n ** 63n - 1n];
const SINCES: readonly (string | null)[] = [null, '2026-11-20'];
const DAY = '2026-12-01';

/** The posting path's inline expressions before B2-02y (ledger.ts computeWrite / write), verbatim. */
const before = {
  negativeSince(b: { available_fen: bigint; negative_since: string | null }, afterFen: bigint) {
    const after = { available_fen: afterFen };
    const day = DAY;
    return after.available_fen < 0n
      ? b.available_fen < 0n && b.negative_since !== null
        ? b.negative_since
        : day
      : null;
  },
  recovered(beforeFen: bigint, afterFen: bigint) {
    return beforeFen < 0n && afterFen >= 0n;
  },
  wentNegative(beforeFen: bigint, afterFen: bigint) {
    return beforeFen >= 0n && afterFen < 0n;
  },
};

it('[AC-B2-02y-UNIT#1] nextNegativeSince 与入账路径原判定在全部边界组合上一致', () => {
  let cases = 0;
  for (const b of AMOUNTS) {
    for (const a of AMOUNTS) {
      for (const since of SINCES) {
        expect(
          nextNegativeSince({
            availableBefore: b,
            availableAfter: a,
            negativeSinceBefore: since,
            day: DAY,
          }),
        ).toBe(before.negativeSince({ available_fen: b, negative_since: since }, a));
        cases += 1;
      }
    }
  }
  expect(cases).toBe(AMOUNTS.length * AMOUNTS.length * SINCES.length);
});

it('[AC-B2-02y-UNIT#2] recovers / goesNegative 与入账路径原判定在全部边界组合上一致，且二者互斥', () => {
  for (const b of AMOUNTS) {
    for (const a of AMOUNTS) {
      expect(recovers(b, a)).toBe(before.recovered(b, a));
      expect(goesNegative(b, a)).toBe(before.wentNegative(b, a));
      expect(recovers(b, a) && goesNegative(b, a)).toBe(false);
    }
  }
});

it('[AC-B2-02y-UNIT#3] negative_since 三分支：沿用、记当天、清空', () => {
  const base = { day: DAY };
  expect(
    nextNegativeSince({
      ...base,
      availableBefore: -800n,
      availableAfter: -300n,
      negativeSinceBefore: '2026-11-20',
    }),
  ).toBe('2026-11-20');
  expect(
    nextNegativeSince({
      ...base,
      availableBefore: 0n,
      availableAfter: -1n,
      negativeSinceBefore: null,
    }),
  ).toBe(DAY);
  expect(
    nextNegativeSince({
      ...base,
      availableBefore: -1n,
      availableAfter: -1n,
      negativeSinceBefore: null,
    }),
  ).toBe(DAY);
  expect(
    nextNegativeSince({
      ...base,
      availableBefore: -300n,
      availableAfter: 0n,
      negativeSinceBefore: '2026-11-20',
    }),
  ).toBeNull();
});

it('[AC-B2-02y-UNIT#4] 恰为 0 算 ≥0：0→−1 变负，−1→0 回正，0→0 两者皆否', () => {
  expect(goesNegative(0n, -1n)).toBe(true);
  expect(recovers(0n, -1n)).toBe(false);
  expect(recovers(-1n, 0n)).toBe(true);
  expect(goesNegative(-1n, 0n)).toBe(false);
  expect(goesNegative(0n, 0n)).toBe(false);
  expect(recovers(0n, 0n)).toBe(false);
});
