// CT-27b · 运营位批 1 契约伴随规则测试 ①～⑤（FU-CT-27-SPEC-R3-GAPS；编排 D10-2401 六条必满足项）。
// 规则：08 BR-TEXT-28（准入表：search 结果页置顶位 1 个；me 只许 more_services，条目数上限由契约线定稿）、
// BR-TEXT-29（徽标只用于 icon_grid 条目）、BR-TEXT-30（me / search 里的跳转只收站内目标，外链拒收；首页原有
// 类型照旧可用 ExternalPage；图标下发带摘要）。
// 本文件自带辅助函数，不导入 test/spec/contracts/operation-slots/ 下已冻结的文件（be 补充）。
// 字段名按 CT-27 契约定稿（be 补充「契约定稿的形状」、编排 D10-2547 ②）：search 置顶卡取自 search golden；
// product_scroll 的「更多」是 props.more_action；me 的图标与摘要在同一对象里（定稿 icon: {url, sha256}；本文件
// 按语义找「https 地址 + 64 位十六进制摘要」同在的对象，不钉键名）；徽标只认 04 §6.2 的建议名 badge，徽标
// 取值取自 me golden，不在本文件写死徽标内部的键名。
// 每条规则同时查整页 schema 与该 page_key 的准入定义（根 allOf 按 page_key 套给 sections 的 $defs，服务端
// 保存 / 发布与后台表单共用，04 §6.2「运营位」①），两处结论必须一致。
// 全部静态读 contracts/：不连库、不 listen、不联网。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

interface Variant {
  name: string;
  section: Obj;
}

interface PictureNode {
  path: string[];
  urls: string[];
  digests: string[];
}

const root = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', root));
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => AjvInstance;
};
const addFormats = apiRequire('ajv-formats') as (ajv: AjvInstance) => void;

// ---------------------------------------------------------------------------------------------
// 规则常量（独立预期）

const HOME = 'home';
const ME = 'me';
const SEARCH = 'search';
const GOLDEN_DIR = 'contracts/fixtures/home-golden/';

/** 条目数上限的搜索界：契约给的上限必须小于它（「有上限」）。 */
const CAP_BOUND = 64;

/**
 * 第 i 个条目的几种合法站内跳转（routes.json 已登记、entry 含 in_app、不是 BR-TEXT-28 的核心入口；
 * BR-TEXT-30）。含缺口原文漏计的商品详情 ProductDetail（platform=jd、product_key=sku…）。
 */
const TARGETS: Record<string, (i: number) => Obj> = {
  Help: (i) => ({ route: 'Help', params: { article_id: `guide_${i}` } }),
  HotRankList: () => ({ route: 'HotRankList', params: { platform: 'jd' } }),
  WebPage: (i) => ({ route: 'WebPage', params: { url: `https://h5.example.com/topic/${i}` } }),
  Search: (i) => ({ route: 'Search', params: { q: `入口${i}` } }),
  Notice: (i) => ({ route: 'Notice', params: { article_id: `notice_${i}` } }),
  ProductDetail: (i) => ({
    route: 'ProductDetail',
    params: { platform: 'jd', product_key: `sku${100 + i}` },
  }),
};
const KINDS = Object.keys(TARGETS);

/** BR-TEXT-30 外部链接（缺口原文的地址）。 */
const EXTERNAL: Obj = { route: 'ExternalPage', params: { url: 'https://example.com/topic' } };

/** BR-TEXT-30 允许的站内跳转。 */
const GOOD_TARGETS: Obj[] = [
  { route: 'Help', params: { article_id: 'sign_in_guide' } },
  { route: 'HotRankList', params: { platform: 'taobao' } },
  { route: 'WebPage', params: { url: 'https://h5.example.com/topic/double11' } },
  { route: 'Search', params: { q: '洗衣液' } },
  { route: 'ProductDetail', params: { platform: 'jd', product_key: 'sku123' } },
  { route: 'Notice' },
];

/**
 * 适用范围内不收的跳转：ExternalPage（不论地址）、非 https 或缺地址的 WebPage（BR-TEXT-30），以及
 * BR-TEXT-28 不可配清单里的核心入口（提现、钱包、订单、设置、授权管理）。
 */
const BAD_TARGETS: Obj[] = [
  EXTERNAL,
  { route: 'ExternalPage', params: { url: 'https://h5.example.com/topic/double11' } },
  { route: 'ExternalPage' },
  { route: 'WebPage', params: { url: 'http://h5.example.com/topic/double11' } },
  { route: 'WebPage', params: { url: 'javascript:alert(1)' } },
  { route: 'WebPage' },
  { route: 'Withdraw' },
  { route: 'Wallet', params: {} },
  { route: 'OrderList' },
  { route: 'Settings' },
  { route: 'AuthManage' },
];

/** 带协议的地址（图片地址的形状）。 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
/** SHA-256 摘要的形状（64 位十六进制）。 */
const DIGEST_LIKE = /^[0-9a-f]{64}$/i;
/** 缺口原文里没有摘要的那张图。 */
const LOOSE_PICTURE = 'https://media.example.test/sign-in.png';

// ---------------------------------------------------------------------------------------------
// 读文件与 Ajv

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function check(ok: boolean, valid: boolean, label: string): void {
  expect(ok, `${label}：期望${valid ? '通过' : '被拒'}`).toBe(valid);
}

function readJson(path: string): Obj {
  const file = new URL(path, root);
  expect(existsSync(file), `缺少文件 ${path}`).toBe(true);
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  expect(isObj(value), `${path} 必须是对象`).toBe(true);
  return value as Obj;
}

