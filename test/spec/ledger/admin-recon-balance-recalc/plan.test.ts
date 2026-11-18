// B2-02x pure decision rule test (claude-independent, SPEC_REF ba6655b1): planBalanceRecalc of
// apps/api/src/modules/ledger/application/admin-recon-diff-balance-recalc.ts — contracts/openapi.yaml
// recalcBalanceAdminReconDiff (CT-24zzn, CT-24zzna) with 08 BR-FUND-19 细则「差异以分录为准修正」
// (the cache becomes the entry sums, no amount from the handler), BR-FUND-12 (negative_since as on
// the posting path, ledger.ts computeWrite), BR-WDR-05 (a) (跨零 as ledger.ts wentNegative /
// recovered), D10-2032 ② (a negative frozen sum or a sum outside bigint is refused) and ④ (a
// change is version + 1; equal values write nothing). No database. Top-level it() only.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  planBalanceRecalc,
  type BalanceRecalcCache,
  type BalanceRecalcPlan,
} from '../../../../apps/api/src/modules/ledger/application/admin-recon-diff-balance-recalc.ts';

const DAY = '2026-11-18';
const EARLIER = '2026-10-02';
const MAX = 9_223_372_036_854_775_807n;
const MIN = -9_223_372_036_854_775_808n;

function cache(
  available: bigint,
  frozen = 0n,
  negativeSince: string | null = available < 0n ? EARLIER : null,
  version = 7n,
): BalanceRecalcCache {
  return { available_fen: available, frozen_fen: frozen, negative_since: negativeSince, version };
}

function plan(before: BalanceRecalcCache, available: bigint, frozen: bigint): BalanceRecalcPlan {
  return planBalanceRecalc({
    cache: before,
    sums: { available_fen: available, frozen_fen: frozen },
    accountingDay: DAY,
  });
}

function write(
  before: BalanceRecalcCache,
  after: {
    readonly available: bigint;
    readonly frozen: bigint;
    readonly negativeSince: string | null;
    readonly wentNegative?: boolean;
    readonly recovered?: boolean;
  },
): BalanceRecalcPlan {
  return {
    kind: 'write',
    available_fen: after.available,
    frozen_fen: after.frozen,
    negative_since: after.negativeSince,
    version: before.version + 1n,
    wentNegative: after.wentNegative ?? false,
    recovered: after.recovered ?? false,
  };
}

it('[AC-B2-02x#1] BR-FUND-19 例：缓存 available 5000、分录合计 4900 → 写回 4900（frozen 照分录 0），version + 1，negative_since 仍为空，不跨零', () => {
  const before = cache(5000n, 0n, null, 3n);
  expect(plan(before, 4900n, 0n)).toEqual(
    write(before, { available: 4900n, frozen: 0n, negativeSince: null }),
  );
});

it('[AC-B2-02x#2] available 与 frozen 两个子户各按自己的合计写回：只差 frozen、只差 available、两个都差都是 write，version 恰好 + 1', () => {
  const before = cache(1200n, 300n, null, 41n);
  expect(plan(before, 1200n, 500n)).toEqual(
    write(before, { available: 1200n, frozen: 500n, negativeSince: null }),
  );
  expect(plan(before, 900n, 300n)).toEqual(
    write(before, { available: 900n, frozen: 300n, negativeSince: null }),
  );
  expect(plan(before, 0n, 0n)).toEqual(
    write(before, { available: 0n, frozen: 0n, negativeSince: null }),
  );
});

it('[AC-B2-02x#3] 前后相同（两个合计都等于缓存）→ unchanged：不写余额行，version 与 negative_since 都不动（即使缓存的 negative_since 与余额不相称也不顺手改）', () => {
  expect(plan(cache(4900n, 0n, null), 4900n, 0n)).toEqual({ kind: 'unchanged' });
  expect(plan(cache(-300n, 0n, EARLIER), -300n, 0n)).toEqual({ kind: 'unchanged' });
  expect(plan(cache(-300n, 20n, null), -300n, 20n)).toEqual({ kind: 'unchanged' });
  expect(plan(cache(500n, 0n, EARLIER), 500n, 0n)).toEqual({ kind: 'unchanged' });
});

