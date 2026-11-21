// CT-27: operation slots of contracts/home-schema.json (BR-TEXT-28～30) and the console's search
// settings writes of openapi.yaml — the six points the orchestrator requires (D10-2401 ①～⑥), each
// with its golden counter-example where one exists. Static reads only; same strict Ajv loader as
// home-schema.test.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';

const apiRequire = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
interface ValidateFn {
  (data: unknown): boolean;
  errors?: unknown;
}
interface Validator {
  addFormat(name: string, format: { type: 'number'; validate: (value: number) => boolean }): void;
  compile(schema: object): ValidateFn;
}
const { Ajv2020 } = apiRequire('ajv/dist/2020.js') as {
  Ajv2020: new (options: { strict: true; allErrors: true }) => Validator;
};
const addFormats = apiRequire('ajv-formats') as (ajv: Validator) => void;
const { dereference } = apiRequire('@readme/openapi-parser') as {
  dereference(path: string): Promise<unknown>;
};

type Json = Record<string, unknown>;
type Page = Json & { sections: Json[] };

const contractsDir = new URL('../../../contracts/', import.meta.url);
const goldenDir = new URL('fixtures/home-golden/', contractsDir);
const invalidDir = new URL('invalid/', goldenDir);

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}
const clone = <T>(value: T): T => structuredClone(value);

const schema = readJson<Json & { $defs: Json }>(new URL('home-schema.json', contractsDir));

function newAjv(): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  ajv.addFormat('int32', {
    type: 'number',
    validate: (value) => Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 - 1,
  });
  ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
  return ajv;
}

let page: ValidateFn;
const admission: Record<string, ValidateFn> = {};
let doc: { paths: Record<string, Record<string, Json>> };

beforeAll(async () => {
  page = newAjv().compile(schema);
  for (const key of ['home', 'me', 'search']) {
    admission[key] = newAjv().compile({
      $schema: schema['$schema'],
      $defs: schema.$defs,
      $ref: `#/$defs/admission_${key}`,
    });
  }
  doc = (await dereference(fileURLToPath(new URL('openapi.yaml', contractsDir)))) as typeof doc;
});

/** Whole page and the page's admission definition agree (04 §6.2「运营位」①). */
function expectSections(pageKey: 'home' | 'me' | 'search', sections: Json[], valid: boolean): void {
  const whole = { page_key: pageKey, version: 1, ttl_sec: 300, sections: clone(sections) };
  expect(page(whole), `${pageKey} page: ${JSON.stringify(page.errors ?? null)}`).toBe(valid);
  expect(admission[pageKey]!(clone(sections)), `admission_${pageKey}`).toBe(valid);
}

const golden = (name: string): Page => readJson<Page>(new URL(name, goldenDir));
const invalid = (name: string): Page => readJson<Page>(new URL(name, invalidDir));

function items(section: Json): Json[] {
  return (section['data_source'] as { items: Json[] }).items;
}

const banner = (): Json => clone(golden('search-top-banner.json').sections[0]!);
const scroll = (): Json => clone(golden('search-top-products.json').sections[0]!);
const meGrid = (): Json => clone(golden('me-more-services.json').sections[0]!);
const homeFull = (): Page => golden('home-full.json');
const homeSection = (type: string): Json =>
  clone(homeFull().sections.find((s) => s['type'] === type)!);

const EXTERNAL = { route: 'ExternalPage', params: { url: 'https://example.com/activity/autumn' } };
const IN_APP = [
  { route: 'Help', params: { article_id: 'guide' } },
  { route: 'HotRankList', params: { platform: 'pdd' } },
  { route: 'Search', params: { q: '纸巾' } },
  { route: 'Notice' },
  { route: 'WebPage', params: { url: 'https://h5.example.com/topic/x' } },
];

