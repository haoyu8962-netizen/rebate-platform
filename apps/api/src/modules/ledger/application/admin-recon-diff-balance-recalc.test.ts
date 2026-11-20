// B2-02x unit tests (no database): planBalanceRecalc's branches and recalcBalanceAuditRecord, whose
// before and after each write available_fen from the available value and frozen_fen from the frozen
// value (spec-test r2 S2: the rule tests do not pin a swap within one side). Rule tests:
// test/spec/ledger/admin-recon-balance-recalc/**.
import { expect, it } from 'vitest';
import {
  balanceRecalcSourceRef,
  decideBalanceRecalc,
  planBalanceRecalc,
  recalcBalanceAuditRecord,
  type BalanceRecalcCache,
  type BalanceRecalcPlan,
  type BalanceRecalcSums,
} from './admin-recon-diff-balance-recalc.ts';

const DAY = '2026-11-18';
const EARLIER = '2026-10-02';
const DIFF = '0199a3b4-5c6d-7e8f-9a0b-0000000000d1';
const USER = '0199a3b4-5c6d-7e8f-9a0b-0000000000a1';

function cache(
  available: bigint,
  frozen: bigint,
  negativeSince: string | null = null,
  version = 4n,
): BalanceRecalcCache {
  return { available_fen: available, frozen_fen: frozen, negative_since: negativeSince, version };
}

function plan(before: BalanceRecalcCache, sums: BalanceRecalcSums): BalanceRecalcPlan {
  return planBalanceRecalc({ cache: before, sums, accountingDay: DAY });
}

function record(before: BalanceRecalcCache, sums: BalanceRecalcSums) {
  return recalcBalanceAuditRecord({
    reconDiffId: DIFF,
    userId: USER,
    reason: '核对无误',
    cache: before,
    sums,
    decision: decideBalanceRecalc({ cache: before, sums, accountingDay: DAY }),
  });
}

it('[AC-B2-02x-UNIT#1] 写回：合计与缓存不同 → write 两个合计、version + 1；不跨零时两个标志都为 false', () => {
  expect(plan(cache(5000n, 30n), { available_fen: 4900n, frozen_fen: 70n })).toEqual({
    kind: 'write',
    available_fen: 4900n,
    frozen_fen: 70n,
    negative_since: null,
    version: 5n,
    wentNegative: false,
    recovered: false,
  });
});

it('[AC-B2-02x-UNIT#2] 前后相同 → unchanged，缓存里与余额不相称的 negative_since 也不顺手改', () => {
  expect(plan(cache(10n, 0n, EARLIER), { available_fen: 10n, frozen_fen: 0n })).toEqual({
    kind: 'unchanged',
  });
});

it('[AC-B2-02x-UNIT#3] negative_since：负到负沿用原值；非负到负、或原为负但无值 → 当天；到非负 → null', () => {
  const kept = plan(cache(-5n, 0n, EARLIER), { available_fen: -9n, frozen_fen: 0n });
  expect(kept).toMatchObject({ kind: 'write', negative_since: EARLIER, wentNegative: false });
  const fresh = plan(cache(0n, 0n), { available_fen: -1n, frozen_fen: 0n });
  expect(fresh).toMatchObject({ kind: 'write', negative_since: DAY, wentNegative: true });
  const missing = plan(cache(-5n, 0n, null), { available_fen: -9n, frozen_fen: 0n });
  expect(missing).toMatchObject({ kind: 'write', negative_since: DAY, wentNegative: false });
  const cleared = plan(cache(-5n, 0n, EARLIER), { available_fen: 0n, frozen_fen: 0n });
  expect(cleared).toMatchObject({ kind: 'write', negative_since: null, recovered: true });
});