function getAt(value: unknown, path: string[]): unknown {
  let node = value;
  for (const key of path) {
    if (!isObj(node)) return undefined;
    node = node[key];
  }
  return node;
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

let schemaCache: Obj | undefined;
function homeSchema(): Obj {
  schemaCache ??= readJson('contracts/home-schema.json');
  return schemaCache;
}

let pageCache: ValidateFn | undefined;
/** 一整页（home-schema.json 根）是否合契约。 */
function validPage(value: unknown): boolean {
  pageCache ??= compileStrict(homeSchema());
  return pageCache(clone(value));
}

function page(pageKey: string, sections: Obj[]): Obj {
  return { page_key: pageKey, version: 1, ttl_sec: 300, sections };
}

function homeOk(section: Obj): boolean {
  return validPage(page(HOME, [section]));
}

function constOf(schema: unknown): unknown {
  if (!isObj(schema)) return undefined;
  if (schema['const'] !== undefined) return schema['const'];
  const values = schema['enum'];
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

/**
 * 根 allOf 里 if 的 page_key 恰为该值的分支，then 套给 sections 的 $defs 引用（该 page_key 的准入定义，
 * 04 §6.2「运营位」①）。
 */
function admissionRef(pageKey: string): string {
  const refs: string[] = [];
  const branches = homeSchema()['allOf'];
  for (const branch of Array.isArray(branches) ? branches : []) {
    if (constOf(getAt(branch, ['if', 'properties', 'page_key'])) !== pageKey) continue;
    const ref = getAt(branch, ['then', 'properties', 'sections', '$ref']);
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) refs.push(ref);
  }
  expect(refs, `根 allOf 给 page_key=${pageKey} 套的准入定义`).toHaveLength(1);
  return refs[0] as string;
}

const admissionCache = new Map<string, ValidateFn>();
/** 该 page_key 的准入定义是否收这组 sections。 */
function admits(pageKey: string, sections: Obj[]): boolean {
  let validate = admissionCache.get(pageKey);
  if (validate === undefined) {
    const { $schema, $defs } = homeSchema();
    validate = compileStrict({ $schema, $defs, $ref: admissionRef(pageKey) });
    admissionCache.set(pageKey, validate);
  }
  return validate(clone(sections));
}

/** 整页与该 page_key 的准入定义给出同一结论（me、search）。 */
function verdict(key: string, sections: Obj[], valid: boolean, label: string): void {
  check(validPage(page(key, sections)), valid, `${label}（整页）`);
  check(admits(key, sections), valid, `${label}（准入定义）`);
}

// ---------------------------------------------------------------------------------------------
// golden 样例

let goldenCache: Obj[] | undefined;
function goldenPages(): Obj[] {
  if (goldenCache === undefined) {
    const dir = new URL(GOLDEN_DIR, root);
    expect(existsSync(dir), `缺少目录 ${GOLDEN_DIR}`).toBe(true);
    const names = readdirSync(dir).filter((name) => name.endsWith('.json'));
    goldenCache = names.sort().map((name) => readJson(`${GOLDEN_DIR}${name}`));
  }
  return goldenCache;
}

function sectionsOf(value: Obj): Obj[] {
  const sections = value['sections'];
  return Array.isArray(sections) ? sections.filter(isObj) : [];
}

function itemsOf(section: Obj): Obj[] {
  const items = getAt(section, ['data_source', 'items']);
  return Array.isArray(items) ? items.filter(isObj) : [];
}

/** golden 里该页该类型的 section（副本；有条目的优先）。 */
function goldenSection(pageKey: string, type: string): Obj {
  const found: Obj[] = [];
  for (const golden of goldenPages()) {
    if (golden['page_key'] !== pageKey) continue;
    found.push(...sectionsOf(golden).filter((s) => s['type'] === type));
  }
  expect(found.length, `${GOLDEN_DIR} 里 ${pageKey} 页的 ${type} section`).toBeGreaterThan(0);
  const withItems = found.find((s) => itemsOf(s).length > 0);
  return clone(withItems ?? (found[0] as Obj));
}

function propsOf(section: Obj): Obj {
  const props = section['props'];
  return isObj(props) ? props : {};
}

/** 副本换上 props（undefined 即删掉 props）。 */
function withProps(section: Obj, props: Obj | undefined): Obj {
  const next = clone(section);
  if (props === undefined) delete next['props'];
  else next['props'] = clone(props);
  return next;
}

function withMoreAction(section: Obj, target: unknown): Obj {
  return withProps(section, { ...propsOf(section), more_action: clone(target) });
}

/** 副本里第 index 个条目的 key 换成 value。 */
function withItemKey(section: Obj, index: number, key: string, value: unknown): Obj {
  const next = clone(section);
  const item = itemsOf(next)[index];
  expect(item, `${String(next['id'])} 第 ${index} 个条目`).toBeDefined();
  (item as Obj)[key] = clone(value);
  return next;
}

// ---------------------------------------------------------------------------------------------
// ① search 置顶位

/** 同一张置顶卡的几种写法：golden 原样、不带 props、props 只留一个键、补上标题「本周热销」。 */
function propVariants(type: string, section: Obj): Variant[] {
  const props = propsOf(section);
  const titled = withProps(section, { ...props, title: '本周热销' });
  const out: Variant[] = [
    { name: `${type}（golden）`, section },
    { name: `${type}（不带 props）`, section: withProps(section, undefined) },
    { name: `${type}（标题本周热销）`, section: titled },
  ];
  for (const key of Object.keys(props)) {
    const only = withProps(section, { [key]: props[key] });
    out.push({ name: `${type}（props 只留 ${key}）`, section: only });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ② more_services 条目数

function repeat(kind: string, n: number): string[] {
  return Array.from({ length: n }, () => kind);
}

function targetOf(kind: string, i: number): Obj {
  const make = TARGETS[kind];
  expect(make, `未知跳转种类 ${kind}`).toBeDefined();
  return (make as (i: number) => Obj)(i);
}

/** me.more_services 依次放 kinds 指定跳转的条目（以 me golden 的第一个条目为底，名称各不相同）。 */
function meWith(kinds: string[]): Obj {
  const section = goldenSection(ME, 'icon_grid');
  const first = itemsOf(section)[0];
  expect(first, 'me golden 的 more_services 至少一个条目').toBeDefined();
  const items = kinds.map((kind, i) => {
    const item = clone(first as Obj);
    item['action'] = targetOf(kind, i);
    if (typeof item['title'] === 'string') item['title'] = `格${i}`;
    return item;
  });
  section['data_source'] = { ...(section['data_source'] as Obj), items };
  return section;
}

/** 只用帮助文章跳转时，more_services 最多能放几格（CAP_BOUND 以内）。 */
function meCap(): number {
  let cap = 0;
  for (let n = 1; n <= CAP_BOUND; n += 1) {
    if (!validPage(page(ME, [meWith(repeat('Help', n))]))) break;
    cap = n;
  }
  return cap;
}

/** n 个条目的几种跳转组合：全是同一种、几种轮换、n-1 个帮助文章加 1 个别的。 */
function compositions(n: number): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const kind of KINDS) out.push([`全是 ${kind}`, repeat(kind, n)]);
  const rotated = Array.from({ length: n }, (_, i) => KINDS[i % KINDS.length] as string);
  out.push(['几种跳转轮换', rotated]);
  for (const kind of KINDS) {
    const name = `${n - 1} 个 Help + 1 个 ${kind}`;
    out.push([name, [...repeat('Help', n - 1), kind]]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ③ 徽标

/** me golden 条目上的徽标（合法徽标样例；不在本文件写死徽标内部键名）。 */
function goldenBadges(): unknown[] {
  const items = itemsOf(goldenSection(ME, 'icon_grid'));
  const badges = items.map((item) => item['badge']).filter((b) => b !== undefined);
  expect(badges.length, 'me golden 的条目里有徽标样例').toBeGreaterThan(0);
  return badges;
}

// ---------------------------------------------------------------------------------------------
// ⑤ 图标与摘要

/**
 * 条目里（跳转 action 除外）带图片地址或摘要的对象：每个对象列出值像地址的键与值像 SHA-256 摘要的键。
 */
function pictureNodes(value: unknown, path: string[] = []): PictureNode[] {
  if (!isObj(value)) return [];
  const urls: string[] = [];
  const digests: string[] = [];
  const nested: PictureNode[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'action') continue;
    if (typeof child === 'string' && URL_LIKE.test(child)) urls.push(key);
    else if (typeof child === 'string' && DIGEST_LIKE.test(child)) digests.push(key);
    else nested.push(...pictureNodes(child, [...path, key]));
  }
  if (urls.length === 0 && digests.length === 0) return nested;
  return [{ path, urls, digests }, ...nested];
}

/** me golden 的 more_services 副本，第 index 个条目经 edit 改过。 */
function editMe(index: number, edit: (item: Obj) => void): Obj {
  const section = goldenSection(ME, 'icon_grid');
  const item = itemsOf(section)[index];
  expect(item, `me golden 第 ${index} 个条目`).toBeDefined();
  edit(item as Obj);
  return section;
}

function holder(item: Obj, path: string[]): Obj {
  const node = getAt(item, path);
  expect(isObj(node), `条目里 ${path.join('.')} 处的图片对象`).toBe(true);
  return node as Obj;
}

function setPath(item: Obj, path: string[], value: unknown): void {
  holder(item, path.slice(0, -1))[path[path.length - 1] as string] = value;
}

// ---------------------------------------------------------------------------------------------
// 用例

it('[AC-CT-27b#1] search 置顶位至多一张：search golden 的 banner、接商品池的 product_scroll 各自单放都收，空页也收；任两张同放（不论卡的类型，不论可选 props 填没填、标题有没有，同类两张也算）一律拒收，整页与准入定义一致', () => {
  // BR-TEXT-28 准入表 search 行：结果页置顶位 1 个（banner 或接商品池的 product_scroll，以契约为准）。
  // D10-2401 ①：至多一张，不论卡的类型；候选是否「启用」不取决于可选 / 必填 props 是否齐全（缺口原文：
  // 运营给商品卡填上「本周热销」，即可把两张各自合法的置顶卡一并提交）。
  verdict(SEARCH, [], true, 'search 不出置顶位（空页，回落）');
  const banner = goldenSection(SEARCH, 'banner');
  const scroll = goldenSection(SEARCH, 'product_scroll');
  const source = getAt(scroll, ['data_source', 'kind']);
  expect(source, 'search golden 的商品卡接商品池').toBe('product_pool');
  verdict(SEARCH, [banner], true, 'search golden 的 banner 置顶卡单放');
  verdict(SEARCH, [scroll], true, 'search golden 的 product_scroll 置顶卡单放');
  const variants = propVariants('banner', banner);
  variants.push(...propVariants('product_scroll', scroll));
  for (const first of variants) {
    for (const second of variants) {
      const label = `置顶卡 ${first.name} + ${second.name}`;
      verdict(SEARCH, [first.section, second.section], false, label);
    }
  }
});

it('[AC-CT-27b#2] me.more_services 的条目数上限对整个 items 数组算：契约给了上限（不低于 golden 的条目数）；上限格数不论跳转怎么组合（全是商品详情、帮助文章加一格商品详情、几种轮换）都收，多一格不论怎么组合都拒收', () => {
  // BR-TEXT-28 准入表 me 行「条目数上限、列数由契约线定稿」；D10-2401 ②：上限对整个 items 数组算，不按
  // 列举的路由计（缺口原文：8 个帮助入口再加一格跳 ProductDetail，契约仍接受 9 格）。
  const cap = meCap();
  const goldenCount = itemsOf(goldenSection(ME, 'icon_grid')).length;
  expect(cap, `契约给了条目数上限（${CAP_BOUND} 格以内）`).toBeLessThan(CAP_BOUND);
  expect(cap, '上限不低于 me golden 的条目数').toBeGreaterThanOrEqual(goldenCount);
  for (const [name, kinds] of compositions(cap)) {
    verdict(ME, [meWith(kinds)], true, `${cap} 格（${name}）`);
  }
  for (const [name, kinds] of compositions(cap + 1)) {
    verdict(ME, [meWith(kinds)], false, `${cap + 1} 格（${name}）`);
  }
});

it('[AC-CT-27b#3] 徽标只在 icon_grid 条目上：me golden 的各种徽标放在 more_services、首页金刚区条目上都收；放在 search 置顶 banner 的任何一项（含第二项及以后、补上的第三项）、首页 banner / activity_entry / popup 的任何一项都拒收', () => {
  // BR-TEXT-29 细则「徽标」：本批徽标只用于 icon_grid 条目（「我的 · 更多服务」与首页金刚区）；D10-2401 ③：
  // banner 任何一项都不得带（缺口原文：运营添加第二张非主横幅并带红点时，契约仍会接受）。
  const badges = goldenBadges();
  const me = goldenSection(ME, 'icon_grid');
  const grid = goldenSection(HOME, 'icon_grid');
  for (const value of badges) {
    const shown = JSON.stringify(value);
    verdict(ME, [withItemKey(me, 0, 'badge', value)], true, `more_services 带徽标 ${shown}`);
    check(homeOk(withItemKey(grid, 0, 'badge', value)), true, `首页金刚区带徽标 ${shown}`);
  }
  const banner = goldenSection(SEARCH, 'banner');
  const items = itemsOf(banner);
  expect(items.length, 'search golden 的 banner 至少两项').toBeGreaterThanOrEqual(2);
  const extra = clone(items[items.length - 1] as Obj);
  delete extra['badge'];
  extra['action'] = { route: 'Help', params: { article_id: 'third_entry' } };
  const longer = clone(banner);
  (longer['data_source'] as Obj)['items'] = [...items, extra];
  verdict(SEARCH, [longer], true, 'search banner 补第三项（不带徽标）');
  for (const base of [banner, longer]) {
    for (let index = 0; index < itemsOf(base).length; index += 1) {
      for (const value of badges) {
        const label = `search banner 第 ${index} 项带徽标 ${JSON.stringify(value)}`;
        verdict(SEARCH, [withItemKey(base, index, 'badge', value)], false, label);
      }
    }
  }
  for (const type of ['banner', 'activity_entry', 'popup']) {
    const base = goldenSection(HOME, type);
    check(homeOk(base), true, `首页 golden 的 ${type} 单放`);
    expect(itemsOf(base).length, `首页 golden 的 ${type} 有条目`).toBeGreaterThan(0);
    for (let index = 0; index < itemsOf(base).length; index += 1) {
      for (const value of badges) {
        const label = `首页 ${type} 第 ${index} 项带徽标 ${JSON.stringify(value)}`;
        check(homeOk(withItemKey(base, index, 'badge', value)), false, label);
      }
    }
  }
});

it('[AC-CT-27b#4] search 置顶位 product_scroll 的「更多」按钮 props.more_action 只收站内跳转：帮助、热销榜、https 站内 H5、搜索、商品详情、公告都收；ExternalPage（不论地址）、http / javascript / 缺地址的 WebPage、核心入口都拒收', () => {
  // BR-TEXT-30：me、search 里条目的跳转目标只能是 in_app 路由或 bridge_origins 内的 https WebPage，外链拒收；
  // D10-2401 ④：product_scroll 的更多按钮用与静态条目同一套站内跳转白名单（契约定稿键名 props.more_action）。
  // 缺口原文：运营填入 {route:'ExternalPage',params:{url:'https://example.com/topic'}} 时契约仍接受。
  const scroll = goldenSection(SEARCH, 'product_scroll');
  expect(isObj(propsOf(scroll)['more_action']), 'search golden 配了 more_action').toBe(true);
  for (const target of GOOD_TARGETS) {
    const shown = JSON.stringify(target);
    verdict(SEARCH, [withMoreAction(scroll, target)], true, `more_action=${shown}`);
  }
  for (const target of BAD_TARGETS) {
    const shown = JSON.stringify(target);
    verdict(SEARCH, [withMoreAction(scroll, target)], false, `more_action=${shown}`);
  }
});

it('[AC-CT-27b#5] product_scroll 的 more_action 与静态条目同一套白名单：同一跳转放进 more_action、search banner 条目、more_services 条目，三处结论相同', () => {
  // D10-2401 ④：more_action 用与静态条目同一套站内跳转白名单（BR-TEXT-30，运营位不加动态码的前提，D10-2383）。
  const scroll = goldenSection(SEARCH, 'product_scroll');
  const banner = goldenSection(SEARCH, 'banner');
  const me = goldenSection(ME, 'icon_grid');
  for (const target of [...GOOD_TARGETS, ...BAD_TARGETS]) {
    const shown = JSON.stringify(target);
    const more = validPage(page(SEARCH, [withMoreAction(scroll, target)]));
    const item = validPage(page(SEARCH, [withItemKey(banner, 0, 'action', target)]));
    const meItem = validPage(page(ME, [withItemKey(me, 0, 'action', target)]));
    expect(more, `${shown}：more_action 与 search banner 条目同一结论`).toBe(item);
    expect(more, `${shown}：more_action 与 more_services 条目同一结论`).toBe(meItem);
  }
});

it('[AC-CT-27b#6] search 置顶位 product_scroll 的 props 不能另找键夹带外链（缺口原文的早期写法 more={label, action:ExternalPage}、more_url、more_link 都拒收）；首页 product_scroll 的 more_action 照旧可填 ExternalPage（BR-TEXT-30 适用范围）', () => {
  // BR-TEXT-30：适用范围是本次新增的 page_key（me、search）；首页原有的 section 类型照旧可用 ExternalPage。
  const scroll = goldenSection(SEARCH, 'product_scroll');
  const leaks: Obj[] = [
    { more: { label: '更多', action: EXTERNAL } },
    { more_url: 'https://example.com/topic' },
    { more_link: EXTERNAL },
  ];
  for (const leak of leaks) {
    const label = `search product_scroll 的 props 加 ${JSON.stringify(leak)}`;
    verdict(SEARCH, [withProps(scroll, { ...propsOf(scroll), ...leak })], false, label);
  }
  const home = goldenSection(HOME, 'product_scroll');
  const homeLabel = '首页 product_scroll 的 more_action 填 ExternalPage';
  check(homeOk(withMoreAction(home, EXTERNAL)), true, homeLabel);
});

it('[AC-CT-27b#7] more_services 每个条目恰有一张下发图，图片地址与它的摘要在同一对象里一一对应；条目里没有不带摘要的图片地址，也没有不挨着图片的摘要', () => {
  // BR-TEXT-30 细则「图标」：三端共用同一张下发图，下发带摘要（同 BR-TEXT-24、BR-TEXT-26）；D10-2401 ⑤：图标
  // 摘要字段与实际显示的 image 在同一对象里绑定（缺口原文：实际显示的 image 与另发的 asset_metadata={url,
  // sha256} 分开，客户端收到 image 时仍没有这张图的摘要）。
  const items = itemsOf(goldenSection(ME, 'icon_grid'));
  expect(items.length, 'me golden 的条目').toBeGreaterThan(0);
  for (const [index, item] of items.entries()) {
    const nodes = pictureNodes(item);
    const where = `me golden 第 ${index} 个条目`;
    expect(nodes.length, `${where}：带图片地址或摘要的对象恰一个`).toBe(1);
    for (const node of nodes) {
      expect(node.urls.length, `${where} @${node.path.join('.')}：一个图片地址`).toBe(1);
      expect(node.digests.length, `${where} @${node.path.join('.')}：一个摘要`).toBe(1);
    }
  }
});

it('[AC-CT-27b#8] more_services 条目的图片与摘要拆不开：另加不带摘要的图片字段（image 等）、删掉摘要或地址、把摘要挪出图片对象、图片改成纯地址、图片对象里再塞一张图、摘要不是 64 位十六进制、地址不是 https 都拒收；换一对新的地址与摘要照收', () => {
  // BR-TEXT-30 细则「图标」、D10-2401 ⑤（同上）。golden 条目的图片对象按语义找（pictureNodes）。
  const section = goldenSection(ME, 'icon_grid');
  verdict(ME, [section], true, 'me golden');
  for (const [index, item] of itemsOf(section).entries()) {
    const where = `me 第 ${index} 个条目`;
    const [node] = pictureNodes(item);
    expect(node, `${where} 的图片对象`).toBeDefined();
    const { path, urls, digests } = node as PictureNode;
    const urlKey = urls[0] as string;
    const digestKey = digests[0] as string;
    const url = String(holder(item, path)[urlKey]);
    const digest = String(holder(item, path)[digestKey]);

    for (const key of ['image', 'icon_url', 'picture', 'img']) {
      const edited = editMe(index, (t) => {
        t[key] = LOOSE_PICTURE;
      });
      verdict(ME, [edited], false, `${where} 另加 ${key}=${LOOSE_PICTURE}`);
    }
    const noDigest = editMe(index, (t) => {
      delete holder(t, path)[digestKey];
    });
    verdict(ME, [noDigest], false, `${where} 删掉摘要 ${digestKey}`);
    const noUrl = editMe(index, (t) => {
      delete holder(t, path)[urlKey];
    });
    verdict(ME, [noUrl], false, `${where} 删掉地址 ${urlKey}`);
    const extraUrl = editMe(index, (t) => {
      holder(t, path)['fallback_url'] = LOOSE_PICTURE;
    });
    verdict(ME, [extraUrl], false, `${where} 图片对象里再塞 fallback_url`);
    if (path.length > 0) {
      const outside = `${path.join('_')}_${digestKey}`;
      for (const moved of [digestKey, outside]) {
        const edited = editMe(index, (t) => {
          delete holder(t, path)[digestKey];
          t[moved] = digest;
        });
        verdict(ME, [edited], false, `${where} 摘要挪到条目的 ${moved}`);
      }
      const plain = editMe(index, (t) => {
        setPath(t, path, url);
      });
      verdict(ME, [plain], false, `${where} 图片改成纯地址`);
    }
    for (const bad of [digest.slice(1), `${digest}0`, 'g'.repeat(64), '']) {
      const edited = editMe(index, (t) => {
        holder(t, path)[digestKey] = bad;
      });
      verdict(ME, [edited], false, `${where} 摘要=${JSON.stringify(bad)}`);
    }
    const http = editMe(index, (t) => {
      holder(t, path)[urlKey] = url.replace(/^https:/, 'http:');
    });
    verdict(ME, [http], false, `${where} 地址改成 http`);

    const fresh = 'ab'.repeat(32);
    const renamed = editMe(index, (t) => {
      holder(t, path)[urlKey] = url.replaceAll(digest, fresh);
      holder(t, path)[digestKey] = fresh;
    });
    verdict(ME, [renamed], true, `${where} 换一对新的地址与摘要`);
  }
});

// ---------------------------------------------------------------------------------------------
// 写测 2（spec-test r1 的 6 条 S1，每条是一个能骗过 #1～#8 的错误契约）：先断言契约里生效的定义本身，
// 再用边界样例补。字段名按契约定稿（编排 D10-2547 ②）：me 的图标 icon: {url, sha256}、product_scroll 的
// 「更多」props.more_action、核心入口 $defs/core_route。

/** 契约线定稿的「我的 · 更多服务」条目数上限（slot_me_more_services 1–12 格，D10-2401 ②）。 */
const ME_CAP = 12;

/**
 * BR-TEXT-28 不可配清单里的核心入口：订单、钱包与收益、提现及其各步、「推广与邀请」组、设置、隐私与授权、
 * 协议（契约定稿 $defs/core_route 的完整枚举）。契约的枚举必须全包含这一份，测试再并上契约多列的。
 */
const CORE_ROUTES = [
  'OrderList',
  'OrderDetail',
  'FindOrder',
  'Wallet',
  'Earnings',
  'Ledger',
  'Withdraw',
  'WithdrawRecords',
  'PayoutAccount',
  'RealName',
  'Reverify',
  'ShareHub',
  'InviteShare',
  'Settings',
  'PrivacyCenter',
  'DeleteAccount',
  'DataCopy',
  'AuthManage',
  'Agreement',
  'LaborAgreement',
];

/** 只作注解、不改校验结论的键。 */
const ANNOTATIONS = ['$comment', 'description', 'title'];

/** search 置顶卡另试的 section id（缺口原文与评审提到的）。 */
const EXTRA_SEARCH_IDS = ['search_top', 'search_products', 'search_banner', 'search_top_2'];

/** banner 条目凑到几项再逐项试徽标（错误契约可以只让前三项按严规则校验）。 */
const BANNER_LENGTH = 6;

function defs(): Obj {
  const all = homeSchema()['$defs'];
  expect(isObj(all), 'home-schema.json 的 $defs').toBe(true);
  return all as Obj;
}

function defName(ref: string): string {
  expect(ref.startsWith('#/$defs/'), `本文件 $defs 内的引用：${ref}`).toBe(true);
  return ref.slice('#/$defs/'.length);
}

function def(name: string): Obj {
  const node = defs()[name];
  expect(isObj(node), `$defs/${name}`).toBe(true);
  return node as Obj;
}

/** 该 page_key 的准入定义在 $defs 下的名字。 */
function admissionName(pageKey: string): string {
  return defName(admissionRef(pageKey));
}

/** 顺着 $ref 走到最终的定义。 */
function deref(node: unknown): Obj {
  let current = node;
  const seen = new Set<string>();
  let ref = isObj(current) ? current['$ref'] : undefined;
  while (typeof ref === 'string') {
    const name = defName(ref);
    expect(seen.has(name), `循环引用 $defs/${name}`).toBe(false);
    seen.add(name);
    current = def(name);
    ref = (current as Obj)['$ref'];
  }
  expect(isObj(current), 'schema 节点是对象').toBe(true);
  return current as Obj;
}

/** 从 $defs/<start> 出发、顺着本文件 $defs 内的 $ref（skip 里的定义不进）访问到的每个对象节点。 */
function reachableNodes(start: string, skip: string[]): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<string>([start, ...skip]);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isObj(node)) return;
    out.push(node);
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      const name = defName(ref);
      if (!seen.has(name)) {
        seen.add(name);
        walk(def(name));
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(def(start));
  return out;
}

/** 访问到的节点里 properties.<key> 处的 schema。 */
function propertyNodes(nodes: Obj[], key: string): Obj[] {
  const out: Obj[] = [];
  for (const node of nodes) {
    const schema = getAt(node, ['properties', key]);
    if (isObj(schema)) out.push(schema);
  }
  return out;
}

/** search 置顶卡试的 section id：契约里 properties.id 的常量与枚举、golden 里的 id，再加 EXTRA_SEARCH_IDS。 */
function searchIds(): string[] {
  const ids = new Set<string>(EXTRA_SEARCH_IDS);
  for (const golden of goldenPages()) {
    for (const section of sectionsOf(golden)) {
      const id = section['id'];
      if (typeof id === 'string') ids.add(id);
    }
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isObj(node)) return;
    const id = getAt(node, ['properties', 'id']);
    if (isObj(id)) {
      const listed = id['enum'];
      const values: unknown[] = [id['const']];
      if (Array.isArray(listed)) values.push(...listed);
      for (const value of values) {
        if (typeof value === 'string') ids.add(value);
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(homeSchema());
  return [...ids].sort();
}

let routesCache: Obj | undefined;
/** contracts/routes.json 的路由表。 */
function routeTable(): Obj {
  routesCache ??= readJson('contracts/routes.json');
  const routes = routesCache['routes'];
  expect(isObj(routes), 'routes.json 的 routes').toBe(true);
  return routes as Obj;
}

/** routes.json 里 entry 含 in_app 的路由名；bare 时只留 params 没有必填项的（可写成 params: {}）。 */
function inAppRoutes(bare: boolean): string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(routeTable())) {
    const entry = getAt(spec, ['entry']);
    if (!Array.isArray(entry) || !entry.includes('in_app')) continue;
    const required = getAt(spec, ['params', 'required']);
    if (bare && Array.isArray(required) && required.length > 0) continue;
    out.push(name);
  }
  expect(out.length, 'routes.json 里 entry 含 in_app 的路由').toBeGreaterThan(0);
  return out.sort();
}

/** 核心入口：CORE_ROUTES 并上契约 $defs/core_route 的枚举（契约的枚举必须包含 CORE_ROUTES）。 */
function coreRoutes(): string[] {
  const listed = def('core_route')['enum'];
  expect(Array.isArray(listed), '$defs/core_route 是枚举').toBe(true);
  const contract = (listed as unknown[]).filter((v): v is string => typeof v === 'string');
  for (const route of CORE_ROUTES) {
    expect(contract, `$defs/core_route 含 ${route}`).toContain(route);
  }
  return [...new Set([...CORE_ROUTES, ...contract])].sort();
}

/** me.more_services，条目依次跳 targets（以 me golden 的第一个条目为底，名称各不相同）。 */
function meWithTargets(targets: Obj[]): Obj {
  const section = goldenSection(ME, 'icon_grid');
  const first = itemsOf(section)[0];
  expect(first, 'me golden 的 more_services 至少一个条目').toBeDefined();
  const items = targets.map((target, i) => {
    const item = clone(first as Obj);
    item['action'] = clone(target);
    item['title'] = `格${i}`;
    return item;
  });
  section['data_source'] = { ...(section['data_source'] as Obj), items };
  return section;
}

function helpTargets(n: number): Obj[] {
  return Array.from({ length: n }, (_, i) => targetOf('Help', i));
}

/** me golden 的条目轮流取 n 个，再接上跳 extra 的条目（以 golden 第一个条目为底）。 */
function meGoldenCycled(n: number, extra: Obj[]): Obj {
  const section = goldenSection(ME, 'icon_grid');
  const golden = itemsOf(section);
  expect(golden.length, 'me golden 的条目').toBeGreaterThan(0);
  const items = Array.from({ length: n }, (_, i) => clone(golden[i % golden.length] as Obj));
  for (const target of extra) {
    items.push({ ...clone(golden[0] as Obj), title: '多一格', action: clone(target) });
  }
  section['data_source'] = { ...(section['data_source'] as Obj), items };
  return section;
}

/** 副本的静态条目轮流取原条目凑到 n 项（去掉徽标，补上的项换一张图）。 */
function lengthened(section: Obj, n: number): Obj {
  const next = clone(section);
  const items = itemsOf(next);
  expect(items.length, `${String(next['id'])} 的条目`).toBeGreaterThan(0);
  const out = Array.from({ length: n }, (_, i) => {
    const item = clone(items[i % items.length] as Obj);
    delete item['badge'];
    if (i >= items.length) item['image'] = `https://example.com/img/extra-${i}.png`;
    return item;
  });
  (next['data_source'] as Obj)['items'] = out;
  return next;
}

function noticeItems(section: Obj): Obj[] {
  const items = getAt(section, ['props', 'items']);
  return Array.isArray(items) ? items.filter(isObj) : [];
}

/** golden 里首页静态公告条（props.items 非空）的 section 副本。 */
function goldenNotice(): Obj {
  const found: Obj[] = [];
  for (const golden of goldenPages()) {
    if (golden['page_key'] !== HOME) continue;
    for (const section of sectionsOf(golden)) {
      if (section['type'] !== 'notice_bar') continue;
      if (noticeItems(section).length > 0) found.push(section);
    }
  }
  expect(found.length, `${GOLDEN_DIR} 里首页静态公告条`).toBeGreaterThan(0);
  return clone(found[0] as Obj);
}

/** 契约里声明了非 false 的 badge 属性的位置（按 $defs 下的定义名归并）。 */
function badgeHolders(): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) {
      for (const [i, child] of node.entries()) walk(child, [...path, String(i)]);
      return;
    }
    if (!isObj(node)) return;
    const badge = getAt(node, ['properties', 'badge']);
    if (badge !== undefined && badge !== false) out.add(path.slice(0, 2).join('/'));
    for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
  };
  walk(homeSchema(), []);
  return [...out].sort();
}

