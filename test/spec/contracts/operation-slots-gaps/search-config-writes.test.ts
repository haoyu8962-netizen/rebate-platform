// CT-27b · 运营位批 1 契约伴随规则测试 ⑥（FU-CT-27-SPEC-R3-GAPS；编排 D10-2401 ⑥、D10-2410）。
// 规则：04 §6.3 `GET /v1/search/hot-words` 行 2026-11-20（后台补热词与直达的编辑页，读写仍是 search.hot_words、
// search.keyword_routes 两个配置项）、01 F-PROD-16（搜索框默认词 search.default_word）、08 BR-TEXT-28 细则
// 「权限与日志」。D10-2401 ⑥：共用操作的 key 必填且与列表类型 oneOf 绑定，不设「可选 key」这种可错配的形状；
// 契约定稿（D10-2410，be 补充「契约定稿的形状」）是三个各自封闭请求体的独立 PUT（adminUpdateSearchHotWords /
// adminUpdateSearchKeywordRoutes / adminUpdateSearchDefaultWord），请求体里没有配置键，操作本身定了写哪一项。
// 本文件钉住两点：三个操作的请求体都封闭、没有配置键一类的字段（可选的也不行）；一项的请求体塞另一项的
// 值（换属性、同时带、或把另一项的值写进本项）一律拒收。
// 本文件自带辅助函数，不导入 test/spec/contracts/operation-slots/ 下已冻结的文件（be 补充）。
// 全部静态读 contracts/openapi.yaml：不连库、不 listen、不联网。
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

type Obj = Record<string, unknown>;

interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}

interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): ValidateFn;
}

interface Operation {
  path: string;
  method: string;
  op: Obj;
}

interface ConfigItem {
  operationId: string;
  configKey: string;
  prop: string;
  value: unknown;
}

const root = new URL('../../../../', import.meta.url);
const testRequire = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { parseYamlLite } = testRequire('../../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;

// ---------------------------------------------------------------------------------------------
// 规则常量（独立预期）

const SIGN_IN = { route: 'Help', params: { article_id: 'sign_in_guide' } };
/** 缺口原文的热词值：[{text: '洗衣液'}]。 */
const HOT_LIST = [{ text: '洗衣液' }];
const ROUTE_LIST = [{ keyword: '签到', target: SIGN_IN }];
const DEFAULT_WORD = '洗衣液';

/** 三个搜索配置项与写它们的操作（D10-2410）。 */
const ITEMS: ConfigItem[] = [
  {
    operationId: 'adminUpdateSearchHotWords',
    configKey: 'search.hot_words',
    prop: 'hot_words',
    value: HOT_LIST,
  },
  {
    operationId: 'adminUpdateSearchKeywordRoutes',
    configKey: 'search.keyword_routes',
    prop: 'keyword_routes',
    value: ROUTE_LIST,
  },
  {
    operationId: 'adminUpdateSearchDefaultWord',
    configKey: 'search.default_word',
    prop: 'default_word',
    value: DEFAULT_WORD,
  },
];

const VALUE_PROPS = ITEMS.map((item) => item.prop);
const CONFIG_KEYS = ITEMS.map((item) => item.configKey);
/** 「配置键」一类的字段名：key、config_key、item、setting_id 等（keyword_routes 不算）。 */
const KEY_LIKE = /(^|_)(key|config|item|setting)(_?(name|id))?$/i;
/** 往请求体里塞配置键时试的字段名。 */
const KEY_FIELDS = ['key', 'config_key', 'item_key', 'item'];

// ---------------------------------------------------------------------------------------------
// 读文件与 Ajv

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown, label = '值'): Obj {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Obj;
}

function text(value: unknown, label = '值'): string {
  expect(typeof value, `${label} 必须是字符串`).toBe('string');
  return value as string;
}

function at(value: unknown, ...keys: string[]): Obj {
  let node = object(value);
  for (const [i, key] of keys.entries()) {
    const label = keys.slice(0, i + 1).join('.');
    expect(Object.hasOwn(node, key), `缺少 ${label}`).toBe(true);
    node = object(node[key], label);
  }
  return node;
}

function check(ok: boolean, valid: boolean, label: string): void {
  expect(ok, `${label}：期望${valid ? '通过' : '被拒'}`).toBe(valid);
}

