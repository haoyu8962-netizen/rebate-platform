import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ALLOWED_ITEM_KEYS,
  couliItemId,
  dtkGoodsId,
  dtkRow,
  expectTrueIdentities,
  expectWarned,
  HIDDEN_MARKERS,
  instant,
  mainPicOf,
  one,
  rowWithout,
  search,
  searchData,
  searchRows,
  setup,
  titleOf,
  visible,
  type Row,
} from './kit.ts';

// UnionItem 映射：逐个挑字段；不映射不外露 estimateAmount / couponLink / itemLink / 大淘客 id /
// goodsSign / sellerId；缺必需字段（goodsId / 标题 / 主图）或佣金比例非法的条目跳过并告警，不整页失败。

it('[AC-B1-04zh#23] 一条完整映射：凑狸 item_id、title、三价（BR-PRICE-01）、佣金 bp、quoted_at、主图；只含允许的键、不填一级类目', async () => {
  const item = await one(dtkRow(1));
  expect(item).toMatchObject({
    platform: 'taobao',
    item_id: couliItemId(1),
    title: titleOf(1),
    price_fen: 5990n,
    coupon_fen: 2000n,
    final_price_fen: 3990n,
    commission_rate_bp: 2050n,
    quoted_at: instant,
    price_status: 'ok',
    main_image_url: mainPicOf(1),
  });
  for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
  expect(Object.hasOwn(item, 'category_l1_id')).toBe(false);
  expect(Object.hasOwn(item, 'category_l1_name')).toBe(false);
  expect(Object.hasOwn(item, 'image_urls')).toBe(false);
});

it('[AC-B1-04zh#24] quoted_at = 收到搜索响应时的注入时钟（不是请求前，也不是换算响应时）', async () => {
  const received = '2026-11-01T04:05:09.250Z';
  const h = setup({
    data: () => searchData([dtkRow(1)], 1, 1),
    onDataokeSend: (clock) => clock.set(received),
    onTopSend: (clock) => clock.set('2026-11-01T04:05:12.500Z'),
  });
  const page = await search(h);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.quoted_at).toBe(received);
});

it('[AC-B1-04zh#25] estimateAmount / couponLink / itemLink / 大淘客 id / goodsSign / sellerId 不映射不外露（任何字段、序列化与打印都看不到）', async () => {
  const { page } = await searchRows([dtkRow(1), dtkRow(2)]);
  expect(page.items).toHaveLength(2);
  const shown = visible(page);
  for (const marker of HIDDEN_MARKERS) expect(shown, marker).not.toContain(marker);
  for (const item of page.items) {
    for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
  }
});

it('[AC-B1-04zh#26] 标题与图片取大淘客搜索条目，不取换算详情里的标题 / 主图 / 价格 / 佣金', async () => {
  const item = await one(dtkRow(3));
  expect(item.title).toBe(titleOf(3));
  expect(item.main_image_url).toBe(mainPicOf(3));
  expect(visible(item)).not.toContain('TOP-only');
  expect(item.price_fen).toBe(5990n);
  expect(item.commission_rate_bp).toBe(2050n);
});

it.each([
  ['空串', ''],
  ['空白', '   '],
  ['null', null],
  ['缺失', undefined],
  ['非字符串', 42],
])('[AC-B1-04zh#27] title %s → 用 dtitle（短标题）', async (_label, title) => {
  const row = title === undefined ? rowWithout(4, 'title') : dtkRow(4, { title });
  const item = await one(row);
  expect(item.title).toBe('合成短标题 0004');
  expect(item.item_id).toBe(couliItemId(4));
});

it.each([
  ['都空白', { title: '  ', dtitle: '' }],
  ['都是 null', { title: null, dtitle: null }],
] as [string, Row][])(
  '[AC-B1-04zh#28] title 与 dtitle %s → 该条跳过并告警 invalid_item；其余条目照常、顺序不变',
  async (_label, overrides) => {
    const { h, page } = await searchRows([dtkRow(1), dtkRow(2, overrides), dtkRow(3)]);
    expect(expectTrueIdentities(page)).toEqual([1, 3]);
    expectWarned(h, 'invalid_item');
  },
);

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空串', ''],
  ['http', 'http://img.synthetic.invalid/dtk/main.jpg'],
  ['协议相对', '//img.synthetic.invalid/dtk/main.jpg'],
  ['含空白', 'https://img.synthetic.invalid/dtk/ main.jpg'],
  ['非字符串', 7],
])(
  '[AC-B1-04zh#29] 主图 mainPic %s（经 normalizeItemImages 不合格）→ 该条跳过并告警 invalid_item',
  async (_label, mainPic) => {
    const bad = mainPic === undefined ? rowWithout(2, 'mainPic') : dtkRow(2, { mainPic });
    const { h, page } = await searchRows([dtkRow(1), bad, dtkRow(3)]);
    expect(expectTrueIdentities(page)).toEqual([1, 3]);
    expectWarned(h, 'invalid_item');
  },
);

