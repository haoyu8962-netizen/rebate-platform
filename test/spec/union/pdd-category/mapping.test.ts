import { expect, it } from 'vitest';
import { one, row, sources } from '../pdd-goods/kit.ts';
import { CAT_IDS, catRow, control, expectL1, expectNoCategory, L1 } from './kit.ts';

it.each(sources)(
  '[AC-B1-04zzw#1] %s：cat_ids 首项转十进制字符串作 category_l1_id，其余字段不变、不出 category_l1_name',
  async (source) => {
    const plain = await one(source, row());
    const item = await one(source, catRow());
    expectL1(item, L1);
    expect(typeof item.category_l1_id).toBe('string');
    expect(item).toEqual({ ...plain, category_l1_id: L1 });
  },
);

const firstOnly: readonly (readonly [string, readonly number[], string])[] = [
  ['首项不是最小值', [8569, 8439, 8581], '8569'],
  ['首项不是最大值', [8439, 8581, 8569], '8439'],
  ['首项是最小值', [1, 99_999, 7], '1'],
  ['只有一项', [15], '15'],
  ['四项（一~四级）', [6_398, 6_401, 6_420, 6_433], '6398'],
  ['后面各项重复首项', [27, 27, 27], '27'],
  ['首项为安全整数上界', [Number.MAX_SAFE_INTEGER, 3], '9007199254740991'],
  ['首项为 1000', [1e3, 2_000], '1000'],
];

const firstOnlyCases = sources.flatMap((source) =>
  firstOnly.map(([label, ids, id]) => [source, label, ids, id] as const),
);

it.each(firstOnlyCases)(
  '[AC-B1-04zzw#2] %s：%s → 只取 cat_ids 首项',
  async (source, _label, ids, id) => {
    const item = await one(source, row({ cat_ids: [...ids] }));
    expectL1(item, id);
  },
);

it.each(sources)(
  '[AC-B1-04zzw#3] %s：不用 cat_id——cat_ids 合格时只认首项，cat_ids 缺失或不合格时 cat_id 也不顶替',
  async (source) => {
    // 物料流的 cat_id 是字符串，搜索 / 详情是整数；两种都不得进 category_l1_id。
    const catId = source === 'feed' ? '9001' : 9001;
    expectL1(await one(source, catRow({ cat_id: catId })), L1);
    await control(source);
    expectNoCategory(await one(source, row({ cat_id: catId })));
    expectNoCategory(await one(source, row({ cat_id: catId, cat_ids: [] })));
    expectNoCategory(await one(source, row({ cat_id: catId, cat_ids: [0, ...CAT_IDS] })));
  },
);

it.each(sources)(
  '[AC-B1-04zzw#4] %s：拼多多无一级名称——报文里与 DTO 同名的 category_l1_id / category_l1_name 不透传',
  async (source) => {
    const spoof = { category_l1_id: '777', category_l1_name: '合成冒名一级类目' };
    const item = await one(source, catRow(spoof));
    expectL1(item, L1);
    expect(Object.values(item)).not.toContain('合成冒名一级类目');
    await control(source);
    expectNoCategory(await one(source, row(spoof)));
  },
);
