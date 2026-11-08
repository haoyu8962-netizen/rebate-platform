import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi, type Mock } from 'vitest';
import {
  mapTaobaoPrice,
  type TaobaoPriceWarning,
} from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import type {
  TaobaoAdapterOptions,
  TaobaoPriceWarningEvent,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  ctx,
  DAY_MS,
  DETAIL,
  detailBody,
  detailRow,
  detailSetup,
  ITEM_ID,
  MAIN_IMAGE,
  nowMs,
  priceReader,
  promotion,
  ref,
  SELLER_ID_TEXT,
  setup,
  visible,
  type Row,
  type RowParts,
} from '../taobao-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzg#n]) identify this task's acceptance points (B1-04l 遗留，
// D10-1072 ①), not business rules. 淘宝详情 getItem 的价格告警：mapTaobaoPrice 给出的每条告警
// （PRICE_CALC_DIFF；PRICE_PROMO_UNKNOWN 另带归一化后的未知优惠名 promotion_title）经适配器可选钩子
// priceWarn 各发一次，字段只有方法名与码（+ 优惠名），不带商品 ID / 商品标题 / 金额 / 链接 / 上游 msg。
// 现有 warn 钩子在价格告警时一次都不调用（编排第 2 轮口径，同冻结 [AC-B1-04zx#36]）；没装 priceWarn
// 不发、不报错。价格计算与返回不变。
// 合成值，复用 ../taobao-goods/kit.ts 夹具；不联网、不连库、不监听端口。

const CALC_DIFF = 'PRICE_CALC_DIFF';
const PROMO_UNKNOWN = 'PRICE_PROMO_UNKNOWN';
// Special characters are built from code points, never written literally.
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const FULL_WIDTH_A = String.fromCharCode(0xff21);
const FULL_WIDTH_EIGHT = String.fromCharCode(0xff18);
/** An unknown promotion name as it may come on the wire: ideographic space, full-width A, a blank. */
const RAW_UNKNOWN = `${IDEOGRAPHIC_SPACE}合成未知优惠${FULL_WIDTH_A} `;
/** The same name after NFKC and trim, as mapTaobaoPrice reports it. */
const UNKNOWN_NAME = '合成未知优惠A';

type PriceWarn = (event: TaobaoPriceWarningEvent) => void;

/** A detail gateway answering `rows`, with a priceWarn mock installed next to the kit's warn. */
function priced(rows: readonly Row[], overrides: Partial<TaobaoAdapterOptions> = {}) {
  const priceWarn = vi.fn<PriceWarn>();
  return { ...detailSetup(rows, { priceWarn, ...overrides }), priceWarn };
}

/** Key-order independent text of one event (exact keys and values). */
function canon(event: unknown): string {
  const entries = Object.entries(event as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify(entries);
}

function sentEvents(priceWarn: Mock<PriceWarn>): string[] {
  return priceWarn.mock.calls.map(([event]) => canon(event)).sort();
}

function calcDiff(method: string): TaobaoPriceWarningEvent {
  return { method, code: CALC_DIFF };
}

function promoUnknown(method: string, name: string): TaobaoPriceWarningEvent {
  return { method, code: PROMO_UNKNOWN, promotion_title: name };
}

function expected(events: readonly TaobaoPriceWarningEvent[]): string[] {
  return events.map(canon).sort();
}

/** mapTaobaoPrice's warnings as the events the adapter must send for `method`. */
function asEvents(method: string, warnings: readonly TaobaoPriceWarning[]): string[] {
  return expected(
    warnings.map((warning) =>
      warning.code === PROMO_UNKNOWN ? promoUnknown(method, warning.title) : calcDiff(method),
    ),
  );
}

/** Yuan text with two decimals for a non-negative fen amount (no floating point). */
function yuan(fen: bigint): string {
  return `${fen / 100n}.${String(fen % 100n).padStart(2, '0')}`;
}

function priceView(item: {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly price_status?: string;
  readonly price_anomaly_reason?: string;
  readonly coupon_ids?: string;
}) {
  return {
    price_fen: item.price_fen,
    coupon_fen: item.coupon_fen,
    final_price_fen: item.final_price_fen,
    price_status: item.price_status,
    price_anomaly_reason: item.price_anomaly_reason,
    coupon_ids: item.coupon_ids,
  };
}

/** Discount 59.90 against a promotion final price of 40.00: the default promotions do not add up. */
function calcDiffRow(): Row {
  return detailRow({ price: { zk_final_price: '59.90', final_promotion_price: '40.00' } });
}

it('[AC-B1-04zzzzg#1] 详情 calc_diff → priceWarn 恰好一次 { method: taobao.tbk.item.info.upgrade.get, code: PRICE_CALC_DIFF }，不多带字段，warn 不调用；返回结果不变（anomaly、三价 0）；价格合格的详情不告警；没装 priceWarn 照常返回、不报错', async () => {
  const normal = priced([detailRow()]);
  const ok = await normal.adapter.getItem(ref, ctx);
  expect(ok).toMatchObject({
    item_id: ITEM_ID,
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    coupon_ids: 'syn-coupon-0001',
    price_status: 'ok',
  });
  expect(normal.priceWarn).not.toHaveBeenCalled();
  expect(normal.warn).not.toHaveBeenCalled();

  const { adapter, warn, priceWarn } = priced([calcDiffRow()]);
  const detail = await adapter.getItem(ref, ctx);
  const anomaly = {
    platform: 'taobao',
    item_id: ITEM_ID,
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'calc_diff',
  };
  expect(detail).toMatchObject(anomaly);
  expect(detail).not.toHaveProperty('coupon_ids');
  expect(priceWarn.mock.calls).toStrictEqual([[{ method: DETAIL, code: CALC_DIFF }]]);
  expect(warn).not.toHaveBeenCalled();

  // Without priceWarn (the frozen fixtures pass none): same result, nothing thrown, warn silent.
  const bare = detailSetup([calcDiffRow()]);
  const unhooked = await bare.adapter.getItem(ref, ctx);
  expect(unhooked).toEqual(detail);
  expect(bare.warn).not.toHaveBeenCalled();
});

const OTHER_ANOMALIES: [string, RowParts, string][] = [
  ['zk_final_price 非数字（missing_field）', { price: { zk_final_price: 'abc' } }, 'missing_field'],
  [
    '商品券已过期（expired_item）',
    {
      promotions: [
        promotion('商品券', '10.00', 'syn-coupon-0001', {
          promotion_start_time: String(nowMs - 2 * DAY_MS),
          promotion_end_time: String(nowMs - 1000),
        }),
        promotion('88VIP', '5.00', 'syn-member-0001'),
      ],
    },
    'expired_item',
  ],
  [
    '到手价不大于 0（invalid_price）',
    { price: { zk_final_price: '0.00', final_promotion_price: '0.00' }, promotions: [] },
    'invalid_price',
  ],
];

it.each(OTHER_ANOMALIES)(
  '[AC-B1-04zzzzg#2] 详情 %s：mapTaobaoPrice 给出一条 PRICE_CALC_DIFF → priceWarn 恰好一次 { method, code }，warn 不调用；返回结果不变',
  async (_label, parts, reason) => {
    const { adapter, warn, priceWarn } = priced([detailRow(parts)]);
    const detail = await adapter.getItem(ref, ctx);
    expect(detail).toMatchObject({
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
      price_status: 'anomaly',
      price_anomaly_reason: reason,
    });
    expect(priceWarn.mock.calls).toStrictEqual([[{ method: DETAIL, code: CALC_DIFF }]]);
    expect(warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzzzg#3] 详情未知优惠名（缺省 unavailable）→ priceWarn 恰好一次 PRICE_PROMO_UNKNOWN：方法名、码与归一化（NFKC + trim）后的优惠名 promotion_title，共三个字段；warn 不调用；返回 anomaly / unknown_promo 不变', async () => {
  const row = detailRow({
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion(RAW_UNKNOWN, '5.00', 'syn-unknown-0001'),
    ],
  });
  const { adapter, warn, priceWarn } = priced([row]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
  expect(priceWarn.mock.calls).toStrictEqual([
    [{ method: DETAIL, code: PROMO_UNKNOWN, promotion_title: UNKNOWN_NAME }],
  ]);
  expect(visible(priceWarn.mock.calls)).not.toContain(FULL_WIDTH_A);
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzzzg#4] price.taobao.unknown_promo = add_back：价格照常合格（59.90 / 10.00 / 49.90），未知优惠名照样经 priceWarn 发一次，warn 不调用', async () => {
  const row = detailRow({
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion(RAW_UNKNOWN, '5.00', 'syn-unknown-0001'),
    ],
  });
  const settings = priceReader(() => ({ unknown_promo: 'add_back' }));
  const { adapter, warn, priceWarn } = priced([row], { priceSettings: settings.reader });
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    coupon_ids: 'syn-coupon-0001',
    price_status: 'ok',
  });
  expect(detail).not.toHaveProperty('price_anomaly_reason');
  expect(settings.read).toHaveBeenCalledTimes(1);
  expect(sentEvents(priceWarn)).toEqual(expected([promoUnknown(DETAIL, UNKNOWN_NAME)]));
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzzzg#5] 一个详情多条告警（两个未知优惠名 + calc_diff）→ priceWarn 每条各一次，共三次，warn 不调用；返回 calc_diff 不变', async () => {
  const row = detailRow({
    price: { zk_final_price: '59.90', final_promotion_price: '40.00' },
    promotions: [
      promotion(RAW_UNKNOWN, '3.00', 'syn-unknown-0001'),
      promotion('合成未知优惠B', '2.00', 'syn-unknown-0002'),
      promotion('商品券', '10.00', 'syn-coupon-0001'),
    ],
  });
  const { adapter, warn, priceWarn } = priced([row]);
  const detail = await adapter.getItem(ref, ctx);
  expect(detail).toMatchObject({ price_status: 'anomaly', price_anomaly_reason: 'calc_diff' });
  expect(priceWarn).toHaveBeenCalledTimes(3);
  expect(sentEvents(priceWarn)).toEqual(
    expected([
      promoUnknown(DETAIL, UNKNOWN_NAME),
      promoUnknown(DETAIL, '合成未知优惠B'),
      calcDiff(DETAIL),
    ]),
  );
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzzzg#6] 价格告警不含商品信息：没有商品 ID、商品标题、金额、图片 / 推广链接、券 ID、卖家、request_id 与调用方标识；字段值都是字符串', async () => {
  const row = detailRow({
    price: { zk_final_price: '59.90', final_promotion_price: '40.00' },
    promotions: [
      promotion('商品券', '10.00', 'syn-coupon-0001'),
      promotion(RAW_UNKNOWN, '5.00', 'syn-unknown-0001'),
    ],
  });
  const { adapter, priceWarn } = priced([row]);
  await adapter.getItem(ref, ctx);
  expect(priceWarn).toHaveBeenCalledTimes(2);
  for (const [event] of priceWarn.mock.calls) {
    for (const value of Object.values(event)) expect(typeof value).toBe('string');
  }
  const shown = visible(priceWarn.mock.calls);
  for (const marker of [
    ITEM_ID,
    '合成详情商品',
    '合成一级类目',
    MAIN_IMAGE,
    'img.synthetic',
    'synthetic-click',
    '59.90',
    '40.00',
    '10.00',
    '5.00',
    '5990',
    '4000',
    'syn-coupon',
    'syn-unknown',
    SELLER_ID_TEXT,
    'synthetic-request-id',
    ctx.appId,
    ctx.requestId,
  ]) {
    expect(shown, marker).not.toContain(marker);
  }
});

