// CT-07e (D10-1758 / D10-1764 / D10-1765): tags through the real console entry — adminAddPoolItem,
// adminUpdatePoolItem, adminListPoolItems → PoolAdmin → PostgreSQL — with the B1-05q admin kit
// (only normalized union DTOs are synthetic). Every answer passes the contract's response schema.
// Rows that a case needs before the call go in by SQL; what a call writes is read back by SQL.
import { expect, it } from 'vitest';
import type { UnionItemDetail } from '../../../../apps/api/src/modules/union/index.ts';
import {
  bounds,
  fields,
  linkOf,
  product,
  seedItem,
  seedPool,
  send,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  useHarness,
  type Item,
  type ItemList,
  type Setup,
} from '../product-pool-admin/kit.ts';
import { TIMEOUT, requireTags, seedTags, storedTags } from './db-kit.ts';
import { ELEVEN_TAGS, WIDE_SPACE, tagsOf } from './model.ts';

const h = useHarness();

/** adminAddPoolItem by link for this product, with `tags` only when given. */
function add(f: Setup, pool: string, item: UnionItemDetail, tags?: readonly string[]) {
  stubProduct(item);
  return send(
    f,
    'addItem',
    { pool },
    {
      link_text: linkOf(item.item_id!),
      ...bounds(),
      ...(tags === undefined ? {} : { tags }),
    },
  );
}

function list(f: Setup, pool: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  return send(f, 'listItems', { pool }, undefined, search === '' ? {} : { query: `?${search}` });
}

async function keysOf(f: Setup, pool: string, query: Record<string, string>) {
  const page = await success<ItemList>(await list(f, pool, query));
  return { keys: page.items.map((entry) => entry.product_key), total: page.total };
}

it(
  '[CT-07e][D10-1758] 迁移：pool_items.tags 是 text[] NOT NULL DEFAULT {}，已有条目读出来是 []',
  async () => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    await seedItem(h, f, pool, 'tb:OLD');

    expect(await storedTags(h.db, f.appId, pool, 'tb:OLD')).toEqual([]);
    const page = await success<ItemList>(await list(f, pool));
    expect(page.items.map(tagsOf)).toEqual([[]]);
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1758] 新入库带 tags：存与返回的都是规范化后的值；不带 tags 存 []',
  async () => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const tagged = product(f, stableId());
    const plain = product(f, stableId());

    const raw = ['  新品 ', 'ＡＢ', 'AB', 'ab', `618${WIDE_SPACE.repeat(2)}大促`];
    const item = await success<Item>(await add(f, pool, tagged, raw));
    const bare = await success<Item>(await add(f, pool, plain));

    const expected = ['新品', 'AB', 'ab', '618 大促'];
    expect(tagsOf(item)).toEqual(expected);
    expect(await storedTags(h.db, f.appId, pool, item.product_key)).toEqual(expected);
    expect(tagsOf(bare)).toEqual([]);
    expect(await storedTags(h.db, f.appId, pool, bare.product_key)).toEqual([]);
  },
  TIMEOUT,
);

it.each([
  { label: '超 10 项', tags: [...ELEVEN_TAGS] },
  { label: '一项超 16 个码点', tags: ['新品', '𠀀'.repeat(17)] },
  { label: '含控制字符', tags: ['新\u0007品'] },
])(
  '[CT-07e][D10-1758] 新入库 tags $label → 20001 data.fields=[tags]，什么都不写；合法的同一请求照常入库',
  async ({ tags }) => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const item = product(f, stableId());
    const before = await snapshot(h, f.appId);

    await fields(await add(f, pool, item, tags), ['tags']);

    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(tagsOf(await success<Item>(await add(f, pool, item, ['新品'])))).toEqual(['新品']);
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1764] 重复入库：不带 tags 保留原有，带了整体替换，[] 清空',
  async () => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const item = product(f, stableId());
    const key = (await success<Item>(await add(f, pool, item, ['甲', '乙']))).product_key;

    f.clock.advanceMs(60_000);
    expect(tagsOf(await success<Item>(await add(f, pool, item)))).toEqual(['甲', '乙']);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(['甲', '乙']);

    expect(tagsOf(await success<Item>(await add(f, pool, item, [' 丙 ', '丙'])))).toEqual(['丙']);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(['丙']);

    expect(tagsOf(await success<Item>(await add(f, pool, item, [])))).toEqual([]);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[CT-07e][D10-1758] 编辑：不带 tags 不改，带了整体替换（原样重发结果相同），[] 清空，不合法的拒绝且不改',
  async () => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const key = (await success<Item>(await add(f, pool, product(f, stableId()), ['甲'])))
      .product_key;
    const patch = (body: Record<string, unknown>) => send(f, 'updateItem', { pool, key }, body);

    expect(tagsOf(await success<Item>(await patch({ sort: 5 })))).toEqual(['甲']);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(['甲']);

    const replace = { tags: ['丙', 'Ｃ', ' 丙'] };
    expect(tagsOf(await success<Item>(await patch(replace)))).toEqual(['丙', 'C']);
    expect(tagsOf(await success<Item>(await patch(replace)))).toEqual(['丙', 'C']);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(['丙', 'C']);

    await fields(await patch({ tags: ['中'.repeat(17)] }), ['tags']);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(['丙', 'C']);

    expect(tagsOf(await success<Item>(await patch({ tags: [] })))).toEqual([]);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual([]);
  },
  TIMEOUT,
);

