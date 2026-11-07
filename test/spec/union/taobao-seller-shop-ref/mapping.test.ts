import { expect, it } from 'vitest';
import {
  convertAll,
  couliItemId,
  dtkRow,
  expectTrueIdentities,
  expectWarned,
  goodsNumber,
  one,
  rowWithout,
  search,
  searchData,
  searchRows,
  setup,
  visible,
  withoutShopRef,
  type Row,
} from '../taobao-search/kit.ts';
import {
  expectNoInvalidItem,
  expectNoShopRef,
  expectOnlyAllowedKeys,
  expectShopRef,
} from './kit.ts';

// 大淘客搜索（searchSource='dataoke'，经 TaobaoUnionAdapter.searchItems）：每条 UnionItem 的 shop_ref 只取
// 同一行的 sellerId（S-17 S17-u1，D10-806 ①）。sellerId 全是纯数字合成值；不合格的 sellerId 只让该条
// 不带 shop_ref，不跳行、不告警 invalid_item；sellerId 不出现在 shop_ref 以外的任何地方。

it.each([
  ['十进制字符串', '2201234567', '2201234567'],
  ['一位数字串', '1', '1'],
  ['超出安全整数的数字串（原样，不经 number）', '9007199254740993', '9007199254740993'],
  ['二十位数字串', '22012345678901234567', '22012345678901234567'],
  ['安全整数 number', 2_201_234_567, '2201234567'],
  ['number 1', 1, '1'],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, '9007199254740991'],
] as [string, string | number, string][])(
  '[AC-B1-04zzs#1] sellerId 为%s → 该条带 shop_ref = 其十进制字符串原样',
  async (_label, sellerId, expected) => {
    const item = await one(dtkRow(1, { sellerId }));
    expect(item.item_id).toBe(couliItemId(1));
    expectShopRef(item, expected);
    expectOnlyAllowedKeys(item);
  },
);

const GOOD_FIRST = '7310000000001';
/** Every invalid value below that carries digits uses this run, so a leak is easy to spot. */
const BAD_DIGITS = '7310000000002';

it.each([
  ['缺失', undefined],
  ['null', null],
  ['空串', ''],
  ['字符串 0', '0'],
  ['number 0', 0],
  ['全是 0', '000'],
  ['负数字符串', `-${BAD_DIGITS}`],
  ['负数 number', -7_310_000_000_002],
  ['小数字符串', `${BAD_DIGITS}.5`],
  ['以 .0 结尾的字符串', `${BAD_DIGITS}.0`],
  ['小数 number', 7_310_000_000.5],
  ['科学计数字符串', '7.310000000002e12'],
  ['科学计数 number（超出安全整数）', 7.31e21],
  ['超出安全整数的 number', 2 ** 53 + 2],
  ['前导零', `0${BAD_DIGITS}`],
  ['前导空格', ` ${BAD_DIGITS}`],
  ['尾随空格', `${BAD_DIGITS} `],
  ['前导制表符', `\t${BAD_DIGITS}`],
  ['尾随换行', `${BAD_DIGITS}\n`],
  ['前导全角空格', `　${BAD_DIGITS}`],
  ['中间空格', '7310 000000002'],
  ['正号', `+${BAD_DIGITS}`],
  ['十六进制', '0x1F'],
  ['全角数字', '７３１'],
  ['字母混数字', `S${BAD_DIGITS}`],
  ['布尔', true],
  ['对象', { id: BAD_DIGITS }],
  ['数组', [BAD_DIGITS]],
] as [string, unknown][])(
  '[AC-B1-04zzs#2] sellerId %s → 该条照常返回但不带 shop_ref；不跳行、不告警 invalid_item；同页合法 sellerId 照出',
  async (_label, bad) => {
    const middle = bad === undefined ? rowWithout(2, 'sellerId') : dtkRow(2, { sellerId: bad });
    const { h, page } = await searchRows([
      dtkRow(1, { sellerId: GOOD_FIRST }),
      middle,
      dtkRow(3, { sellerId: 7_330_000_000_003 }),
    ]);
    expect(expectTrueIdentities(page)).toEqual([1, 2, 3]);
    expectShopRef(page.items[0], GOOD_FIRST);
    expectNoShopRef(page.items[1]);
    expectShopRef(page.items[2], '7330000000003');
    for (const item of page.items) expectOnlyAllowedKeys(item);
    expect(visible(page)).not.toContain(BAD_DIGITS);
    expectNoInvalidItem(h);
  },
);