it('[AC-B2-02x#4] negative_since 分支一（BR-FUND-12，同入账路径）：重算后 < 0 且重算前也 < 0、有 negative_since → 沿用原值，不改成当天', () => {
  const before = cache(-500n, 0n, EARLIER);
  expect(plan(before, -300n, 0n)).toEqual(
    write(before, { available: -300n, frozen: 0n, negativeSince: EARLIER }),
  );
  expect(plan(before, -9000n, 40n)).toEqual(
    write(before, { available: -9000n, frozen: 40n, negativeSince: EARLIER }),
  );
});

it('[AC-B2-02x#5] negative_since 分支二：重算后 < 0 而重算前 ≥ 0（含正好 0），或重算前 < 0 却没有 negative_since → 当天会计日', () => {
  for (const before of [cache(200n, 0n, null), cache(0n, 0n, null), cache(-500n, 0n, null)]) {
    expect(plan(before, -300n, 0n), `${before.available_fen} / ${before.negative_since}`).toEqual(
      write(before, {
        available: -300n,
        frozen: 0n,
        negativeSince: DAY,
        wentNegative: before.available_fen >= 0n,
      }),
    );
  }
});

it('[AC-B2-02x#6] negative_since 分支三：重算后 ≥ 0（含正好 0）→ NULL，不论重算前是否为负', () => {
  for (const before of [cache(-500n, 0n, EARLIER), cache(-1n, 0n, null), cache(300n, 0n, null)]) {
    for (const available of [0n, 1n, 400n]) {
      expect(plan(before, available, 0n)).toEqual(
        write(before, {
          available,
          frozen: 0n,
          negativeSince: null,
          recovered: before.available_fen < 0n,
        }),
      );
    }
  }
});

it('[AC-B2-02x#7] 前后都为负时原值不动：缓存 −1（negative_since 为较早一天）重算成 −999999、只改 frozen 也一样，negative_since 仍是缓存里的原值', () => {
  const before = cache(-1n, 10n, EARLIER);
  expect(plan(before, -999_999n, 10n)).toEqual(
    write(before, { available: -999_999n, frozen: 10n, negativeSince: EARLIER }),
  );
  expect(plan(before, -1n, 0n)).toEqual(
    write(before, { available: -1n, frozen: 0n, negativeSince: EARLIER }),
  );
});

it('[AC-B2-02x#8] 跨零（D10-2041，同入账路径判定）：0 → −1 为 wentNegative；−1 → 0 为 recovered；同号之间（负到负、正到正、只改 frozen）两者都不是', () => {
  const zero = cache(0n, 0n, null);
  expect(plan(zero, -1n, 0n)).toEqual(
    write(zero, { available: -1n, frozen: 0n, negativeSince: DAY, wentNegative: true }),
  );
  const minusOne = cache(-1n, 0n, EARLIER);
  expect(plan(minusOne, 0n, 0n)).toEqual(
    write(minusOne, { available: 0n, frozen: 0n, negativeSince: null, recovered: true }),
  );
  const negative = cache(-5n, 0n, EARLIER);
  expect(plan(negative, -1n, 0n)).toEqual(
    write(negative, { available: -1n, frozen: 0n, negativeSince: EARLIER }),
  );
  const positive = cache(5n, 0n, null);
  expect(plan(positive, 1n, 0n)).toEqual(
    write(positive, { available: 1n, frozen: 0n, negativeSince: null }),
  );
  expect(plan(positive, 5n, 9n)).toEqual(
    write(positive, { available: 5n, frozen: 9n, negativeSince: null }),
  );
});

it('[AC-B2-02x#9] frozen 合计为负（D10-2032 ②）→ refused frozen_negative，不论 available 合计如何；frozen 合计正好 0 照常写', () => {
  for (const available of [-50n, 0n, 700n]) {
    expect(plan(cache(100n, 0n, null), available, -1n)).toEqual({
      kind: 'refused',
      cause: 'frozen_negative',
    });
  }
  expect(plan(cache(100n, 0n, null), 700n, -700n)).toEqual({
    kind: 'refused',
    cause: 'frozen_negative',
  });
  const before = cache(100n, 5n, null);
  expect(plan(before, 100n, 0n)).toEqual(
    write(before, { available: 100n, frozen: 0n, negativeSince: null }),
  );
});

