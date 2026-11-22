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

export type Field = {
  where: string;
  path: string;
  /** 字段在 200 响应体里的位置（如 ['data', 'default_word']）。 */
  bodyPath: string[];
  name: string;
  schema: Obj;
  required: boolean;
};

function fieldsOf(doc: Obj, path: string, bodyPath: string[], where: string, schema: Obj): Field[] {
  const props = isObj(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.entries(props).map(([name, def]) => ({
    where,
    path,
    bodyPath: [...bodyPath, name],
    name,
    schema: resolve(doc, def),
    required: required.includes(name),
  }));
}

/** 名字像默认词（default / placeholder）。 */
const DEFAULT_WORD_NAME = /default|placeholder/i;
/** 名字像、语义不对的（评审 S1 #11 的 default_locale 一类）：直接排除。 */
const NOT_DEFAULT_WORD = /locale|lang|currency|region|timezone|sort|order|tab|platform|channel/i;

/**
 * 搜索框默认词字段的候选（01 F-PROD-16：随热词接口或 `/v1/config` 下发，以契约为准；04 / 08 未定名）。
 * 只收「搜索语境」里的字段：`GET /v1/search/hot-words` 的 data 本身就是搜索语境；`GET /v1/config` 只看
 * data 里名字含 search 的字段，以及名字含 search 的一层子对象里的字段。名字须含 default 或 placeholder，
 * 且不含 locale、lang 等别的语义。字段说明是否明确写了「搜索框默认词」由用例另查。
 */
export function defaultWordFields(doc: Obj): Field[] {
  const hotPath = '/v1/search/hot-words';
  const configPath = '/v1/config';
  const hotData = response200Data(doc, hotPath, 'get');
  const hot = fieldsOf(doc, hotPath, ['data'], 'getSearchHotWords.data', hotData);
  const configData = response200Data(doc, configPath, 'get');
  const config = fieldsOf(doc, configPath, ['data'], 'getConfig.data', configData).filter((f) =>
    /search/i.test(f.name),
  );
  const nested = config.flatMap((f) =>
    fieldsOf(doc, configPath, f.bodyPath, `getConfig.data.${f.name}`, f.schema),
  );
  return [...hot, ...config, ...nested].filter(
    (f) => DEFAULT_WORD_NAME.test(f.name) && !NOT_DEFAULT_WORD.test(f.name),
  );
}

/** 字段说明明确写了「搜索（输入）框的默认词 / 占位文字」。 */
export function describesSearchBoxDefault(schema: Obj): boolean {
  const description = typeof schema['description'] === 'string' ? schema['description'] : '';
  const box = /搜索框|搜索输入框|search[ _-]?(box|bar|input|field)/i;
  const word =
    /默认词|默认搜索词|默认文字|默认提示|占位|placeholder|default (search )?(word|term|keyword|text|query)/i;
  return box.test(description) && word.test(description);
}

/** 200 响应的 schema（整份响应信封）。 */
export function response200Schema(doc: Obj, path: string, method: string): Obj {
  const op = at(doc, 'paths', path, method);
  const response = resolve(doc, at(op, 'responses', '200'));
  return resolve(doc, at(response, 'content', 'application/json', 'schema'));
}

/** 200 响应的全部示例（example 与 examples 的每个 value）。 */
export function response200Examples(doc: Obj, path: string, method: string): unknown[] {
  const op = at(doc, 'paths', path, method);
  const response = resolve(doc, at(op, 'responses', '200'));
  const media = at(response, 'content', 'application/json');
  const out: unknown[] = [];
  if (Object.hasOwn(media, 'example')) out.push(clone(media['example']));
  if (isObj(media['examples'])) {
    for (const entry of Object.values(media['examples'])) {
      const example = resolve(doc, entry);
      if (Object.hasOwn(example, 'value')) out.push(clone(example['value']));
    }
  }
  expect(out.length, `${method.toUpperCase()} ${path} 的 200 响应示例`).toBeGreaterThan(0);
  return out;
}

/** 200 响应的示例（example 或 examples 的第一个）。 */
export function response200Example(doc: Obj, path: string, method: string): unknown {
  const op = at(doc, 'paths', path, method);
  const response = resolve(doc, at(op, 'responses', '200'));
  const media = at(response, 'content', 'application/json');
  if (Object.hasOwn(media, 'example')) return clone(media['example']);
  const examples = isObj(media['examples']) ? Object.values(media['examples']) : [];
  expect(examples.length, `${method.toUpperCase()} ${path} 的 200 响应示例`).toBeGreaterThan(0);
  return clone(resolve(doc, examples[0])['value']);
}

// ---------------------------------------------------------------------------------------------
// 批 1 的补充（spec-test r1）

/** 08 BR-TEXT-28 细则「不可配清单」：订单页、钱包页不设运营位，这些名字不是 page_key。 */
export const NO_SLOT_PAGE_KEYS = ['wallet', 'orders', 'order', 'withdraw'] as const;

/**
 * BR-TEXT-29 细则「起止时间」：ISO 8601 带 +08:00（BR-TEXT-11）。下列时刻语法合法，但偏移量不是 +08:00，
 * 不能作为下发值。
 */
export const OFFSET_BAD_INSTANTS = [
  '2026-11-11T00:00:00Z',
  '2026-11-10T16:00:00.000Z',
  '2026-11-11T01:00:00+09:00',
  '2026-11-11T00:00:00+00:00',
];

export type Candidate = { type: string; section: Obj };

export const SEARCH_TOP_ID = 'search_top';

/** home-schema.json 里任何 `properties.id` 上写死的取值（const / enum）。 */
function schemaIdConsts(): string[] {
  const out = new Set<string>();
  walk(homeSchema(), (node) => {
    const props = node['properties'];
    if (!isObj(props) || props['id'] === undefined) return;
    for (const v of constValues(props['id'])) if (typeof v === 'string') out.add(v);
  });
  return [...out].sort();
}

/** home-schema.json 里出现过的全部属性名（任何 `properties` 表的键）。 */
export function schemaPropertyNames(): string[] {
  const out = new Set<string>();
  walk(homeSchema(), (node) => {
    const props = node['properties'];
    if (isObj(props)) for (const name of Object.keys(props)) out.add(name);
  });
  return [...out].sort();
}

/** 通过的 search golden 里的全部 section（副本）。 */
function searchGoldenSections(): Obj[] {
  return validGoldens()
    .filter(({ page: p }) => p['page_key'] === SEARCH)
    .flatMap(({ page: p }) => sectionsOf(p))
    .map((s) => clone(s));
}

/**
 * search 结果页置顶位的两种候选（08 BR-TEXT-28 准入表 search 行：`banner` 或接商品池的 `product_scroll`，
 * 以契约为准），各自独立：优先取 search golden 里该类型的 section（保留它自己的 id），没有就取首页 golden
 * 的同类 section（跳转换成站内路由，product_scroll 换成商品池），id 依次试 search golden 用过的 id、
 * `search_top`、契约里写死的 section id 与几个常见名，取第一个能让该卡独立通过的（spec-test r2 S1 #3：
 * 契约可以给两种置顶卡各定一个 id，不能因 id 不对把合法的卡当成「不收」）。都不行时保留 `search_top`。
 */
export function searchCandidates(): Candidate[] {
  const golden = searchGoldenSections();
  const ids = [
    ...new Set([
      ...golden.map((s) => s['id']).filter((id): id is string => typeof id === 'string'),
      SEARCH_TOP_ID,
      ...schemaIdConsts(),
      'search_products',
      'search_banner',
      'search_scroll',
      'top',
    ]),
  ];
  const pickId = (base: Obj): Obj => {
    const id = ids.find((candidate) =>
      isValidPage(page(SEARCH, [{ ...clone(base), id: candidate }])),
    );
    return { ...clone(base), id: id ?? SEARCH_TOP_ID };
  };
  const goldenBanner = golden.find((s) => s['type'] === 'banner');
  const goldenScroll = golden.find(
    (s) =>
      s['type'] === 'product_scroll' &&
      isObj(s['data_source']) &&
      s['data_source']['kind'] === 'product_pool',
  );
  const banner: Obj = goldenBanner ?? pickId(homeSection('banner'));
  const scroll: Obj =
    goldenScroll ??
    pickId({
      ...homeSection('product_scroll'),
      data_source: { kind: 'product_pool', pool_id: 'pool_demo_hot', limit: 10 },
    });
  return [
    { type: 'banner', section: banner },
    { type: 'product_scroll', section: scroll },
  ];
}

/** 契约实际启用的 search 置顶位候选（至少一种）。 */
export function admittedSearch(): Candidate[] {
  const admitted = searchCandidates().filter(({ section }) =>
    isValidPage(page(SEARCH, [clone(section)])),
  );
  expect(
    admitted.map((c) => c.type),
    'search 至少收 banner、接商品池的 product_scroll 之一作置顶位',
  ).not.toEqual([]);
  return admitted;
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * home-schema.json `$defs` 里的准入定义（04 §6.2「运营位」①：每个 page_key 一张准入表，放在契约里供
 * 服务端保存校验与后台表单共用）。名字没定，认两种写法：① `$defs` 里某个对象同时有 `me`、`search` 两个键
 * （不是 properties 表），取其中 pageKey 那一键；② 一组 `$defs` 名字只差 `me` / `search` / pageKey 一段、
 * 且名字含 admission / sections / allow（如 `admission_me` / `admission_search` / `admission_home`）。
 * pageKey 为 `home` 时同理（批 1 的三个页面各一张，spec-test r2 S1 #2）。
 */
function admissionPointers(pageKey: string): string[] {
  const defs = homeSchema()['$defs'];
  const out = new Set<string>();
  if (!isObj(defs)) return [];
  const visit = (node: unknown, ptr: string, parentKey: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${ptr}/${i}`, String(i)));
      return;
    }
    if (!isObj(node)) return;
    if (
      parentKey !== 'properties' &&
      isObj(node[ME]) &&
      isObj(node[SEARCH]) &&
      isObj(node[pageKey])
    ) {
      out.add(`${ptr}/${escapePointer(pageKey)}`);
    }
    for (const [key, child] of Object.entries(node)) {
      visit(child, `${ptr}/${escapePointer(key)}`, key);
    }
  };
  visit(defs, '#/$defs', '$defs');
  const names = Object.keys(defs);
  for (const name of names) {
    if (!/(^|[_-])me($|[_-])/.test(name) || !/admission|sections|allow/i.test(name)) continue;
    const swap = (key: string): string => name.replace(/(^|[_-])me(?=$|[_-])/, `$1${key}`);
    const partner = swap(SEARCH);
    const target = swap(pageKey);
    if (partner !== name && names.includes(partner) && names.includes(target)) {
      out.add(`#/$defs/${escapePointer(target)}`);
    }
  }
  return [...out].sort();
}

export type Admission = { where: string; admits(sections: Obj[]): boolean };

/**
 * page_key 的准入定义，编译成校验函数：它是该页 `sections` 数组的 JSON Schema（整页 schema 按 page_key
 * 引用它），服务端保存与后台表单读同一份。`admits(sections)` 即该数组过这份定义。
 */
export function admissionEntries(pageKey: string): Admission[] {
  const pointers = admissionPointers(pageKey);
  expect(
    pointers,
    `home-schema.json $defs 里 ${pageKey} 的准入定义（04 §6.2「运营位」①，供保存校验与后台表单共用）`,
  ).not.toEqual([]);
  const root = homeSchema();
  return pointers.map((ptr) => {
    const validate = compileStrict({ $schema: root['$schema'], $defs: root['$defs'], $ref: ptr });
    return { where: ptr, admits: (sections: Obj[]) => validate(clone(sections)) };
  });
}

const HOT_RANK_PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
] as const;

