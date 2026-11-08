import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { isPriceAnomaly } from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import {
  UnionError,
  type UnionItem,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  mapDataokeSearchItem,
  type DataokeSearchCandidate,
} from '../../../../apps/api/src/modules/union/infra/taobao/dataoke-search.ts';
import type { TaobaoWarning } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  couliItemId,
  dtkGoodsId,
  dtkRow,
  expectTrueIdentities,
  expectWarned,
  instant,
  rowWithout,
  SEARCH_PATH,
  searchRows,
  visible,
  type Harness,
  type Row,
} from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzf#n]) identify this task's acceptance points, not business rules.
// D10-1072 ②（B1-04zh 遗留）：大淘客搜索的 price_fen = actualPrice + couponPrice。两个金额各自合法
// （parseYuanToFen 收下、都在 int64 内），相加却超出 int64 时，只把这一条标成价格异常：照样返回，
// price_status 'anomaly'、price_anomaly_reason 'invalid_price'、三价 0n（与 missing_field 那一路同形），
// 告警 PRICE_ANOMALY 恰好一次；同页其余条目照常映射、价格正确，整页不失败。
// 金额全是合成值：INT64_MAX 分 = 92233720368547758.07 元，两个都取它的一半以上即可让和越界。

const INT64_MAX = 9_223_372_036_854_775_807n;
/** 元字符串：每个都合法（≤ INT64_MAX 分），两两相加越界。 */
const HUGE_YUAN = '50000000000000000.00';
const HUGE_FEN = 5_000_000_000_000_000_000n;

/** Exact yuan text of a non-negative fen amount (two decimals). */
function yuanOf(fen: bigint): string {
  return `${fen / 100n}.${String(fen % 100n).padStart(2, '0')}`;
}

function priceAnomalyCount(h: Harness): number {
  return h.warn.mock.calls.filter(([event]) => event.code === 'PRICE_ANOMALY').length;
}

function expectOverflowAnomaly(item: UnionItem): void {
  expect(item.price_status).toBe('anomaly');
  expect(item.price_anomaly_reason).toBe('invalid_price');
  // 不出截断值、不出部分价格（与 missing_field 那一路一样三价 0n）。
  expect(item.price_fen).toBe(0n);
  expect(item.coupon_fen).toBe(0n);
  expect(item.final_price_fen).toBe(0n);
  expect(isPriceAnomaly(item)).toBe(true);
}

/** dtkRow 的默认三价：actualPrice 39.9 + couponPrice 20。 */
function expectDefaultOkPrice(item: UnionItem): void {
  expect(item.price_status).toBe('ok');
  expect(item.price_fen).toBe(5990n);
  expect(item.coupon_fen).toBe(2000n);
  expect(item.final_price_fen).toBe(3990n);
  expect(item).not.toHaveProperty('price_anomaly_reason');
  expect(isPriceAnomaly(item)).toBe(false);
}

it('[AC-B1-04zzzzf#1] 经 searchItems（大淘客搜索）：一条 actualPrice + couponPrice 越界、一条正常 → 不抛错，两条都返回；越界那条 anomaly / invalid_price / 三价 0，正常那条价格正确；PRICE_ANOMALY 恰好一次', async () => {
  const overflow = dtkRow(1, { actualPrice: HUGE_YUAN, couponPrice: HUGE_YUAN });
  const { h, page } = await searchRows([overflow, dtkRow(2)]);
  expect(page.items).toHaveLength(2);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);
  expectOverflowAnomaly(page.items[0]!);
  expectDefaultOkPrice(page.items[1]!);
  expectWarned(h, 'PRICE_ANOMALY');
  expect(priceAnomalyCount(h)).toBe(1);
  // 告警只带路径与固定码，不带金额原值。
  expect(visible(h.warn.mock.calls)).not.toContain('50000000000000000');
  expect(page.nextCursor).toBeNull();
});

it.each([
  ['两个元字符串各取一半以上', { actualPrice: HUGE_YUAN, couponPrice: HUGE_YUAN }],
  [
    'JSON number（String() 后合法）',
    { actualPrice: 90_000_000_000_000_000, couponPrice: 90_000_000_000_000_000 },
  ],
  ['券面额接近上限、售价 1 元', { actualPrice: '1.00', couponPrice: yuanOf(INT64_MAX) }],
  ['售价恰为上限、券 0.01 元', { actualPrice: yuanOf(INT64_MAX), couponPrice: '0.01' }],
] as [string, Row][])(
  '[AC-B1-04zzzzf#2] %s → 越界那条照样返回为价格异常（invalid_price），前后正常条目照常、顺序不变、整页不失败',
  async (_label, overrides) => {
    const { h, page } = await searchRows([dtkRow(1), dtkRow(2, overrides), dtkRow(3)]);
    expect(page.items).toHaveLength(3);
    expect(expectTrueIdentities(page)).toEqual([1, 2, 3]);
    expectDefaultOkPrice(page.items[0]!);
    expectOverflowAnomaly(page.items[1]!);
    expect(page.items[1]!.item_id).toBe(couliItemId(2));
    expectDefaultOkPrice(page.items[2]!);
    expect(priceAnomalyCount(h)).toBe(1);
  },
);

