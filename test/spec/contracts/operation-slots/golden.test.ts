// CT-27 · golden 样例（08 BR-TEXT-28 细则「新类型按『注册 type 与 props schema → 三端渲染器 → golden 样例』加」；
// 任务台账：golden 含过期条目、超长徽标、外链跳转、准入表外类型（拒收））。样例在
// contracts/fixtures/home-golden/（通过的）与 invalid/（拒收的）；文件名不钉，按内容找。拒收样例要求
// 「只去掉那一处就通过」，保证它是因为该条规则被拒，而不是别的毛病。
import { expect, it } from 'vitest';
import {
  BADGE_KINDS,
  GOLDEN_DIR,
  GOLDEN_REFERENCE_NOW,
  IN_APP_TARGET,
  INVALID_DIR,
  ME,
  MORE_SERVICES,
  SEARCH,
  SEARCH_ADMITTED,
  actionsOf,
  badgeKeys,
  clone,
  compileStrict,
  invalidGoldens,
  isObj,
  isValidPage,
  itemsOf,
  object,
  routes,
  validGoldens,
  type Golden,
  type Obj,
} from './kit.ts';

/** 不合法样例的 sections 可能本身就不是数组：取不到时按空处理，不抛错。 */
function looseSections(page: Obj): Obj[] {
  const sections = page['sections'];
  return Array.isArray(sections) ? sections.filter(isObj) : [];
}

function looseItems(page: Obj): Obj[] {
  return looseSections(page).flatMap(itemsOf);
}

const at0 = Date.parse(GOLDEN_REFERENCE_NOW);
function expired(item: Obj): boolean {
  return typeof item['end_at'] === 'string' && Date.parse(String(item['end_at'])) < at0;
}

// BR-TEXT-28 不可配清单：订单、钱包、提现、设置等核心入口与隐私、授权、协议入口不得出现在运营位里。
const CORE_ROUTES = [
  'OrderList',
  'OrderDetail',
  'Wallet',
  'Withdraw',
  'WithdrawRecords',
  'Ledger',
  'PayoutAccount',
  'Settings',
  'PrivacyCenter',
  'AuthManage',
  'Agreement',
];

/** BR-TEXT-30：已登记、非 debug_only、入口含 in_app、不是 ExternalPage、params 合该路由定义；WebPage 只许 https。 */
function expectInAppTarget(where: string, action: Obj): void {
  const route = action['route'];
  expect(typeof route, `${where}.route`).toBe('string');
  expect(route, `${where} 不用 ExternalPage`).not.toBe('ExternalPage');
  const def = routes()[route as string];
  expect(isObj(def), `${where}.route=${String(route)} 在 routes.json 登记`).toBe(true);
  const entry = object(def)['entry'];
  expect(Array.isArray(entry) && entry.includes('in_app'), `${where} 入口含 in_app`).toBe(true);
  expect(object(def)['debug_only'] ?? false, `${where} 不是 debug_only`).toBe(false);
  const check = compileStrict(object(object(def)['params'], `${String(route)}.params`));
  expect(check(action['params'] ?? {}), `${where}.params 合 ${String(route)} 的定义`).toBe(true);
  if (route === 'WebPage') {
    const url = object(action['params'])['url'];
    expect(String(url).startsWith('https://'), `${where} WebPage 只许 https`).toBe(true);
  }
  expect(CORE_ROUTES, `${where} 不放核心入口（BR-TEXT-28 不可配清单）`).not.toContain(route);
}

it('[AC-CT-27#17] golden 有通过的 me 与 search 样例：me 的 more_services 条目带红点与文字徽标（含到期），跳转都是站内入口', () => {
  const goldens = validGoldens();
  const mes = goldens.filter(({ page }) => page['page_key'] === ME);
  const searches = goldens.filter(({ page }) => page['page_key'] === SEARCH);
  expect(
    mes.map((g) => g.name),
    `${GOLDEN_DIR} 下 page_key=me 的样例`,
  ).not.toEqual([]);
  expect(
    searches.map((g) => g.name),
    `${GOLDEN_DIR} 下 page_key=search 的样例`,
  ).not.toEqual([]);
  for (const { name, page } of [...mes, ...searches]) {
    expect(isValidPage(page), `${name} 通过 home-schema.json`).toBe(true);
    actionsOf(page).forEach((action, i) => expectInAppTarget(`${name} 跳转 #${i}`, action));
  }
  const meWithGrid = mes.filter(({ page }) =>
    looseSections(page).some((s) => s['type'] === 'icon_grid' && s['id'] === MORE_SERVICES),
  );
  expect(
    meWithGrid.map((g) => g.name),
    'me 样例里有 more_services',
  ).not.toEqual([]);

  // 三端渲染器要覆盖的徽标：红点、文字（BR-TEXT-29），以及带到期时刻的徽标。
  const keys = badgeKeys();
  const badges = mes.flatMap(({ page }) => looseItems(page)).map((item) => item['badge']);
  const kinds = new Set(badges.filter(isObj).map((b) => b[keys.kind]));
  expect(kinds.has('dot'), 'me 样例有红点徽标').toBe(true);
  expect(kinds.has('text'), 'me 样例有文字徽标').toBe(true);
  expect(
    badges.some((b) => isObj(b) && typeof b[keys.expiry] === 'string'),
    'me 样例有带到期时刻的徽标',
  ).toBe(true);
});

