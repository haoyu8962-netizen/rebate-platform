// CT-27 运营位批 1 的契约规则测试（BR-TEXT-28～30，SPEC_REF 3eafae406a6b；编排 D10-2317 ④ / D10-2361）。
// 独立预期只来自 08 BR-TEXT-28～30 细则、04 §6.2「运营位」、§6.3 `GET /v1/search/hot-words`、§6.6 `pages`、
// §10.1 表后「跳转目标」与 03 §6.3 卡片注册表；不从被测契约推导期望值。
// 全部静态读 contracts/、specs/ 与生成物：不连库、不 listen、不联网。
//
// 命名口径：04 只给了建议名。`page_key` 的 `me` / `search`、section id `more_services`、起止时刻
// `start_at` / `end_at`、条目徽标 `badge` 与徽标三种取值 none / dot / text 是 04 §6.2 写出的建议名，按它钉；
// 徽标里「类型」「文字」「到期时刻」三个键与 icon_grid 的列数键 04 / 08 没有定名，不钉字面名字，
// 改为在 home-schema.json 里找满足该语义的字段（找不到即断言失败）。
//
// 样例来源：schema 规则的正例取自实现方的 golden（contracts/fixtures/home-golden/ 下 page_key 为 me、search
// 的样例与现有首页样例），反例在正例上只改一处，这样实现方给条目加了必填键（如名称）也不会让本测试误红；
// golden 不存在时在断言上红，不让 ENOENT 冒充先红。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect } from 'vitest';

export type Obj = Record<string, unknown>;
export interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}
interface AjvInstance {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): ValidateFn;
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

/** 08 BR-TEXT-28 准入表：批 1 新增的两个 page_key。 */
export const ME = 'me';
export const SEARCH = 'search';
/** 08 BR-TEXT-28：`me` 只许一个 `icon_grid`，section id 为 `more_services`。 */
export const MORE_SERVICES = 'more_services';
/** 08 BR-TEXT-28：`search` 的结果页置顶位是 `banner` 或接商品池的 `product_scroll`（以契约为准）。 */
export const SEARCH_ADMITTED = ['banner', 'product_scroll'] as const;
/** 03 §6.3 已注册的 8 个类型。 */
export const REGISTERED = [
  'banner',
  'icon_grid',
  'product_scroll',
  'product_grid',
  'activity_entry',
  'notice_bar',
  'feed_infinite',
  'popup',
] as const;
/** 批 2 的建议名（08 BR-TEXT-28 细则「分批」）：本批任何准入表都不收。 */
export const BATCH2_TYPES = ['float_button', 'splash'] as const;
/** 08 BR-TEXT-29：徽标只有三种。 */
export const BADGE_KINDS = ['none', 'dot', 'text'] as const;
/** 03 §6.3 `icon_grid`：列数 4 / 5。 */
export const ICON_GRID_COLUMNS = [4, 5] as const;
/**
 * golden「过期条目」的参照时刻：本单入账日（2026-11-21，+08:00，BR-TEXT-11）。golden 里的过期条目
 * `end_at` 必须早于它，客户端按本机时间再过滤（BR-TEXT-29）。
 */
export const GOLDEN_REFERENCE_NOW = '2026-11-21T00:00:00+08:00';

/** 契约既有的时刻格式（ISO 8601 带时区，BR-TEXT-11；同 notice_item 的 date-time）。 */
export const GOOD_INSTANTS = [
  '2026-11-11T00:00:00+08:00',
  '2026-11-12T00:00:00+08:00',
  '2026-11-30T23:59:59+08:00',
];
export const BAD_INSTANTS: unknown[] = [
  '2026-11-11',
  '2026-11-11T00:00:00',
  '2026-11-31T00:00:00+08:00',
  '11-12 00:00',
  'tomorrow',
  '',
  20261111,
];

/** BR-TEXT-30 允许的站内跳转（routes.json 已登记、entry 含 in_app，不是 ExternalPage）。 */
export const IN_APP_TARGET: Obj = { route: 'Help', params: { article_id: 'sign_in_guide' } };
/** BR-TEXT-30 ②：WebPage 打开的站内 H5（https；白名单 bridge_origins 是运行时配置，schema 只管 https）。 */
export const WEBPAGE_TARGET: Obj = {
  route: 'WebPage',
  params: { url: 'https://h5.example.com/topic/double11' },
};
/** BR-TEXT-30：外部链接。 */
export const EXTERNAL_TARGET: Obj = {
  route: 'ExternalPage',
  params: { url: 'https://example.com/activity/autumn' },
};

