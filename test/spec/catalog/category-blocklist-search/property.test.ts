// B1-04zzx (D10-860 ①③④) property: for any page of items (with, without or with an empty
// category) and any active rows of the app, the main results are exactly the items the rules let
// through, in upstream order, and the two alert counts match the page.
// The first example always has blocked items. All values are synthetic.
// Run count (orchestrator D10-902 ②): every sample builds a whole new search fixture, which is
// costly and keeps about 120 KB per sample, so PROP_RUNS 100 000 runs out of memory in CI. The
// count follows PROP_RUNS scaled by 1/100 with a floor of 50 (100 000 → 1 000); the seed is
// PROP_SEED as it is.
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  APP,
  BLOCKED_EVENT,
  MISSING_EVENT,
  alerts,
  goods,
  isBlocked,
  setup,
  total,
} from './kit.ts';

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

it('[AC-B1-04zzx#11] 任意商品与名单：主结果恰为规则放行的商品且保持上游顺序，无类目与被滤两类告警计数与该页一致', async () => {
  let checked = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(itemSpec, { maxLength: 12 }),
      fc.array(row, { maxLength: 5 }),
      async (specs, rows) => {
        const f = setup();
        f.block(APP, rows);
        const page = specs.map((spec, index) =>
          goods(`p${index}`, spec.category, {
            title: [`synthetic-p${index}`, ...spec.fragments].join('-'),
          }),
        );
        f.pages.set(1, { items: page, hasMore: false });
        const result = await f.run({ limit: 50 });
        const judged = page.map(({ item }) => ({
          title: item.title,
          missing: item.category_l1_id === undefined || item.category_l1_id === '',
          blocked: isBlocked(
            { platform: item.platform, categoryId: item.category_l1_id ?? null, title: item.title },
            rows,
          ),
        }));
        expect(result.items.map((card) => card.title)).toEqual(
          judged.filter((entry) => !entry.blocked).map((entry) => entry.title),
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
    {
      numRuns: Math.max(50, Math.floor(propRuns() / 100)),
      seed: propSeed(),
      examples: [
        [
          [
            { category: '50', fragments: [] },
            { category: undefined, fragments: ['禁售词'] },
            { category: '', fragments: ['AAB'] },
            { category: '70', fragments: ['A+B'] },
          ],
          [
            { platform: 'taobao', categoryId: '50', keyword: null },
            { platform: 'taobao', categoryId: '70', keyword: '禁售词' },
            { platform: 'jd', categoryId: '500', keyword: '跨平台词' },
          ],
        ],
      ],
    },
  );
  expect(checked).toBeGreaterThan(0);
}, 900_000);