const KNOWN_TITLES = [
  '商品券',
  '店铺券',
  '88VIP',
  `${FULL_WIDTH_EIGHT}${FULL_WIDTH_EIGHT}VIP会员价`,
  '百亿补贴',
  '满件折',
];
const UNKNOWN_TITLES = [RAW_UNKNOWN, '合成未知优惠B', ` 合成未知优惠C${IDEOGRAPHIC_SPACE}`];

it('[AC-B1-04zzzzg#7] 性质：任意优惠明细（已知 / 未知名、全角与空白写法）与对得上 / 对不上的价格 → priceWarn 收到的恰是 mapTaobaoPrice 的告警（每条一次，方法名 + 码，未知优惠另带归一化优惠名），warn 不调用，返回三价与它一致', async () => {
  // One adapter and one pair of mocks for every run (no vi.fn per run); the body is swapped per run.
  let body = detailBody([detailRow()]);
  const priceWarn = vi.fn<PriceWarn>();
  const { adapter, warn } = setup(() => body, { priceWarn });
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          title: fc.constantFrom(...KNOWN_TITLES, ...UNKNOWN_TITLES),
          fee: fc.bigInt({ min: 1n, max: 2000n }),
        }),
        { maxLength: 4 },
      ),
      fc.bigInt({ min: 1n, max: 5000n }),
      fc.constantFrom(0n, 0n, 1n, 100n),
      async (promotions, finalFen, gap) => {
        warn.mockClear();
        priceWarn.mockClear();
        const total = promotions.reduce((sum, entry) => sum + entry.fee, 0n);
        const discountFen = finalFen + total + gap;
        body = detailBody([
          detailRow({
            price: { zk_final_price: yuan(discountFen), final_promotion_price: yuan(finalFen) },
            promotions: promotions.map((entry, i) =>
              promotion(entry.title, yuan(entry.fee), `syn-prop-${i}`),
            ),
          }),
        ]);
        const detail = await adapter.getItem(ref, ctx);
        const mapped = mapTaobaoPrice(
          {
            discount_fen: discountFen,
            promotion_final_fen: finalFen,
            promotions: promotions.map((entry, i) => ({
              title: entry.title,
              amount_fen: entry.fee,
              id: `syn-prop-${i}`,
              start_ms: nowMs - DAY_MS,
              end_ms: nowMs + DAY_MS,
            })),
          },
          nowMs,
        );
        expect(priceView(detail)).toEqual(priceView(mapped));
        expect(sentEvents(priceWarn)).toEqual(asEvents(DETAIL, mapped.warnings));
        expect(warn).not.toHaveBeenCalled();
        checked += 1;
        return true;
      },
    ),
    { numRuns: Math.max(50, Math.floor(propRuns() / 100)), seed: propSeed() },
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