it('[AC-CT-27-MUST#1] search 置顶位至多一张，不论卡的类型；单张卡带不带可选 props 都收，任意两张（同类、异类、任一顺序、带不带 props）都拒收', () => {
  const bare = (section: Json): Json => {
    const next = clone(section);
    delete next['props'];
    return next;
  };
  const cards = [banner(), scroll(), bare(banner()), bare(scroll())];
  for (const card of cards) expectSections('search', [card], true);
  for (const a of cards) {
    for (const b of cards) expectSections('search', [clone(a), clone(b)], false);
  }
  // golden 反例：两张置顶卡；去掉第二张即通过。
  const two = invalid('search-two-top-slots.json');
  expect(page(two)).toBe(false);
  expect(page({ ...two, sections: two.sections.slice(0, 1) })).toBe(true);
});

it('[AC-CT-27-MUST#2] me.more_services 的条目上限 12 对整个 items 数组计，与跳转类型无关', () => {
  const grid = meGrid();
  const base = items(grid)[0]!;
  const withItems = (targets: Json[]): Json => {
    const next = clone(grid);
    (next['data_source'] as { items: Json[] }).items = targets.map((action) => ({
      ...clone(base),
      action: clone(action),
    }));
    return next;
  };
  const mixed = Array.from({ length: 12 }, (_, i) => IN_APP[i % IN_APP.length]!);
  expectSections('me', [withItems(mixed)], true);
  for (const last of IN_APP) {
    expectSections('me', [withItems([...mixed, last])], false);
    expectSections('me', [withItems(Array.from({ length: 13 }, () => last))], false);
    expectSections('me', [withItems(Array.from({ length: 12 }, () => last))], true);
  }
  expectSections('me', [withItems([])], false);
  // golden 反例：13 个条目、跳转轮换四种；截到 12 个即通过。
  const over = invalid('me-items-over-limit.json');
  expect(page(over)).toBe(false);
  const cut = clone(over);
  const section = cut.sections[0]!;
  (section['data_source'] as { items: Json[] }).items = items(section).slice(0, 12);
  expect(page(cut)).toBe(true);
});

it('[AC-CT-27-MUST#3] 徽标只在 icon_grid 条目上：banner（首页与 search）、活动入口、弹窗的任一条目带徽标都拒收', () => {
  const dot = { kind: 'dot' };
  const cases: ['home' | 'search', Json][] = [
    ['home', homeSection('banner')],
    ['home', homeSection('activity_entry')],
    ['home', homeSection('popup')],
    ['search', banner()],
  ];
  for (const [pageKey, section] of cases) {
    expectSections(pageKey, [clone(section)], true);
    items(section).forEach((_, i) => {
      const next = clone(section);
      items(next)[i]!['badge'] = dot;
      expectSections(pageKey, [next], false);
    });
  }
  // icon_grid 条目照收（首页金刚区与 me）。
  const icons = homeSection('icon_grid');
  items(icons)[1]!['badge'] = dot;
  expectSections('home', [icons], true);
  // golden 反例：首页 banner 第二项带红点；去掉即通过。
  const bad = invalid('banner-item-badge.json');
  expect(page(bad)).toBe(false);
  const fixed = clone(bad);
  delete items(fixed.sections[0]!)[1]!['badge'];
  expect(page(fixed)).toBe(true);
});

it('[AC-CT-27-MUST#4] search 商品滚动卡的「更多」props.more_action（第 1 版客户端的键名）与同页静态条目同一套站内白名单：外链、非 https 的 WebPage、核心入口拒收；首页商品滚动卡同首页静态条目照旧', () => {
  const withMore = (section: Json, action: Json): Json => {
    const next = clone(section);
    next['props'] = { ...(next['props'] as Json), more_action: action };
    return next;
  };
  for (const action of IN_APP) expectSections('search', [withMore(scroll(), action)], true);
  for (const action of [
    EXTERNAL,
    { route: 'WebPage', params: { url: 'http://h5.example.com/x' } },
    { route: 'WebPage' },
    { route: 'Withdraw' },
    { route: 'LaborAgreement', params: {} },
  ]) {
    expectSections('search', [withMore(scroll(), action)], false);
    // 同页静态条目（search banner）同样拒收。
    const b = banner();
    items(b)[0]!['action'] = action;
    expectSections('search', [b], false);
  }
  // 首页原有类型照旧可用 ExternalPage（BR-TEXT-30 适用范围），more_action 同首页静态条目。
  expectSections('home', [withMore(homeSection('product_scroll'), EXTERNAL)], true);
  // search 不收第 1 版以外的新键（如 more: {text, action}），避免同一按钮两种写法。
  const other = scroll();
  other['props'] = { title: '今日好价', more: { text: '更多', action: IN_APP[0] } };
  expectSections('search', [other], false);
  // golden 反例：search 的「更多」跳外链；换成站内路由即通过。
  const bad = invalid('search-more-external.json');
  expect(page(bad)).toBe(false);
  const fixed = clone(bad);
  (fixed.sections[0]!['props'] as Json)['more_action'] = IN_APP[1];
  expect(page(fixed)).toBe(true);
});

