// CT-27 · icon_grid props 定稿与条目徽标（03 §6.3 `icon_grid`：列数 4/5、行数、徽标；08 BR-TEXT-29 细则
// 「徽标」：只有无 / 红点 / 最多 2 个字的短文字三种，文字按 Unicode 字符计、超过 2 个字保存被拒（20001），
// 可设到期时刻，数字徽标不属运营配置；本批徽标只用于 icon_grid 条目（「我的 · 更多服务」与首页金刚区）；
// 04 §6.2「运营位」③：条目加徽标 badge，类型 none / dot / text，text 时带 1–2 字的文字，可带到期时刻）。
// 类型 / 文字 / 到期三个键与列数键 04、08 没定名：由 kit.ts 在 home-schema.json 里按语义找。
import { expect, it } from 'vitest';
import {
  BAD_INSTANTS,
  GOOD_INSTANTS,
  ICON_GRID_COLUMNS,
  ME,
  MORE_SERVICES,
  SEARCH,
  admittedSearch,
  badge,
  badgeKeys,
  clone,
  columnsKey,
  expectPage,
  findPaths,
  firstItem,
  getAt,
  homeSection,
  isObj,
  isValidPage,
  itemsOf,
  meBase,
  meWithItems,
  moreServices,
  page,
  sectionsOf,
  setAt,
  validGoldens,
  type BadgeKeys,
  type Obj,
} from './kit.ts';

type Grid = { label: string; pageKey: string; section: Obj };

/** 「我的 · 更多服务」与首页金刚区两处 icon_grid。 */
function grids(): Grid[] {
  return [
    { label: 'me.more_services', pageKey: ME, section: moreServices(meBase()) },
    { label: 'home 金刚区', pageKey: 'home', section: homeSection('icon_grid') },
  ];
}

function withProps(section: Obj, props: Obj): Obj {
  const next = clone(section);
  const current = next['props'];
  next['props'] = { ...(isObj(current) ? current : {}), ...props };
  return next;
}

function withBadge(grid: Grid, value: unknown): Obj {
  const next = clone(grid.section);
  const item = firstItem(next);
  delete item['badge'];
  item['badge'] = value;
  return page(grid.pageKey, [next]);
}

function textBadge(keys: BadgeKeys, value: string, extra: Obj = {}): Obj {
  return badge(keys, 'text', { [keys.text]: value, ...extra });
}

it('[AC-CT-27#7] icon_grid 的列数只取 4 / 5（首页金刚区两种都收；me 至少收其一），其他取值拒收', () => {
  const key = columnsKey();
  for (const { label, pageKey, section } of grids()) {
    const accepted = ICON_GRID_COLUMNS.filter((n) =>
      isValidPage(page(pageKey, [withProps(section, { [key]: n })])),
    );
    if (pageKey === 'home') {
      expect(accepted, `${label} 列数 4、5 都收`).toEqual([...ICON_GRID_COLUMNS]);
    } else {
      // 08 BR-TEXT-28 准入表 me 行：「条目数上限、列数由契约线定稿」——在 4 / 5 里定。
      expect(accepted.length, `${label} 列数至少收 4 / 5 之一`).toBeGreaterThan(0);
    }
    for (const bad of [3, 6, 0, -4, 4.5, '4', null]) {
      expectPage(
        page(pageKey, [withProps(section, { [key]: bad })]),
        false,
        `${label} 列数 ${JSON.stringify(bad)}`,
      );
    }
  }
});

it('[AC-CT-27#8] icon_grid 条目徽标只有 none / dot / text 三种：text 必带文字；数字徽标、表外类型、缺类型都拒收', () => {
  const keys = badgeKeys();
  for (const grid of grids()) {
    for (const value of [
      badge(keys, 'none'),
      badge(keys, 'dot'),
      textBadge(keys, '新'),
      textBadge(keys, '热卖'),
    ]) {
      expectPage(withBadge(grid, value), true, `${grid.label} 徽标 ${JSON.stringify(value)}`);
    }
    // 数字徽标（未读数、待处理数）只来自业务数据，运营位里不能填（BR-TEXT-29）。
    for (const value of [
      3,
      '新',
      true,
      {},
      badge(keys, 'number', { [keys.text]: '3' }),
      badge(keys, 'count'),
      badge(keys, 'TEXT', { [keys.text]: '新' }),
      badge(keys, 'text'),
      { [keys.text]: '新' },
    ]) {
      expectPage(withBadge(grid, value), false, `${grid.label} 徽标 ${JSON.stringify(value)}`);
    }
  }
});