it('[AC-B2-02x-UNIT#4] 拒绝：frozen 合计为负先于越界判（两者同时成立时为 frozen_negative）；planBalanceRecalc 的越界只看 bigint 边界（应答范围由 decideBalanceRecalc 判）', () => {
  const max = 9_223_372_036_854_775_807n;
  expect(plan(cache(0n, 0n), { available_fen: max + 1n, frozen_fen: -1n })).toEqual({
    kind: 'refused',
    cause: 'frozen_negative',
  });
  expect(plan(cache(0n, 0n), { available_fen: max + 1n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'out_of_range',
  });
  expect(plan(cache(0n, 0n), { available_fen: -max - 1n, frozen_fen: max })).toMatchObject({
    kind: 'write',
  });
});

it('[AC-B2-02x-UNIT#5] 审计同一侧内 available_fen 与 frozen_fen 不对调：四个值各不相同，before 取锁内缓存、after 取写回值，各按字段名对应', () => {
  const row = record(cache(5000n, 300n), { available_fen: 4900n, frozen_fen: 700n });
  expect(row.target).toBe(DIFF);
  expect(row.before).toEqual({ available_fen: '5000', frozen_fen: '300' });
  expect(row.after).toEqual({
    recon_diff_id: DIFF,
    user_id: USER,
    reason: '核对无误',
    changed: true,
    available_fen: '4900',
    frozen_fen: '700',
  });
});

it('[AC-B2-02x-UNIT#6] 审计前后相同：changed false，after 与 before 同值且同样按字段名对应', () => {
  const row = record(cache(-40n, 15n, EARLIER), { available_fen: -40n, frozen_fen: 15n });
  expect(row.before).toEqual({ available_fen: '-40', frozen_fen: '15' });
  expect(row.after).toMatchObject({ changed: false, available_fen: '-40', frozen_fen: '15' });
});

it('[AC-B2-02x-UNIT#7] 拒绝的审计：记原因与精确合计（超出 bigint 也不丢位），after 的余额仍是未动的缓存，两种原因可区分', () => {
  const huge = 300n + 2n * 9_223_372_036_854_775_807n;
  const outOfRange = record(cache(-5n, 9n, EARLIER), { available_fen: huge, frozen_fen: 2n });
  expect(outOfRange.before).toEqual({ available_fen: '-5', frozen_fen: '9' });
  expect(outOfRange.after).toEqual({
    recon_diff_id: DIFF,
    user_id: USER,
    reason: '核对无误',
    changed: false,
    refused: 'sum_out_of_range',
    available_fen: '-5',
    frozen_fen: '9',
    entry_sums: { available_fen: huge.toString(), frozen_fen: '2' },
  });
  const negative = record(cache(-5n, 9n), { available_fen: 1700n, frozen_fen: -700n });
  expect(negative.after).toMatchObject({
    refused: 'frozen_negative',
    entry_sums: { available_fen: '1700', frozen_fen: '-700' },
  });
});

const JSON_MAX = 9_007_199_254_740_991n;

function decide(before: BalanceRecalcCache, sums: BalanceRecalcSums) {
  return decideBalanceRecalc({ cache: before, sums, accountingDay: DAY });
}

it('[AC-B2-02x-UNIT#17] 应答金额范围 ±(2^53 − 1)：合计越界 → sum_out_of_range，缓存越界 → cache_out_of_range；恰好 ±(2^53 − 1) 照写；frozen 为负先判', () => {
  expect(decide(cache(0n, 0n), { available_fen: JSON_MAX + 1n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'sum_out_of_range',
  });
  expect(decide(cache(0n, 0n), { available_fen: -JSON_MAX - 1n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'sum_out_of_range',
  });
  expect(decide(cache(0n, 0n), { available_fen: 0n, frozen_fen: JSON_MAX + 1n })).toEqual({
    kind: 'refused',
    cause: 'sum_out_of_range',
  });
  // Beyond bigint is beyond the response range too: the same cause.
  expect(decide(cache(0n, 0n), { available_fen: 2n ** 64n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'sum_out_of_range',
  });
  expect(decide(cache(JSON_MAX + 1n, 0n), { available_fen: 5n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'cache_out_of_range',
  });
  expect(decide(cache(-JSON_MAX - 1n, 0n), { available_fen: 5n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'cache_out_of_range',
  });
  expect(decide(cache(5n, JSON_MAX + 1n), { available_fen: 5n, frozen_fen: 0n })).toEqual({
    kind: 'refused',
    cause: 'cache_out_of_range',
  });
  // Equal sums and cache beyond the range: refused, not unchanged.
  expect(
    decide(cache(JSON_MAX + 1n, 0n), { available_fen: JSON_MAX + 1n, frozen_fen: 0n }),
  ).toMatchObject({ kind: 'refused' });
  expect(decide(cache(0n, 0n), { available_fen: -JSON_MAX - 1n, frozen_fen: -1n })).toEqual({
    kind: 'refused',
    cause: 'frozen_negative',
  });
  expect(decide(cache(-JSON_MAX, JSON_MAX), { available_fen: JSON_MAX, frozen_fen: 0n })).toEqual(
    plan(cache(-JSON_MAX, JSON_MAX), { available_fen: JSON_MAX, frozen_fen: 0n }),
  );
  expect(
    decide(cache(JSON_MAX, 0n), { available_fen: -JSON_MAX, frozen_fen: JSON_MAX }),
  ).toMatchObject({
    kind: 'write',
    available_fen: -JSON_MAX,
    frozen_fen: JSON_MAX,
    wentNegative: true,
  });
});

it('[AC-B2-02x-UNIT#18] frozen 下调与 available、frozen 同时下调都是 write（合计本身、version + 1），不是只报不写', () => {
  expect(decide(cache(300n, 500n), { available_fen: 300n, frozen_fen: 100n })).toEqual({
    kind: 'write',
    available_fen: 300n,
    frozen_fen: 100n,
    negative_since: null,
    version: 5n,
    wentNegative: false,
    recovered: false,
  });
  expect(decide(cache(900n, 500n), { available_fen: 200n, frozen_fen: 0n })).toEqual({
    kind: 'write',
    available_fen: 200n,
    frozen_fen: 0n,
    negative_since: null,
    version: 5n,
    wentNegative: false,
    recovered: false,
  });
});

it('[AC-B2-02x-UNIT#19] 拒绝审计三种原因可区分，缓存越界也记锁内缓存与合计', () => {
  const row = record(cache(JSON_MAX + 7n, 3n), { available_fen: 10n, frozen_fen: 3n });
  expect(row.before).toEqual({ available_fen: (JSON_MAX + 7n).toString(), frozen_fen: '3' });
  expect(row.after).toMatchObject({
    changed: false,
    refused: 'cache_out_of_range',
    entry_sums: { available_fen: '10', frozen_fen: '3' },
  });
});

it('[AC-B2-02x-UNIT#20] 来源号 recalc:<差错单>:<版本>', () => {
  expect(balanceRecalcSourceRef({ reconDiffId: DIFF, version: 10n })).toBe(`recalc:${DIFF}:10`);
});