/** Five stored items, sort 1–5; tb:B is offline. */
async function taggedPool(f: Setup): Promise<string> {
  const pool = await seedPool(h, f);
  const rows: readonly [string, number, readonly string[], string][] = [
    ['tb:A', 1, ['新品', 'AB'], 'online'],
    ['tb:B', 2, ['新品'], 'offline'],
    ['tb:C', 3, [], 'online'],
    ['tb:D', 4, ['ab'], 'online'],
    ['tb:E', 5, ['新品上架'], 'online'],
  ];
  for (const [key, sort, tags, status] of rows) {
    await seedItem(h, f, pool, key, { sort, status });
    await seedTags(h.db, f.appId, pool, key, tags);
  }
  return pool;
}

it(
  '[CT-07e][D10-1765] 条目列表按 tag 筛选：规范化后完全相等匹配「tags 含它」，total 按筛选后算，可与 status、分页同用；不带不筛',
  async () => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await taggedPool(f);

    const all = await success<ItemList>(await list(f, pool));
    expect(all.items.map((entry) => [entry.product_key, tagsOf(entry)])).toEqual([
      ['tb:A', ['新品', 'AB']],
      ['tb:B', ['新品']],
      ['tb:C', []],
      ['tb:D', ['ab']],
      ['tb:E', ['新品上架']],
    ]);
    expect(all.total).toBe(5);

    expect(await keysOf(f, pool, { tag: '新品' })).toEqual({ keys: ['tb:A', 'tb:B'], total: 2 });
    expect(await keysOf(f, pool, { tag: ' 新品  ' })).toEqual({ keys: ['tb:A', 'tb:B'], total: 2 });
    expect(await keysOf(f, pool, { tag: 'ＡＢ' })).toEqual({ keys: ['tb:A'], total: 1 });
    expect(await keysOf(f, pool, { tag: 'ab' })).toEqual({ keys: ['tb:D'], total: 1 });
    expect(await keysOf(f, pool, { tag: '新' })).toEqual({ keys: [], total: 0 });
    expect(await keysOf(f, pool, { tag: '新品', status: 'online' })).toEqual({
      keys: ['tb:A'],
      total: 1,
    });
    expect(await keysOf(f, pool, { tag: '新品', page: '2', page_size: '1' })).toEqual({
      keys: ['tb:B'],
      total: 2,
    });
  },
  TIMEOUT,
);

it.each([
  { label: '空串', tag: '' },
  { label: '只有空格', tag: '   ' },
  { label: '只有全角空格', tag: WIDE_SPACE },
  { label: '超 16 个码点', tag: '𠀀'.repeat(17) },
  { label: '含控制字符', tag: '新\u0007品' },
])(
  '[CT-07e][D10-1765] 条目列表 tag $label → 20001 data.fields=[tag]，不当成不筛也不当成无结果',
  async ({ tag }) => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await taggedPool(f);
    expect(await keysOf(f, pool, { tag: '新品' })).toEqual({ keys: ['tb:A', 'tb:B'], total: 2 });

    await fields(await list(f, pool, { tag }), ['tag']);
  },
  TIMEOUT,
);
