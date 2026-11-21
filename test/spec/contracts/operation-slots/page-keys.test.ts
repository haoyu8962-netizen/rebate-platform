// CT-27 · page_key 与准入表（08 BR-TEXT-28「运营位的位置、准入与不可配项」及细则「准入表」「分批」「不可配清单」；
// 04 §6.2 `GET /v1/pages/{page_key}` 行与「运营位」①）。AC-CT-27#n 是本单验收点的本地分组。
import { expect, it } from 'vitest';
import {
  BATCH2_TYPES,
  ME,
  MORE_SERVICES,
  NO_SLOT_PAGE_KEYS,
  REGISTERED,
  SEARCH,
  SEARCH_ADMITTED,
  SEARCH_TOP_ID,
  admissionEntries,
  admittedSearch,
  at,
  batch2Section,
  clone,
  compileOpenapi,
  expectPage,
  homeSection,
  isValidPage,
  meBase,
  moreServices,
  object,
  openapi,
  page,
  pageKeyDefinitions,
  resolve,
  searchBase,
  searchCandidates,
  sectionsOf,
  type Obj,
} from './kit.ts';

const GOOD_KEYS = [ME, SEARCH, 'home', 'custom:autumn_promo'];
// 表外的 page_key 一律拒收（BR-TEXT-28 细则「准入表」）；订单页、钱包页不设运营位（细则「不可配清单」末项）；
// custom:<slug> 的 slug 规则照旧。
const BAD_KEYS = [
  ...NO_SLOT_PAGE_KEYS,
  'mine',
  'Me',
  'ME',
  'me ',
  ' search',
  'search:hot',
  'searches',
  'my',
  'custom:',
  '',
];

/** 不在准入表里的类型：批 2 的建议名与一个未注册的名字（BR-TEXT-28「表外的 page_key 与类型一律拒收」）。 */
const UNLISTED_TYPES = [...BATCH2_TYPES, 'member_banner'];

it('[AC-CT-27#1] page_key 收 me、search（home、custom:<slug> 照旧），表外的 page_key（含 wallet、orders）拒收；GET /v1/pages/{page_key} 的 PageKeyPath 同口径', () => {
  // BR-TEXT-28：page_key 为 home、me、search、custom:<slug>；批 1 新增 me、search（04 §6.2）。
  // 空页（sections 为空数组）是合法下发：me 被回滚到空版本、或过滤后为空，客户端回落内置默认格子。
  for (const key of GOOD_KEYS) expectPage(page(key, []), true, `page_key=${key} 的空页`);
  for (const key of BAD_KEYS) expectPage(page(key, []), false, `page_key=${JSON.stringify(key)}`);

  const doc = openapi();
  const param = resolve(doc, at(doc, 'components', 'parameters', 'PageKeyPath'));
  const validate = compileOpenapi(doc, object(param['schema'], 'PageKeyPath.schema'));
  for (const key of GOOD_KEYS) {
    expect(validate(key), `PageKeyPath 收 ${key}`).toBe(true);
  }
  for (const key of BAD_KEYS) {
    expect(validate(key), `PageKeyPath 拒 ${JSON.stringify(key)}`).toBe(false);
  }
});

it('[AC-CT-27#2] me 只收一个 icon_grid、section id 为 more_services、数据源 static；换 id、第二个 section、其他已注册类型都拒收', () => {
  // BR-TEXT-28 准入表 me 行：icon_grid 1 个，section id 为 more_services，数据源只用 static。
  // 例：运营在 me 页再加一个 banner → 保存返回 20001（me 只许 more_services）。
  const section = moreServices(meBase());
  expectPage(page(ME, [clone(section)]), true, 'me 只有 more_services');

  expectPage(page(ME, [{ ...clone(section), id: 'services' }]), false, 'me 的 icon_grid 换 id');
  expectPage(
    page(ME, [clone(section), { ...clone(section), id: `${MORE_SERVICES}_2` }]),
    false,
    'me 两个 icon_grid',
  );
  expectPage(page(ME, [clone(section), clone(section)]), false, 'me 两个 more_services');
  expectPage(
    page(ME, [
      {
        ...clone(section),
        data_source: { kind: 'product_pool', pool_id: 'pool_demo_hot', limit: 8 },
      },
    ]),
    false,
    'me 的 more_services 接商品池（只许 static）',
  );

  for (const type of REGISTERED.filter((t) => t !== 'icon_grid')) {
    const other: Obj = homeSection(type);
    expectPage(page(ME, [{ ...clone(other), id: MORE_SERVICES }]), false, `me 只放 ${type}`);
    expectPage(
      page(ME, [clone(section), { ...clone(other), id: `extra_${type}` }]),
      false,
      `me 在 more_services 之外再放 ${type}`,
    );
  }
});