let openapiCache: Obj | undefined;
function openapi(): Obj {
  if (openapiCache === undefined) {
    const file = new URL('contracts/openapi.yaml', root);
    expect(existsSync(file), '缺少 contracts/openapi.yaml').toBe(true);
    openapiCache = object(parseYamlLite(readFileSync(file, 'utf8')), 'openapi.yaml');
  }
  return openapiCache;
}

function newAjv(): AjvInstance {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (v) => Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv;
}

function compileStrict(schema: Obj): ValidateFn {
  let validate: ValidateFn | undefined;
  expect(() => {
    validate = newAjv().compile(schema);
  }, 'Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate as ValidateFn;
}

function resolve(doc: Obj, value: unknown): Obj {
  let node = object(value);
  const seen = new Set<string>();
  while (node['$ref'] !== undefined) {
    const ref = text(node['$ref'], '$ref');
    expect(ref.startsWith('#/'), `只解析本文件内的引用：${ref}`).toBe(true);
    expect(seen.has(ref), `循环引用 ${ref}`).toBe(false);
    seen.add(ref);
    const { $ref: ignored, ...siblings } = node;
    void ignored;
    node = {
      ...at(
        doc,
        ...ref
          .slice(2)
          .split('/')
          .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~')),
      ),
      ...siblings,
    };
  }
  return node;
}

function expand(doc: Obj, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(doc, entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(resolve(doc, value)).map(([key, child]) => [key, expand(doc, child)]),
  );
}

function compileOpenapi(doc: Obj, schema: unknown): ValidateFn {
  return compileStrict(object(expand(doc, schema)));
}

// ---------------------------------------------------------------------------------------------
// 操作与请求体

function label({ method, path }: Operation): string {
  return `${method.toUpperCase()} ${path}`;
}

/** 按 operationId 找操作（恰一个）。 */
function operation(doc: Obj, operationId: string): Operation {
  const found: Operation[] = [];
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    if (!isObj(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (isObj(op) && op['operationId'] === operationId) found.push({ path, method, op });
    }
  }
  expect(found.map(label), `operationId=${operationId} 的操作`).toHaveLength(1);
  return found[0] as Operation;
}

/** /admin/v1 下的写操作（POST / PUT / PATCH）。 */
function adminWrites(doc: Obj): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    if (!path.startsWith('/admin/v1/') || !isObj(item)) continue;
    for (const method of ['post', 'put', 'patch']) {
      const op = item[method];
      if (isObj(op)) out.push({ path, method, op });
    }
  }
  return out;
}

/** JSON 请求体的 schema（已解析引用）；没有 JSON 请求体时为 undefined。 */
function jsonRequestSchema(doc: Obj, op: Obj): Obj | undefined {
  if (op['requestBody'] === undefined) return undefined;
  const content = resolve(doc, op['requestBody'])['content'];
  if (!isObj(content)) return undefined;
  const media = content['application/json'];
  if (!isObj(media) || media['schema'] === undefined) return undefined;
  return resolve(doc, media['schema']);
}

function requestSchema(doc: Obj, op: Obj): Obj {
  const schema = jsonRequestSchema(doc, op);
  expect(schema, `${String(op['operationId'])} 的 JSON 请求体 schema`).toBeDefined();
  return schema as Obj;
}

/** 请求体顶层能出现的属性名（含 allOf / anyOf / oneOf 各分支的顶层属性）。 */
function topProps(doc: Obj, schema: Obj): string[] {
  const names: string[] = [];
  if (isObj(schema['properties'])) names.push(...Object.keys(schema['properties']));
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) names.push(...topProps(doc, resolve(doc, branch)));
  }
  return [...new Set(names)].sort();
}

/** 请求示例（example 与 examples 的每个 value）。 */
function requestExamples(doc: Obj, op: Obj): unknown[] {
  const content = resolve(doc, op['requestBody'])['content'];
  if (!isObj(content) || !isObj(content['application/json'])) return [];
  const media = content['application/json'];
  const out: unknown[] = [];
  if (Object.hasOwn(media, 'example')) out.push(clone(media['example']));
  if (isObj(media['examples'])) {
    for (const entry of Object.values(media['examples'])) {
      const example = resolve(doc, entry);
      if (Object.hasOwn(example, 'value')) out.push(clone(example['value']));
    }
  }
  return out;
}

function without(value: Obj, key: string): Obj {
  const next = { ...value };
  delete next[key];
  return next;
}

