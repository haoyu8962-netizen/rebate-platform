// CT-27 · section 与 static 条目的起止时刻（08 BR-TEXT-29「运营位的排期、频次与徽标」细则「起止时间」；
// 04 §6.2「运营位」②：建议名 start_at / end_at，ISO 8601 带 +08:00，BR-TEXT-11）。
// 时刻格式按契约既有写法（notice_item 的 date-time）；条目区间不超出 section 区间是保存时的服务端校验
// （20001，04 §6.6），JSON Schema 表达不了，不在本文件。
import { it } from 'vitest';
import {
  BAD_INSTANTS,
  GOOD_INSTANTS,
  ME,
  SEARCH,
  clone,
  expectPage,
  firstItem,
  homeSection,
  itemsOf,
  meBase,
  moreServices,
  page,
  searchBase,
  sectionsOf,
  type Obj,
} from './kit.ts';

const [START, END, LATER] = GOOD_INSTANTS as [string, string, string];
// 都不设即不限；只设一端也合法（BR-TEXT-29「section 与条目都可设起止时刻（不设即不限）」）。
const GOOD_RANGES: Obj[] = [
  { start_at: START, end_at: END },
  { start_at: START },
  { end_at: LATER },
];

type Case = { label: string; pageKey: string; section: Obj };

/** 批 1 用得到的几种 section：me 的 more_services、search 的置顶位、首页弹窗（后台表单带起止时刻）与首页 banner。 */
function sectionCases(): Case[] {
  return [
    { label: 'me.more_services', pageKey: ME, section: moreServices(meBase()) },
    { label: 'search 置顶位', pageKey: SEARCH, section: sectionsOf(searchBase())[0] as Obj },
    { label: 'home.popup', pageKey: 'home', section: homeSection('popup') },
    { label: 'home.banner', pageKey: 'home', section: homeSection('banner') },
  ];
}

it('[AC-CT-27#5] section 可带起止时刻 start_at / end_at（date-time，可只设一端），格式不合拒收', () => {
  for (const { label, pageKey, section } of sectionCases()) {
    expectPage(page(pageKey, [clone(section)]), true, `${label} 不设起止`);
    for (const range of GOOD_RANGES) {
      expectPage(
        page(pageKey, [{ ...clone(section), ...range }]),
        true,
        `${label} 带 ${JSON.stringify(range)}`,
      );
    }
    for (const bad of BAD_INSTANTS) {
      for (const key of ['start_at', 'end_at']) {
        expectPage(
          page(pageKey, [{ ...clone(section), [key]: bad }]),
          false,
          `${label}.${key}=${JSON.stringify(bad)}`,
        );
      }
    }
  }
});

it('[AC-CT-27#6] static 数据源的每个条目可带起止时刻 start_at / end_at（date-time，可只设一端），格式不合拒收', () => {
  // BR-TEXT-29：section 与其中每个条目都可设起止时刻；例：双十一活动格 end_at=11-12T00:00:00+08:00。
  const cases = sectionCases().filter(({ section }) => itemsOf(section).length > 0);
  for (const { label, pageKey, section } of cases) {
    for (const range of GOOD_RANGES) {
      const next = clone(section);
      Object.assign(firstItem(next), range);
      expectPage(page(pageKey, [next]), true, `${label} 条目带 ${JSON.stringify(range)}`);
    }
    for (const bad of BAD_INSTANTS) {
      for (const key of ['start_at', 'end_at']) {
        const next = clone(section);
        firstItem(next)[key] = bad;
        expectPage(page(pageKey, [next]), false, `${label} 条目 ${key}=${JSON.stringify(bad)}`);
      }
    }
  }
});
