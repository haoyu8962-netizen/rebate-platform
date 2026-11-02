import { expect, it } from 'vitest';
import type { PriceAnomalyReason } from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import { mapTaobaoDetail } from '../../../../apps/api/src/modules/union/infra/taobao/goods.ts';
import {
  convertToDetail,
  ctx,
  detailIdLists,
  detailItemId,
  identities,
  instant,
  OFFICIAL_SEARCH,
  priceFields,
  promotion,
  query,
  rowsFrom,
  search,
  SEARCH_ENVELOPE,
  searchBody,
  searchItemId,
  searchNumber,
  searchRow,
  searchRows,
  setup,
  skipReasons,
  titleOf,
  topError,
  unionFailure,
  visible,
  type Row,
  type RowParts,
} from './official-harness.ts';

// 不合格的行（D10-582、BR-PRICE-01、BR-PRICE-02）：
// - 价格不合格不跳行：同 mapTaobaoDetail，留在 items 里，price_status = anomaly，三价 0。
// - 跳行只有缺标题、佣金非法、换不到 ID：发独立事件 taobao_search_row_skipped（reason，不含取值），
//   不走适配器 warn（union.module 把它记成 API 权限告警）。
// - 整页每行都因缺标题或佣金非法而跳过 → invalid_dto；换不到不算非法（见 identity.test.ts #28）。
// - 外层键缺失或不是对象 → upstream_unavailable（同 request()）；result_list / map_data 损坏 → invalid_dto。
// - code 11 → upstream_rejected。

const NOW = new Date(instant);

const ANOMALIES: [string, RowParts, PriceAnomalyReason][] = [
  ['zk_final_price 非数字', { price: { zk_final_price: 'abc' } }, 'missing_field'],
  ['zk_final_price 空串', { price: { zk_final_price: '' } }, 'missing_field'],
  ['zk_final_price 负数', { price: { zk_final_price: '-1' } }, 'missing_field'],
  ['zk_final_price 超两位小数', { price: { zk_final_price: '59.905' } }, 'missing_field'],
  ['zk_final_price 缺失', { price: { zk_final_price: undefined } }, 'missing_field'],
  ['final_promotion_price 非数字', { price: { final_promotion_price: 'abc' } }, 'missing_field'],
  [
    'final_promotion_price 超两位小数',
    { price: { final_promotion_price: '44.905' } },
    'missing_field',
  ],
  ['final_promotion_price 缺失', { price: { final_promotion_price: undefined } }, 'missing_field'],
  [
    'promotion_fee 非数字',
    { promotions: [promotion('商品券', 'abc', 'syn-coupon-bad')] },
    'missing_field',
  ],
  [
    'promotion_fee 超两位小数',
    { promotions: [promotion('商品券', '10.005', 'syn-coupon-bad')] },
    'missing_field',
  ],
  [
    'coupon ≥ price',
    {
      price: { zk_final_price: '10.00', final_promotion_price: '0.00' },
      promotions: [promotion('商品券', '10.00', 'syn-coupon-full')],
    },
    'invalid_price',
  ],
  [
    'final ≤ 0',
    { price: { zk_final_price: '0.00', final_promotion_price: '0.00' }, promotions: [] },
    'invalid_price',
  ],
  [
    'calc_diff',
    { price: { zk_final_price: '59.90', final_promotion_price: '40.00' } },
    'calc_diff',
  ],
  [
    'unknown_promo',
    {
      price: { zk_final_price: '59.90', final_promotion_price: '49.90' },
      promotions: [promotion('合成未知优惠', '10.00', 'syn-unknown-c')],
    },
    'unknown_promo',
  ],
];

const BAD_COMMISSIONS: [string, unknown][] = [
  ['非数字', 'abc'],
  ['空串', ''],
  ['负数', '-1'],
  ['带小数', '2050.5'],
  ['超过 100%', '10001'],
  ['null', null],
  ['缺失', undefined],
];

const BAD_TITLES: [string, unknown][] = [
  ['缺失', undefined],
  ['空串', ''],
  ['空白', '   '],
  ['null', null],
  ['非字符串', 42],
];

it.each(ANOMALIES)(
  '[AC-B1-04zx#36] %s → 不跳行不废页：该行留在 items 里，price_status = anomaly，三价 0，与详情一致，不发跳行事件',
  async (_label, parts, reason) => {
    const row = searchRow(2, parts);
    const { h, page } = await searchRows([searchRow(1), row, searchRow(3)]);
    expect(identities(page)).toEqual([1, 2, 3]);
    expect(page.items[0]!.price_status).toBe('ok');
    expect(page.items[2]!.price_status).toBe('ok');
    const item = page.items[1]!;
    expect(item).toMatchObject({
      price_status: 'anomaly',
      price_anomaly_reason: reason,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    });
    expect(priceFields(item)).toEqual(
      priceFields(mapTaobaoDetail(row, detailItemId(2), NOW, undefined)),
    );
    expect(h.searchWarn).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zx#63] 整页都是价格异常 → 整页照常返回（全部 anomaly），不算非法，满页照给 nextCursor', async () => {
  const rows = rowsFrom(1, 20).map((_row, i) =>
    searchRow(i + 1, { price: { zk_final_price: 'abc' } }),
  );
  const h = setup({ page: () => searchBody(rows, 165) });
  const page = await search(h);
  expect(identities(page)).toHaveLength(20);
  expect(page.items.every((item) => item.price_status === 'anomaly')).toBe(true);
  expect(page.nextCursor).toBe('taobao-search:2');
});