it('[AC-B2-02x#10] 合计超出 PostgreSQL bigint（−2^63 … 2^63 − 1）→ refused out_of_range；边界值 2^63 − 1 与 −2^63 本身可以写', () => {
  const before = cache(100n, 0n, null);
  expect(plan(before, MAX + 1n, 0n)).toEqual({ kind: 'refused', cause: 'out_of_range' });
  expect(plan(before, MIN - 1n, 0n)).toEqual({ kind: 'refused', cause: 'out_of_range' });
  expect(plan(before, 2n * MAX, 0n)).toEqual({ kind: 'refused', cause: 'out_of_range' });
  expect(plan(before, 100n, MAX + 1n)).toEqual({ kind: 'refused', cause: 'out_of_range' });
  expect(plan(before, 100n, 2n * MAX)).toEqual({ kind: 'refused', cause: 'out_of_range' });
  expect(plan(before, MAX, MAX)).toEqual(
    write(before, { available: MAX, frozen: MAX, negativeSince: null }),
  );
  expect(plan(before, MIN, 0n)).toEqual(
    write(before, { available: MIN, frozen: 0n, negativeSince: DAY, wentNegative: true }),
  );
});

it('[AC-B2-02x#11] frozen 合计既为负又低于 −2^63 → 也是 refused（原因不钉）', () => {
  const result = plan(cache(0n, 0n, null), 0n, MIN - 1n);
  expect(result.kind).toBe('refused');
});

const inRange = fc.bigInt({ min: MIN, max: MAX });
const frozenInRange = fc.bigInt({ min: 0n, max: MAX });
const day = fc.constantFrom(EARLIER, '2026-11-01', '2025-12-31');
const cacheArb = fc.record({
  available_fen: fc.oneof(fc.bigInt({ min: -10_000n, max: 10_000n }), inRange),
  frozen_fen: fc.oneof(fc.bigInt({ min: 0n, max: 10_000n }), frozenInRange),
  negative_since: fc.option(day, { nil: null }),
  version: fc.bigInt({ min: 0n, max: 1_000_000n }),
});

it('[AC-B2-02x#12] 性质：合计在范围内且 frozen ≥ 0 时，相等即 unchanged；不等即 write 合计本身、version + 1、negative_since 照入账规则、跨零标志照前后 available 判定', () => {
  fc.assert(
    fc.property(
      cacheArb,
      fc.oneof(fc.bigInt({ min: -10_000n, max: 10_000n }), inRange),
      fc.oneof(fc.bigInt({ min: 0n, max: 10_000n }), frozenInRange),
      fc.boolean(),
      (before, available, frozen, same) => {
        const sums = same
          ? { available: before.available_fen, frozen: before.frozen_fen }
          : { available, frozen };
        const result = plan(before, sums.available, sums.frozen);
        if (sums.available === before.available_fen && sums.frozen === before.frozen_fen) {
          expect(result).toEqual({ kind: 'unchanged' });
          return true;
        }
        const negativeSince =
          sums.available < 0n
            ? before.available_fen < 0n && before.negative_since !== null
              ? before.negative_since
              : DAY
            : null;
        expect(result).toEqual(
          write(before, {
            available: sums.available,
            frozen: sums.frozen,
            negativeSince,
            wentNegative: before.available_fen >= 0n && sums.available < 0n,
            recovered: before.available_fen < 0n && sums.available >= 0n,
          }),
        );
        return true;
      },
    ),
    propParams(),
  );
});

it('[AC-B2-02x#13] 性质：frozen 合计在 [−2^63, −1] → frozen_negative；任一合计超出 bigint 而 frozen 不为负 → out_of_range；都与缓存无关', () => {
  const beyond = fc.oneof(
    fc.bigInt({ min: MAX + 1n, max: 4n * MAX }),
    fc.bigInt({ min: 4n * MIN, max: MIN - 1n }),
  );
  fc.assert(
    fc.property(
      cacheArb,
      inRange,
      fc.bigInt({ min: MIN, max: -1n }),
      (before, available, frozen) => {
        expect(plan(before, available, frozen)).toEqual({
          kind: 'refused',
          cause: 'frozen_negative',
        });
        return true;
      },
    ),
    propParams(),
  );
  fc.assert(
    fc.property(cacheArb, beyond, frozenInRange, (before, available, frozen) => {
      expect(plan(before, available, frozen)).toEqual({ kind: 'refused', cause: 'out_of_range' });
      return true;
    }),
    propParams(),
  );
  fc.assert(
    fc.property(
      cacheArb,
      inRange,
      fc.bigInt({ min: MAX + 1n, max: 4n * MAX }),
      (before, available, frozen) => {
        expect(plan(before, available, frozen)).toEqual({
          kind: 'refused',
          cause: 'out_of_range',
        });
        return true;
      },
    ),
    propParams(),
  );
});