/** 第 i 个条目的 PNG / SVG 图标：文件以摘要命名，地址与摘要同在一个对象里（定稿 icon: {url, sha256}）。 */
function iconAsset(i: number, ext: string): Obj {
  const digest = `${String(i % 10).repeat(63)}${ext === 'svg' ? 'b' : 'a'}`;
  return { url: `https://media.example.test/icons/${digest}.${ext}`, sha256: digest };
}

/** me golden 的 more_services 副本：条目全换成 ext 图标，第 index 个的图标再经 edit 改过。 */
function meIcons(ext: string, index: number, edit: (icon: Obj) => unknown): Obj {
  const section = goldenSection(ME, 'icon_grid');
  for (const [i, item] of itemsOf(section).entries()) {
    const icon = iconAsset(i, ext);
    item['icon'] = i === index ? edit(icon) : icon;
  }
  return section;
}

function omit(value: Obj, key: string): Obj {
  const next = clone(value);
  delete next[key];
  return next;
}

it('[AC-CT-27b#11] search 置顶位的上限对整个 sections 数组算：准入定义自身 maxItems 为 1；契约与 golden 里出现过的各个 section id（含 search_top、search_products）配上各种 props 写法的 banner 与商品池 product_scroll，凡单放能收的，任两张同放（不同 id、不同类型、商品卡标题填「本周热销」也算）一律拒收；单放时整页与准入定义结论一致', () => {
  // BR-TEXT-28 准入表 search 行「结果页置顶位 1 个」；D10-2401 ①。spec-test r1 S1 第 1 条：错误契约另许
  // product_scroll 用 search_products，并把数组上限换成只约束 id=search_top 的 maxContains 1，运营就能把
  // search_top 横幅和标题「本周热销」的 search_products 商品卡一并提交。
  const admission = def(admissionName(SEARCH));
  expect(admission['type'], 'search 准入定义是 sections 数组').toBe('array');
  expect(admission['maxItems'], 'search 准入定义对整个 sections 数组限 1 项').toBe(1);
  const bases: [string, Obj][] = [
    ['banner', goldenSection(SEARCH, 'banner')],
    ['product_scroll', goldenSection(SEARCH, 'product_scroll')],
  ];
  const singles: Variant[] = [];
  for (const id of searchIds()) {
    for (const [type, base] of bases) {
      for (const variant of propVariants(type, base)) {
        const section = { ...variant.section, id };
        const name = `${variant.name} id=${id}`;
        const onPage = validPage(page(SEARCH, [section]));
        expect(admits(SEARCH, [section]), `${name} 单放：准入定义与整页一致`).toBe(onPage);
        if (onPage) singles.push({ name, section });
      }
    }
  }
  const types = [...new Set(singles.map((single) => String(single.section['type'])))];
  expect(types.sort(), '单放能收的置顶卡两种类型都有').toEqual(['banner', 'product_scroll']);
  for (const first of singles) {
    for (const second of singles) {
      const label = `置顶卡 ${first.name} + ${second.name}`;
      verdict(SEARCH, [first.section, second.section], false, label);
    }
  }
});

