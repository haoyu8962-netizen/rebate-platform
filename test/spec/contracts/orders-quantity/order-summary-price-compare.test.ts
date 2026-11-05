import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// AC-CT-26p#n 是 CT-26p（D10-664 S-04，04 §6.4）验收点的本地分组，不新增业务 AC / BR。
// 依据：08 BR-TEXT-03「比价订单」行、BR-TEXT-12 细则「资金术语键」单列、BR-TEXT-13「比价」allow_keys、
// BR-TEXT-14 表 C；contracts/README 第 8 条（已有 /v1 结构只许新增可选字段）。
// 只静态读取契约与 specs；不调用接口、不执行生成代码、不读取数据库。
type Obj = Record<string, unknown>;
const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parse } = apiRequire('@readme/openapi-parser') as {
  parse(path: string): Promise<unknown>;
};

const TAG_KEY = 'order.tag.price_compare';

function object(value: unknown): Obj {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Obj;
}

function at(value: unknown, ...keys: string[]): Obj {
  let current = object(value);
  for (const key of keys) {
    expect(current, `缺少 ${keys.join('.')}`).toHaveProperty([key]);
    current = object(current[key]);
  }
  return current;
}

it('[AC-CT-26p#1] OrderSummary 新增可选的 is_price_compare（boolean | null，不进 required），列表示例取值合法，OrderDetail 照旧', async () => {
  const doc = await parse(fileURLToPath(new URL('contracts/openapi.yaml', root)));

  const summary = at(doc, 'components', 'schemas', 'OrderSummary');
  const summaryProperties = at(summary, 'properties');
  expect(summaryProperties, 'OrderSummary 缺少 is_price_compare').toHaveProperty([
    'is_price_compare',
  ]);
  const field = at(summaryProperties, 'is_price_compare');
  expect(field['type']).toEqual(['boolean', 'null']);
  // 可选字段：不进 required（contracts/README 第 8 条）。
  expect(Array.isArray(summary['required'])).toBe(true);
  expect(summary['required']).not.toContain('is_price_compare');

  // GET /v1/orders 200 示例：带了该字段的列表项，取值只能是布尔或 null。
  const example = at(
    doc,
    'paths',
    '/v1/orders',
    'get',
    'responses',
    '200',
    'content',
    'application/json',
    'example',
    'data',
  );
  const items = example['items'];
  expect(Array.isArray(items)).toBe(true);
  const invalid = (items as unknown[])
    .map(object)
    .filter((item) => Object.hasOwn(item, 'is_price_compare'))
    .map((item) => item['is_price_compare'])
    .filter((value) => value !== null && typeof value !== 'boolean');
  expect(invalid).toEqual([]);

  // OrderDetail.is_price_compare 不动：仍存在、仍为 boolean | null、仍必填。
  const detail = at(doc, 'components', 'schemas', 'OrderDetail');
  const detailField = at(detail, 'properties', 'is_price_compare');
  expect(detailField['type']).toEqual(['boolean', 'null']);
  expect(detail['required']).toContain('is_price_compare');
});

it('[AC-CT-26p#2] texts.default.json 有「比价订单」标识键 order.tag.price_compare（BR-TEXT-14 表 C / BR-TEXT-03）', () => {
  const texts = (
    JSON.parse(readFileSync(new URL('contracts/texts.default.json', root), 'utf8')) as {
      texts: Record<string, unknown>;
    }
  ).texts;
  expect(Object.hasOwn(texts, TAG_KEY), `texts.default.json 缺少 ${TAG_KEY}`).toBe(true);
  expect(texts[TAG_KEY]).toBe('比价订单');
});

it('[AC-CT-26p#3] fund-term-keys.yaml 把 order.tag.price_compare 单列为资金术语键，且不归普通（BR-TEXT-12 细则）', () => {
  const spec = parseYamlLite(readFileSync(new URL('specs/fund-term-keys.yaml', root), 'utf8')) as {
    fund_terms: { keys: string[]; prefixes: string[] };
    ordinary: { keys: string[]; prefixes: string[] };
  };
  expect(spec.fund_terms.keys).toContain(TAG_KEY);
  expect(spec.ordinary.keys).not.toContain(TAG_KEY);
  expect(spec.ordinary.prefixes.filter((prefix) => TAG_KEY.startsWith(prefix))).toEqual([]);
});

it('[AC-CT-26p#4] banned-words.yaml「比价」条目的 allow_keys 含 order.tag.price_compare（BR-TEXT-13）', () => {
  const words = (
    parseYamlLite(readFileSync(new URL('specs/banned-words.yaml', root), 'utf8')) as {
      words: { word: string; allow_keys?: string[] }[];
    }
  ).words;
  const entries = words.filter((entry) => entry.word === '比价');
  expect(entries).toHaveLength(1);
  expect(entries[0]!.allow_keys ?? []).toContain(TAG_KEY);
});
