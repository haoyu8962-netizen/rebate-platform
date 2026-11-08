// B1-04zzzz (D10-860 ①④⑦) property: for any channel page (items with, without or with an empty
// category) and any active rows of the app, the hot list holds exactly the positions the rules let
// through, each ranked by its own channel position, and a one-channel feed section holds exactly
// those items in upstream order; the two alert counts match the page. Pages say hasMore=false, so
// no refill is involved. The first example always has blocked items. All values are synthetic.
// Run count (as B1-04zzx, D10-902 ②): every sample builds whole new fixtures, so the count follows
// PROP_RUNS scaled by 1/100 with a floor of 50; the seed is PROP_SEED as it is. No vi.fn is created
// per sample (#2682).
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  APP,
  BLOCKED_EVENT,
  MISSING_EVENT,
  TB,
  TB_CHANNEL,
  alerts,
  eventsOf,
  feedTitles,
  hotFixture,
  isBlocked,
  rankTitles,
  ranked,
  sectionHome,
  total,
  type BlockRow,
} from './home-kit.ts';

const CATEGORIES = [undefined, '', '50', '500', '70'] as const;
const FRAGMENTS = ['禁售词', 'A+B', 'AAB', '跨平台词'] as const;

const itemSpec = fc.record({
  category: fc.constantFrom(...CATEGORIES),
  fragments: fc.subarray([...FRAGMENTS]),
});
const row = fc.record({
  platform: fc.constantFrom('taobao' as const, 'jd' as const),
  categoryId: fc.constantFrom('50', '70', '500'),
  keyword: fc.constantFrom(null, '禁售词', 'A+B', '跨平台词'),
});

interface ItemSpec {
  category: (typeof CATEGORIES)[number];
  fragments: (typeof FRAGMENTS)[number][];
}
interface RowSpec {
  platform: 'taobao' | 'jd';
  categoryId: '50' | '70' | '500';
  keyword: null | '禁售词' | 'A+B' | '跨平台词';
}

const EXAMPLE: [ItemSpec[], RowSpec[]] = [
  [
    { category: '50', fragments: [] },
    { category: undefined, fragments: ['禁售词'] },
    { category: '', fragments: ['AAB'] },
    { category: '70', fragments: ['A+B'] },
    { category: '500', fragments: ['跨平台词'] },
  ],
  [
    { platform: 'taobao', categoryId: '50', keyword: null },
    { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
    { platform: 'jd', categoryId: '500', keyword: '跨平台词' },
  ],
];

function pageOf(specs: readonly ItemSpec[]) {
  return specs.map((spec, index) =>
    ranked(`p${index}`, spec.category, {
      title: [`synthetic-p${index}`, ...spec.fragments].join('-'),
    }),
  );
}

function judge(page: ReturnType<typeof pageOf>, rows: readonly BlockRow[]) {
  return page.map(({ item }, index) => ({
    rank: index + 1,
    title: item.title,
    missing: item.category_l1_id === undefined || item.category_l1_id === '',
    blocked: isBlocked(
      { platform: item.platform, categoryId: item.category_l1_id ?? null, title: item.title },
      rows,
    ),
  }));
}

const settings = () => ({
  numRuns: Math.max(50, Math.floor(propRuns() / 100)),
  seed: propSeed(),
  examples: [EXAMPLE],
});

it('[AC-B1-04zzzz#16] 任意商品与名单：热销榜恰为规则放行的位次（名次=频道原位次），无类目与被滤告警计数与该页一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(itemSpec, { maxLength: 12 }),
      fc.array(row, { maxLength: 5 }),
      async (specs, rows) => {
        const f = hotFixture();
        f.block(APP, rows);
        const page = pageOf(specs);
        f.setPage('taobao', TB_CHANNEL, null, 1, page, false);
        const result = await f.run();
        const judged = judge(page, rows);
        expect(rankTitles(result)).toEqual(
          judged.filter((entry) => !entry.blocked).map((entry) => [entry.rank, entry.title]),
        );
        expect(total(alerts(f.warn, MISSING_EVENT))).toBe(
          judged.filter((entry) => entry.missing).length,
        );
        expect(total(alerts(f.warn, BLOCKED_EVENT))).toBe(
          judged.filter((entry) => entry.blocked).length,
        );
        checked += 1;
        return true;
      },
    ),
    settings(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);

it('[AC-B1-04zzzz#17] 任意商品与名单：单频道物料流恰为规则放行的商品且保持上游顺序，无类目与被滤告警计数与该页一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(itemSpec, { maxLength: 12 }),
      fc.array(row, { maxLength: 5 }),
      async (specs, rows) => {
        const f = sectionHome({ channels: [TB] });
        f.block(APP, rows);
        const page = pageOf(specs);
        f.answer(TB, 1, page, false);
        const result = await f.run();
        const judged = judge(page, rows);
        expect(feedTitles(result)).toEqual(
          judged.filter((entry) => !entry.blocked).map((entry) => entry.title),
        );
        const warnings = f.warnings();
        expect(total(eventsOf(warnings, MISSING_EVENT))).toBe(
          judged.filter((entry) => entry.missing).length,
        );
        expect(total(eventsOf(warnings, BLOCKED_EVENT))).toBe(
          judged.filter((entry) => entry.blocked).length,
        );
        checked += 1;
        return true;
      },
    ),
    settings(),
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