it('[AC-CT-27b#12] more_services 的上限钉在 items 数组自身：准入定义里 data_source.items 的 maxItems 恰为 12，只放帮助入口试出的上限也是 12；routes.json 里 entry 含 in_app、单放能收的每个非核心路由（含「我的收藏」Favorites、商品详情 ProductDetail）接在 11 格帮助后收，接在 12 格帮助前或后都拒收，同一路由 13 格拒收；golden 条目轮流凑满 12 格收，再加一格 Favorites 拒收', () => {
  // BR-TEXT-28 准入表 me 行（条目数上限由契约线定稿）；D10-2401 ②。spec-test r1 S1 第 2 条：错误契约把 maxItems 12
  // 换成只统计 action.route 不是 Favorites 的 maxContains 12，12 格帮助入口再加一格「我的收藏」，13 格仍会通过。
  const slot = deref(getAt(def(admissionName(ME)), ['items']));
  const items = getAt(slot, ['properties', 'data_source', 'properties', 'items']);
  expect(isObj(items), 'more_services 准入定义里 data_source.items 的定义').toBe(true);
  expect((items as Obj)['type'], 'data_source.items 是数组').toBe('array');
  expect((items as Obj)['maxItems'], 'items 数组自身的 maxItems').toBe(ME_CAP);
  expect(meCap(), '只放帮助入口时试出的上限').toBe(ME_CAP);
  const excluded = ['ExternalPage', 'WebPage', ...coreRoutes()];
  const bare = inAppRoutes(true).filter((route) => !excluded.includes(route));
  const candidates: [string, Obj][] = [
    ...bare.map((route): [string, Obj] => [route, { route, params: {} }]),
    ...KINDS.map((kind): [string, Obj] => [kind, targetOf(kind, ME_CAP)]),
  ];
  const accepted: string[] = [];
  for (const [name, target] of candidates) {
    if (!validPage(page(ME, [meWithTargets([target])]))) continue;
    accepted.push(name);
    const label = `1 格跳 ${name}`;
    const under = meWithTargets([...helpTargets(ME_CAP - 1), target]);
    const after = meWithTargets([...helpTargets(ME_CAP), target]);
    const before = meWithTargets([target, ...helpTargets(ME_CAP)]);
    const same = meWithTargets(Array.from({ length: ME_CAP + 1 }, () => target));
    verdict(ME, [under], true, `${ME_CAP - 1} 格帮助 + ${label}`);
    verdict(ME, [after], false, `${ME_CAP} 格帮助 + ${label}`);
    verdict(ME, [before], false, `${label} + ${ME_CAP} 格帮助`);
    verdict(ME, [same], false, `${ME_CAP + 1} 格都跳 ${name}`);
  }
  expect(accepted, '单放能收的路由含「我的收藏」').toContain('Favorites');
  expect(accepted, '单放能收的路由含商品详情').toContain('ProductDetail');
  const favorites = { route: 'Favorites', params: {} };
  const full = meGoldenCycled(ME_CAP, []);
  const over = meGoldenCycled(ME_CAP, [favorites]);
  verdict(ME, [full], true, `golden 条目轮流凑满 ${ME_CAP} 格`);
  verdict(ME, [over], false, `${ME_CAP} 格 golden 条目 + 1 格 Favorites`);
});

