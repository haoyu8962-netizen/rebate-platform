// CT-07e (D10-1777 ①): through the real console entry, a body whose tags are 9 valid ones plus one
// that is longer than 16 code points after normalization (10 items, each well under 256 characters,
// so inside the request body's outer edge) is 20001 with data.fields exactly [tags] — the whole
// field, not an index path like tags.9 from request validation — and nothing is written: the item
// keeps the tags it had. The same request with only the nine valid tags goes through.
import { expect, it } from 'vitest';
import {
  bounds,
  fields,
  linkOf,
  product,
  seedPool,
  send,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  useHarness,
  type Item,
} from '../product-pool-admin/kit.ts';
import { TIMEOUT, requireTags, storedTags } from './db-kit.ts';
import { TEN_TAGS, tagsOf } from './model.ts';

const h = useHarness();

const STORED = ['原有', '标签'];
const NINE = TEN_TAGS.slice(0, 9);

const CASES = (['add', 'update'] as const).flatMap((op) =>
  [
    { label: 'NFKC 后 20 个码点（输入 5 个）', tag: '㍿'.repeat(5) },
    { label: '本身 17 个码点', tag: '中'.repeat(17) },
  ].map(({ label, tag }) => ({ op, label, tags: [...NINE, tag] })),
);

it.each(CASES)(
  '[CT-07e][D10-1777] $op tags = 9 个合法 + 1 个$label → 20001 data.fields 恰为 [tags]，不写入，原有标签不变；只带 9 个合法的照常写入',
  async ({ op, tags }) => {
    await requireTags(h.db);
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const item = product(f, stableId());
    stubProduct(item);
    const add = (value: readonly string[]) =>
      send(f, 'addItem', { pool }, { link_text: linkOf(item.item_id!), ...bounds(), tags: value });
    const key = (await success<Item>(await add(STORED))).product_key;
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(STORED);
    f.clock.advanceMs(60_000);

    const write = (value: readonly string[]) =>
      op === 'add' ? add(value) : send(f, 'updateItem', { pool, key }, { tags: value });

    const before = await snapshot(h, f.appId);
    const refused = await write(tags);
    await fields(refused, ['tags']);
    expect(refused.response.json<{ data: { fields: string[] } }>().data.fields).toEqual(['tags']);
    expect(await snapshot(h, f.appId)).toEqual(before);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(STORED);

    expect(tagsOf(await success<Item>(await write(NINE)))).toEqual(NINE);
    expect(await storedTags(h.db, f.appId, pool, key)).toEqual(NINE);
  },
  TIMEOUT,
);