it('[AC-CT-27#9] 徽标文字最多 2 个字（按 Unicode 字符计），空文字与超长文字拒收', () => {
  // 例：运营在徽标里填「限时3天」→ 超过 2 个字，保存被拒。
  const keys = badgeKeys();
  for (const grid of grids()) {
    for (const value of ['新', '热卖', 'Hi', '🔥新', '🔥🔥']) {
      expectPage(withBadge(grid, textBadge(keys, value)), true, `${grid.label} 徽标「${value}」`);
    }
    for (const value of ['', '限时3天', '新品上', 'NEW', '🔥🔥🔥', '热卖中']) {
      expectPage(withBadge(grid, textBadge(keys, value)), false, `${grid.label} 徽标「${value}」`);
    }
  }
});

it('[AC-CT-27#10] 徽标可带到期时刻（date-time），红点与文字徽标都可设；格式不合拒收', () => {
  // 例：「更多服务」新加一格设徽标「新」、到期 11-30 24:00 → 12-01 起徽标消失、该格照常显示。
  const keys = badgeKeys();
  for (const grid of grids()) {
    for (const instant of GOOD_INSTANTS) {
      for (const value of [
        badge(keys, 'dot', { [keys.expiry]: instant }),
        textBadge(keys, '新', { [keys.expiry]: instant }),
      ]) {
        expectPage(withBadge(grid, value), true, `${grid.label} 徽标 ${JSON.stringify(value)}`);
      }
    }
    for (const bad of BAD_INSTANTS) {
      for (const value of [
        badge(keys, 'dot', { [keys.expiry]: bad }),
        textBadge(keys, '新', { [keys.expiry]: bad }),
      ]) {
        expectPage(withBadge(grid, value), false, `${grid.label} 徽标 ${JSON.stringify(value)}`);
      }
    }
  }
});

it('[AC-CT-27#11] icon_grid 的 props 定稿后关闭：golden 的 props 照收，未定义的键拒收', () => {
  // 04 §6.2「运营位」③「icon_grid 的 props 定稿」：定稿前 props 开放（home-schema $comment），定稿后只收定义过的键。
  for (const { label, pageKey, section } of grids()) {
    expectPage(page(pageKey, [clone(section)]), true, `${label} golden props`);
    for (const extra of [{ ct27_unknown_prop: 1 }, { autoplay_ms: 3000 }, { items: [] }]) {
      expectPage(
        page(pageKey, [withProps(section, extra)]),
        false,
        `${label} props 带未定义的键 ${Object.keys(extra).join(',')}`,
      );
    }
  }
});

/** 条目数上限的探测范围：上限须是不超过它的有限正整数。 */
const MAX_PROBE = 100;

it(`[AC-CT-27#25] me.more_services 的 static 条目数有有限上限（≤ ${MAX_PROBE}）：恰好到上限通过，再加一个合法且不同的条目即拒收`, () => {
  // 08 BR-TEXT-28 准入表 me 行：「条目数上限、列数由契约线定稿」——定稿契约必须给出有限上限。
  const results: boolean[] = [];
  for (let n = 1; n <= MAX_PROBE + 1; n += 1) results.push(isValidPage(meWithItems(n)));
  const limit = results.indexOf(false);
  expect(limit, `me.more_services 在 ${MAX_PROBE} 个以内有条目数上限`).toBeGreaterThan(0);
  expect(results.slice(0, limit).every(Boolean), `1～${limit} 个条目都收（上限以内不留空洞）`).toBe(
    true,
  );
  expect(results.slice(limit).some(Boolean), `超过上限 ${limit} 后一律拒收`).toBe(false);
  expectPage(meWithItems(limit), true, `恰好 ${limit} 个条目`);
  expectPage(meWithItems(limit + 1), false, `${limit + 1} 个条目`);
  const goldenCount = itemsOf(moreServices(meBase())).length;
  expect(goldenCount, 'me golden 的条目数不超过上限').toBeLessThanOrEqual(limit);
});