it('[AC-CT-27b#13] 徽标在 banner 的每个下标都不收、首页公告条目也不收：契约里声明了 badge 属性（非 false）的只有 icon_grid_item 与 me_item 两处定义，横幅、公告条与 search 准入一路引用到的数组定义都不用 prefixItems 分段；首页与 search 置顶 banner 凑到 6 项后，me golden 的各种徽标放在任一项都拒收（含第四项红点）；首页静态公告条的任一条目带徽标也拒收', () => {
  // BR-TEXT-29 细则「徽标」：本批徽标只用于 icon_grid 条目；D10-2401 ③。spec-test r1 S1 第 3 条：错误契约用
  // prefixItems 只让前三个 banner 条目按严规则校验，第四条可带 {kind:'dot'}；或在 notice_item.properties 声明
  // badge，让首页普通公告带红点。
  const holders = ['$defs/icon_grid_item', '$defs/me_item'];
  expect(badgeHolders(), '声明了 badge 属性的定义').toEqual(holders);
  for (const scope of ['section_banner', 'section_notice_bar', admissionName(SEARCH)]) {
    const nodes = reachableNodes(scope, []);
    const tuples = nodes.filter((node) => Object.hasOwn(node, 'prefixItems'));
    expect(tuples.length, `$defs/${scope} 一路引用到的数组定义不用 prefixItems`).toBe(0);
  }
  const badges = goldenBadges();
  const homeBanner = lengthened(goldenSection(HOME, 'banner'), BANNER_LENGTH);
  const searchBanner = lengthened(goldenSection(SEARCH, 'banner'), BANNER_LENGTH);
  check(homeOk(homeBanner), true, `首页 banner 凑到 ${BANNER_LENGTH} 项（不带徽标）`);
  verdict(SEARCH, [searchBanner], true, `search banner 凑到 ${BANNER_LENGTH} 项（不带徽标）`);
  for (let index = 0; index < BANNER_LENGTH; index += 1) {
    for (const value of badges) {
      const shown = `第 ${index} 项带徽标 ${JSON.stringify(value)}`;
      const onHome = withItemKey(homeBanner, index, 'badge', value);
      const onSearch = withItemKey(searchBanner, index, 'badge', value);
      check(homeOk(onHome), false, `首页 banner ${shown}`);
      verdict(SEARCH, [onSearch], false, `search banner ${shown}`);
    }
  }
  const notice = goldenNotice();
  check(homeOk(notice), true, '首页 golden 的静态公告条');
  const count = noticeItems(notice).length;
  for (let index = 0; index < count; index += 1) {
    for (const value of badges) {
      const edited = clone(notice);
      (noticeItems(edited)[index] as Obj)['badge'] = clone(value);
      check(homeOk(edited), false, `首页公告条第 ${index} 条带徽标 ${JSON.stringify(value)}`);
    }
  }
});

