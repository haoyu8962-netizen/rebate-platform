import { expect, it } from 'vitest';
import { contractIntentOf, storedIntentOf } from './run-intent.ts';

it('[AC-B3-08t#1] the intent port verdict wins over the model label', () => {
  expect(
    storedIntentOf({ checked: 'order_query', traced: 'earnings_query', firstTool: null }),
  ).toBe('order_query');
  expect(storedIntentOf({ checked: 'page_guide', traced: 'page_guide', firstTool: null })).toBe(
    'page_guide',
  );
});

it('[AC-B3-08t#2] without an intent the first tool called decides', () => {
  const cases = [
    ['search_products', 'search'],
    ['get_rebate_quote', 'find_by_link'],
    ['list_my_orders', 'order_query'],
    ['explain_order', 'order_query'],
    ['prefill_claim', 'order_query'],
    ['get_my_earnings', 'earnings_query'],
    ['search_rules', 'rule_qa'],
    ['handoff_to_human', 'handoff'],
  ] as const;
  for (const [tool, intent] of cases) {
    expect(storedIntentOf({ traced: null, firstTool: tool })).toBe(intent);
    // A port that decided on none (broken object) falls back to the tool as well.
    expect(storedIntentOf({ checked: null, traced: 'search', firstTool: tool })).toBe(intent);
  }
  expect(storedIntentOf({ traced: null, firstTool: 'unknown_tool' })).toBeNull();
  expect(storedIntentOf({ traced: null, firstTool: 'constructor' })).toBeNull();
});

it('[AC-B3-08t#3] ref_ordinal is refine; core intents of the paths are kept', () => {
  expect(storedIntentOf({ checked: 'ref_ordinal', traced: 'ref_ordinal', firstTool: null })).toBe(
    'refine',
  );
  expect(storedIntentOf({ traced: 'find_by_link', firstTool: 'get_rebate_quote' })).toBe(
    'find_by_link',
  );
  expect(storedIntentOf({ traced: 'out_of_scope', firstTool: 'search_products' })).toBe(
    'out_of_scope',
  );
  expect(storedIntentOf({ traced: 'search', firstTool: null })).toBe('search');
});

it('[AC-B3-08t#4] nothing served, nothing called or no valid label → null', () => {
  expect(storedIntentOf({ traced: 'search', unserved: true, firstTool: null })).toBeNull();
  expect(storedIntentOf({ traced: null, firstTool: null })).toBeNull();
  expect(storedIntentOf({ checked: null, traced: null, firstTool: null })).toBeNull();
  expect(storedIntentOf({ traced: 'nonsense', firstTool: null })).toBeNull();
  expect(contractIntentOf(undefined)).toBeNull();
  expect(contractIntentOf('clarify')).toBe('clarify');
});

it('[AC-B3-08t#3][AC-B3-08t#6] the scenario entry intent wins over later text handling', () => {
  expect(
    storedIntentOf({
      entry: 'find_by_link',
      checked: 'page_guide',
      traced: 'page_guide',
      firstTool: null,
    }),
  ).toBe('find_by_link');
  expect(storedIntentOf({ entry: 'order_query', traced: 'order_query', firstTool: null })).toBe(
    'order_query',
  );
  expect(
    storedIntentOf({ entry: null, checked: 'page_guide', traced: null, firstTool: null }),
  ).toBe('page_guide');
});

it('[AC-B3-08t#1][AC-B3-08t#2] an unchecked model label (template run) is not stored: the first tool decides', () => {
  expect(
    storedIntentOf({ traced: 'earnings_query', unchecked: true, firstTool: 'list_my_orders' }),
  ).toBe('order_query');
  expect(storedIntentOf({ traced: 'earnings_query', unchecked: true, firstTool: null })).toBeNull();
});