/**
 * 几种合法的站内跳转（routes.json 已登记、entry 含 in_app、不是核心入口；BR-TEXT-30），第 i 个条目用的
 * params 各不相同：帮助文章、热销榜、站内 H5（https WebPage）、搜索、公告。
 */
export const ITEM_TARGET_KINDS: { name: string; at(i: number): Obj }[] = [
  { name: 'Help', at: (i) => ({ route: 'Help', params: { article_id: `guide_${i}` } }) },
  {
    name: 'HotRankList',
    at: (i) => ({
      route: 'HotRankList',
      params: { platform: HOT_RANK_PLATFORMS[i % HOT_RANK_PLATFORMS.length] as string },
    }),
  },
  {
    name: 'WebPage',
    at: (i) => ({ route: 'WebPage', params: { url: `https://h5.example.com/topic/${i}` } }),
  },
  { name: 'Search', at: (i) => ({ route: 'Search', params: { q: `入口${i}` } }) },
  { name: 'Notice', at: (i) => ({ route: 'Notice', params: { article_id: `notice_${i}` } }) },
];

/** 第 i 个条目轮换使用 ITEM_TARGET_KINDS（第 i 个用第 i mod 5 种）。 */
export function variedTarget(i: number): Obj {
  const kind = ITEM_TARGET_KINDS[i % ITEM_TARGET_KINDS.length] as { at(i: number): Obj };
  return kind.at(i);
}

