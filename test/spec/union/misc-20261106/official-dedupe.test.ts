import { expect, it } from 'vitest';
import {
  convertToDetail,
  detailItemId,
  identities,
  rowsFrom,
  search,
  searchBody,
  searchRow,
  searchRows,
  setup,
  sharedTail,
  titleOf,
  visible,
  type Row,
  type RowParts,
} from '../taobao-official-search/official-harness.ts';

// Task-local AC labels ([AC-B1-04zzj#n]) identify this task's acceptance points, not business rules.
// D10-692 S2-4：淘宝官方搜索同一页里，两条搜索行换回的凑狸 item_id（详情口径）相同 → 只保留首条，其余
// 行不出现在结果里，顺序不变，不报错。是否另发跳行告警由实现定，这里不钉。全部合成值，不读录制。

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** Another search id of the same goods: whole string differs, last segment the same. */
function altSearchId(n: number): string {
  return `SrchAltern${pad(n)}Qb-${sharedTail(n)}`;
}

function altTitle(n: number): string {
  return `合成同款另一条搜索行 ${pad(n)}`;
}

/** A second search row of goods `n` under another search id and another title. */
function altRow(n: number, parts: RowParts = {}): Row {
  return searchRow(n, {
    ...parts,
    top: { item_id: altSearchId(n), ...parts.top },
    basic: { title: altTitle(n), ...parts.basic },
  });
}

/** The fake detail converts both search ids of a goods to its one detail id. */
function convertWithAlt(id: string): string | undefined {
  const match = /^SrchAltern([0-9]{4})Qb-SharedTail([0-9]{4})Zz$/.exec(id);
  if (match === null || match[1] !== match[2]) return convertToDetail(id);
  return detailItemId(Number(match[1]));
}

it('[AC-B1-04zzj#1] 同一搜索行在同页出现两次：只保留首次出现的那条，其余条目顺序不变，不报错', async () => {
  const { page } = await searchRows([searchRow(1), searchRow(2), searchRow(1), searchRow(3)]);
  expect(identities(page)).toEqual([1, 2, 3]);
});

it('[AC-B1-04zzj#2] 两条不同的搜索 ID 换回同一个详情 item_id：只保留首条（标题取首条），后一条不出现', async () => {
  const { page } = await searchRows([searchRow(4), searchRow(5), altRow(4), searchRow(6)], {
    available: convertWithAlt,
  });
  expect(page.items.map((item) => item.item_id)).toEqual([
    detailItemId(4),
    detailItemId(5),
    detailItemId(6),
  ]);
  expect(page.items.map((item) => item.title)).toEqual([titleOf(4), titleOf(5), titleOf(6)]);
  expect(visible(page)).not.toContain(altTitle(4));
});

it('[AC-B1-04zzj#3] 首条是哪一行就留哪一行：另一条搜索 ID 在前时留它，原搜索 ID 的那条不出现', async () => {
  const { page } = await searchRows([altRow(7), searchRow(8), searchRow(7)], {
    available: convertWithAlt,
  });
  expect(page.items.map((item) => item.item_id)).toEqual([detailItemId(7), detailItemId(8)]);
  expect(page.items.map((item) => item.title)).toEqual([altTitle(7), titleOf(8)]);
  expect(visible(page)).not.toContain(titleOf(7));
});

it('[AC-B1-04zzj#4] 首条价格异常也留首条：不因后一条价格正常而换成后一条', async () => {
  const anomalous = searchRow(9, { price: { zk_final_price: undefined } });
  const { page } = await searchRows([anomalous, altRow(9)], { available: convertWithAlt });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    item_id: detailItemId(9),
    title: titleOf(9),
    price_status: 'anomaly',
  });
});

it('[AC-B1-04zzj#5] 被跳过（缺标题）的行不算首条：同款里第一条能返回的行留下，其后同款不出现', async () => {
  const untitled = searchRow(10, { basic: { title: undefined } });
  const { page } = await searchRows([untitled, altRow(10), searchRow(11), searchRow(10)], {
    available: convertWithAlt,
  });
  expect(page.items.map((item) => item.item_id)).toEqual([detailItemId(10), detailItemId(11)]);
  expect(page.items.map((item) => item.title)).toEqual([altTitle(10), titleOf(11)]);
});

it('[AC-B1-04zzj#6] 换算缓存命中时同样去重：同一适配器第二次搜到含重复行的页，结果里每个详情 ID 只出现一次', async () => {
  let round = 0;
  const h = setup({
    available: convertWithAlt,
    page: () =>
      round === 0
        ? searchBody([searchRow(12), searchRow(13)], 2)
        : searchBody([searchRow(12), searchRow(13), searchRow(12), altRow(13)], 4),
  });
  const first = await search(h);
  expect(identities(first)).toEqual([12, 13]);
  round = 1;
  const second = await search(h);
  expect(identities(second)).toEqual([12, 13]);
});

it('[AC-B1-04zzj#7] 满页 20 条里后 10 条与前 10 条同款：只返回前 10 条（顺序不变），nextCursor 仍按原始条数给', async () => {
  const rows = [...rowsFrom(21, 10), ...rowsFrom(21, 10)];
  const h = setup({ page: () => searchBody(rows, 165) });
  const page = await search(h);
  expect(identities(page)).toEqual(Array.from({ length: 10 }, (_unused, i) => 21 + i));
  expect(page.nextCursor).toBe('taobao-search:2');
});