it('[AC-B1-04zh#30] smallImages 有效项作多图 image_urls（https、去重、保持顺序，不合格项丢弃）；主图不并入多图', async () => {
  const small = [
    'https://img.synthetic.alicdn.com/dtk/small-1.jpg',
    'http://img.synthetic.alicdn.com/dtk/small-bad.jpg',
    'https://img.synthetic.alicdn.com/dtk/small-2.jpg',
    'https://img.synthetic.alicdn.com/dtk/small-1.jpg',
  ];
  const item: UnionItemDetail = await one(dtkRow(5, { smallImages: small }));
  expect(item.main_image_url).toBe(mainPicOf(5));
  expect(item.image_urls).toEqual([
    'https://img.synthetic.alicdn.com/dtk/small-1.jpg',
    'https://img.synthetic.alicdn.com/dtk/small-2.jpg',
  ]);
});

it.each([
  [20.5, 2050n],
  [30, 3000n],
  [0.55, 55n],
  [12.34, 1234n],
  [100, 10_000n],
])('[AC-B1-04zh#31] commissionRate（百分数）%s → commission_rate_bp %s', async (rate, bp) => {
  const item = await one(dtkRow(6, { commissionRate: rate }));
  expect(item.commission_rate_bp).toBe(bp);
});

it.each([
  [20.556, 2055n],
  ['20.556', 2055n],
  [0.019, 1n],
  ['0.019', 1n],
  [33.335, 3333n],
  ['33.335', 3333n],
] as [number | string, bigint][])(
  '[AC-B1-04zh#42] commissionRate %j 超两位小数 → 十进制截断（BR-CALC-26 / pctStrToBp 取 floor，number 先 String() 再按十进制解析，不经浮点四舍五入）→ commission_rate_bp %s',
  async (rate, bp) => {
    const item = await one(dtkRow(6, { commissionRate: rate }));
    expect(item.commission_rate_bp).toBe(bp);
    expect(item.item_id).toBe(couliItemId(6));
  },
);

it.each([
  ['缺失', undefined],
  ['null', null],
  ['负数', -1],
  ['超过 100%', 100.5],
  ['非数字串', 'abc'],
  ['布尔', true],
])(
  '[AC-B1-04zh#32] commissionRate %s → 该条跳过并告警 invalid_commission；其余条目照常',
  async (_label, rate) => {
    const bad =
      rate === undefined ? rowWithout(2, 'commissionRate') : dtkRow(2, { commissionRate: rate });
    const { h, page } = await searchRows([dtkRow(1), bad, dtkRow(3)]);
    expect(expectTrueIdentities(page)).toEqual([1, 3]);
    expectWarned(h, 'invalid_commission');
  },
);

it('[AC-B1-04zh#33] 跳过条目的告警只带路径与固定码，不带商品 ID、标题、链接、金额原值', async () => {
  const { h, page } = await searchRows([
    dtkRow(1),
    dtkRow(2, { title: null, dtitle: null }),
    dtkRow(3, { mainPic: 'http://img.synthetic.invalid/x.jpg' }),
    dtkRow(4, { commissionRate: -3 }),
    dtkRow(5),
  ]);
  expect(expectTrueIdentities(page)).toEqual([1, 5]);
  expect(h.warn).toHaveBeenCalled();
  const shown = visible(h.warn.mock.calls);
  for (const n of [2, 3, 4]) {
    expect(shown).not.toContain(dtkGoodsId(n));
    expect(shown).not.toContain(`合成短标题 000${n}`);
  }
  expect(shown).not.toContain('img.synthetic.invalid');
  expect(shown).not.toContain('synthetic-coupon-link');
  expect(shown).not.toContain('59.9');
});
