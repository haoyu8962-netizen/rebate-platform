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
  atLeastTwo,
  clone,
  expectPage,
  findPaths,
  homeSection,
  isObj,
  isValidPage,
  itemsOf,
  meBase,
  moreServices,
  page,
  schemaPropertyNames,
  setAt,
  type Obj,
} from './kit.ts';

/** 第 index 个条目换成 action，其余条目原样（都是原本合法的条目）。 */
function withAction(pageKey: string, section: Obj, index: number, action: Obj): Obj {
  const next = clone(section);
  (itemsOf(next)[index] as Obj)['action'] = clone(action);
  return page(pageKey, [next]);
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
    { label: 'me.more_services', pageKey: ME, section: atLeastTwo(ME, moreServices(meBase())) },
    // 契约启用、且带跳转字段（static 条目）的每种 search 置顶形状。
    ...admittedSearch()
      .filter(({ section }) => itemsOf(section).length > 0)
      .map(({ type, section }) => ({
        label: `search.${type}`,
        pageKey: SEARCH,
        section: atLeastTwo(SEARCH, section),
      })),
  ];
  expect(
    itemsOf(cases[0]?.section ?? {}).length,
    'me.more_services 至少两个条目（检查到非首项）',
  ).toBeGreaterThanOrEqual(2);
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
  // 每个条目（含非首项）都查。
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

/** props 里放跳转的常见键名（03 §6.3 product_scroll「更多按钮 action」，04 未定名）。 */
const PROP_TARGET_GUESSES = [
  'more_action',
  'more',
  'more_target',
  'more_link',
  'more_route',
  'action',
  'target',
  'link',
  'route',
];

const isTarget = (value: unknown): boolean => isObj(value) && typeof value['route'] === 'string';

it('[AC-CT-27#36] me、search 卡片 props 里的跳转（如商品滚动卡的「更多」按钮）同样只许站内路由与 https 的 WebPage：golden props 里已有的跳转，以及 props 能收跳转的每个键，换成 ExternalPage 或非 https 的 WebPage 都拒收', () => {
  // 08 BR-TEXT-30「跳转目标」：适用范围是本次新增的 page_key（me、search）里的跳转，不只 static 条目的 action。
  // spec-test r2 S1 #7：启用接商品池的 product_scroll 时沿用开放的 props，「更多」按钮就能配外链——这里
  // ① 改 golden props 里已有的跳转；② 对契约里出现过的每个属性名与常见名，props 若能收一个站内跳转，
  // 就不能收外链（props 开放时任何键都能收，于是任何键都不能收外链）。首页原有类型不在此列（#12 末段）。
  const cases: { label: string; pageKey: string; section: Obj }[] = [
    { label: 'me.more_services', pageKey: ME, section: moreServices(meBase()) },
    ...admittedSearch().map(({ type, section }) => ({
      label: `search.${type}`,
      pageKey: SEARCH,
      section,
    })),
  ];
  const names = [...new Set([...schemaPropertyNames(), ...PROP_TARGET_GUESSES])];
  for (const { label, pageKey, section } of cases) {
    expectPage(page(pageKey, [clone(section)]), true, `${label} 原样`);
    const props: Obj = isObj(section['props']) ? section['props'] : {};
    const withProp = (path: (string | number)[], value: unknown): Obj => {
      const next = clone(section);
      next['props'] = setAt(props, path, value) as Obj;
      return page(pageKey, [next]);
    };
    for (const path of findPaths(props, isTarget)) {
      const where = `${label} props.${path.join('.')}`;
      for (const action of GOOD_TARGETS) {
        expectPage(withProp(path, action), true, `${where} 跳 ${JSON.stringify(action)}`);
      }
      for (const action of [...EXTERNALS, ...BAD_WEBPAGES]) {
        expectPage(withProp(path, action), false, `${where} 跳 ${JSON.stringify(action)}`);
      }
    }
    for (const name of names) {
      if (Object.hasOwn(props, name)) continue;
      if (!isValidPage(withProp([name], IN_APP_TARGET))) continue;
      for (const action of [...EXTERNALS, ...BAD_WEBPAGES]) {
        expectPage(
          withProp([name], action),
          false,
          `${label} props.${name}（能收站内跳转）跳 ${JSON.stringify(action)}`,
        );
      }
    }
  }
});
