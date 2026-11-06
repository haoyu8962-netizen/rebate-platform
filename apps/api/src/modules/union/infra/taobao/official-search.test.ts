import { expect, it } from 'vitest';
import { firstPerItemId } from './official-search.ts';

// Local unit-test identifiers (B1-04zzj, D10-692 S2-4); synthetic ids.

it('[B1-04zzj unit] firstPerItemId keeps the first of each item_id, order unchanged', () => {
  const items = [
    { item_id: 'syn-a', title: 'a1' },
    { item_id: 'syn-b', title: 'b1' },
    { item_id: 'syn-a', title: 'a2' },
    { item_id: 'syn-c', title: 'c1' },
    { item_id: 'syn-b', title: 'b2' },
  ];
  expect(firstPerItemId(items).map((item) => item.title)).toEqual(['a1', 'b1', 'c1']);
  expect(firstPerItemId([])).toEqual([]);
});