it('[AC-CT-27b#14] product_scroll 的 more_action 与静态条目引用同一个站内目标定义：search 准入定义里的 more_action、banner 条目 action 与 more_services 条目 action 都只是同一个 $ref；routes.json 的每个 in_app 路由、$defs/core_route 的全部核心入口、ExternalPage、WebPage（带与不带 params）放进三处与该定义本身，结论都相同；核心入口（含 WithdrawRecords）与外链在 more_action 处一律拒收', () => {
  // BR-TEXT-30 细则「跳转目标」、BR-TEXT-28 不可配清单；D10-2401 ④（D10-2383）。spec-test r1 S1 第 4 条：错误契约给
  // more_action 复制一份 in_app_target，只在副本的禁用路由里漏掉 WithdrawRecords，搜索置顶商品卡就收提现记录入口。
  const searchNodes = reachableNodes(admissionName(SEARCH), ['section']);
  const meNodes = reachableNodes(admissionName(ME), ['section']);
  const groups: [string, Obj[]][] = [
    ['search 置顶 product_scroll 的 more_action', propertyNodes(searchNodes, 'more_action')],
    ['search 置顶 banner 条目的 action', propertyNodes(searchNodes, 'action')],
    ['more_services 条目的 action', propertyNodes(meNodes, 'action')],
  ];
  const allowed = ['$ref', ...ANNOTATIONS];
  const refs = new Set<string>();
  for (const [name, nodes] of groups) {
    expect(nodes.length, `${name} 的定义`).toBeGreaterThan(0);
    for (const node of nodes) {
      const extra = Object.keys(node).filter((key) => !allowed.includes(key));
      expect(extra, `${name} 只引用共用定义，不另加约束`).toEqual([]);
      expect(node['$ref'], `${name} 是 $ref`).toBeTypeOf('string');
      refs.add(String(node['$ref']));
    }
  }
  expect([...refs], 'more_action 与静态条目引用同一个站内目标定义').toHaveLength(1);
  const { $schema, $defs } = homeSchema();
  const target = compileStrict({ $schema, $defs, $ref: [...refs][0] as string });
  const forbidden = ['ExternalPage', ...coreRoutes()];
  const scroll = goldenSection(SEARCH, 'product_scroll');
  const banner = goldenSection(SEARCH, 'banner');
  const me = goldenSection(ME, 'icon_grid');
  const routes = [...new Set([...forbidden, ...inAppRoutes(false), 'WebPage'])].sort();
  for (const route of routes) {
    const forms: Obj[] = [{ route }, { route, params: {} }];
    if (route === 'ExternalPage') forms.push(EXTERNAL);
    for (const form of forms) {
      const shown = JSON.stringify(form);
      const more = validPage(page(SEARCH, [withMoreAction(scroll, form)]));
      const item = validPage(page(SEARCH, [withItemKey(banner, 0, 'action', form)]));
      const meItem = validPage(page(ME, [withItemKey(me, 0, 'action', form)]));
      expect(more, `${shown}：more_action 与共用定义同一结论`).toBe(target(clone(form)));
      expect(more, `${shown}：more_action 与 search banner 条目同一结论`).toBe(item);
      expect(more, `${shown}：more_action 与 more_services 条目同一结论`).toBe(meItem);
      if (!forbidden.includes(route)) continue;
      const admitted = admits(SEARCH, [withMoreAction(scroll, form)]);
      check(more, false, `more_action=${shown}（整页）`);
      check(admitted, false, `more_action=${shown}（准入定义）`);
    }
  }
});

