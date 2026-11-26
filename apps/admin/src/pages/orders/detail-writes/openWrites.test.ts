// Unit tests of the open write count (F1-07ee r7, D10-3169): per order, only in memory; each
// begin is ended once (ending again changes nothing, the count never goes below zero), and the
// subscribers are told of every change.
import { expect, it } from 'vitest';
import { beginWrite, subscribeWrites, writePending } from './openWrites.ts';

it('[AC-F1-07ee-UNIT#25] 在途计数：begin / 结束成对，重复结束不变负，按订单分开，订阅在变化时触发', () => {
  const calls: boolean[] = [];
  const off = subscribeWrites(() => calls.push(writePending('order-a')));
  expect(writePending('order-a')).toBe(false);
  const first = beginWrite('order-a');
  const second = beginWrite('order-a');
  expect(writePending('order-a')).toBe(true);
  expect(writePending('order-b')).toBe(false);
  first();
  expect(writePending('order-a')).toBe(true);
  first();
  expect(writePending('order-a'), 'ending twice does not end the other write').toBe(true);
  second();
  expect(writePending('order-a')).toBe(false);
  second();
  first();
  expect(writePending('order-a')).toBe(false);
  // A begin after extra ends counts from zero: one end clears it.
  const third = beginWrite('order-a');
  expect(writePending('order-a')).toBe(true);
  third();
  expect(writePending('order-a')).toBe(false);
  expect(calls).toEqual([true, true, true, false, true, false]);
  off();
  beginWrite('order-a')();
  expect(calls).toHaveLength(6);
});