// ---------------------------------------------------------------------------------------------
// 读文件

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function read(path: string): string {
  const file = new URL(path, root);
  expect(existsSync(file), `缺少文件 ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

export function object(value: unknown, label = '值'): Obj {
  expect(value, `${label} 不能为 null`).not.toBeNull();
  expect(typeof value, `${label} 必须是对象`).toBe('object');
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as Obj;
}

export function list(value: unknown, label = '值'): unknown[] {
  expect(Array.isArray(value), `${label} 必须是数组`).toBe(true);
  return value as unknown[];
}

export function text(value: unknown, label = '值'): string {
  expect(typeof value, `${label} 必须是字符串`).toBe('string');
  return value as string;
}

export function at(value: unknown, ...keys: string[]): Obj {
  let node = object(value);
  for (const [i, key] of keys.entries()) {
    const label = keys.slice(0, i + 1).join('.');
    expect(Object.hasOwn(node, key), `缺少 ${label}`).toBe(true);
    node = object(node[key], label);
  }
  return node;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

let schemaCache: Obj | undefined;
export function homeSchema(): Obj {
  schemaCache ??= object(JSON.parse(read('contracts/home-schema.json')), 'home-schema.json');
  return schemaCache;
}

let routesCache: Obj | undefined;
export function routes(): Obj {
  routesCache ??= at(JSON.parse(read('contracts/routes.json')), 'routes');
  return routesCache;
}

let openapiCache: Obj | undefined;
export function openapi(): Obj {
  openapiCache ??= object(parseYamlLite(read('contracts/openapi.yaml')), 'openapi.yaml');
  return openapiCache;
}

export function permissionKeys(): string[] {
  const doc = object(parseYamlLite(read('specs/permissions.yaml')), 'specs/permissions.yaml');
  return list(doc['permissions'], 'permissions').map((entry) =>
    text(object(entry)['key'], 'permissions[].key'),
  );
}

// ---------------------------------------------------------------------------------------------
// Ajv

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

export function compileStrict(schema: Obj): ValidateFn {
  let validate: ValidateFn | undefined;
  expect(() => {
    validate = newAjv().compile(schema);
  }, 'Ajv2020 strict 编译').not.toThrow();
  expect(validate).toBeTypeOf('function');
  return validate as ValidateFn;
}

let pageValidatorCache: ValidateFn | undefined;
/** home-schema.json 根（一整页）的校验函数。 */
export function pageValidator(): ValidateFn {
  pageValidatorCache ??= compileStrict(homeSchema());
  return pageValidatorCache;
}

export function isValidPage(page: unknown): boolean {
  return pageValidator()(page);
}

export function expectPage(page: unknown, valid: boolean, label: string): void {
  const validate = pageValidator();
  const ok = validate(page);
  expect(
    ok,
    `${label}：期望${valid ? '通过' : '被拒'}；errors=${JSON.stringify(validate.errors ?? null)}`,
  ).toBe(valid);
}

// ---------------------------------------------------------------------------------------------
// golden 样例

export const GOLDEN_DIR = 'contracts/fixtures/home-golden/';
export const INVALID_DIR = 'contracts/fixtures/home-golden/invalid/';

export type Golden = { name: string; page: Obj };

function jsonIn(dir: string): Golden[] {
  const url = new URL(dir, root);
  expect(existsSync(url), `缺少目录 ${dir}`).toBe(true);
  return readdirSync(url)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name: `${dir}${name}`,
      page: object(JSON.parse(read(`${dir}${name}`)), `${dir}${name}`),
    }));
}

export function validGoldens(): Golden[] {
  return jsonIn(GOLDEN_DIR);
}

export function invalidGoldens(): Golden[] {
  return jsonIn(INVALID_DIR);
}

export function sectionsOf(page: Obj): Obj[] {
  return list(page['sections'], 'sections').map((s) => object(s, 'section'));
}

/** section 的 static 数据源条目（没有时为空数组）。 */
export function itemsOf(section: Obj): Obj[] {
  const source = section['data_source'];
  if (!isObj(source) || !Array.isArray(source['items'])) return [];
  return source['items'].filter(isObj);
}

/** 一页里所有 static 数据源条目的 action（跳转目标）。 */
export function actionsOf(page: Obj): Obj[] {
  return sectionsOf(page)
    .flatMap(itemsOf)
    .map((item) => item['action'])
    .filter(isObj);
}

/** golden 里第一页 page_key=me、含 more_services icon_grid 且至少一个条目的页面（副本）。 */
export function meBase(): Obj {
  const found = validGoldens().find(
    ({ page }) =>
      page['page_key'] === ME &&
      sectionsOf(page).some(
        (s) => s['type'] === 'icon_grid' && s['id'] === MORE_SERVICES && itemsOf(s).length > 0,
      ),
  );
  expect(found, `${GOLDEN_DIR} 下没有 page_key=me、含 more_services 条目的 golden`).toBeDefined();
  const base = clone((found as Golden).page);
  expectPage(base, true, `${(found as Golden).name}（me golden）`);
  return base;
}

/** meBase 的 more_services section。 */
export function moreServices(page: Obj): Obj {
  const section = sectionsOf(page).find((s) => s['id'] === MORE_SERVICES);
  expect(section, 'me 页的 more_services').toBeDefined();
  return section as Obj;
}

/** meBase 的第一个条目（可直接改）。 */
export function firstItem(section: Obj): Obj {
  const items = itemsOf(section);
  expect(items.length, `${String(section['id'])} 至少一个条目`).toBeGreaterThan(0);
  return items[0] as Obj;
}

/** golden 里第一页 page_key=search 且至少一个 section 的页面（副本）。 */
export function searchBase(): Obj {
  const found = validGoldens().find(
    ({ page }) => page['page_key'] === SEARCH && sectionsOf(page).length > 0,
  );
  expect(found, `${GOLDEN_DIR} 下没有 page_key=search、带置顶位的 golden`).toBeDefined();
  const base = clone((found as Golden).page);
  expectPage(base, true, `${(found as Golden).name}（search golden）`);
  return base;
}

/** 现有首页 golden 里第一个该类型的 section（副本，跳转换成站内路由，避免把 BR-TEXT-30 混进准入判断）。 */
export function homeSection(type: string): Obj {
  const section = validGoldens()
    .filter(({ page }) => page['page_key'] === 'home')
    .flatMap(({ page }) => sectionsOf(page))
    .find((s) => s['type'] === type);
  expect(section, `${GOLDEN_DIR} 的首页 golden 里没有 ${type} section`).toBeDefined();
  return inAppOnly(clone(section as Obj));
}

export function inAppOnly(section: Obj): Obj {
  for (const item of itemsOf(section)) {
    if (isObj(item['action']) && item['action']['route'] === 'ExternalPage') {
      item['action'] = clone(IN_APP_TARGET);
    }
  }
  return section;
}

export function page(pageKey: string, sections: Obj[]): Obj {
  return { page_key: pageKey, version: 1, ttl_sec: 300, sections };
}

/** 一个准入表外的批 2 类型 section（信封合法）。 */
export function batch2Section(type: string, id: string): Obj {
  return {
    id,
    type,
    version: 1,
    props: { image: 'https://example.com/img/float.png' },
    data_source: { kind: 'static', items: [{ action: clone(IN_APP_TARGET) }] },
  };
}

// ---------------------------------------------------------------------------------------------
// 在 home-schema.json 里按语义找字段（04 / 08 没定名的键）

function pointer(doc: Obj, ref: string): unknown {
  let node: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObj(node)) return undefined;
    node = node[key];
  }
  return node;
}

function deref(node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isObj(current) && typeof current['$ref'] === 'string') {
    const ref = String(current['$ref']);
    if (!ref.startsWith('#/') || seen.has(ref)) return undefined;
    seen.add(ref);
    current = pointer(homeSchema(), ref);
  }
  return current;
}

const BRANCHES = ['allOf', 'anyOf', 'oneOf'] as const;
const CONDITIONALS = ['if', 'then', 'else'] as const;

/** 从一个子 schema 出发、经 $ref 与组合关键字能到的全部 properties 表。 */
function propertyMaps(schema: unknown, seen = new Set<unknown>()): Obj[] {
  const node = deref(schema);
  if (!isObj(node) || seen.has(node)) return [];
  seen.add(node);
  const out: Obj[] = [];
  if (isObj(node['properties'])) out.push(node['properties']);
  for (const key of BRANCHES) {
    const branches = node[key];
    if (Array.isArray(branches)) for (const b of branches) out.push(...propertyMaps(b, seen));
  }
  for (const key of CONDITIONALS) {
    if (node[key] !== undefined) out.push(...propertyMaps(node[key], seen));
  }
  return out;
}

/** 子 schema（含 anyOf / oneOf / allOf 分支）上的某个关键字取值。 */
function keywordValues(schema: unknown, keyword: string, seen = new Set<unknown>()): unknown[] {
  const node = deref(schema);
  if (!isObj(node) || seen.has(node)) return [];
  seen.add(node);
  const out: unknown[] = [];
  if (node[keyword] !== undefined) out.push(node[keyword]);
  for (const key of BRANCHES) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      for (const b of branches) out.push(...keywordValues(b, keyword, seen));
    }
  }
  return out;
}

function constValues(schema: unknown): unknown[] {
  return [
    ...keywordValues(schema, 'enum').flatMap((v) => (Array.isArray(v) ? v : [])),
    ...keywordValues(schema, 'const'),
  ];
}

/** 遍历整份 schema 的每个对象节点。 */
function walk(node: unknown, visit: (value: Obj) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isObj(node)) return;
  visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}

export type BadgeKeys = { kind: string; text: string; expiry: string };

/**
 * 条目徽标 `badge`（04 §6.2 ③ 建议名）里三个没定名的键：取值恰为 none / dot / text 的「类型」键、
 * 最长 2 个字的「文字」键（08 BR-TEXT-29）、date-time 格式的「到期时刻」键。
 */
export function badgeKeys(): BadgeKeys {
  const badgeSchemas: unknown[] = [];
  walk(homeSchema(), (node) => {
    const props = node['properties'];
    if (isObj(props) && props['badge'] !== undefined) badgeSchemas.push(props['badge']);
  });
  expect(badgeSchemas.length, 'home-schema.json 里找不到条目的 badge 定义').toBeGreaterThan(0);
  const maps = badgeSchemas.flatMap((s) => propertyMaps(s));
  const names = [...new Set(maps.flatMap((m) => Object.keys(m)))].sort();
  const defsOf = (name: string): unknown[] =>
    maps.map((m) => m[name]).filter((d) => d !== undefined);
  const kind = names.find((name) => {
    const values = new Set(defsOf(name).flatMap(constValues));
    return values.size === BADGE_KINDS.length && BADGE_KINDS.every((v) => values.has(v));
  });
  const textKey = names.find((name) =>
    defsOf(name).some((d) => keywordValues(d, 'maxLength').includes(2)),
  );
  const expiry = names.find((name) =>
    defsOf(name).some((d) => keywordValues(d, 'format').includes('date-time')),
  );
  expect(kind, 'badge 里取值恰为 none / dot / text 的类型键').toBeDefined();
  expect(textKey, 'badge 里最长 2 个字的文字键（maxLength 2）').toBeDefined();
  expect(expiry, 'badge 里 date-time 格式的到期时刻键').toBeDefined();
  return { kind: kind as string, text: textKey as string, expiry: expiry as string };
}

/** icon_grid 的列数键（03 §6.3「列数（4/5）」；04 未定名）：取值恰为 4、5 的整数属性。 */
export function columnsKey(): string {
  const names = new Set<string>();
  walk(homeSchema(), (node) => {
    const props = node['properties'];
    if (!isObj(props)) return;
    for (const [name, def] of Object.entries(props)) {
      const values = constValues(def)
        .filter((v): v is number => typeof v === 'number')
        .sort((a, b) => a - b);
      const resolved = deref(def);
      const ranged =
        isObj(resolved) &&
        resolved['type'] === 'integer' &&
        resolved['minimum'] === 4 &&
        resolved['maximum'] === 5;
      if (JSON.stringify(values) === JSON.stringify([...ICON_GRID_COLUMNS]) || ranged) {
        names.add(name);
      }
    }
  });
  expect([...names], 'home-schema.json 里取值为 4 / 5 的 icon_grid 列数键（恰一个）').toHaveLength(
    1,
  );
  return [...names][0] as string;
}

/** 一个徽标对象。 */
export function badge(keys: BadgeKeys, kind: string, extra: Obj = {}): Obj {
  return { [keys.kind]: kind, ...extra };
}

// ---------------------------------------------------------------------------------------------
// openapi

export function resolve(doc: Obj, value: unknown): Obj {
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

export function expand(doc: Obj, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => expand(doc, entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(resolve(doc, value)).map(([key, child]) => [key, expand(doc, child)]),
  );
}

export function compileOpenapi(doc: Obj, schema: unknown): ValidateFn {
  return compileStrict(object(expand(doc, schema)));
}

export type Operation = { path: string; method: string; op: Obj };

const WRITE_METHODS = ['post', 'put', 'patch'];

/** /admin/v1 下的写操作。 */
export function adminWrites(doc: Obj): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    if (!path.startsWith('/admin/v1/') || !isObj(item)) continue;
    for (const method of WRITE_METHODS) {
      const op = item[method];
      if (isObj(op)) out.push({ path, method, op });
    }
  }
  return out;
}

/** 请求体里出现的全部属性名（经 $ref，每个引用只走一次，循环引用不会死循环）。 */
function requestPropertyNames(doc: Obj, op: Obj): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isObj(node)) return;
    const ref = node['$ref'];
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/') || seen.has(ref)) return;
      seen.add(ref);
      visit(pointer(doc, ref));
      return;
    }
    const props = node['properties'];
    if (isObj(props)) names.push(...Object.keys(props));
    for (const child of Object.values(node)) visit(child);
  };
  visit(op['requestBody']);
  return names;
}

/**
 * 与某个概念相关的后台写操作：路径或 operationId 命中，或（路径、operationId 与搜索相关时）请求体里
 * 有命中的属性名。不钉路径与 operationId（04 只写「后台补一个编辑页、读写仍是这两个配置项」）。
 */
export function adminWritesAbout(doc: Obj, concept: RegExp): Operation[] {
  return adminWrites(doc).filter(({ path, op }) => {
    const id = typeof op['operationId'] === 'string' ? op['operationId'] : '';
    if (concept.test(path) || concept.test(id)) return true;
    if (!/search|hot|keyword/i.test(`${path} ${id}`)) return false;
    return requestPropertyNames(doc, op).some((name) => concept.test(name));
  });
}

export const HOT_WORDS = /hot[-_]?words?/i;
export const KEYWORD_ROUTES = /keyword/i;

export function response200Data(doc: Obj, path: string, method: string): Obj {
  const op = at(doc, 'paths', path, method);
  const response = resolve(doc, at(op, 'responses', '200'));
  const schema = resolve(doc, at(response, 'content', 'application/json', 'schema'));
  return resolve(doc, at(schema, 'properties', 'data'));
}

export type Field = { where: string; name: string; schema: Obj; required: boolean };

function fieldsOf(doc: Obj, where: string, schema: Obj): Field[] {
  const props = isObj(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.entries(props).map(([name, def]) => ({
    where,
    name,
    schema: resolve(doc, def),
    required: required.includes(name),
  }));
}

/**
 * 搜索框默认词字段的候选（01 F-PROD-16：随热词接口或 `/v1/config` 下发，以契约为准；04 / 08 未定名）：
 * `GET /v1/search/hot-words` 的 data、`GET /v1/config` 的 data 及其名字含 search 的一层子对象里，
 * 名字含 default 或 placeholder 的属性。
 */
export function defaultWordFields(doc: Obj): Field[] {
  const semantic = /default|placeholder/i;
  const hotData = response200Data(doc, '/v1/search/hot-words', 'get');
  const hot = fieldsOf(doc, 'getSearchHotWords.data', hotData);
  const config = fieldsOf(doc, 'getConfig.data', response200Data(doc, '/v1/config', 'get'));
  const nested = config
    .filter((f) => /search/i.test(f.name))
    .flatMap((f) => fieldsOf(doc, `getConfig.data.${f.name}`, f.schema));
  return [...hot, ...config, ...nested].filter((f) => semantic.test(f.name));
}