it('[AC-CT-27b#15] more_services 图标的摘要不分文件格式都必填：准入定义里条目 icon 的定义（顺着引用）封闭、必填 url 与 sha256；条目全换成以摘要命名的 PNG 或 SVG 图标 {url, sha256} 都收；任一条目的 PNG 或 SVG 图标删掉 sha256、删掉 url、sha256 置 null、改成纯地址，都拒收', () => {
  // BR-TEXT-30 细则「图标」（grid/ 规格 PNG 或 SVG，下发带摘要）；D10-2401 ⑤（定稿 icon: {url, sha256}）。spec-test r1
  // S1 第 5 条：错误契约只在 PNG 分支要求 sha256、SVG 分支只要求 url，「签到说明」配 SVG 时客户端没有这张图的摘要。
  const icons = propertyNodes(reachableNodes(admissionName(ME), ['section']), 'icon');
  expect(icons.length, 'more_services 条目的 icon 定义').toBeGreaterThan(0);
  for (const node of icons) {
    const asset = deref(node);
    expect(asset['additionalProperties'], 'icon 对象封闭').toBe(false);
    const listed = asset['required'];
    const required = Array.isArray(listed) ? listed : [];
    expect(required, 'icon 必填图片地址').toContain('url');
    expect(required, 'icon 必填摘要').toContain('sha256');
  }
  const count = itemsOf(goldenSection(ME, 'icon_grid')).length;
  const edits: [string, (icon: Obj) => unknown][] = [
    ['删掉 sha256', (icon) => omit(icon, 'sha256')],
    ['删掉 url', (icon) => omit(icon, 'url')],
    ['sha256 置 null', (icon) => ({ ...icon, sha256: null })],
    ['改成纯地址', (icon) => icon['url']],
  ];
  for (const ext of ['png', 'svg']) {
    verdict(ME, [meIcons(ext, -1, (icon) => icon)], true, `条目全换成 .${ext} 图标`);
    for (let index = 0; index < count; index += 1) {
      for (const [name, edit] of edits) {
        const label = `第 ${index} 个条目的 .${ext} 图标${name}`;
        verdict(ME, [meIcons(ext, index, edit)], false, label);
      }
    }
  }
});