it('[AC-B1-04zzzzf#3] 边界：和恰为 INT64_MAX 照常 ok（三价精确），和为 INT64_MAX + 1 才算越界；同页两条各自判定', async () => {
  const atMax = dtkRow(1, { actualPrice: '92233720368547758.00', couponPrice: '0.07' });
  const pastMax = dtkRow(2, { actualPrice: '92233720368547758.00', couponPrice: '0.08' });
  const { h, page } = await searchRows([atMax, pastMax]);
  expect(page.items).toHaveLength(2);
  expect(expectTrueIdentities(page)).toEqual([1, 2]);
  const ok = page.items[0]!;
  expect(ok.price_status).toBe('ok');
  expect(ok.price_fen).toBe(INT64_MAX);
  expect(ok.coupon_fen).toBe(7n);
  expect(ok.final_price_fen).toBe(INT64_MAX - 7n);
  expect(isPriceAnomaly(ok)).toBe(false);
  expectOverflowAnomaly(page.items[1]!);
  expect(priceAnomalyCount(h)).toBe(1);
});

function candidateOf(n: number, row: Row): DataokeSearchCandidate {
  return { goodsId: dtkGoodsId(n), row };
}

function mapped(
  candidate: DataokeSearchCandidate,
  warn: (event: TaobaoWarning) => void,
): { readonly item: UnionItemDetail | undefined; readonly failure: unknown } {
  try {
    return {
      item: mapDataokeSearchItem(candidate, couliItemId(9), new Date(instant), warn),
      failure: undefined,
    };
  } catch (error) {
    return { item: undefined, failure: error };
  }
}

it('[AC-B1-04zzzzf#4] mapDataokeSearchItem 直调：越界不抛错，结果与同一行 actualPrice 缺失（missing_field）那一路同形，只差 price_anomaly_reason；告警一次、只带路径与码；行本身不合格的错误照旧抛出', () => {
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const overflowRow = dtkRow(9, { actualPrice: HUGE_YUAN, couponPrice: HUGE_YUAN });
  const result = mapped(candidateOf(9, overflowRow), warn);
  expect(result.failure, 'an int64 overflow of the price sum must not throw').toBeUndefined();
  const item = result.item!;
  expectOverflowAnomaly(item);
  expect(warn.mock.calls).toEqual([[{ method: SEARCH_PATH, code: 'PRICE_ANOMALY' }]]);

  warn.mockClear();
  const missing = mapped(candidateOf(9, rowWithout(9, 'actualPrice')), warn);
  expect(missing.failure).toBeUndefined();
  expect(missing.item!.price_anomaly_reason).toBe('missing_field');
  expect({ ...item, price_anomaly_reason: 'missing_field' }).toEqual(missing.item);
  expect(Object.keys(item).sort()).toEqual(Object.keys(missing.item!).sort());

  // 本单只接越界：绕过候选筛选的不合格行（佣金比例非法）仍按原口径抛 upstream_unavailable。
  warn.mockClear();
  const bad = mapped(candidateOf(9, { ...overflowRow, commissionRate: 'not-a-rate' }), warn);
  expect(bad.failure).toBeInstanceOf(UnionError);
  expect(bad.failure).toMatchObject({ code: 'upstream_unavailable', platform: 'taobao' });
});

it('[AC-B1-04zzzzf#5] 属性：任意合法 actualPrice（≥ 0.01 元）与 couponPrice（≥ 0）→ 和不越界时 ok 且三价精确，越界时 anomaly / invalid_price / 三价 0；从不抛错，PRICE_ANOMALY 只在越界时发、恰好一次', () => {
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  let overflowSeen = 0;
  let okSeen = 0;
  const amount = (min: bigint) =>
    fc.oneof(
      fc.bigInt({ min, max: INT64_MAX }),
      fc.bigInt({ min: HUGE_FEN, max: INT64_MAX }),
      fc.bigInt({ min: INT64_MAX - 1_000n, max: INT64_MAX }),
      fc.bigInt({ min, max: 1_000n }),
    );
  fc.assert(
    fc.property(amount(1n), amount(0n), (actual, coupon) => {
      warn.mockClear();
      const row = dtkRow(9, { actualPrice: yuanOf(actual), couponPrice: yuanOf(coupon) });
      const { item, failure } = mapped(candidateOf(9, row), warn);
      expect(failure).toBeUndefined();
      if (actual + coupon > INT64_MAX) {
        overflowSeen += 1;
        expectOverflowAnomaly(item!);
        expect(warn.mock.calls).toEqual([[{ method: SEARCH_PATH, code: 'PRICE_ANOMALY' }]]);
      } else {
        okSeen += 1;
        expect(item!.price_status).toBe('ok');
        expect(item!.price_fen).toBe(actual + coupon);
        expect(item!.coupon_fen).toBe(coupon);
        expect(item!.final_price_fen).toBe(actual);
        expect(warn).not.toHaveBeenCalled();
      }
    }),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
  expect(overflowSeen).toBeGreaterThan(0);
  expect(okSeen).toBeGreaterThan(0);
}, 900_000);