it('[AC-CT-27#26] 徽标只用于 icon_grid 条目：首页 popup、banner、活动入口与 search 置顶位的条目加合法红点 / 文字徽标都拒收', () => {
  // 08 BR-TEXT-29 细则「徽标」末项：本批徽标只用于 icon_grid 条目（「我的 · 更多服务」与首页金刚区）。
  const keys = badgeKeys();
  const cases: { label: string; pageKey: string; section: Obj }[] = [
    { label: 'home.popup', pageKey: 'home', section: homeSection('popup') },
    { label: 'home.banner', pageKey: 'home', section: homeSection('banner') },
    { label: 'home.activity_entry', pageKey: 'home', section: homeSection('activity_entry') },
    ...admittedSearch()
      .filter(({ section }) => itemsOf(section).length > 0)
      .map(({ type, section }) => ({ label: `search.${type}`, pageKey: SEARCH, section })),
  ];
  for (const { label, pageKey, section } of cases) {
    expectPage(page(pageKey, [clone(section)]), true, `${label} 不带徽标`);
    for (const value of [badge(keys, 'dot'), textBadge(keys, '新')]) {
      const next = clone(section);
      firstItem(next)['badge'] = value;
      expectPage(page(pageKey, [next]), false, `${label} 条目带徽标 ${JSON.stringify(value)}`);
    }
  }
});

const DIGEST = /^[0-9a-f]{64}$/;

it('[AC-CT-27#27] me 的下发图标带可核对的摘要：golden 每个条目有 https 图标地址与 64 位小写十六进制摘要；去掉摘要、改坏摘要、图标改 http 都拒收', () => {
  // 08 BR-TEXT-30 细则「图标」第 3 项：下发图片存 OSS media，下发带摘要（同 BR-TEXT-24、BR-TEXT-26 的做法，
  // 即 popup lottie 的 sha256：64 位小写十六进制）；字段名契约定，这里按值找（跳转字段除外）。
  const goldens = validGoldens().filter(({ page: p }) => p['page_key'] === ME);
  expect(
    goldens.map((g) => g.name),
    'page_key=me 的 golden',
  ).not.toEqual([]);
  let checked = 0;
  for (const { name, page: base } of goldens) {
    sectionsOf(base).forEach((section, s) => {
      if (section['id'] !== MORE_SERVICES) return;
      itemsOf(section).forEach((item, i) => {
        const where = `${name} sections.${s} 条目 #${i}`;
        const itemPath = ['sections', s, 'data_source', 'items', i];
        const isDigest = (v: unknown): boolean => typeof v === 'string' && DIGEST.test(v);
        const isHttps = (v: unknown): boolean => typeof v === 'string' && v.startsWith('https://');
        const digests = findPaths(item, isDigest, ['action']);
        const urls = findPaths(item, isHttps, ['action']);
        expect(digests.length, `${where} 带图标摘要`).toBeGreaterThan(0);
        expect(urls.length, `${where} 带 https 图标地址`).toBeGreaterThan(0);
        for (const rel of digests) {
          const path = [...itemPath, ...rel];
          const value = String(getAt(base, path));
          expectPage(setAt(base, path, undefined), false, `${where} 去掉摘要 ${rel.join('.')}`);
          for (const bad of [
            value.slice(1),
            `${value}0`,
            `g${value.slice(1)}`,
            `A${value.slice(1)}`,
            `sha256:${value}`,
          ]) {
            expectPage(setAt(base, path, bad), false, `${where} 摘要改成 ${bad}`);
          }
        }
        for (const rel of urls) {
          const path = [...itemPath, ...rel];
          const value = String(getAt(base, path));
          const http = `http://${value.slice('https://'.length)}`;
          expectPage(setAt(base, path, http), false, `${where} 图标改 http`);
        }
        checked += 1;
      });
    });
  }
  expect(checked, 'me golden 的 more_services 条目').toBeGreaterThan(0);
});