it('[AC-CT-27#3] search 只收 1 个结果页置顶位（banner 或接商品池的 product_scroll，各自独立检验）；同类两个、两类并放（任一顺序）、其他类型、接物料信息流的 product_scroll 都拒收', () => {
  // BR-TEXT-28 准入表 search 行：结果页置顶位 1 个（banner 或接商品池的 product_scroll，以契约为准）。
  // 两种候选各自独立取自首页 golden，不由 search golden 选中的那一种代表另一种。
  const admitted = admittedSearch();
  const admittedTypes = admitted.map((c) => c.type);

  const top = sectionsOf(searchBase());
  expect(top, 'search golden 恰有一个置顶位').toHaveLength(1);
  const golden = top[0] as Obj;
  expect(admittedTypes, 'search golden 的置顶位是契约启用的类型').toContain(golden['type']);
  if (golden['type'] === 'product_scroll') {
    expect(object(golden['data_source'])['kind'], 'search 的 product_scroll 只接商品池').toBe(
      'product_pool',
    );
  }

  for (const { type, section } of admitted) {
    expectPage(
      page(SEARCH, [clone(section), { ...clone(section), id: `${SEARCH_TOP_ID}_2` }]),
      false,
      `search 两个 ${type} 置顶位`,
    );
  }
  const [banner, scroll] = searchCandidates() as [
    { type: string; section: Obj },
    { type: string; section: Obj },
  ];
  expectPage(
    page(SEARCH, [clone(banner.section), { ...clone(scroll.section), id: `${SEARCH_TOP_ID}_2` }]),
    false,
    'search 同时放 banner 与 product_scroll',
  );
  expectPage(
    page(SEARCH, [clone(scroll.section), { ...clone(banner.section), id: `${SEARCH_TOP_ID}_2` }]),
    false,
    'search 同时放 product_scroll 与 banner',
  );

  const admittedNames: readonly string[] = SEARCH_ADMITTED;
  for (const type of REGISTERED.filter((t) => !admittedNames.includes(t))) {
    expectPage(
      page(SEARCH, [{ ...homeSection(type), id: SEARCH_TOP_ID }]),
      false,
      `search 放 ${type}`,
    );
  }

  const unionSource = clone(object(homeSection('feed_infinite')['data_source']));
  expectPage(
    page(SEARCH, [{ ...clone(scroll.section), data_source: unionSource }]),
    false,
    'search 的 product_scroll 接物料信息流（只许商品池）',
  );
});

it('[AC-CT-27#4] me、search 不收准入表外的类型：批 2 的悬浮按钮 / 开屏图与未注册类型单放、与合法 section 并放都拒收', () => {
  // BR-TEXT-28 细则：表外的 page_key 与类型一律拒收；悬浮按钮（建议名 float_button）、开屏图（splash）属批 2，
  // 批 1 的准入表不收（细则「分批」）。本用例只断言 me / search 拒收，不对 home 作任何要求。
  const section = moreServices(meBase());
  const top = sectionsOf(searchBase())[0] as Obj;
  for (const type of UNLISTED_TYPES) {
    expectPage(page(ME, [batch2Section(type, MORE_SERVICES)]), false, `me 只放 ${type}`);
    expectPage(
      page(ME, [clone(section), batch2Section(type, `extra_${type}`)]),
      false,
      `me 在 more_services 之外再放 ${type}`,
    );
    expectPage(page(SEARCH, [batch2Section(type, 'top')]), false, `search 只放 ${type}`);
    expectPage(
      page(SEARCH, [clone(top), batch2Section(type, `extra_${type}`)]),
      false,
      `search 在置顶位之外再放 ${type}`,
    );
  }
});

