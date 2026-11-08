import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoPriceWarningEvent,
  type TaobaoSearchSlotReader,
  type TaobaoSearchWarning,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  ADZONE,
  couponIdOf,
  ctx,
  detailItemId,
  endpoint,
  gateway,
  identities,
  instant,
  OFFICIAL_SEARCH,
  promotion,
  query,
  searchBody,
  searchItemId,
  searchRow,
  SLOT_PID,
  titleOf,
  visible,
  type Row,
} from '../taobao-official-search/official-harness.ts';
import { searched } from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzzzg#n]) identify this task's acceptance points (B1-04l 遗留，
// D10-1072 ①), not business rules. 官方搜索（taobao.tbk.dg.material.optional.upgrade）的行经
// mapTaobaoDetail 映射，同样把 mapTaobaoPrice 的每条价格告警经适配器可选钩子 priceWarn 各发一次：字段
// 只有物料搜索方法名与码，PRICE_PROMO_UNKNOWN 另带归一化优惠名 promotion_title；不带商品 ID、商品标题、
// 金额、链接、推广位。现有 warn 钩子一次都不调用（冻结 [AC-B1-04zx#36]），价格不合格仍不跳行（不发跳行
// 事件），返回结果不变；没装 priceWarn 不发、不报错。
// 合成值，复用 ../taobao-official-search/official-harness.ts 的报文与假网关（那里的 setup 不收
// priceWarn，这里按同样的选项另装一个适配器）；不联网、不连库、不监听端口。

const CALC_DIFF = 'PRICE_CALC_DIFF';
const PROMO_UNKNOWN = 'PRICE_PROMO_UNKNOWN';
// Special characters are built from code points, never written literally.
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const FULL_WIDTH_A = String.fromCharCode(0xff21);
/** An unknown promotion name as it may come on the wire: ideographic space, full-width A, a blank. */
const RAW_UNKNOWN = `${IDEOGRAPHIC_SPACE}合成未知优惠${FULL_WIDTH_A} `;
/** The same name after NFKC and trim, as mapTaobaoPrice reports it. */
const UNKNOWN_NAME = '合成未知优惠A';

/**
 * The official search over `rows` (one page), as the harness assembles it (official switch, slot
 * reader answering SLOT_PID, warn and searchWarn mocks), plus a priceWarn mock unless `hooked` is
 * false.
 */
function priced(rows: readonly Row[], hooked = true) {
  const clock = new FixedClock(instant);
  const transport = gateway(clock, { page: () => searchBody(rows, rows.length) });
  const searchSlot = vi.fn<TaobaoSearchSlotReader>(async () => SLOT_PID);
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const searchWarn = vi.fn<(event: TaobaoSearchWarning) => void>();
  const priceWarn = vi.fn<(event: TaobaoPriceWarningEvent) => void>();
  const adapter = new TaobaoUnionAdapter({
    credentials: async () => ({
      appKey: 'fake-price-warnings-search-key',
      appSecret: 'prsw-prsw-prsw-prsw-prsw',
    }),
    transport,
    clock,
    endpoint,
    warn,
    searchWarn,
    searchSource: 'official',
    searchSlot,
    ...(hooked ? { priceWarn } : {}),
  });
  return { adapter, warn, searchWarn, priceWarn };
}

/** Key-order independent text of one event (exact keys and values). */
function canon(event: unknown): string {
  const entries = Object.entries(event as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify(entries);
}

function priceView(item: UnionItem) {
  return {
    price_fen: item.price_fen,
    coupon_fen: item.coupon_fen,
    final_price_fen: item.final_price_fen,
    price_status: item.price_status,
    price_anomaly_reason: item.price_anomaly_reason,
  };
}

/** Row 1 prices fine; 2 does not reconcile; 3 carries an unknown name; 4 has a bad discount price. */
function mixedRows(): Row[] {
  return [
    searchRow(1),
    searchRow(2, { price: { final_promotion_price: '40.00' } }),
    searchRow(3, {
      promotions: [
        promotion('商品券', '10.00', couponIdOf(3)),
        promotion(RAW_UNKNOWN, '5.00', 'syn-unknown-0003'),
      ],
    }),
    searchRow(4, { price: { zk_final_price: 'abc' } }),
  ];
}

const MIXED_PRICES = [
  {
    price_fen: 5990n,
    coupon_fen: 1000n,
    final_price_fen: 4990n,
    price_status: 'ok',
    price_anomaly_reason: undefined,
  },
  {
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'calc_diff',
  },
  {
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  },
  {
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'missing_field',
  },
];

it('[AC-B1-04zzzzg#8] 官方搜索：每行的价格告警经 priceWarn 各发一次（方法名为物料搜索、码，未知优惠另带归一化优惠名），合格行不告警；warn 与跳行事件都不调用；整页照常返回、三价不变；没装 priceWarn 同样返回、不报错', async () => {
  const h = priced(mixedRows());
  const page = await searched(() => h.adapter.searchItems(query, ctx));
  expect(identities(page)).toEqual([1, 2, 3, 4]);
  expect(page.items.map(priceView)).toEqual(MIXED_PRICES);
  expect(h.searchWarn).not.toHaveBeenCalled();
  expect(h.warn).not.toHaveBeenCalled();
  expect(h.priceWarn).toHaveBeenCalledTimes(3);
  const expected: TaobaoPriceWarningEvent[] = [
    { method: OFFICIAL_SEARCH, code: CALC_DIFF },
    { method: OFFICIAL_SEARCH, code: CALC_DIFF },
    { method: OFFICIAL_SEARCH, code: PROMO_UNKNOWN, promotion_title: UNKNOWN_NAME },
  ];
  expect(h.priceWarn.mock.calls.map(([event]) => canon(event)).sort()).toEqual(
    expected.map(canon).sort(),
  );
  expect(visible(h.priceWarn.mock.calls)).not.toContain(FULL_WIDTH_A);

  // Without priceWarn (the frozen harness passes none): the same page, nothing thrown, warn silent.
  const bare = priced(mixedRows(), false);
  const unhooked = await searched(() => bare.adapter.searchItems(query, ctx));
  expect(identities(unhooked)).toEqual([1, 2, 3, 4]);
  expect(unhooked.items.map(priceView)).toEqual(MIXED_PRICES);
  expect(bare.warn).not.toHaveBeenCalled();
  expect(bare.searchWarn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzzzg#9] 官方搜索的价格告警不含取值：没有搜索 / 详情口径商品 ID、商品标题、金额、图片与推广链接、券 ID、推广位与调用方标识；字段值都是字符串', async () => {
  const h = priced(mixedRows());
  await searched(() => h.adapter.searchItems(query, ctx));
  expect(h.priceWarn).toHaveBeenCalled();
  for (const [event] of h.priceWarn.mock.calls) {
    for (const value of Object.values(event)) expect(typeof value).toBe('string');
  }
  const shown = visible(h.priceWarn.mock.calls);
  for (const n of [2, 3, 4]) {
    expect(shown).not.toContain(searchItemId(n));
    expect(shown).not.toContain(detailItemId(n));
    expect(shown).not.toContain(titleOf(n));
  }
  for (const marker of [
    'SharedTail',
    'img.synthetic',
    'synthetic-click',
    'synthetic-share',
    'syn-coupon',
    'syn-unknown',
    '59.90',
    '40.00',
    '10.00',
    '5990',
    ADZONE,
    ctx.appId,
    ctx.requestId,
  ]) {
    expect(shown, marker).not.toContain(marker);
  }
  expect(h.warn).not.toHaveBeenCalled();
});