// ---------------------------------------------------------------------------------------------
// 用例

it('[AC-CT-27b#9] 搜索三个配置项各由一个独立的 PUT 写：/admin/v1 下、说明点名它写的配置项、本项的值必填；请求体封闭（additionalProperties false），只带本项的值，没有 key / config_key 一类的配置键（可选的也不行）；后台写操作里请求体带这三个值的恰是这三个操作', () => {
  // D10-2401 ⑥：不设「可选 key」这种可错配的形状；D10-2410：三个各自封闭请求体的独立 PUT，没有 key 字段。
  const doc = openapi();
  for (const item of ITEMS) {
    const { path, method, op } = operation(doc, item.operationId);
    const name = `${item.operationId}（${method.toUpperCase()} ${path}）`;
    expect(path.startsWith('/admin/v1/'), `${name} 在 /admin/v1 下`).toBe(true);
    expect(method, `${name} 是整项替换的 PUT`).toBe('put');
    const description = text(op['description'], `${name} description`);
    expect(description, `${name} 点名配置项`).toContain(item.configKey);
    const schema = requestSchema(doc, op);
    expect(schema['additionalProperties'], `${name} 请求体封闭`).toBe(false);
    const props = topProps(doc, schema);
    const values = props.filter((prop) => VALUE_PROPS.includes(prop));
    expect(values, `${name} 请求体只带本项的值`).toEqual([item.prop]);
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    expect(required, `${name} 本项的值必填`).toContain(item.prop);
    const keyLike = props.filter((prop) => KEY_LIKE.test(prop));
    expect(keyLike, `${name} 请求体没有配置键一类的字段`).toEqual([]);
  }
  // 不能另有一个「共用」写操作（如带可选 key 的通用搜索配置接口）也收这三个值。
  const writers: string[] = [];
  for (const { op } of adminWrites(doc)) {
    const schema = jsonRequestSchema(doc, op);
    if (schema === undefined) continue;
    const id = String(op['operationId']);
    if (topProps(doc, schema).some((prop) => VALUE_PROPS.includes(prop))) writers.push(id);
  }
  const expected = ITEMS.map((item) => item.operationId).sort();
  expect(writers.sort(), '请求体带搜索配置值的后台写操作').toEqual(expected);
});

it('[AC-CT-27b#10] 搜索配置写接口的请求体与配置项绑死：各自的示例与本项的合法值通过；加 key / config_key / item 等配置键（不论写哪一项，含缺口原文的 {hot_words:[{text:洗衣液}], key:search.keyword_routes}）、把本项换成另一项的属性、同时带另一项、把另一项的值写进本项，都拒收', () => {
  // D10-2401 ⑥：运营提交 {hot_words:[{text:'洗衣液'}], key:'search.keyword_routes'} 时契约必须拒收，否则按显式
  // 键保存就会把热词值写到直达配置；热词体塞关键词路由列表会被拒，反之亦然（be 补充）。
  const doc = openapi();
  for (const item of ITEMS) {
    const id = item.operationId;
    const { op } = operation(doc, id);
    const validate = compileOpenapi(doc, requestSchema(doc, op));
    const examples = requestExamples(doc, op);
    expect(examples.length, `${id} 有请求示例`).toBeGreaterThan(0);
    for (const [n, example] of examples.entries()) {
      const where = `${id} 示例 #${n}`;
      check(validate(example), true, `${where} 原样`);
      const base = { ...object(example, where), [item.prop]: clone(item.value) };
      check(validate(base), true, `${where} 的 ${item.prop}=${JSON.stringify(item.value)}`);
      for (const field of KEY_FIELDS) {
        for (const configKey of CONFIG_KEYS) {
          const body = { ...base, [field]: configKey };
          check(validate(body), false, `${where} 加 ${field}=${configKey}`);
        }
      }
      for (const other of ITEMS) {
        if (other.prop === item.prop) continue;
        const value = clone(other.value);
        const swapped = { ...without(base, item.prop), [other.prop]: value };
        check(validate(swapped), false, `${where} 改带 ${other.prop}`);
        const both = { ...base, [other.prop]: value };
        check(validate(both), false, `${where} 同时带 ${other.prop}`);
        const misfiled = { ...base, [item.prop]: value };
        check(validate(misfiled), false, `${where} 的 ${item.prop} 写 ${other.prop} 的值`);
      }
    }
  }
});