it('[AC-CT-27#23] 页面配置各操作（下发、后台保存草稿 / 读取 / 发布 / 预览令牌等）用到的页面键定义都收 me、search；后台的页面键定义带约束，拒收表外键与 wallet / orders', () => {
  // BR-TEXT-28「page_key 为 home、me、search、custom:<slug>」：后台保存 me 草稿后，草稿版本、页面详情、
  // 发布等响应里的 page_key=me 也必须合契约；订单页、钱包页不设运营位（细则「不可配清单」末项）。
  const doc = openapi();
  const defs = pageKeyDefinitions(doc);
  const admin = defs.filter((d) => /\/admin\/v1\//.test(d.where));
  expect(
    admin.filter((d) => d.where.includes('responses')).map((d) => d.where),
    '后台页面配置操作响应里的 page_key 定义',
  ).not.toEqual([]);
  expect(
    admin.filter((d) => d.where.includes('路径参数')).map((d) => d.where),
    '后台页面配置操作的 page_key 路径参数',
  ).not.toEqual([]);

  for (const { where, schema } of defs) {
    const validate = compileOpenapi(doc, schema);
    for (const key of GOOD_KEYS) expect(validate(key), `${where} 收 ${key}`).toBe(true);
  }
  const constraints = ['pattern', 'enum', 'const', 'anyOf', 'oneOf', 'allOf'];
  for (const { where, schema } of admin) {
    expect(
      constraints.some((k) => schema[k] !== undefined),
      `${where} 带页面键约束（不是任意字符串）`,
    ).toBe(true);
  }
  for (const { where, schema } of defs) {
    if (!constraints.some((k) => schema[k] !== undefined)) continue;
    const validate = compileOpenapi(doc, schema);
    for (const key of BAD_KEYS) {
      expect(validate(key), `${where} 拒 ${JSON.stringify(key)}`).toBe(false);
    }
  }
});

it('[AC-CT-27#24] 契约里有 me、search 的准入定义（供保存校验与后台表单共用）：按页写明允许的类型、个数与数据源，与整页 schema 对同一组样例结论一致', () => {
  // 04 §6.2「运营位」①：每个 page_key 一张准入表（允许的 section 类型与个数），放在契约里供服务端保存校验与
  // 后台表单共用；08 BR-TEXT-28 准入表 me 行（icon_grid 1 个、id more_services、只用 static）、search 行
  // （置顶位 1 个：banner 或接商品池的 product_scroll）。
  const grid = moreServices(meBase());
  const pool = { kind: 'product_pool', pool_id: 'pool_demo_hot', limit: 8 };
  const meCases: [string, Obj[], boolean][] = [
    ['只有 more_services', [clone(grid)], true],
    ['icon_grid 换 id', [{ ...clone(grid), id: 'services' }], false],
    ['两个 icon_grid', [clone(grid), { ...clone(grid), id: `${MORE_SERVICES}_2` }], false],
    ['more_services 接商品池', [{ ...clone(grid), data_source: pool }], false],
  ];
  for (const type of REGISTERED.filter((t) => t !== 'icon_grid')) {
    meCases.push([`只放 ${type}`, [{ ...homeSection(type), id: MORE_SERVICES }], false]);
    meCases.push([
      `more_services 之外再放 ${type}`,
      [clone(grid), { ...homeSection(type), id: `extra_${type}` }],
      false,
    ]);
  }
  for (const type of UNLISTED_TYPES) {
    meCases.push([`只放 ${type}`, [batch2Section(type, MORE_SERVICES)], false]);
  }

  const candidates = searchCandidates();
  const admitted = admittedSearch().map((c) => c.type);
  const [banner, scroll] = candidates as [
    { type: string; section: Obj },
    { type: string; section: Obj },
  ];
  const second = (section: Obj): Obj => ({ ...clone(section), id: `${SEARCH_TOP_ID}_2` });
  const searchCases: [string, Obj[], boolean][] = candidates.map(({ type, section }) => [
    `只放 ${type}`,
    [clone(section)],
    admitted.includes(type),
  ]);
  for (const { type, section } of candidates) {
    searchCases.push([`两个 ${type}`, [clone(section), second(section)], false]);
  }
  searchCases.push([
    'banner + product_scroll',
    [clone(banner.section), second(scroll.section)],
    false,
  ]);
  searchCases.push([
    'product_scroll + banner',
    [clone(scroll.section), second(banner.section)],
    false,
  ]);
  searchCases.push([
    'product_scroll 接物料信息流',
    [{ ...clone(scroll.section), data_source: clone(homeSection('feed_infinite')['data_source']) }],
    false,
  ]);
  const admittedNames: readonly string[] = SEARCH_ADMITTED;
  for (const type of REGISTERED.filter((t) => !admittedNames.includes(t))) {
    searchCases.push([`只放 ${type}`, [{ ...homeSection(type), id: SEARCH_TOP_ID }], false]);
  }
  for (const type of UNLISTED_TYPES) {
    searchCases.push([`只放 ${type}`, [batch2Section(type, SEARCH_TOP_ID)], false]);
  }

  for (const [pageKey, cases] of [
    [ME, meCases],
    [SEARCH, searchCases],
  ] as const) {
    const entries = admissionEntries(pageKey);
    for (const [label, sections, expected] of cases) {
      for (const entry of entries) {
        expect(entry.admits(sections), `${entry.where}：${pageKey} ${label}`).toBe(expected);
      }
      expect(isValidPage(page(pageKey, sections)), `整页 schema：${pageKey} ${label}`).toBe(
        expected,
      );
    }
  }
});