/**
 * me.more_services 带 n 个互不相同的条目（以 golden 第一个条目为底）；第 i 个条目的跳转为 targetAt(i)，
 * 默认按 variedTarget 轮换几种站内路由（spec-test r2 S1 #4：上限不能只对某一种路由计数）。
 */
export function meWithItems(n: number, targetAt: (i: number) => Obj = variedTarget): Obj {
  const section = clone(moreServices(meBase()));
  const first = firstItem(section);
  const items: Obj[] = [];
  for (let i = 0; i < n; i += 1) {
    const item = clone(first);
    item['action'] = targetAt(i);
    for (const key of ['id', 'item_id', 'key', 'slug']) {
      if (typeof item[key] === 'string') item[key] = `${String(item[key])}_${i}`;
    }
    items.push(item);
  }
  section['data_source'] = { ...object(section['data_source']), items };
  return page(ME, [section]);
}

export type Path = (string | number)[];

/** 值里满足条件的节点的位置（命中后不再往下找）。 */
export function findPaths(
  value: unknown,
  match: (node: unknown) => boolean,
  skip: readonly string[] = [],
  path: Path = [],
): Path[] {
  if (match(value)) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((child, i) => findPaths(child, match, skip, [...path, i]));
  }
  if (isObj(value)) {
    return Object.entries(value)
      .filter(([key]) => !skip.includes(key))
      .flatMap(([key, child]) => findPaths(child, match, skip, [...path, key]));
  }
  return [];
}

