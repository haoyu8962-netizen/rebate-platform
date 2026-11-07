import { expect, it } from 'vitest';
import { envelope, one, read, row, setup, sources } from '../pdd-goods/kit.ts';
import { CAT_IDS, catRow, control, expectL1, expectNoCategory, L1, mapped } from './kit.ts';

// 不合格一律「不出 category_l1_id」：不跳行、不告警、不改动其他字段。
// 写在这里的不可见 / 特殊空白字符一律用 \uXXXX 转义。

const badLists: readonly (readonly [string, unknown])[] = [
  ['缺失', undefined],
  ['null', null],
  ['空数组', []],
  ['字符串', '8569'],
  ['逗号分隔字符串', '8569,8439,8581'],
  ['数字', 8569],
  ['类数组对象', { 0: 8569, length: 1 }],
  ['对象', { cat_id: 8569 }],
  ['布尔', true],
];

const badListCases = sources.flatMap((source) =>
  badLists.map(([label, raw]) => [source, label, raw] as const),
);

it.each(badListCases)(
  '[AC-B1-04zzw#5] %s：cat_ids %s → 不出 category_l1_id，其余字段照常',
  async (source, _label, raw) => {
    await control(source);
    const plain = await one(source, row());
    const item = await one(source, row({ cat_ids: raw }));
    expectNoCategory(item);
    expect(item).toEqual(plain);
  },
);

// 首项不合格时不回退到后面的合格项。字符串首项只钉「不合格的一定不出」，合格形状的字符串不在本单钉。
const badFirsts: readonly (readonly [string, unknown])[] = [
  ['0', 0],
  ['负数', -8569],
  ['小数', 85.69],
  ['null', null],
  ['布尔', true],
  ['嵌套数组', [8569]],
  ['对象', { id: 8569 }],
  ['字符串 0', '0'],
  ['前导零', '08569'],
  ['空串', ''],
  ['前导空格', ' 8569'],
  ['尾随空格', '8569 '],
  ['正号', '+8569'],
  ['负号', '-8569'],
  ['小数串', '85.69'],
  ['科学计数串', '8e3'],
  ['十六进制串', '0x2179'],
  ['全角数字', '８５６９'],
  ['阿拉伯-印度数字', '٨٥٦٩'],
  ['尾随 NBSP', '8569\u00A0'],
  ['尾随全角空格', '8569\u3000'],
  ['前导零宽空格', '\u200B8569'],
  ['尾随行分隔符', '8569\u2028'],
  ['20 位数字串', '12345678901234567890'],
];

const badFirstCases = sources.flatMap((source) =>
  badFirsts.map(([label, first]) => [source, label, first] as const),
);

it.each(badFirstCases)(
  '[AC-B1-04zzw#6] %s：cat_ids 首项为%s → 不出 category_l1_id，不回退到第二项',
  async (source, _label, first) => {
    await control(source);
    const plain = await one(source, row());
    const item = await one(source, row({ cat_ids: [first, ...CAT_IDS] }));
    expectNoCategory(item);
    expect(item).toEqual(plain);
  },
);

// JSON 报文到不了的数值（非安全整数、非有限数、稀疏首项）直接走映射函数。
const unsafeFirsts: readonly (readonly [string, unknown])[] = [
  ['2^53', 2 ** 53],
  ['2^53 + 2', 2 ** 53 + 2],
  ['1e21', 1e21],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['NaN', Number.NaN],
  ['-0', -0],
  ['undefined', undefined],
];

const unsafeFirstCases = sources.flatMap((source) =>
  unsafeFirsts.map(([label, first]) => [source, label, first] as const),
);

it.each(unsafeFirstCases)(
  '[AC-B1-04zzw#7] %s 映射：cat_ids 首项为 %s → 不出 category_l1_id',
  (source, _label, first) => {
    expectL1(mapped(source, catRow()), L1);
    const plain = mapped(source, row());
    const item = mapped(source, row({ cat_ids: [first, ...CAT_IDS] }));
    expectNoCategory(item);
    expect(item).toEqual(plain);
  },
);

it.each(sources)('[AC-B1-04zzw#7] %s 映射：cat_ids 首项是空位（稀疏数组）→ 不出', (source) => {
  expectL1(mapped(source, catRow()), L1);
  const sparse: unknown[] = [];
  sparse[1] = CAT_IDS[0];
  expectNoCategory(mapped(source, row({ cat_ids: sparse })));
});

function goods(n: number, overrides: Record<string, unknown>): Record<string, unknown> {
  return row({ goods_id: 7_345_678_901_230 + n, goods_sign: `synthetic-sign-${n}`, ...overrides });
}

it.each(['search', 'feed'] as const)(
  '[AC-B1-04zzw#8] %s：一页里 cat_ids 不合格的行照样返回、顺序不变，只有合格行带 category_l1_id，不告警',
  async (source) => {
    const rows = [
      goods(1, { cat_ids: [...CAT_IDS] }),
      goods(2, { cat_ids: [] }),
      goods(3, { cat_ids: ['08569', ...CAT_IDS] }),
      goods(4, {}),
      goods(5, { cat_ids: [6_398, 6_401] }),
    ];
    const { adapter, warn } = setup((body) => envelope(body.type, rows));
    const items = await read(adapter, source);
    expect(items.map((item) => item.goods_id)).toEqual(rows.map((r) => String(r.goods_id)));
    expectL1(items[0]!, L1);
    expectNoCategory(items[1]!);
    expectNoCategory(items[2]!);
    expectNoCategory(items[3]!);
    expectL1(items[4]!, '6398');
    expect(warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04zzw#9] detail：cat_ids 不合格照样返回商品详情，不报错、不告警', async () => {
  const good = setup((body) => envelope(body.type, [catRow()]));
  expectL1(await read(good.adapter, 'detail').then((items) => items[0]!), L1);
  expect(good.warn).not.toHaveBeenCalled();
  for (const cats of [undefined, [], [0, ...CAT_IDS], 'not-a-list']) {
    const { adapter, warn } = setup((body) => envelope(body.type, [row({ cat_ids: cats })]));
    const items = await read(adapter, 'detail');
    expect(items).toHaveLength(1);
    expectNoCategory(items[0]!);
    expect(items[0]!.price_status).toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  }
});