it('[AC-B1-04zzs#3] shop_ref 只来自同一行的 sellerId：多行各取各的；被跳过、换不到的条目不让后面的条目错位，倒序也一样', async () => {
  const rows: Row[] = [
    dtkRow(1, { sellerId: '7410000000001' }),
    // 缺标题：跳过并告警 invalid_item（与 sellerId 无关）。
    dtkRow(2, { sellerId: '7420000000002', title: null, dtitle: null }),
    // 换不到凑狸 ID：不返回。
    dtkRow(3, { sellerId: '7430000000003' }),
    dtkRow(4, { sellerId: 7_440_000_000_004 }),
    dtkRow(5, { sellerId: '7450000000005' }),
  ];
  const available = (goodsId: string) =>
    goodsNumber(goodsId) === 3 ? undefined : convertAll(goodsId);
  const { h, page } = await searchRows(rows, { available });
  expect(expectTrueIdentities(page)).toEqual([1, 4, 5]);
  expectShopRef(page.items[0], '7410000000001');
  expectShopRef(page.items[1], '7440000000004');
  expectShopRef(page.items[2], '7450000000005');
  expectWarned(h, 'invalid_item');
  const shown = visible(page);
  expect(shown).not.toContain('7420000000002');
  expect(shown).not.toContain('7430000000003');

  const reversed = await searchRows([rows[4]!, rows[3]!, rows[0]!]);
  expect(expectTrueIdentities(reversed.page)).toEqual([5, 4, 1]);
  expectShopRef(reversed.page.items[0], '7450000000005');
  expectShopRef(reversed.page.items[1], '7440000000004');
  expectShopRef(reversed.page.items[2], '7410000000001');
});

it('[AC-B1-04zzs#4] 同一商品再次搜索命中 ID 缓存：shop_ref 仍取本次这一行的 sellerId，不沿用上次；本次没有就不带', async () => {
  const sellers: readonly unknown[] = ['7510000000001', 7_520_000_000_002, undefined];
  let call = 0;
  const h = setup({
    data: () => {
      const sellerId = sellers[call];
      call += 1;
      const row = sellerId === undefined ? rowWithout(1, 'sellerId') : dtkRow(1, { sellerId });
      return searchData([row], 1);
    },
  });
  const first = await search(h);
  expect(expectTrueIdentities(first)).toEqual([1]);
  expectShopRef(first.items[0], '7510000000001');
  const second = await search(h);
  expect(expectTrueIdentities(second)).toEqual([1]);
  expectShopRef(second.items[0], '7520000000002');
  const third = await search(h);
  expect(expectTrueIdentities(third)).toEqual([1]);
  expectNoShopRef(third.items[0]);
  // 后两次都命中映射缓存：换算只调过一次。
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);
  expect(h.dataokeTransport).toHaveBeenCalledTimes(3);
});

it('[AC-B1-04zzs#5] sellerId 只以 shop_ref 原样出现：其余键、序列化与打印、告警、换算请求里都看不到', async () => {
  const markers = [
    '7610000000001',
    '7620000000002',
    '7630000000003',
    '7640000000004',
    '7650000000005',
  ] as const;
  const { h, page } = await searchRows([
    dtkRow(1, { sellerId: markers[0] }),
    dtkRow(2, { sellerId: 7_620_000_000_002 }),
    // 前导零：不出 shop_ref。
    dtkRow(3, { sellerId: `0${markers[2]}` }),
    // 主图不合格：跳过并告警 invalid_item。
    dtkRow(4, { sellerId: markers[3], mainPic: 'http://img.synthetic.invalid/x.jpg' }),
    // 价格非法：照样返回（价格异常）并告警 PRICE_ANOMALY；shop_ref 不受影响。
    dtkRow(5, { sellerId: markers[4], actualPrice: 'abc' }),
  ]);
  expect(expectTrueIdentities(page)).toEqual([1, 2, 3, 5]);
  expectShopRef(page.items[0], markers[0]);
  expectShopRef(page.items[1], markers[1]);
  expectNoShopRef(page.items[2]);
  expectShopRef(page.items[3], markers[4]);
  for (const item of page.items) expectOnlyAllowedKeys(item);
  expectWarned(h, 'invalid_item');
  expectWarned(h, 'PRICE_ANOMALY');

  const shown = visible(page);
  const hidden = visible(withoutShopRef(page));
  const warnings = visible([h.warn.mock.calls, h.dataokeWarn.mock.calls]);
  const topRequests = visible(h.taobaoTransport.mock.calls);
  for (const marker of markers) {
    expect(hidden, marker).not.toContain(marker);
    expect(warnings, marker).not.toContain(marker);
    expect(topRequests, marker).not.toContain(marker);
  }
  expect(shown).not.toContain(markers[2]);
  expect(shown).not.toContain(markers[3]);
});

it('[AC-B1-04zzs#6] 只认 sellerId：行里冒名的 shop_ref / shopRef / shopId / seller_id / userId 不透传、不补位', async () => {
  const spoof: Row = {
    shop_ref: '7710000000001',
    shopRef: '7720000000002',
    shopId: '7730000000003',
    seller_id: '7740000000004',
    userId: '7750000000005',
  };
  const { h, page } = await searchRows([
    dtkRow(1, { ...spoof, sellerId: '7760000000006' }),
    { ...rowWithout(2, 'sellerId'), ...spoof },
    dtkRow(3, { ...spoof, sellerId: '0' }),
  ]);
  expect(expectTrueIdentities(page)).toEqual([1, 2, 3]);
  expectShopRef(page.items[0], '7760000000006');
  expectNoShopRef(page.items[1]);
  expectNoShopRef(page.items[2]);
  const shown = visible(page);
  for (const value of Object.values(spoof)) expect(shown).not.toContain(String(value));
  for (const item of page.items) expectOnlyAllowedKeys(item);
  expectNoInvalidItem(h);
});
