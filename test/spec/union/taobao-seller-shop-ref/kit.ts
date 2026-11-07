import { expect } from 'vitest';
import type { UnionItem } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { ALLOWED_ITEM_KEYS, type Harness } from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zzs#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：大淘客搜索行沿用 taobao-search/kit.ts 的 dtkRow（只读复用），sellerId 换成纯数字合成值；
// 不读私有录制、不联网、不监听端口。
//
// 口径（S-17 S17-u1，D10-806 ①）：淘宝 sellerId 本期只取大淘客搜索，映射为 UnionItem.shop_ref——
// 正整数十进制字符串（/^[1-9][0-9]*$/，与 domain/types.ts shopRefField 同口径）原样，或安全正整数
// number 的十进制文本；其余一律不带 shop_ref，但该条照常返回、不告警 invalid_item。

/** Positive decimal integer without leading zeros (shopRefField's rule). */
const SHOP_REF_TEXT = /^[1-9][0-9]*$/;

/**
 * The shop_ref a 大淘客 search row should carry for this `sellerId`, judged on what the row looks
 * like after the JSON wire (undefined → the key is absent): a decimal string as given, a safe
 * positive integer as its decimal text, otherwise none.
 */
export function expectedShopRef(sellerId: unknown): string | undefined {
  if (sellerId === undefined) return undefined;
  const wire: unknown = (JSON.parse(JSON.stringify([sellerId])) as unknown[])[0];
  if (typeof wire === 'string') return SHOP_REF_TEXT.test(wire) ? wire : undefined;
  if (typeof wire === 'number' && Number.isSafeInteger(wire) && wire > 0) return String(wire);
  return undefined;
}

/** The item carries `shop_ref` as its own key with exactly this string value. */
export function expectShopRef(item: UnionItem | undefined, value: string): void {
  expect(item, 'item').toBeDefined();
  expect(Object.hasOwn(item!, 'shop_ref'), 'shop_ref present').toBe(true);
  expect(typeof item!.shop_ref).toBe('string');
  expect(item!.shop_ref).toBe(value);
}

/** The item has no `shop_ref` key at all (not even an undefined / null / empty one). */
export function expectNoShopRef(item: UnionItem | undefined): void {
  expect(item, 'item').toBeDefined();
  expect(Object.hasOwn(item!, 'shop_ref'), 'shop_ref absent').toBe(false);
}

/** Every key of the item is one a searched Taobao item may carry. */
export function expectOnlyAllowedKeys(item: UnionItem): void {
  for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
}

/** No invalid_item warning was sent: a shop id is optional, never a reason to skip a row. */
export function expectNoInvalidItem(h: Harness): void {
  const codes = h.warn.mock.calls.map(([event]) => event.code);
  expect(codes).not.toContain('invalid_item');
}