it('[AC-CT-27-MUST#5] me 的图标摘要与实际显示的图片绑在同一对象 icon {url, sha256} 里：缺一、摘要放在别处、旁边另带 image、地址文件名不是摘要都拒收', () => {
  const grid = meGrid();
  for (const item of items(grid)) {
    const icon = item['icon'] as { url: string; sha256: string };
    expect(new URL(icon.url).pathname.split('/').pop()).toBe(`${icon.sha256}.png`);
  }
  expectSections('me', [grid], true);
  const mutate = (change: (item: Json) => void): Json => {
    const next = clone(grid);
    change(items(next)[1]!);
    return next;
  };
  const sha = (items(grid)[1]!['icon'] as { sha256: string }).sha256;
  for (const change of [
    (item: Json) => delete (item['icon'] as Json)['sha256'],
    (item: Json) => delete (item['icon'] as Json)['url'],
    (item: Json) => delete item['icon'],
    (item: Json) => {
      delete (item['icon'] as Json)['sha256'];
      item['sha256'] = sha;
    },
    (item: Json) => {
      item['image'] = 'https://example.com/img/other.png';
    },
    (item: Json) => {
      (item['icon'] as Json)['image'] = 'https://example.com/img/other.png';
    },
    (item: Json) => {
      (item['icon'] as Json)['url'] = 'https://media.example.test/icons/help.png';
    },
    (item: Json) => {
      (item['icon'] as Json)['url'] = `http://media.example.test/icons/${sha}.png`;
    },
  ]) {
    expectSections('me', [mutate(change)], false);
  }
  // 首页金刚区沿用旧形状（契约评审 r1 S1）：绑定只对 me 生效，首页 icon 可以是旧的图片地址字符串。
  const icons = homeSection('icon_grid');
  delete items(icons)[0]!['image'];
  items(icons)[0]!['icon'] = 'https://img.example.com/icon-a.png';
  expectSections('home', [icons], true);
  // 同一个旧形状条目放进 me 即拒收（me 只收 icon {url, sha256}）。
  const legacy = clone(items(grid)[0]!);
  legacy['icon'] = 'https://img.example.com/icon-a.png';
  const meLegacy = clone(grid);
  items(meLegacy)[0] = legacy;
  expectSections('me', [meLegacy], false);
  // golden 反例：摘要离开图标对象 / 图标旁另带 image。
  for (const name of ['me-icon-digest-unbound.json', 'me-icon-and-image.json']) {
    expect(page(invalid(name)), name).toBe(false);
  }
  const unbound = clone(invalid('me-icon-digest-unbound.json'));
  const first = items(unbound.sections[0]!)[0]!;
  (first['icon'] as Json)['sha256'] = first['sha256'];
  delete first['sha256'];
  expect(page(unbound)).toBe(true);
});

type Op = Json & {
  operationId: string;
  requestBody: { required: boolean; content: { 'application/json': { schema: Json } } };
};

/** Every property name below a (dereferenced) schema. */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const child of node) propertyNames(child, out);
  else if (typeof node === 'object' && node !== null) {
    const object = node as Json;
    if (typeof object['properties'] === 'object' && object['properties'] !== null) {
      for (const name of Object.keys(object['properties'] as Json)) out.add(name);
    }
    for (const [key, child] of Object.entries(object)) {
      if (key !== 'example' && key !== 'examples') propertyNames(child, out);
    }
  }
  return out;
}