export function getAt(value: unknown, path: Path): unknown {
  let node = value;
  for (const key of path) {
    if (!isObj(node) && !Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[String(key)];
  }
  return node;
}

/**
 * 副本上把 path 处换成 next（next 为 undefined 时删掉该键）。路上缺的父对象（如示例省略了可选的
 * data.search）先补成空对象再设值；删除时父对象本来就缺则原样返回。不抛 TypeError（spec-test r2 S2）。
 */
export function setAt(value: unknown, path: Path, next: unknown): unknown {
  if (path.length === 0) return clone(next);
  const copy = clone(value);
  if (!isObj(copy) && !Array.isArray(copy)) return copy;
  let node = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    const child = node[String(key)];
    if (!isObj(child) && !Array.isArray(child)) {
      if (next === undefined) return copy;
      node[String(key)] = {};
    }
    node = node[String(key)] as Record<string, unknown>;
  }
  const last = String(path.at(-1));
  if (next === undefined) delete node[last];
  else node[last] = clone(next);
  return copy;
}

/** 后台写操作请求体的示例（example 与 examples 的每个 value）。 */
export function requestExamples(doc: Obj, op: Obj): unknown[] {
  if (op['requestBody'] === undefined) return [];
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

export function requestSchema(doc: Obj, op: Obj): Obj {
  const body = resolve(doc, op['requestBody']);
  return resolve(doc, at(body, 'content', 'application/json', 'schema'));
}

/** 从一个 openapi 节点出发、经 $ref 能到的全部 `properties.<prop>` 定义（跳过示例）。 */
function propertyDefsIn(doc: Obj, root: unknown, prop: string): Obj[] {
  const out: Obj[] = [];
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
    if (isObj(props) && props[prop] !== undefined) out.push(resolve(doc, props[prop]));
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'example' && key !== 'examples') visit(child);
    }
  };
  visit(root);
  return out;
}

