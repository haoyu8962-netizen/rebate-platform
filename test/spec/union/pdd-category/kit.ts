import { expect } from 'vitest';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import {
  mapPddGoods,
  type PddGoodsSource,
} from '../../../../apps/api/src/modules/union/infra/pdd/goods.ts';
import { instant, one, row, type Source } from '../pdd-goods/kit.ts';

// B1-04zzw（FU-CATEGORY-BLOCKLIST 第一步，D10-805 ⑤）：拼多多 goods.search / goods.detail /
// goods.recommend.get 的 cat_ids[0] → category_l1_id（十进制字符串）；拼多多没有一级名称，
// category_l1_name 一律不出；cat_id 不用。字段形状按三个商品接口文档与录制（cat_ids 为整数数组），
// 下面的类目 ID 全是合成值，不是平台真实类目。

/** 合成的 cat_ids：三个正整数，首项既不是最小也不是最大，用来区分「取首项」与排序取值。 */
export const CAT_IDS: readonly number[] = [8569, 8439, 8581];
/** CAT_IDS 首项的十进制字符串。 */
export const L1 = '8569';
/** 与 B1-04zzv 同口径：正整数、无前导零的十进制字符串。 */
export const L1_SHAPE = /^[1-9][0-9]{0,18}$/;

/** pdd-goods 默认行加上合成 cat_ids。 */
export function catRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return row({ cat_ids: [...CAT_IDS], ...overrides });
}

export function has(item: object, key: string): boolean {
  return Object.hasOwn(item, key);
}

/** 不经适配器，直接调映射（用于 JSON 表达不了的值：非安全整数、NaN、稀疏数组）。 */
export function mapped(source: PddGoodsSource, input: Record<string, unknown>): UnionItem {
  return mapPddGoods(input, source, new Date(instant), () => undefined);
}

/** 有一级类目 ID，且没有一级类目名称。 */
export function expectL1(item: UnionItem, id: string): void {
  expect(item.category_l1_id).toBe(id);
  expect(item.category_l1_id).toMatch(L1_SHAPE);
  expect(has(item, 'category_l1_name')).toBe(false);
}

/** 两个类目字段都不出。 */
export function expectNoCategory(item: UnionItem): void {
  expect(has(item, 'category_l1_id')).toBe(false);
  expect(has(item, 'category_l1_name')).toBe(false);
}

/** 每条「不出」用例先过一次「有值」对照：同一入口、合格 cat_ids 时出 L1。 */
export async function control(source: Source): Promise<void> {
  expectL1(await one(source, catRow()), L1);
}