it(`[AC-CT-27#18] golden 有过期条目：通过的样例里某 section 的一个 static 条目 end_at 早于 ${GOLDEN_REFERENCE_NOW}，同 section 另有未过期条目`, () => {
  // BR-TEXT-29：客户端按本机时间再过滤，过了结束时刻立即隐藏；BR-TEXT-28 细则「回落」：只去掉该条目，
  // 一个 section 的条目全没了才隐藏整个 section。
  const hits: string[] = [];
  for (const { name, page } of validGoldens()) {
    looseSections(page).forEach((section, i) => {
      const items = itemsOf(section);
      if (items.some(expired) && items.some((item) => !expired(item))) {
        hits.push(`${name} sections.${i}`);
        expect(isValidPage(page), `${name} 通过 home-schema.json`).toBe(true);
      }
    });
  }
  expect(hits, '含过期条目与未过期条目的 section').not.toEqual([]);
});

it('[AC-CT-27#19] golden 有超长徽标的拒收样例：徽标文字超过 2 个字被拒，去掉该徽标即通过', () => {
  const kinds: readonly string[] = BADGE_KINDS;
  const overlong = (value: unknown): boolean =>
    isObj(value) &&
    Object.values(value).some(
      (v) =>
        typeof v === 'string' &&
        !kinds.includes(v) &&
        Number.isNaN(Date.parse(v)) &&
        [...v].length > 2,
    );
  const candidates = invalidGoldens().filter(({ page }) =>
    looseItems(page).some((item) => overlong(item['badge'])),
  );
  expect(
    candidates.map((g) => g.name),
    `${INVALID_DIR} 下带超长徽标文字的样例`,
  ).not.toEqual([]);
  const confirmed = candidates.filter(({ page }) => {
    const fixed = clone(page);
    for (const item of looseItems(fixed)) if (overlong(item['badge'])) delete item['badge'];
    return !isValidPage(page) && isValidPage(fixed);
  });
  expect(
    confirmed.map((g) => g.name),
    '超长徽标样例被拒、只去掉超长徽标即通过',
  ).not.toEqual([]);
});

it('[AC-CT-27#20] golden 有外链跳转的拒收样例：me / search 条目跳 ExternalPage 被拒，换成站内路由即通过；首页原有外链样例照旧通过', () => {
  const external = (action: Obj): boolean => action['route'] === 'ExternalPage';
  const externalItem = (item: Obj): boolean => isObj(item['action']) && external(item['action']);
  const inScope = ({ page }: Golden): boolean =>
    page['page_key'] === ME || page['page_key'] === SEARCH;
  const candidates = invalidGoldens().filter(
    (g) => inScope(g) && looseItems(g.page).some(externalItem),
  );
  const message = `${INVALID_DIR} 下 me / search 跳外链的样例`;
  expect(
    candidates.map((g) => g.name),
    message,
  ).not.toEqual([]);
  const confirmed = candidates.filter(({ page }) => {
    const fixed = clone(page);
    for (const item of looseItems(fixed)) {
      if (externalItem(item)) item['action'] = clone(IN_APP_TARGET);
    }
    return !isValidPage(page) && isValidPage(fixed);
  });
  expect(
    confirmed.map((g) => g.name),
    '外链样例被拒、只换掉外链即通过',
  ).not.toEqual([]);

  // BR-TEXT-30 适用范围之外：首页原有类型照旧可用 ExternalPage。
  const homes = validGoldens().filter(
    ({ page }) => page['page_key'] === 'home' && actionsOf(page).some(external),
  );
  expect(
    homes.map((g) => g.name),
    '首页外链样例',
  ).not.toEqual([]);
  for (const { name, page } of homes) expect(isValidPage(page), `${name} 照旧通过`).toBe(true);
});

it('[AC-CT-27#21] golden 有准入表外类型的拒收样例：me / search 放了表外类型被拒，去掉表外的 section 即通过', () => {
  const admitted = (pageKey: unknown, section: Obj): boolean => {
    const type = section['type'];
    if (pageKey === ME) return type === 'icon_grid';
    return (SEARCH_ADMITTED as readonly unknown[]).includes(type);
  };
  const candidates = invalidGoldens().filter(
    ({ page }) =>
      (page['page_key'] === ME || page['page_key'] === SEARCH) &&
      looseSections(page).some((s) => !admitted(page['page_key'], s)),
  );
  const message = `${INVALID_DIR} 下 me / search 放表外类型的样例`;
  expect(
    candidates.map((g) => g.name),
    message,
  ).not.toEqual([]);
  const confirmed = candidates.filter(({ page }) => {
    const fixed = clone(page);
    fixed['sections'] = looseSections(fixed).filter((s) => admitted(fixed['page_key'], s));
    return !isValidPage(page) && isValidPage(fixed);
  });
  expect(
    confirmed.map((g) => g.name),
    '表外类型样例被拒、只去掉表外 section 即通过',
  ).not.toEqual([]);
});

it('[AC-CT-27#22] golden 有带起止时刻的首页弹窗：popup 带 start_at / end_at 与每日次数、时段，通过校验', () => {
  // 批 1 ②：首页弹窗补后台表单，弹窗带起止时刻（BR-TEXT-29）与每日次数、时段（01 F-HOME-08）。
  const hits = validGoldens().filter(
    ({ page }) =>
      page['page_key'] === 'home' &&
      looseSections(page).some((s) => {
        if (s['type'] !== 'popup') return false;
        const timed = [s, ...itemsOf(s)].some(
          (node) => typeof node['start_at'] === 'string' || typeof node['end_at'] === 'string',
        );
        const props = isObj(s['props']) ? s['props'] : {};
        return timed && props['daily_max'] !== undefined && props['time_window'] !== undefined;
      }),
  );
  expect(
    hits.map((g) => g.name),
    '带起止时刻、每日次数与时段的首页弹窗样例',
  ).not.toEqual([]);
  for (const { name, page } of hits) expect(isValidPage(page), `${name} 通过`).toBe(true);
});
