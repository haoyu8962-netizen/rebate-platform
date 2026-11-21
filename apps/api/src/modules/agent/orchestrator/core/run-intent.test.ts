import { expect, it } from 'vitest';
import { contractIntentOf, storedIntentOf } from './run-intent.ts';

it('[AC-B3-08t#1] the intent port verdict wins', () => {
  expect(storedIntentOf({ checked: 'order_query', firstTool: null })).toBe('order_query');
  expect(storedIntentOf({ checked: 'page_guide', ruled: 'search', firstTool: null })).toBe(
    'page_guide',
  );
});

it('[AC-B3-08t#2] without a checked intent the first tool called decides', () => {
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
    expect(storedIntentOf({ firstTool: tool })).toBe(intent);
    // A port that decided on none (broken object) falls back to the tool as well.
    expect(storedIntentOf({ checked: null, ruled: 'search', firstTool: tool })).toBe(intent);
  }
  expect(storedIntentOf({ firstTool: 'unknown_tool' })).toBeNull();
  expect(storedIntentOf({ firstTool: 'constructor' })).toBeNull();
});

it('[AC-B3-08t#3] ref_ordinal is refine; the rules of the paths are kept', () => {
  expect(storedIntentOf({ checked: 'ref_ordinal', firstTool: null })).toBe('refine');
  expect(storedIntentOf({ ruled: 'find_by_link', firstTool: 'get_rebate_quote' })).toBe(
    'find_by_link',
  );
  expect(storedIntentOf({ checked: 'out_of_scope', firstTool: 'search_products' })).toBe(
    'out_of_scope',
  );
  expect(storedIntentOf({ ruled: 'search', firstTool: null })).toBe('search');
});

it('[AC-B3-08t#4] nothing checked, nothing called or no valid label → null', () => {
  expect(storedIntentOf({ ruled: null, firstTool: null })).toBeNull();
  expect(storedIntentOf({ firstTool: null })).toBeNull();
  expect(storedIntentOf({ checked: null, firstTool: null })).toBeNull();
  expect(storedIntentOf({ ruled: 'nonsense', firstTool: null })).toBeNull();
  expect(contractIntentOf(undefined)).toBeNull();
  expect(contractIntentOf('clarify')).toBe('clarify');
});

it('[AC-B3-08t#3][AC-B3-08t#6] the scenario entry intent wins over later text handling', () => {
  expect(storedIntentOf({ entry: 'find_by_link', checked: 'page_guide', firstTool: null })).toBe(
    'find_by_link',
  );
  expect(storedIntentOf({ entry: 'order_query', ruled: 'order_query', firstTool: null })).toBe(
    'order_query',
  );
  expect(storedIntentOf({ entry: null, checked: 'page_guide', firstTool: null })).toBe(
    'page_guide',
  );
  // U-7 in an entry run: the entry is still a fact.
  expect(storedIntentOf({ entry: 'find_by_link', withheld: true, firstTool: null })).toBe(
    'find_by_link',
  );
});

it('[AC-B3-08t#1][AC-B3-08t#2] the model label has no fact of its own: only the port, a rule or the first tool', () => {
  // A template run or a run stopped before the port recorded its verdict: the tool decides.
  expect(storedIntentOf({ firstTool: 'list_my_orders' })).toBe('order_query');
  // Nothing checked and no tool: empty (宁可漏判留空).
  expect(storedIntentOf({ firstTool: null })).toBeNull();
});

it('[AC-B3-08t#4] U-7 (no IntentPort, the label dropped for out_of_scope): withheld, even after a tool', () => {
  expect(storedIntentOf({ withheld: true, firstTool: null })).toBeNull();
  expect(storedIntentOf({ withheld: true, firstTool: 'search_products' })).toBeNull();
});
