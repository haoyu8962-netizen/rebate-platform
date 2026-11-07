import { expect, it } from 'vitest';
import { listing, mapped, mode, row, searched, wire, ctx, type Row } from '../jd-goods/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  CID1,
  CID1_NAME,
  CID2,
  CID2_NAME,
  CID3,
  CID3_NAME,
  categoryInfo,
  has,
  through,
  withCategory,
  withoutCategory,
} from './kit.ts';

// 京东 jd.union.open.goods.query（搜索与详情）的一级类目（D10-805 ⑤）。说明见 ./kit.ts。

/** The control every case starts from: a full categoryInfo gives both keys on search and detail. */
async function expectControl(): Promise<void> {
  const { page, detail } = await through(withCategory(categoryInfo()));
  expect(page.items).toHaveLength(1);
  for (const item of [page.items[0]!, detail]) {
    expect(item.category_l1_id).toBe(CID1);
    expect(item.category_l1_name).toBe(CID1_NAME);
  }
}

it('[AC-B1-04zzv#1] 搜索与详情：categoryInfo.cid1 → category_l1_id（十进制字符串），cid1Name → category_l1_name', async () => {
  const { page, detail, warned } = await through(withCategory(categoryInfo()));
  expect(page.items).toHaveLength(1);
  for (const item of [page.items[0]!, detail]) {
    expect(item.category_l1_id).toBe(CID1);
    expect(item.category_l1_id).toBeTypeOf('string');
    expect(item.category_l1_name).toBe(CID1_NAME);
  }
  expect(warned).toBe(0);
});

it.each([
  ['JSON 数字', num(CID1), CID1],
  ['字符串（文档示例形态）', CID1, CID1],
  ['JSON 数字 1', num('1'), '1'],
  ['字符串 1', '1', '1'],
  ['JSON 数字九位', num('123456789'), '123456789'],
  ['字符串九位', '123456789', '123456789'],
] as const)(
  '[AC-B1-04zzv#2] cid1 为%s：搜索与详情的 category_l1_id 都是同一十进制串',
  async (_label, cid1, expected) => {
    const { page, detail } = await through(withCategory(categoryInfo({ cid1 })));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.category_l1_id).toBe(expected);
    expect(detail.category_l1_id).toBe(expected);
  },
);

it('[AC-B1-04zzv#3] sku 模式的搜索同样带一级类目', async () => {
  const item = await searched(withCategory(categoryInfo()), mode('sku'));
  expect(item.category_l1_id).toBe(CID1);
  expect(item.category_l1_name).toBe(CID1_NAME);
});

it.each([
  ['普通名称', CID1_NAME],
  ['前后带半角空格（原样，不 trim 改写）', `  ${CID1_NAME}  `],
  ['前后带全角空格（原样）', `\u3000${CID1_NAME}\u3000`],
  ['中间带空格与符号', '合成 家电 & 数码/配件'],
  ['单个字符', '书'],
] as const)('[AC-B1-04zzv#4] cid1Name 为%s → category_l1_name 原样', async (_label, cid1Name) => {
  const { page, detail } = await through(withCategory(categoryInfo({ cid1Name })));
  for (const item of [page.items[0]!, detail]) {
    expect(item.category_l1_id).toBe(CID1);
    expect(item.category_l1_name).toBe(cid1Name);
  }
});

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空串', ''],
  ['半角空格', '   '],
  ['制表与换行', '\t\r\n'],
  ['全角空格', '\u3000\u3000'],
  ['不换行空格', '\u00A0'],
  ['JSON 数字', num('7000101')],
  ['布尔', true],
  ['对象', { name: CID1_NAME }],
  ['数组', [CID1_NAME]],
] as const)(
  '[AC-B1-04zzv#5] cid1Name 为%s → 只出 category_l1_id，不出 category_l1_name，也不拿 cid2Name / cid3Name 顶替',
  async (_label, cid1Name) => {
    const { page, detail, warned } = await through(withCategory(categoryInfo({ cid1Name })));
    expect(page.items).toHaveLength(1);
    for (const item of [page.items[0]!, detail]) {
      expect(item.category_l1_id).toBe(CID1);
      expect(has(item, 'category_l1_name')).toBe(false);
    }
    expect(warned).toBe(0);
  },
);

/** cid1 values that are not a positive integer: no category_l1_id. */
const BAD_CID1: readonly (readonly [string, unknown])[] = [
  ['缺失', undefined],
  ['null', null],
  ['JSON 数字 0', num('0')],
  ['字符串 0', '0'],
  ['JSON 负数', num('-7000101')],
  ['字符串负数', '-7000101'],
  ['JSON 小数', num('7000101.5')],
  ['字符串小数', '7000101.5'],
  ['空串', ''],
  ['空白串', '   '],
  ['非数字串', 'abc'],
  ['数字后跟字母', '7000101abc'],
  ['布尔', true],
  ['对象', { id: num(CID1) }],
  ['数组', [num(CID1)]],
];

it.each(BAD_CID1)(
  '[AC-B1-04zzv#6] cid1 为%s → 搜索与详情都不出 category_l1_id；照常出卡，不告警，其余字段不变',
  async (_label, cid1) => {
    await expectControl();
    const control = await through(withCategory(categoryInfo()));
    const { page, detail, warned } = await through(withCategory(categoryInfo({ cid1 })));
    expect(page.items).toHaveLength(1);
    expect(has(page.items[0]!, 'category_l1_id')).toBe(false);
    expect(has(detail, 'category_l1_id')).toBe(false);
    expect(warned).toBe(0);
    expect(withoutCategory(page.items[0]!)).toEqual(withoutCategory(control.page.items[0]!));
    expect(withoutCategory(detail)).toEqual(withoutCategory(control.detail));
  },
);

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空对象', {}],
  ['字符串', CID1],
  ['JSON 数字', num(CID1)],
  ['布尔', true],
  ['数组', [categoryInfo()]],
] as const)(
  '[AC-B1-04zzv#7] categoryInfo 为%s → 两个类目键都不出；照常出卡，不告警',
  async (_label, info) => {
    await expectControl();
    const { page, detail, warned } = await through(withCategory(info));
    expect(page.items).toHaveLength(1);
    for (const item of [page.items[0]!, detail]) {
      expect(has(item, 'category_l1_id')).toBe(false);
      expect(has(item, 'category_l1_name')).toBe(false);
    }
    expect(warned).toBe(0);
  },
);

