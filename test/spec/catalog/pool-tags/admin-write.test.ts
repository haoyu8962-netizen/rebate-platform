// CT-07e (D10-1758 / D10-1764 / D10-1765): tags in PoolAdmin, the use case behind adminAddPoolItem,
// adminUpdatePoolItem and adminListPoolItems. A new item without tags stores []; a repeated add
// (overwrite) keeps the stored tags when the body has none and replaces them when it has some ([]
// clears), whatever the re-check answered, like the submitted window; an edit without tags leaves
// them, with tags replaces them. Every write stores the normalized value and refuses an invalid one
// with 20001 data.fields=[tags] before anything is written. The list filter `tag` is refused with
// data.fields=[tag] when it normalizes to nothing, is too long or carries a control character.
import { expect, it } from 'vitest';
import type { PoolProduct } from '../../../../apps/api/src/modules/catalog/application/pool-source.ts';
import {
  ACTOR,
  ADD,
  EXPIRED,
  LIVE,
  OFF_SHELF,
  POOL_ID,
  expectFields,
  harness,
  storedItem,
  tagsOf,
  type AddBody,
  type ListQuery,
  type UpdateBody,
} from './admin-kit.ts';
import { ELEVEN_TAGS, TEN_TAGS, WIDE_SPACE } from './model.ts';

const KEY = 'tb:K1';

const REFUSED: readonly { label: string; tags: string[] }[] = [
  { label: '超 10 项', tags: [...ELEVEN_TAGS] },
  { label: '一项超 16 个码点', tags: ['甲', '𠀀'.repeat(17)] },
  { label: '规范化后超 16 个码点', tags: ['㍿'.repeat(5)] },
  { label: '含控制字符', tags: ['甲', '乙\u0007'] },
  { label: '含 NUL', tags: ['\u0000丙'] },
];

it('[CT-07e][D10-1758] 新入库不带 tags：存 []，返回的条目 tags=[]', async () => {
  const f = harness(null);

  const item = await f.admin.addItem(ACTOR, POOL_ID, ADD);

  expect(tagsOf(f.written())).toEqual([]);
  expect(tagsOf(item)).toEqual([]);
});

it('[CT-07e][D10-1758] 新入库带 tags：存规范化后的值（NFKC、去空白、去重保序、大小写不折叠），返回同样的值', async () => {
  const f = harness(null);
  const body: AddBody = { ...ADD, tags: [' 新品 ', 'ＡＢ', 'AB', 'ab', WIDE_SPACE, '618  大促'] };

  const item = await f.admin.addItem(ACTOR, POOL_ID, body);

  const expected = ['新品', 'AB', 'ab', '618 大促'];
  expect(f.insertItem).toHaveBeenCalledTimes(1);
  expect(tagsOf(f.written())).toEqual(expected);
  expect(tagsOf(item)).toEqual(expected);
});

it('[CT-07e][D10-1758] 新入库 10 项、每项 16 个码点：原样通过', async () => {
  const f = harness(null);
  const tags = [...TEN_TAGS.slice(0, 9), '𠀀'.repeat(16)];

  const body: AddBody = { ...ADD, tags };

  const item = await f.admin.addItem(ACTOR, POOL_ID, body);

  expect(tagsOf(f.written())).toEqual(tags);
  expect(tagsOf(item)).toEqual(tags);
});

it.each(REFUSED)(
  '[CT-07e][D10-1758] 新入库 tags $label → 20001 data.fields=[tags]，不截断、什么都不写',
  async ({ tags }) => {
    const ok = harness(null);
    const valid: AddBody = { ...ADD, tags: ['甲'] };
    expect(tagsOf(await ok.admin.addItem(ACTOR, POOL_ID, valid))).toEqual(['甲']);
    const f = harness(null);
    const body: AddBody = { ...ADD, tags };

    await expectFields(f.admin.addItem(ACTOR, POOL_ID, body), ['tags']);

    expect(f.insertItem).not.toHaveBeenCalled();
    expect(f.updateItem).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  },
);

const REPEATS: readonly { label: string; product: PoolProduct }[] = [
  { label: '复检通过', product: LIVE },
  { label: '联盟下架', product: OFF_SHELF },
  { label: '引用失效', product: EXPIRED },
];

it.each(REPEATS)(
  '[CT-07e][D10-1764] 重复入库（$label）不带 tags：保留原有标签，不因重新入库清掉',
  async ({ product }) => {
    const f = harness(storedItem(['原有', '标签']), product);

    const item = await f.admin.addItem(ACTOR, POOL_ID, ADD);

    expect(f.insertItem).not.toHaveBeenCalled();
    expect(f.written()).toMatchObject({ product_key: KEY, sort: 9 });
    expect(tagsOf(f.written())).toEqual(['原有', '标签']);
    expect(tagsOf(item)).toEqual(['原有', '标签']);
  },
);

it.each(REPEATS)(
  '[CT-07e][D10-1764] 重复入库（$label）带 tags：整体替换为规范化后的值，与窗口字段一样覆盖',
  async ({ product }) => {
    const f = harness(storedItem(['原有', '标签']), product);
    const body: AddBody = { ...ADD, tags: [' 新标签 ', 'ＮＥＷ'] };

    const item = await f.admin.addItem(ACTOR, POOL_ID, body);

    expect(f.written()).toMatchObject({ product_key: KEY, sort: 9 });
    expect(tagsOf(f.written())).toEqual(['新标签', 'NEW']);
    expect(tagsOf(item)).toEqual(['新标签', 'NEW']);
  },
);

