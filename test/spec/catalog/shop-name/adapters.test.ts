import { expect, it } from 'vitest';
import {
  ctx as tbCtx,
  detailRow,
  detailSetup,
  ref as tbRef,
} from '../../union/taobao-goods/kit.ts';
import {
  convertToDetail,
  searchRow,
  searchRows as officialRows,
} from '../../union/taobao-official-search/official-harness.ts';
import {
  convertAll,
  dtkRow,
  searchRows as dataokeRows,
  topBody,
  topRow,
} from '../../union/taobao-search/kit.ts';
import {
  ctx as jdCtx,
  itemRef as jdRef,
  listing,
  row as jdRow,
  wire,
} from '../../union/jd-goods/kit.ts';
import { one as pddOne, row as pddRow } from '../../union/pdd-goods/kit.ts';
import { decoys, dtoNames, wireNames } from './samples.ts';

// 真实适配器入口 + 内存 transport；搜索用于 ID 换算的详情故意给不同店名，不能覆盖或补搜索店名。
function conversionReply(ids: readonly string[], convert: (id: string) => string | undefined) {
  return topBody(
    ids.map((id) => ({
      ...topRow(convert(id)!),
      item_basic_info: {
        title: '合成换算详情标题',
        shop_title: '合成换算详情店，不能补到搜索',
      },
    })),
  );
}

it('[AC-B1-04zzg#1] 淘宝官方搜索只取 item_basic_info.shop_title，空值不从昵称或换算详情补', async () => {
  const rows = wireNames.map((name, index) =>
    searchRow(index + 1, {
      basic: { ...decoys, shop_title: name },
      top: { ...decoys, shop_title: '合成错误层级店名' },
    }),
  );
  const { page } = await officialRows(rows, {
    detailReply: (ids) => conversionReply(ids, convertToDetail),
  });
  expect(page.items).toHaveLength(wireNames.length);
  expect(page.items.map((item) => item.shop_name)).toEqual(dtoNames);
});

it('[AC-B1-04zzg#2] 淘宝详情 upgrade.get 的 results 包装项只取 item_basic_info.shop_title', async () => {
  const names = [];
  for (const name of wireNames) {
    const { adapter } = detailSetup([
      detailRow({
        basic: { ...decoys, shop_title: name },
        top: { ...decoys, shop_title: '合成错误层级店名' },
      }),
    ]);
    names.push((await adapter.getItem(tbRef, tbCtx)).shop_name);
  }
  expect(names).toEqual(dtoNames);
});

it('[AC-B1-04zzg#3] 大淘客搜索只取 data.list 的 shopName，保留内部空格，不拿换算详情补空值', async () => {
  const rows = wireNames.map((name, index) =>
    dtkRow(index + 1, { ...decoys, shopName: name, shop_title: '合成其他来源店名' }),
  );
  const { page } = await dataokeRows(rows, {
    topReply: (ids) => conversionReply(ids, convertAll),
  });
  expect(page.items).toHaveLength(wireNames.length);
  expect(page.items.map((item) => item.shop_name)).toEqual(dtoNames);
});

it.each([
  { ac: 4, port: 'search' },
  { ac: 5, port: 'detail' },
] as const)(
  '[AC-B1-04zzg#$ac] 京东 $port 只取 data 商品项的 shopInfo.shopName，无值不补',
  async ({ port }) => {
    const names = [];
    for (const name of wireNames) {
      const { adapter } = wire(() =>
        listing([
          jdRow({
            ...decoys,
            shopName: '合成错误层级店名',
            shopInfo: name === undefined ? undefined : { ...decoys, shopName: name },
          }),
        ]),
      );
      if (port === 'detail') {
        names.push((await adapter.getItem(jdRef, jdCtx)).shop_name);
      } else {
        const page = await adapter.searchItems({ keyword: '合成店名商品' }, jdCtx);
        expect(page.items).toHaveLength(1);
        names.push(page.items[0]!.shop_name);
      }
    }
    expect(names).toEqual(dtoNames);
  },
);

it.each([
  { ac: 6, port: 'search' },
  { ac: 7, port: 'detail' },
] as const)(
  '[AC-B1-04zzg#$ac] 拼多多 $port 只取 mall_name，不把 mall_id、标题或卖家昵称当店名',
  async ({ port }) => {
    const names = [];
    for (const name of wireNames) {
      const item = await pddOne(
        port,
        pddRow({ ...decoys, mall_name: name, shopName: '合成其他平台店名' }),
      );
      names.push(item.shop_name);
    }
    expect(names).toEqual(dtoNames);
  },
);