it.each(BAD_COMMISSIONS)(
  '[AC-B1-04zx#37] commission_rate %s → 该行跳过（reason commission_invalid），其余行照常，不舍入',
  async (_label, rate) => {
    const bad = searchRow(2, { income: { commission_rate: rate } });
    const { h, page } = await searchRows([searchRow(1), bad, searchRow(3)]);
    expect(identities(page)).toEqual([1, 3]);
    expect(skipReasons(h)).toEqual(['commission_invalid']);
    expect(h.warn).not.toHaveBeenCalled();
  },
);

it.each(BAD_TITLES)(
  '[AC-B1-04zx#38] title %s → 该行跳过（reason title_missing），其余行照常',
  async (_label, title) => {
    const bad = searchRow(2, { basic: { title } });
    const { h, page } = await searchRows([searchRow(1), bad, searchRow(3)]);
    expect(identities(page)).toEqual([1, 3]);
    expect(skipReasons(h)).toEqual(['title_missing']);
    expect(h.warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zx#39] map_data 里不是对象的行跳过并发跳行事件，其余行照常', async () => {
  const { h, page } = await searchRows([searchRow(1), null, 'synthetic-junk', 7, searchRow(3)]);
  expect(identities(page)).toEqual([1, 3]);
  expect(skipReasons(h)).toHaveLength(3);
  expect(h.warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zx#40] 跳行事件不含取值：只有 event 与 reason，商品 ID、标题、佣金、链接、推广位都看不到', async () => {
  const unconverted = (id: string) => (searchNumber(id) === 4 ? undefined : convertToDetail(id));
  const { h, page } = await searchRows(
    [
      searchRow(1),
      searchRow(2, { income: { commission_rate: 'synthetic-bad-rate' } }),
      searchRow(3, { basic: { title: '   ' } }),
      searchRow(4),
      searchRow(5),
    ],
    { available: unconverted },
  );
  expect(identities(page)).toEqual([1, 5]);
  expect(skipReasons(h).sort()).toEqual([
    'commission_invalid',
    'item_unconverted',
    'title_missing',
  ]);
  for (const [warning] of h.searchWarn.mock.calls) {
    expect(Object.keys(warning).sort()).toEqual(['event', 'reason']);
  }
  const shown = visible(h.searchWarn.mock.calls);
  for (const n of [2, 3, 4]) {
    expect(shown).not.toContain(searchItemId(n));
    expect(shown).not.toContain(titleOf(n));
  }
  for (const marker of [
    'SharedTail',
    'synthetic-bad-rate',
    'img.synthetic',
    'synthetic-click',
    'synthetic-share',
    '987654321012',
  ]) {
    expect(shown, marker).not.toContain(marker);
  }
});

it.each([
  ['单行缺标题', [searchRow(1, { basic: { title: undefined } })]],
  [
    '三行各自跳过',
    [
      searchRow(1, { income: { commission_rate: 'abc' } }),
      searchRow(2, { income: { commission_rate: '2050.5' } }),
      searchRow(3, { basic: { title: undefined } }),
    ],
  ],
  [
    '满页全部佣金非法',
    rowsFrom(1, 20).map((_row, i) => searchRow(i + 1, { income: { commission_rate: 'abc' } })),
  ],
  ['每行都不是对象', [null, 'synthetic-junk']],
] as [string, unknown[]][])(
  '[AC-B1-04zx#41] 整页每行都因缺标题或佣金非法跳过（%s）→ invalid_dto，不调换算，错误不含取值',
  async (_label, rows) => {
    const h = setup({ page: () => searchBody(rows, 165) });
    const error = await unionFailure(() => h.adapter.searchItems(query, ctx), 'invalid_dto');
    expect(visible(error)).not.toContain('2050.5');
    expect(visible(error)).not.toContain(searchItemId(1));
    expect(detailIdLists(h)).toEqual([]);
  },
);

it.each([
  ['外层键缺失', { synthetic_other_response: {} }],
  ['外层不是对象', { [SEARCH_ENVELOPE]: 'synthetic' }],
  ['外层是数组', { [SEARCH_ENVELOPE]: [] }],
] as [string, Row][])(
  '[AC-B1-04zx#42] 外层键损坏（%s）→ upstream_unavailable（同 request()），不调换算',
  async (_label, body) => {
    const h = setup({ page: () => body });
    await unionFailure(() => h.adapter.searchItems(query, ctx), 'upstream_unavailable');
    expect(detailIdLists(h)).toEqual([]);
  },
);

it.each([
  ['result_list 不是对象', { [SEARCH_ENVELOPE]: { result_list: 'synthetic' } }],
  ['result_list 是数组', { [SEARCH_ENVELOPE]: { result_list: [] } }],
  ['map_data 不是数组', { [SEARCH_ENVELOPE]: { result_list: { map_data: 'synthetic' } } }],
  ['map_data 是对象', { [SEARCH_ENVELOPE]: { result_list: { map_data: {} } } }],
] as [string, Row][])(
  '[AC-B1-04zx#64] 外层之内结构损坏（%s）→ invalid_dto，不调换算',
  async (_label, body) => {
    const h = setup({ page: () => body });
    await unionFailure(() => h.adapter.searchItems(query, ctx), 'invalid_dto');
    expect(detailIdLists(h)).toEqual([]);
  },
);

it('[AC-B1-04zx#43] code 11 权限错误 → upstream_rejected，告警一次（只带方法名与 code / sub_code），不调换算', async () => {
  const h = setup({ page: () => topError(11, 'isv.permission-api-package-limit') });
  const error = await unionFailure(() => h.adapter.searchItems(query, ctx), 'upstream_rejected');
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(h.warn).toHaveBeenCalledWith({
    method: OFFICIAL_SEARCH,
    code: '11',
    sub_code: 'isv.permission-api-package-limit',
  });
  expect(error.message).not.toContain('synthetic remote error');
  expect(detailIdLists(h)).toEqual([]);
});
