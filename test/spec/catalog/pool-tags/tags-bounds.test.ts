// CT-07e (D10-1777 ①): two layers of bounds on the tags of adminAddPoolItem / adminUpdatePoolItem.
// The request body only declares the outer edge (at most 100 items of at most 256 characters, a cap
// on the request size); the real bounds are judged by the server after normalization: at most 10
// tags of 1–16 code points without control characters, any miss → 20001 data.fields=[tags], the
// whole field and not an index path like tags.9. A body of 9 valid tags plus one that is longer than
// 16 code points after normalization is inside the outer edge, so it reaches PoolAdmin, which refuses
// it, writes nothing and leaves the stored tags as they were.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  ACTOR,
  ADD,
  POOL_ID,
  expectFields,
  harness,
  storedItem,
  tagsOf,
  type AddBody,
  type UpdateBody,
} from './admin-kit.ts';
import { MAX_TAG_CODE_POINTS, TEN_TAGS, codePoints, modelTags } from './model.ts';

const KEY = 'tb:K1';
const STORED = ['原有', '标签'];

interface Document {
  components: { schemas: Record<string, JsonSchema> };
}

let loaded: Promise<Document> | undefined;
function contract(): Promise<Document> {
  loaded ??= (async () => {
    const root = new URL('../../../../', import.meta.url);
    const require = createRequire(new URL('apps/api/package.json', root));
    const parser = require('@readme/openapi-parser') as {
      dereference(path: string, options: object): Promise<Document>;
    };
    return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)), {
      resolve: { external: false },
    });
  })();
  return loaded;
}

async function validator(name: string) {
  const schema = (await contract()).components.schemas[name];
  expect(schema, name).toBeDefined();
  return createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
}

/** Tags that are long only after normalization, and one that is long as typed; both ≤ 256 chars. */
const LONG: readonly { label: string; tag: string }[] = [
  { label: 'NFKC 后 20 个码点（输入 5 个）', tag: '㍿'.repeat(5) },
  { label: '本身 17 个码点', tag: '中'.repeat(17) },
];

const NINE = TEN_TAGS.slice(0, 9);

const CASES = (['add', 'update'] as const).flatMap((op) =>
  LONG.map(({ label, tag }) => ({ op, label, tags: [...NINE, tag] })),
);

/** The case is what it says: 10 items, each ≤ 256 characters, the last one too long once normalized. */
function expectWellFormed(tags: readonly string[]) {
  expect(tags).toHaveLength(10);
  for (const tag of tags) expect(tag.length).toBeLessThanOrEqual(256);
  expect(codePoints(tags[9]!.normalize('NFKC').trim())).toBeGreaterThan(MAX_TAG_CODE_POINTS);
  expect(modelTags(tags), JSON.stringify(tags)).toBeNull();
  expect(modelTags(NINE)).toEqual(NINE);
}

it.each(CASES)(
  '[CT-07e][D10-1777] $op 请求体 tags = 9 个合法 + 1 个$label：在契约外沿之内，请求校验放行（真上限由服务端判）',
  async ({ op, tags }) => {
    expectWellFormed(tags);
    const validate = await validator(
      op === 'add' ? 'AdminPoolItemAddRequest' : 'AdminPoolItemUpdateRequest',
    );
    const body = op === 'add' ? { ...ADD, tags } : { tags };

    expect(validate(body), JSON.stringify(body)).toBe(true);
  },
);

it.each(CASES)(
  '[CT-07e][D10-1777] $op tags = 9 个合法 + 1 个$label → 20001 data.fields 恰为 [tags]（不是 tags.9），不写入，原有标签不变',
  async ({ op, tags }) => {
    expectWellFormed(tags);
    // The same call with the nine valid tags goes through and replaces the stored ones.
    const ok = harness(storedItem(STORED));
    const valid =
      op === 'add'
        ? await ok.admin.addItem(ACTOR, POOL_ID, { ...ADD, tags: [...NINE] } satisfies AddBody)
        : await ok.admin.updateItem(ACTOR, POOL_ID, KEY, { tags: [...NINE] } satisfies UpdateBody);
    expect(tagsOf(valid)).toEqual(NINE);
    expect(tagsOf(ok.written())).toEqual(NINE);

    const f = harness(storedItem(STORED));
    const run =
      op === 'add'
        ? f.admin.addItem(ACTOR, POOL_ID, { ...ADD, tags } satisfies AddBody)
        : f.admin.updateItem(ACTOR, POOL_ID, KEY, { tags } satisfies UpdateBody);

    await expectFields(run, ['tags']);

    expect(f.insertItem).not.toHaveBeenCalled();
    expect(f.updateItem).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
    const listed = await f.admin.listItems(ACTOR.appId, POOL_ID, {});
    expect(listed.items.map(tagsOf)).toEqual([STORED]);
  },
);
