import { isDeepStrictEqual } from 'node:util';
import type {
  Page,
  UnionItem,
  UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import type { JdAdapterOptions } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { ctx, itemRef, listing, mapped, row, wire, type Row } from '../jd-goods/kit.ts';
import { num } from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zzv#n]) identify this task's acceptance points, not business rules.
// FU-CATEGORY-BLOCKLIST 第一步（D10-805 ⑤）：jd.union.open.goods.query（搜索与详情）的
// categoryInfo.cid1 → category_l1_id（十进制字符串；JSON 数字与字符串都收；非正整数 / 缺失 → 缺省），
// categoryInfo.cid1Name → category_l1_name（trim 后非空才出，值原样，同淘宝 goods.ts 的口径）。
// 只取一级（cid1），不取 cid2 / cid3。类目不合格不跳行、不告警。
// goods.query 尚无录制（权限未批）：字段形状按京东文档的 categoryInfo.{cid1, cid1Name, cid2, cid2Name,
// cid3, cid3Name}，值全部合成，不是任何京东类目的真实 ID 或名称。不可见字符一律写 \uXXXX。

export const CID1 = '7000101';
export const CID1_NAME = '合成一级类目';
export const CID2 = '7000202';
export const CID2_NAME = '合成二级类目';
export const CID3 = '7000303';
export const CID3_NAME = '合成三级类目';
export const CATEGORY_KEYS: readonly string[] = ['category_l1_id', 'category_l1_name'];

/** A synthetic categoryInfo of three levels; `overrides` replace or (with undefined) drop members. */
export function categoryInfo(overrides: Row = {}): Row {
  return {
    cid1: num(CID1),
    cid1Name: CID1_NAME,
    cid2: num(CID2),
    cid2Name: CID2_NAME,
    cid3: num(CID3),
    cid3Name: CID3_NAME,
    ...overrides,
  };
}

/** The shared jd-goods row with `categoryInfo` set to `info` (undefined drops the member). */
export function withCategory(info: unknown, overrides: Row = {}): Row {
  return row({ categoryInfo: info, ...overrides });
}

/** Whether the DTO has `name` as an own key. */
export function has(value: object, name: string): boolean {
  return Object.hasOwn(value, name);
}

/** The DTO's own members other than the two category keys. */
export function withoutCategory(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => !CATEGORY_KEYS.includes(name)),
  );
}

/** Same DTO apart from the two category keys; for property bodies (no expect inside). */
export function sameOtherwise(left: object, right: object): boolean {
  return isDeepStrictEqual(withoutCategory(left), withoutCategory(right));
}

export interface Through {
  readonly page: Page<UnionItem>;
  readonly detail: UnionItemDetail;
  readonly warned: number;
}

/** One row through the live adapter's searchItems and getItem (item mode), with the warnings seen. */
export async function through(
  input: Row,
  overrides: Partial<JdAdapterOptions> = {},
): Promise<Through> {
  const { adapter, warn } = wire(() => listing([input]), overrides);
  const page = await adapter.searchItems({ keyword: '合成关键词' }, ctx);
  const detail = await adapter.getItem(itemRef, ctx);
  return { page, detail, warned: warn.mock.calls.length };
}

/** Synchronous mapping with a warning counter; for property bodies. */
export function mappedCounting(input: Row): {
  readonly item: UnionItemDetail;
  readonly warned: number;
} {
  let warned = 0;
  const item = mapped(input, {
    warn: () => {
      warned += 1;
    },
  });
  return { item, warned };
}