it('[AC-CT-27-MUST#6] 热词、关键词直达、默认词各有自己的写操作：请求体封闭、没有可选的配置键，列表不能交给另一个操作；没有同时收两种列表的写操作', () => {
  const writes: [string, string, string, Json][] = [
    [
      '/admin/v1/search/hot-words',
      'adminUpdateSearchHotWords',
      'hot_words',
      { hot_words: [{ text: '洗衣液' }] },
    ],
    [
      '/admin/v1/search/keyword-routes',
      'adminUpdateSearchKeywordRoutes',
      'keyword_routes',
      { keyword_routes: [{ keyword: '热销榜', target: { route: 'HotRankList', params: {} } }] },
    ],
    [
      '/admin/v1/search/default-word',
      'adminUpdateSearchDefaultWord',
      'default_word',
      { default_word: '洗衣液' },
    ],
  ];
  const compiled = writes.map(([path, id, field, body]) => {
    const op = doc.paths[path]!['put'] as Op;
    expect(op.operationId).toBe(id);
    expect(op.requestBody.required).toBe(true);
    const bodySchema = op.requestBody.content['application/json'].schema;
    expect(bodySchema['additionalProperties']).toBe(false);
    expect(bodySchema['required']).toEqual([field, 'expected_version']);
    const names = propertyNames(bodySchema);
    for (const key of ['key', 'config_key', 'item', 'name'])
      expect(names.has(key), `${id} ${key}`).toBe(false);
    const validate = newAjv().compile(bodySchema);
    expect(validate({ ...body, expected_version: 0 }), `${id} own value`).toBe(true);
    return { id, field, body, validate };
  });
  for (const a of compiled) {
    for (const b of compiled) {
      if (a === b) continue;
      expect(a.validate({ ...b.body, expected_version: 0 }), `${a.id} refuses ${b.field}`).toBe(
        false,
      );
      expect(
        a.validate({ ...a.body, ...b.body, expected_version: 0 }),
        `${a.id} + ${b.field}`,
      ).toBe(false);
    }
  }
  // 没有任何 /admin/v1 写操作的请求体同时出现 hot_words 与 keyword_routes。
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/admin/v1/')) continue;
    for (const method of ['post', 'put', 'patch']) {
      const op = item[method] as Op | undefined;
      if (op?.requestBody === undefined) continue;
      const names = propertyNames(op.requestBody);
      expect(names.has('hot_words') && names.has('keyword_routes'), `${method} ${path}`).toBe(
        false,
      );
    }
  }
});

it('[AC-CT-27] golden 反例各只因一处被拒：超长徽标、外链、表外类型、UTC 结束时刻改正后即通过', () => {
  const fixes: [string, (p: Page) => void][] = [
    ['me-badge-overlong.json', (p) => delete items(p.sections[0]!)[0]!['badge']],
    ['me-external-page.json', (p) => (items(p.sections[0]!)[1]!['action'] = IN_APP[0])],
    ['me-unlisted-type.json', (p) => (p.sections = p.sections.slice(0, 1))],
    ['search-unlisted-type.json', (p) => (p.sections = p.sections.slice(0, 1))],
    [
      'me-item-end-at-utc.json',
      (p) => (items(p.sections[0]!)[2]!['end_at'] = '2026-11-12T08:00:00+08:00'),
    ],
  ];
  for (const [name, fix] of fixes) {
    const bad = invalid(name);
    expect(page(bad), name).toBe(false);
    const fixed = clone(bad);
    fix(fixed);
    expect(page(fixed), `${name} fixed: ${JSON.stringify(page.errors ?? null)}`).toBe(true);
  }
});

const vectors = readJson<{
  goldenPages: Record<string, { sections: Json[] }>;
  popup: { name: string; popup: Json; expect: { decisionRaw: string } }[];
}>(new URL('../../../specs/client/home-sdui-vectors.json', import.meta.url));