it.each(REPEATS)('[CT-07e][D10-1764] 重复入库（$label）带 tags=[]：清空', async ({ product }) => {
  const f = harness(storedItem(['原有']), product);
  const body: AddBody = { ...ADD, tags: [] };

  const item = await f.admin.addItem(ACTOR, POOL_ID, body);

  expect(tagsOf(f.written())).toEqual([]);
  expect(tagsOf(item)).toEqual([]);
});

it('[CT-07e][D10-1764] 重复入库带不合法的 tags → 20001 data.fields=[tags]，原行不动', async () => {
  const ok = harness(storedItem(['原有']));
  expect(tagsOf(await ok.admin.addItem(ACTOR, POOL_ID, ADD))).toEqual(['原有']);
  const f = harness(storedItem(['原有']));
  const body: AddBody = { ...ADD, tags: [...ELEVEN_TAGS] };

  await expectFields(f.admin.addItem(ACTOR, POOL_ID, body), ['tags']);

  expect(f.insertItem).not.toHaveBeenCalled();
  expect(f.updateItem).not.toHaveBeenCalled();
  expect(f.audits).toEqual([]);
});

it('[CT-07e][D10-1758] 编辑不带 tags：标签不改', async () => {
  const f = harness(storedItem(['原有', '标签']));
  const body: UpdateBody = { sort: 3 };

  const item = await f.admin.updateItem(ACTOR, POOL_ID, KEY, body);

  expect(f.written()).toMatchObject({ sort: 3 });
  expect(tagsOf(f.written())).toEqual(['原有', '标签']);
  expect(tagsOf(item)).toEqual(['原有', '标签']);
});

it('[CT-07e][D10-1758] 编辑带 tags：整体替换为规范化后的值，其他字段不动；原样重发结果相同', async () => {
  const f = harness(storedItem(['原有'], { sort: 4 }));
  const body: UpdateBody = { tags: ['乙', ' 甲 ', '乙', 'Ａ'] };

  const item = await f.admin.updateItem(ACTOR, POOL_ID, KEY, body);

  expect(f.written()).toMatchObject({ sort: 4, status: 'online' });
  expect(tagsOf(f.written())).toEqual(['乙', '甲', 'A']);
  expect(tagsOf(item)).toEqual(['乙', '甲', 'A']);

  const again = harness(storedItem(['乙', '甲', 'A'], { sort: 4 }));
  expect(tagsOf(await again.admin.updateItem(ACTOR, POOL_ID, KEY, body))).toEqual([
    '乙',
    '甲',
    'A',
  ]);
});

it('[CT-07e][D10-1758] 编辑带 tags=[]：清空', async () => {
  const f = harness(storedItem(['原有']));
  const body: UpdateBody = { tags: [] };

  const item = await f.admin.updateItem(ACTOR, POOL_ID, KEY, body);

  expect(tagsOf(f.written())).toEqual([]);
  expect(tagsOf(item)).toEqual([]);
});

it.each(REFUSED)(
  '[CT-07e][D10-1758] 编辑 tags $label → 20001 data.fields=[tags]，什么都不写',
  async ({ tags }) => {
    const ok = harness(storedItem(['原有']));
    const valid: UpdateBody = { tags: ['甲'] };
    expect(tagsOf(await ok.admin.updateItem(ACTOR, POOL_ID, KEY, valid))).toEqual(['甲']);
    const f = harness(storedItem(['原有']));
    const body: UpdateBody = { tags };

    await expectFields(f.admin.updateItem(ACTOR, POOL_ID, KEY, body), ['tags']);

    expect(f.updateItem).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  },
);

it('[CT-07e][D10-1758] 条目列表：每个条目都带存储里的 tags（按存储顺序），没有标签的是 []', async () => {
  const tagged = harness(storedItem(['乙', '甲']));
  const plain = harness(storedItem([]));

  const list = await tagged.admin.listItems(ACTOR.appId, POOL_ID, {});
  const empty = await plain.admin.listItems(ACTOR.appId, POOL_ID, {});

  expect(list.items.map(tagsOf)).toEqual([['乙', '甲']]);
  expect(empty.items.map(tagsOf)).toEqual([[]]);
});

it.each([
  { label: '空串', tag: '' },
  { label: '只有空格', tag: '   ' },
  { label: '只有全角空格', tag: WIDE_SPACE },
  { label: '超 16 个码点', tag: '𠀀'.repeat(17) },
  { label: '规范化后超 16 个码点', tag: '㍿'.repeat(5) },
  { label: '含控制字符', tag: '新\u0007品' },
])(
  '[CT-07e][D10-1765] 条目列表 tag $label → 20001 data.fields=[tag]，不当成不筛也不当成无结果',
  async ({ tag }) => {
    const ok = harness(storedItem(['新品']));
    const valid: ListQuery = { tag: ' 新品 ' };
    expect((await ok.admin.listItems(ACTOR.appId, POOL_ID, valid)).items.map(tagsOf)).toEqual([
      ['新品'],
    ]);
    const f = harness(storedItem(['新品']));
    const query: ListQuery = { tag };

    await expectFields(f.admin.listItems(ACTOR.appId, POOL_ID, query), ['tag']);
  },
);