it.each([
  ['只有二、三级', { cid2: num(CID2), cid2Name: CID2_NAME, cid3: num(CID3), cid3Name: CID3_NAME }],
  ['只有三级', { cid3: num(CID3), cid3Name: CID3_NAME }],
  ['cid1 为 0，二、三级齐全', categoryInfo({ cid1: num('0'), cid1Name: undefined })],
  ['cid1 为 null，二、三级齐全', categoryInfo({ cid1: null, cid1Name: undefined })],
] as const)(
  '[AC-B1-04zzv#8] 只取一级：%s → 不出 category_l1_id，也不拿二、三级的 ID 或名称顶替',
  async (_label, info) => {
    await expectControl();
    const { page, detail } = await through(withCategory(info));
    expect(page.items).toHaveLength(1);
    for (const item of [page.items[0]!, detail]) {
      expect(has(item, 'category_l1_id')).toBe(false);
      expect(has(item, 'category_l1_name')).toBe(false);
    }
  },
);

it('[AC-B1-04zzv#9] 只取一级：三级齐全时 category_l1_id / category_l1_name 是 cid1 / cid1Name，不是二、三级', async () => {
  const { page, detail } = await through(
    withCategory({
      cid3: num(CID3),
      cid3Name: CID3_NAME,
      cid2: num(CID2),
      cid2Name: CID2_NAME,
      cid1: num(CID1),
      cid1Name: CID1_NAME,
    }),
  );
  for (const item of [page.items[0]!, detail]) {
    expect(item.category_l1_id).toBe(CID1);
    expect(item.category_l1_name).toBe(CID1_NAME);
    for (const other of [CID2, CID3, CID2_NAME, CID3_NAME]) {
      expect([item.category_l1_id, item.category_l1_name]).not.toContain(other);
    }
  }
});

it.each([
  ['顶层 cid1 / cid1Name', { cid1: num(CID1), cid1Name: CID1_NAME }],
  ['顶层 categoryId / categoryName', { categoryId: num(CID1), categoryName: CID1_NAME }],
  ['shopInfo 里的 cid1', { shopInfo: { shopName: '合成京东小店', cid1: num(CID1) } }],
] as const)(
  '[AC-B1-04zzv#10] 只读 categoryInfo：没有 categoryInfo 而有%s → 不出类目',
  async (_label, extra) => {
    await expectControl();
    const { page, detail } = await through(withCategory(undefined, extra as Row));
    expect(page.items).toHaveLength(1);
    for (const item of [page.items[0]!, detail]) {
      expect(has(item, 'category_l1_id')).toBe(false);
      expect(has(item, 'category_l1_name')).toBe(false);
    }
  },
);

it('[AC-B1-04zzv#11] 一页多行各取各的类目；类目不合格的行照常出卡，不告警', async () => {
  const rows: Row[] = [
    row({ itemId: 'synthAsegC1_Bseg', skuId: num('100012345001'), categoryInfo: categoryInfo() }),
    row({
      itemId: 'synthAsegC2_Bseg',
      skuId: num('100012345002'),
      categoryInfo: categoryInfo({ cid1: num('-1'), cid1Name: '   ' }),
    }),
    row({
      itemId: 'synthAsegC3_Bseg',
      skuId: num('100012345003'),
      categoryInfo: categoryInfo({ cid1: '7000999', cid1Name: '合成另一类目' }),
    }),
    row({ itemId: 'synthAsegC4_Bseg', skuId: num('100012345004') }),
  ];
  const { adapter, warn } = wire(() => listing(rows));
  const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  expect(page.items.map((item) => item.item_id)).toEqual([
    'synthAsegC1_Bseg',
    'synthAsegC2_Bseg',
    'synthAsegC3_Bseg',
    'synthAsegC4_Bseg',
  ]);
  const [first, second, third, fourth] = page.items;
  expect(first!.category_l1_id).toBe(CID1);
  expect(first!.category_l1_name).toBe(CID1_NAME);
  expect(has(second!, 'category_l1_id')).toBe(false);
  expect(has(second!, 'category_l1_name')).toBe(false);
  expect(third!.category_l1_id).toBe('7000999');
  expect(third!.category_l1_name).toBe('合成另一类目');
  expect(has(fourth!, 'category_l1_id')).toBe(false);
  expect(has(fourth!, 'category_l1_name')).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

it('[AC-B1-04zzv#12] 加上 categoryInfo 只多出两个类目键，其余字段与没有 categoryInfo 时完全相同', () => {
  const plain = mapped(row());
  const withL1 = mapped(withCategory(categoryInfo()));
  expect(withL1.category_l1_id).toBe(CID1);
  expect(withL1.category_l1_name).toBe(CID1_NAME);
  expect(
    Object.keys(withL1)
      .filter((name) => !has(plain, name))
      .sort(),
  ).toEqual(['category_l1_id', 'category_l1_name']);
  expect(withoutCategory(withL1)).toEqual(withoutCategory(plain));
  expect(Object.isFrozen(withL1)).toBe(true);
});
