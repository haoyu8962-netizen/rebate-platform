// CT-07e (D10-1758 / D10-1765): the contract of the console's pool items (contracts/openapi.yaml).
// AdminPoolItem always carries `tags` (string array, may be empty, at most 10 items of 1–16 code
// points); adminAddPoolItem and adminUpdatePoolItem take an optional `tags`; adminListPoolItems
// takes an optional single query parameter `tag`. Checked through the platform's own request
// validator compiled from the dereferenced document, so the shape is what the routes enforce.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createValidatorCompiler,
  type ContractParameter,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { ELEVEN_TAGS, TEN_TAGS } from './model.ts';

const ITEMS_PATH = '/admin/v1/product-pools/{pool_id}/items';

interface Document {
  paths: Record<string, Record<string, { operationId: string; parameters?: ContractParameter[] }>>;
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
  const doc = await contract();
  const schema = doc.components.schemas[name];
  expect(schema, name).toBeDefined();
  return createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
}

/** An AdminPoolItem in the shape of the contract's own example, with these tags. */
function item(tags?: unknown): Record<string, unknown> {
  return {
    product_key: 'tb:7Kq9LmN3pQ',
    platform: 'taobao',
    title: '合成商品',
    image: null,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    quoted_at: '2026-10-22T10:00:00+08:00',
    status: 'online',
    sort: 10,
    start_at: null,
    end_at: null,
    invalid_reason: null,
    created_by: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b05',
    created_at: '2026-10-20T10:00:00+08:00',
    updated_at: '2026-10-22T10:00:00+08:00',
    ...(tags === undefined ? {} : { tags }),
  };
}

it('[CT-07e][D10-1758] AdminPoolItem 必带 tags：字符串数组，可为 []，最多 10 项，每项 1–16 个码点', async () => {
  const doc = await contract();
  const schema = doc.components.schemas['AdminPoolItem'] as { required?: string[] };
  expect(schema.required).toContain('tags');
  const validate = await validator('AdminPoolItem');

  for (const tags of [[], ['新品'], [...TEN_TAGS], ['𠀀'.repeat(16)], ['AB', 'ab', '618 大促']]) {
    expect(validate(item(tags)), JSON.stringify(tags)).toBe(true);
  }
  for (const tags of [undefined, null, '新品', [...ELEVEN_TAGS], ['中'.repeat(17)], [''], [1]]) {
    expect(validate(item(tags)), JSON.stringify(tags ?? 'absent')).toBe(false);
  }
});

it('[CT-07e][D10-1758] adminAddPoolItem 请求体 tags 可选：不带、[]、带值都合法', async () => {
  const validate = await validator('AdminPoolItemAddRequest');
  const base = {
    link_text: 'https://demo.invalid/taobao/raw-1',
    sort: 0,
    start_at: null,
    end_at: null,
  };

  expect(validate(base)).toBe(true);
  expect(validate({ ...base, tags: [] })).toBe(true);
  expect(validate({ ...base, tags: ['新品', ' 爆款 '] })).toBe(true);
  expect(validate({ ...base, tags: '新品' })).toBe(false);
});

it('[CT-07e][D10-1758] adminUpdatePoolItem 请求体 tags 可选，只带 tags（含 []）也是一次合法的编辑', async () => {
  const validate = await validator('AdminPoolItemUpdateRequest');

  expect(validate({ sort: 1 })).toBe(true);
  expect(validate({ tags: [] })).toBe(true);
  expect(validate({ tags: ['新品'] })).toBe(true);
  expect(validate({ sort: 1, tags: ['新品'] })).toBe(true);
  expect(validate({ tags: '新品' })).toBe(false);
});

it('[CT-07e][D10-1765] adminListPoolItems 有可选的查询参数 tag（单个字符串），其余参数不变', async () => {
  const doc = await contract();
  const operation = doc.paths[ITEMS_PATH]?.['get'];
  expect(operation?.operationId).toBe('adminListPoolItems');
  const parameters = operation?.parameters ?? [];
  const tag = parameters.filter((parameter) => parameter.name === 'tag');
  expect(tag).toHaveLength(1);
  expect(tag[0]).toMatchObject({ in: 'query' });
  expect(tag[0]?.required ?? false).toBe(false);
  expect(tag[0]?.schema).toMatchObject({ type: 'string' });
  expect(parameters.filter((p) => p.in === 'query').map((p) => p.name)).toEqual(
    expect.arrayContaining(['status', 'page', 'page_size', 'tag']),
  );
});
