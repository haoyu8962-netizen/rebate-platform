// CT-27 · 运营位的跳转目标（08 BR-TEXT-30「运营位的跳转目标与图标」及细则「跳转目标」；04 §10.1 表后
// 「跳转目标」2026-11-20 一句）。适用范围是本次新增的 page_key（批 1 只有 me、search；custom:* 属批 2，
// 本单不对它作要求，BR-TEXT-28 细则「分批」）：只许 routes.json 已登记、入口含 in_app 的 App 路由与 WebPage
// 打开的站内 H5（https），不许 ExternalPage；首页原有类型（banner、icon_grid 金刚区、popup 等）照旧可用
// ExternalPage。routes.json 的登记与 params、bridge_origins 白名单是保存时服务端按 routes.json / 配置查的
// （B1-36），schema 不枚举路由名；这里钉 schema 能表达的部分：新 page_key 的每个条目（不只第一个）都不收
// ExternalPage，WebPage 只收带 https url 的。
import { expect, it } from 'vitest';
import {
  EXTERNAL_TARGET,
  IN_APP_TARGET,
  ME,
  SEARCH,
  WEBPAGE_TARGET,
  admittedSearch,
  clone,
  expectPage,
  homeSection,
  itemsOf,
  meBase,
  moreServices,
  page,
  type Obj,
} from './kit.ts';

/** 第 index 个条目换成 action，其余条目原样（都是原本合法的条目）。 */
function withAction(pageKey: string, section: Obj, index: number, action: Obj): Obj {
  const next = clone(section);
  (itemsOf(next)[index] as Obj)['action'] = clone(action);
  return page(pageKey, [next]);
}

/** 保证至少两个原本合法的条目：不够时以第一个条目为底补一个跳帮助文章的条目。 */
function atLeastTwo(section: Obj): Obj {
  const next = clone(section);
  const items = itemsOf(next);
  expect(items.length, `${String(next['id'])} 至少一个条目`).toBeGreaterThan(0);
  if (items.length < 2) {
    const extra = clone(items[0] as Obj);
    extra['action'] = { route: 'Help', params: { article_id: 'second_entry' } };
    const source = next['data_source'] as Obj;
    source['items'] = [...items, extra];
  }
  return next;
}

// ExternalPage 一律拒收，与 url 指向哪里无关（「ExternalPage 与任何白名单外的地址都拒收」）。
const EXTERNALS: Obj[] = [
  EXTERNAL_TARGET,
  { route: 'ExternalPage', params: { url: 'https://h5.example.com/topic/double11' } },
  { route: 'ExternalPage', params: { url: 'https://example.com/a', title: '活动说明' } },
];
// WebPage 只许 https 的站内 H5（BR-TEXT-30 ②，与 routes.json WebPage 的 url 定义一致）。
const BAD_WEBPAGES: Obj[] = [
  { route: 'WebPage', params: { url: 'http://h5.example.com/topic' } },
  { route: 'WebPage', params: { url: 'javascript:alert(1)' } },
  { route: 'WebPage', params: { url: '' } },
  { route: 'WebPage', params: {} },
  { route: 'WebPage' },
];
const GOOD_TARGETS: Obj[] = [IN_APP_TARGET, WEBPAGE_TARGET, { route: 'HotRankList' }];

it('[AC-CT-27#12] me、search 的每个条目只许站内路由与 https 的 WebPage：任一条目（含非首项）跳 ExternalPage 或非 https 的 WebPage 都拒收；首页原有类型的 ExternalPage 照旧收下', () => {
  // 例：运营给「更多服务」配一格跳 https://example.com/活动（外部网站）→ 保存被拒（20001）；
  // 同一地址配在首页 banner 上 → 照旧可以保存（只按 BR-ATTR-29 ① 校验）。
  const cases: { label: string; pageKey: string; section: Obj }[] = [
    { label: 'me.more_services', pageKey: ME, section: atLeastTwo(moreServices(meBase())) },
    // 契约启用、且带跳转字段（static 条目）的每种 search 置顶形状。
    ...admittedSearch()
      .filter(({ section }) => itemsOf(section).length > 0)
      .map(({ type, section }) => ({
        label: `search.${type}`,
        pageKey: SEARCH,
        section: atLeastTwo(section),
      })),
  ];
  for (const { label, pageKey, section } of cases) {
    expectPage(page(pageKey, [clone(section)]), true, `${label} 两个以上合法条目`);
    const count = itemsOf(section).length;
    for (let i = 0; i < count; i += 1) {
      for (const action of GOOD_TARGETS) {
        expectPage(
          withAction(pageKey, section, i, action),
          true,
          `${label} 条目 #${i} 跳 ${JSON.stringify(action)}`,
        );
      }
      for (const action of [...EXTERNALS, ...BAD_WEBPAGES]) {
        expectPage(
          withAction(pageKey, section, i, action),
          false,
          `${label} 条目 #${i} 跳 ${JSON.stringify(action)}`,
        );
      }
    }
  }

  // 范围之外照旧：首页 banner、金刚区、弹窗、活动入口的 ExternalPage 照收（BR-ATTR-29 ① 由服务端另查）。
  for (const type of ['banner', 'icon_grid', 'popup', 'activity_entry']) {
    const section = homeSection(type);
    const count = itemsOf(section).length;
    for (let i = 0; i < count; i += 1) {
      expectPage(
        withAction('home', section, i, EXTERNAL_TARGET),
        true,
        `首页 ${type} 条目 #${i} 跳 ExternalPage`,
      );
    }
  }
});
