// B3-05q implementation unit tests: which entry a run's context names (scenarioEntryOf).
import { expect, it } from 'vitest';
import { isEntryProductKey, scenarioEntryOf } from './scenario-entry.ts';

const ORDER = '0192f3a1-7c00-7000-8000-0000000e0001';

it('[B3-05q][BR-AI-01] 合法的 product_key / order_id 各自成为入口', () => {
  expect(scenarioEntryOf({ product_key: 'tb:synthetic-entry' })).toEqual({
    kind: 'product',
    productKey: 'tb:synthetic-entry',
  });
  expect(scenarioEntryOf({ order_id: ORDER })).toEqual({ kind: 'order', orderId: ORDER });
});

it('[B3-05q][BR-AI-01][BR-AI-05] 没有 context、只有 text、两项同给、格式不合法：都不是入口', () => {
  expect(scenarioEntryOf(undefined)).toBeNull();
  expect(scenarioEntryOf({ text: '合成剪贴板' })).toBeNull();
  expect(scenarioEntryOf({ product_key: 'tb:x', order_id: ORDER })).toBeNull();
  expect(scenarioEntryOf({ product_key: 'TB::不合法 key#1' })).toBeNull();
  expect(scenarioEntryOf({ product_key: 12345 })).toBeNull();
  expect(scenarioEntryOf({ order_id: 'not-an-id' })).toBeNull();
  expect(scenarioEntryOf({})).toBeNull();
});

it('[B3-05q][BR-AI-05] isEntryProductKey：只做 BR-PROD-02 的格式校验', () => {
  expect(isEntryProductKey('jd:100012345')).toBe(true);
  expect(isEntryProductKey('tb:a/b')).toBe(false);
  expect(isEntryProductKey('tb:a?b')).toBe(false);
  expect(isEntryProductKey('tbxx:a')).toBe(false);
  expect(isEntryProductKey(null)).toBe(false);
});
