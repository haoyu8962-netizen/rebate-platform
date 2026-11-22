// CT-27 · section 与 static 条目的起止时刻（08 BR-TEXT-29「运营位的排期、频次与徽标」细则「起止时间」；
// 04 §6.2「运营位」②：建议名 start_at / end_at，ISO 8601 带 +08:00，BR-TEXT-11）。
// 「section 与其中每个条目都可设起止时刻」：覆盖批 1 用到的每一类 section（首页原有 8 类、me 的
// more_services、契约启用的每种 search 置顶位）与 static 数据源的每一个条目（不只第一个）。
// 公告条条目（notice_item）已有的生效与失效时刻照旧（BR-TEXT-13 细则），不在本文件重复检查。
// 条目区间不超出 section 区间是保存时的服务端校验（20001，04 §6.6），JSON Schema 表达不了，不在本文件。
import { expect, it } from 'vitest';
import {
  BAD_INSTANTS,
  GOOD_INSTANTS,
  ME,
  OFFSET_BAD_INSTANTS,
  REGISTERED,
  SEARCH,
  admittedSearch,
  atLeastTwo,
  clone,
  expectPage,
  homeSection,
  itemsOf,
  meBase,
  moreServices,
  page,
  type Obj,
} from './kit.ts';

const [START, END, LATER] = GOOD_INSTANTS as [string, string, string];
// 都不设即不限；只设一端也合法（BR-TEXT-29「section 与条目都可设起止时刻（不设即不限）」）。四种都从
// 去掉起止时刻的干净样例出发（spec-test r2 S1 #6：不能带着 golden 原有的另一端）。
const GOOD_RANGES: [string, Obj][] = [
  ['都不设', {}],
  ['只设开始', { start_at: START }],
  ['只设结束', { end_at: LATER }],
  ['两端都设', { start_at: START, end_at: END }],
];
const TIME_KEYS = ['start_at', 'end_at'] as const;

function stripTimes(node: Obj): void {
  for (const key of TIME_KEYS) delete node[key];
}

/** section 的副本：section 自己与每个 static 条目都去掉起止时刻。 */
function clean(section: Obj): Obj {
  const next = clone(section);
  stripTimes(next);
  for (const item of itemsOf(next)) stripTimes(item);
  return next;
}
/** 格式不合，或语法合法但偏移量不是 +08:00。 */
const REJECTED: unknown[] = [...BAD_INSTANTS, ...OFFSET_BAD_INSTANTS];

type Case = { label: string; pageKey: string; section: Obj };

/** 批 1 用到的各类 section：首页原有 8 类、me 的 more_services、契约启用的每种 search 置顶位。 */
function sectionCases(): Case[] {
  return [
    { label: 'me.more_services', pageKey: ME, section: moreServices(meBase()) },
    ...admittedSearch().map(({ type, section }) => ({
      label: `search.${type}`,
      pageKey: SEARCH,
      section,
    })),
    ...REGISTERED.map((type) => ({
      label: `home.${type}`,
      pageKey: 'home',
      section: homeSection(type),
    })),
  ];
}

/** 干净 section 的第 index 个条目设上 fields（其他条目与 section 都不带起止时刻）。 */
function withItem(section: Obj, index: number, fields: Obj): Obj {
  const next = clean(section);
  Object.assign(itemsOf(next)[index] as Obj, fields);
  return next;
}

it('[AC-CT-27#5] 每类 section 可带起止时刻 start_at / end_at（+08:00 的 date-time）：从干净样例出发，都不设、只设开始、只设结束、两端都设都收；格式不合或偏移量不是 +08:00（Z、+09:00 等）拒收', () => {
  for (const { label, pageKey, section } of sectionCases()) {
    const base = clean(section);
    expectPage(page(pageKey, [clone(base)]), true, `${label} section 与条目都不设起止`);
    for (const [name, range] of GOOD_RANGES) {
      expectPage(
        page(pageKey, [{ ...clone(base), ...range }]),
        true,
        `${label} section ${name} ${JSON.stringify(range)}`,
      );
    }
    for (const bad of REJECTED) {
      for (const key of TIME_KEYS) {
        expectPage(
          page(pageKey, [{ ...clone(base), [key]: bad }]),
          false,
          `${label}.${key}=${JSON.stringify(bad)}`,
        );
      }
    }
  }
});

it('[AC-CT-27#6] static 数据源的每个条目（含第二个及以后）可带起止时刻 start_at / end_at：从干净样例出发，都不设、只设开始、只设结束、两端都设都收；任一条目格式不合或偏移量不是 +08:00 都拒收', () => {
  // BR-TEXT-29：section 与其中每个条目都可设起止时刻（不设即不限）；例：双十一活动格
  // end_at=11-12T00:00:00+08:00。运营新增一个不需要定时上线的入口时，条目不填起止也要收。
  const cases = sectionCases()
    .filter(({ section }) => section['type'] !== 'notice_bar' && itemsOf(section).length > 0)
    .map((c) => ({ ...c, section: atLeastTwo(c.pageKey, c.section) }));
  const multi = cases.filter(({ section }) => itemsOf(section).length > 1).map((c) => c.label);
  // 首页 banner、金刚区、活动入口与 me.more_services 都有两个以上条目：保证「第二项」真的被检查到。
  for (const label of [
    'me.more_services',
    'home.banner',
    'home.icon_grid',
    'home.activity_entry',
  ]) {
    expect(multi, `${label} 的 golden 至少两个条目`).toContain(label);
  }
  for (const { label, pageKey, section } of cases) {
    const count = itemsOf(section).length;
    for (let i = 0; i < count; i += 1) {
      for (const [name, range] of GOOD_RANGES) {
        expectPage(
          page(pageKey, [withItem(section, i, range)]),
          true,
          `${label} 条目 #${i} ${name} ${JSON.stringify(range)}`,
        );
      }
      for (const bad of REJECTED) {
        for (const key of TIME_KEYS) {
          expectPage(
            page(pageKey, [withItem(section, i, { [key]: bad })]),
            false,
            `${label} 条目 #${i} ${key}=${JSON.stringify(bad)}`,
          );
        }
      }
    }
  }
});