/** A legacy string badge (CT-07a client vectors), not the BR-TEXT-29 badge object. */
const hasStringBadge = (section: Json): boolean =>
  items(section).some((item) => typeof item['badge'] === 'string');

it('[AC-CT-27] 兼容：客户端第 1 版向量里首页的金刚区、商品滚动卡与纯展示弹窗照旧通过（icon 为图片地址字符串、props.more_action、items 为空的弹窗）；只有字符串徽标按 BR-TEXT-29 拒收，换成徽标对象即通过', () => {
  const sections = Object.values(vectors.goldenPages)
    .flatMap((p) => p.sections)
    // ad_label 只许 banner 是 CT-07a 的既有规则（BR-TEXT-17），与本单无关，带它的向量不在比较范围。
    .filter((s) => ['icon_grid', 'product_scroll', 'popup'].includes(String(s['type'])))
    .filter((s) => s['ad_label'] === undefined);
  expect(sections.map((s) => s['type'])).toEqual(
    expect.arrayContaining(['icon_grid', 'product_scroll', 'popup']),
  );
  const legacyIcon = vectors.goldenPages['icon_grid']!.sections[0]!;
  expect(items(legacyIcon).some((item) => typeof item['icon'] === 'string')).toBe(true);
  const scrollVector = vectors.goldenPages['product_scroll']!.sections[0]!;
  expect((scrollVector['props'] as Json)['more_action']).toBeDefined();
  for (const section of sections) {
    if (section['type'] === 'icon_grid' && hasStringBadge(section)) {
      // 与 BR-TEXT-29（徽标只有无 / 红点 / 至多 2 字三种，首页金刚区同）及规则测试 AC-CT-27#8 冲突：只列不改。
      expectSections('home', [clone(section)], false);
      const fixed = clone(section);
      for (const item of items(fixed)) {
        if (typeof item['badge'] === 'string') {
          item['badge'] = { kind: 'text', text: item['badge'] };
        }
      }
      expectSections('home', [fixed], true);
      continue;
    }
    expectSections('home', [clone(section)], true);
  }
  // 纯展示弹窗（只有 props.image、items 为 []）是合法 section，客户端向量预期照常展示。
  const shown = vectors.popup.filter((v) => v.expect.decisionRaw === 'show');
  expect(shown.length).toBeGreaterThan(0);
  for (const v of vectors.popup) {
    expect(items(v.popup)).toEqual([]);
    expectSections('home', [clone(v.popup)], true);
  }
  // getPage 的说明：没有条目的 section 不下发只限依赖条目渲染、条目又被过滤完的；纯展示弹窗照常下发。
  const description = String((doc.paths['/v1/pages/{page_key}']!['get'] as Json)['description']);
  expect(description).toMatch(/whose rendering depends on its items/);
  expect(description).toMatch(
    /display-only popup[\s\S]*is still sent|still sent[\s\S]*display-only popup/,
  );
  expect(description).not.toMatch(/a section left with no item is not sent/);
});

it('[AC-CT-27] 核心入口（BR-TEXT-28 不可配清单，含协议入口 LaborAgreement）在 me 与 search 一律拒收，空参数也拒；golden 反例只因签署协议一格被拒', () => {
  const core = (schema['$defs'] as Record<string, { enum: string[] }>)['core_route']!.enum;
  for (const route of ['LaborAgreement', 'Agreement', 'AuthManage', 'PrivacyCenter', 'Withdraw']) {
    expect(core, route).toContain(route);
  }
  const routes = readJson<{ routes: Record<string, unknown> }>(
    new URL('routes.json', contractsDir),
  ).routes;
  for (const route of core) {
    expect(routes[route], `${route} 在 routes.json 登记`).toBeDefined();
    for (const action of [{ route }, { route, params: {} }]) {
      const grid = meGrid();
      items(grid)[1]!['action'] = action;
      expectSections('me', [grid], false);
      const b = banner();
      items(b)[0]!['action'] = action;
      expectSections('search', [b], false);
      // 首页原有类型不在 BR-TEXT-30 适用范围，照旧（金刚区的订单入口是既有 golden）。
      const icons = homeSection('icon_grid');
      items(icons)[0]!['action'] = action;
      expectSections('home', [icons], true);
    }
  }
  const bad = invalid('me-labor-agreement.json');
  expect(page(bad)).toBe(false);
  const fixed = clone(bad);
  const last = items(fixed.sections[0]!).at(-1)!;
  expect(last['action']).toEqual({ route: 'LaborAgreement', params: {} });
  last['action'] = IN_APP[0];
  expect(page(fixed)).toBe(true);
});

