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