export type Definition = { where: string; schema: Obj };

const PAGE_PATHS = /^\/(admin\/)?v1\/pages(\/|$)/;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * 页面配置各操作（`/v1/pages…` 与后台 `/admin/v1/pages…` 的保存、读取、发布等）实际用到的页面键定义：
 * 路径参数 page_key，以及请求体、响应里的 page_key 属性。
 */
export function pageKeyDefinitions(doc: Obj): Definition[] {
  const out: Definition[] = [];
  for (const [path, item] of Object.entries(at(doc, 'paths'))) {
    if (!PAGE_PATHS.test(path) || !isObj(item)) continue;
    const shared: unknown[] = Array.isArray(item['parameters']) ? item['parameters'] : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const name = `${method.toUpperCase()} ${path}`;
      const own: unknown[] = Array.isArray(op['parameters']) ? op['parameters'] : [];
      for (const raw of [...shared, ...own]) {
        const param = resolve(doc, raw);
        if (param['name'] === 'page_key' && param['in'] === 'path') {
          out.push({ where: `${name} 路径参数 page_key`, schema: resolve(doc, param['schema']) });
        }
      }
      for (const part of ['requestBody', 'responses'] as const) {
        propertyDefsIn(doc, op[part], 'page_key').forEach((schema, i) => {
          out.push({ where: `${name} ${part} 里的 page_key #${i}`, schema });
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 批 1 的补充（spec-test r2）

export type EffectiveParam = { where: string; operationId: string; schema: Obj };

/**
 * 某路径下某方法实际生效的路径参数（OpenAPI：操作级同名同位置的参数覆盖路径级的），schema 已解析引用。
 * 只返回 `in: path` 且名字为 name 的那一个；没有时为 undefined。
 */
export function effectivePathParam(
  doc: Obj,
  path: string,
  method: string,
  name: string,
): EffectiveParam | undefined {
  const item = at(doc, 'paths', path);
  const op = at(item, method);
  const pick = (list: unknown): Obj | undefined =>
    (Array.isArray(list) ? list : [])
      .map((raw) => resolve(doc, raw))
      .find((p) => p['name'] === name && p['in'] === 'path');
  const param = pick(op['parameters']) ?? pick(item['parameters']);
  if (param === undefined) return undefined;
  return {
    where: `${method.toUpperCase()} ${path} 实际生效的路径参数 ${name}`,
    operationId: typeof op['operationId'] === 'string' ? op['operationId'] : '',
    schema: resolve(doc, param['schema']),
  };
}

/** 公开的 `/v1/pages/{page_key}…` 下的 GET 操作路径。 */
export function publicPageReadPaths(doc: Obj): string[] {
  return Object.entries(at(doc, 'paths'))
    .filter(
      ([path, item]) =>
        path.startsWith('/v1/pages/{page_key}') && isObj(item) && isObj(item['get']),
    )
    .map(([path]) => path)
    .sort();
}

/**
 * section 的 static 条目补到至少两个（不够时以第一个为底补一个跳帮助文章的条目），用于检查「第二项及以后」。
 * 补出来的 section 不合契约时（如契约限定该卡只有一个条目）原样返回。
 */
export function atLeastTwo(pageKey: string, section: Obj): Obj {
  const next = clone(section);
  const items = itemsOf(next);
  expect(items.length, `${String(next['id'])} 至少一个条目`).toBeGreaterThan(0);
  if (items.length >= 2) return next;
  const extra = clone(items[0] as Obj);
  extra['action'] = { route: 'Help', params: { article_id: 'second_entry' } };
  object(next['data_source'])['items'] = [...items, extra];
  return isValidPage(page(pageKey, [next])) ? next : clone(section);
}