it('[AC-CT-27] 热词、关键词直达的关键词与默认词至少含一个非空白字符：只含空格（含全角空格）的条目拒收（20001，示例在案）；首尾带空格但有字照收', () => {
  const body = (path: string): ValidateFn => {
    const op = doc.paths[path]!['put'] as Op;
    return newAjv().compile(op.requestBody.content['application/json'].schema);
  };
  const hot = body('/admin/v1/search/hot-words');
  const keyword = body('/admin/v1/search/keyword-routes');
  const word = body('/admin/v1/search/default-word');
  const target = { route: 'HotRankList', params: {} };
  for (const blank of [' ', '  ', '　', '\t', ' 　 ']) {
    expect(
      hot({ hot_words: [{ text: '洗衣液' }, { text: blank }], expected_version: 3 }),
      `hot ${JSON.stringify(blank)}`,
    ).toBe(false);
    expect(
      keyword({ keyword_routes: [{ keyword: blank, target }], expected_version: 1 }),
      `keyword ${JSON.stringify(blank)}`,
    ).toBe(false);
    expect(
      word({ default_word: blank, expected_version: 0 }),
      `word ${JSON.stringify(blank)}`,
    ).toBe(false);
  }
  expect(hot({ hot_words: [{ text: '洗衣液' }, { text: ' 纸巾 ' }], expected_version: 3 })).toBe(
    true,
  );
  expect(keyword({ keyword_routes: [{ keyword: '热销 榜', target }], expected_version: 1 })).toBe(
    true,
  );
  expect(word({ default_word: null, expected_version: 0 })).toBe(true);
  // 20001 示例：第二项只含空格时 data.fields 指向它。
  const examples = (doc as unknown as { components: { examples: Record<string, Json> } }).components
    .examples;
  const fieldsOf = (name: string): unknown =>
    ((examples[name]!['value'] as Json)['data'] as Json)['fields'];
  expect(fieldsOf('AdminSearchHotWordsBlank')).toEqual(['hot_words.1.text']);
  expect(fieldsOf('AdminSearchKeywordBlank')).toEqual(['keyword_routes.0.keyword']);
  expect(fieldsOf('AdminSearchDefaultWordBlank')).toEqual(['default_word']);
  for (const [path, name] of [
    ['/admin/v1/search/hot-words', 'blankEntry'],
    ['/admin/v1/search/keyword-routes', 'blankKeyword'],
    ['/admin/v1/search/default-word', 'blankWord'],
  ] as const) {
    const op = doc.paths[path]!['put'] as Json;
    const responses = op['responses'] as Record<string, Json>;
    const error = (responses['4XX']!['content'] as Record<string, Json>)['application/json']!;
    const listed = error['examples'] as Record<string, Json>;
    expect((listed[name]!['value'] as Json)['code'] as number, `${path} ${name}`).toBe(20001);
  }
});

it('[AC-CT-27] 四个 /admin/v1/search/* 操作显式声明 x-signed: false（admin 鉴权、不签名）', () => {
  const ops: [string, string][] = [
    ['/admin/v1/search/settings', 'get'],
    ['/admin/v1/search/hot-words', 'put'],
    ['/admin/v1/search/keyword-routes', 'put'],
    ['/admin/v1/search/default-word', 'put'],
  ];
  for (const [path, method] of ops) {
    const op = doc.paths[path]![method] as Json;
    expect(Object.hasOwn(op, 'x-signed'), `${method} ${path}`).toBe(true);
    expect(op['x-signed'], `${method} ${path}`).toBe(false);
    expect(op['x-auth'], `${method} ${path}`).toBe('admin');
  }
});
