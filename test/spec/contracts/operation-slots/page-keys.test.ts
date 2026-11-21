// CT-27 · page_key 与准入表（08 BR-TEXT-28「运营位的位置、准入与不可配项」及细则「准入表」「分批」；
// 04 §6.2 `GET /v1/pages/{page_key}` 行与「运营位」①）。AC-CT-27#n 是本单验收点的本地分组。
import { expect, it } from 'vitest';
import {
  BATCH2_TYPES,
  ME,
  MORE_SERVICES,
  REGISTERED,
  SEARCH,
  SEARCH_ADMITTED,
  at,
  batch2Section,
  clone,
  compileOpenapi,
  expectPage,
  homeSection,
  meBase,
  moreServices,
  object,
  openapi,
  page,
  resolve,
  searchBase,
  sectionsOf,
  type Obj,
} from './kit.ts';

const GOOD_KEYS = [ME, SEARCH, 'home', 'custom:autumn_promo'];
// 表外的 page_key 一律拒收（BR-TEXT-28 细则「准入表」）；custom:<slug> 的 slug 规则照旧。
const BAD_KEYS = [
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

it('[AC-CT-27#1] page_key 收 me、search（home、custom:<slug> 照旧），表外的 page_key 拒收；GET /v1/pages/{page_key} 的 PageKeyPath 同口径', () => {
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

it('[AC-CT-27#3] search 只收 1 个结果页置顶位（banner 或接商品池的 product_scroll）；第二个 section、其他类型、接物料信息流的 product_scroll 都拒收', () => {
  // BR-TEXT-28 准入表 search 行：结果页置顶位 1 个（banner 或接商品池的 product_scroll，以契约为准）。
  const base = searchBase();
  const sections = sectionsOf(base);
  expect(sections, 'search golden 恰有一个置顶位').toHaveLength(1);
  const top = sections[0] as Obj;
  expect(SEARCH_ADMITTED as readonly unknown[], 'search 置顶位的类型').toContain(top['type']);
  if (top['type'] === 'product_scroll') {
    expect(object(top['data_source'])['kind'], 'search 的 product_scroll 只接商品池').toBe(
      'product_pool',
    );
  }
  const id = String(top['id']);

  expectPage(
    page(SEARCH, [clone(top), { ...clone(top), id: `${id}_2` }]),
    false,
    'search 两个置顶位',
  );

  const admitted: readonly string[] = SEARCH_ADMITTED;
  for (const type of REGISTERED.filter((t) => !admitted.includes(t))) {
    expectPage(page(SEARCH, [{ ...homeSection(type), id }]), false, `search 放 ${type}`);
  }

  const unionSource = clone(object(homeSection('feed_infinite')['data_source']));
  expectPage(
    page(SEARCH, [{ ...homeSection('product_scroll'), id, data_source: unionSource }]),
    false,
    'search 的 product_scroll 接物料信息流（只许商品池）',
  );
});

it('[AC-CT-27#4] me、search 不收准入表外的类型：批 2 的悬浮按钮 / 开屏图与未注册类型单放、与合法 section 并放都拒收', () => {
  // BR-TEXT-28 细则：表外的 page_key 与类型一律拒收；悬浮按钮（建议名 float_button）、开屏图（splash）属批 2，
  // 批 1 的准入表不收（细则「分批」）。
  const section = moreServices(meBase());
  const top = sectionsOf(searchBase())[0] as Obj;
  for (const type of [...BATCH2_TYPES, 'member_banner']) {
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
