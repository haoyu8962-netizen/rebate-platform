// CT-27 · 运营位的跳转目标（08 BR-TEXT-30「运营位的跳转目标与图标」及细则「跳转目标」；04 §10.1 表后
// 「跳转目标」2026-11-20 一句）。适用范围是本次新增的 page_key（批 1 只有 me、search；custom:* 的现行校验
// 批 1 不变，BR-TEXT-28 细则「分批」）：只许 routes.json 已登记、入口含 in_app 的 App 路由与 WebPage 打开的
// 站内 H5，不许 ExternalPage；首页原有类型（banner、icon_grid 金刚区、popup 等）照旧可用 ExternalPage。
// routes.json 的登记与 params、bridge_origins 白名单是保存时服务端按 routes.json / 配置查的（B1-36），schema
// 不枚举路由名（home-schema route_target 的说明）；这里钉 schema 能表达的部分：新 page_key 里不收 ExternalPage。
import { expect, it } from 'vitest';
import {
  EXTERNAL_TARGET,
  IN_APP_TARGET,
  ME,
  SEARCH,
  WEBPAGE_TARGET,
  actionsOf,
  clone,
  expectPage,
  firstItem,
  homeSection,
  isValidPage,
  itemsOf,
  meBase,
  moreServices,
  page,
  searchBase,
  sectionsOf,
  validGoldens,
  type Obj,
} from './kit.ts';

function withAction(pageKey: string, section: Obj, action: Obj): Obj {
  const next = clone(section);
  firstItem(next)['action'] = clone(action);
  return page(pageKey, [next]);
}

// ExternalPage 一律拒收，与 url 指向哪里无关（「ExternalPage 与任何白名单外的地址都拒收」）。
const EXTERNALS: Obj[] = [
  EXTERNAL_TARGET,
  { route: 'ExternalPage', params: { url: 'https://h5.example.com/topic/double11' } },
  { route: 'ExternalPage', params: { url: 'https://example.com/a', title: '活动说明' } },
];

it('[AC-CT-27#12] me、search 的条目只许站内路由与 WebPage，ExternalPage 拒收；首页原有类型与 custom:* 的 ExternalPage 照旧收下', () => {
  // 例：运营给「更多服务」配一格跳 https://example.com/活动（外部网站）→ 保存被拒（20001）；
  // 同一地址配在首页 banner 上 → 照旧可以保存（只按 BR-ATTR-29 ① 校验）。
  const meSection = moreServices(meBase());
  for (const action of [IN_APP_TARGET, WEBPAGE_TARGET, { route: 'HotRankList' }]) {
    expectPage(withAction(ME, meSection, action), true, `me 条目跳 ${JSON.stringify(action)}`);
  }
  for (const action of EXTERNALS) {
    expectPage(withAction(ME, meSection, action), false, `me 条目跳 ${JSON.stringify(action)}`);
  }

  // search 置顶位：有 static 条目（banner）时同样只许站内跳转。
  const top = sectionsOf(searchBase())[0] as Obj;
  if (itemsOf(top).length > 0) {
    expectPage(withAction(SEARCH, top, IN_APP_TARGET), true, 'search 置顶位条目跳站内路由');
    expectPage(withAction(SEARCH, top, WEBPAGE_TARGET), true, 'search 置顶位条目跳 WebPage');
    for (const action of EXTERNALS) {
      const label = `search 条目跳 ${JSON.stringify(action)}`;
      expectPage(withAction(SEARCH, top, action), false, label);
    }
  }
  // search 不论选了哪种置顶位，banner 作置顶位时的外链同样拒收（准入不收 banner 时本就拒收）。
  expectPage(
    withAction(SEARCH, { ...homeSection('banner'), id: String(top['id']) }, EXTERNAL_TARGET),
    false,
    'search 放跳外链的 banner',
  );

  // 范围之外照旧：首页 banner、金刚区、弹窗、活动入口的 ExternalPage 照收（BR-ATTR-29 ① 由服务端另查）。
  for (const type of ['banner', 'icon_grid', 'popup', 'activity_entry']) {
    expectPage(
      withAction('home', homeSection(type), EXTERNAL_TARGET),
      true,
      `首页 ${type} 条目跳 ExternalPage`,
    );
  }
  // custom:<slug> 的现行校验批 1 不变：现有 golden 里的专题页外链照收。
  const customs = validGoldens().filter(
    ({ page: p }) =>
      String(p['page_key']).startsWith('custom:') &&
      actionsOf(p).some((a) => a['route'] === 'ExternalPage'),
  );
  expect(customs.length, '现有 custom:* 外链 golden').toBeGreaterThan(0);
  for (const { name, page: p } of customs) {
    expect(isValidPage(p), `${name} 照旧通过`).toBe(true);
  }
});
