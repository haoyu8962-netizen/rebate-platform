import { expect } from 'vitest';
import type {
  UnionItemDetail,
  UnionShopScore,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx as jdCtx,
  itemRef as jdRef,
  listing,
  row as jdRow,
  wire,
  type Row,
} from '../jd-goods/kit.ts';
import {
  ctx as pddCtx,
  envelope,
  ref as pddRef,
  row as pddRow,
  setup as pddSetup,
} from '../pdd-goods/kit.ts';

// Task-local AC labels ([AC-B1-04zzm#n]) identify this task's acceptance points, not business rules.
// S-09 S09c（D10-736）：联盟详情新增五个可选字段，取不到就缺省（键不出现）。报文值全部合成，
// 不是任何录制原值；字段含义（规划/09 U-92）未实测，这里只钉「原样透传 / 缺省」与选券口径。
// 不可见字符一律写 \uXXXX。

/** The five detail fields of this task. */
export const EXTRA_FIELDS = [
  'coupon_end_at',
  'sales_text',
  'shop_logo',
  'shop_scores',
  'shop_ref',
] as const;
export type ExtraField = (typeof EXTRA_FIELDS)[number];

export const SCORE_KEYS = ['desc', 'serv', 'lgst', 'level'] as const;
export const MAX_URL_LENGTH = 2048;
export const BEIJING_OFFSET_MS = 8 * 3_600_000;

export const LOGO = 'https://img.synthetic.invalid/mall/logo-0001.png';
export const MALL_ID = 987_654_321;
export const SALES = '10万+';

/** Pinduoduo store fields of a detail row (synthetic). */
export function pddStore(overrides: Row = {}): Row {
  return {
    mall_name: '合成拼单小店',
    mall_id: MALL_ID,
    mall_img_url: LOGO,
    sales_tip: SALES,
    desc_txt: '高',
    serv_txt: '中',
    lgst_txt: '低',
    ...overrides,
  };
}

/** A goods.detail row: the shared pdd-goods row plus the store fields, then `overrides`. */
export function pddDetailRow(overrides: Row = {}): Row {
  return pddRow({ ...pddStore(), ...overrides });
}

/** One row through the live Pinduoduo adapter's getItem (goods.detail). */
export async function pddDetail(input: Row): Promise<UnionItemDetail> {
  const { adapter } = pddSetup((body) => envelope(body.type, [input]));
  return adapter.getItem(pddRef, pddCtx);
}

/** One goods.query row through the live jd adapter's getItem (item mode). */
export async function jdDetail(input: Row): Promise<UnionItemDetail> {
  const { adapter } = wire(() => listing([input]));
  return adapter.getItem(jdRef, jdCtx);
}

/** A jd goods row with `shopInfo` (merged over a synthetic one) and other top-level overrides. */
export function jdDetailRow(shopInfo: Row | null = {}, overrides: Row = {}): Row {
  return jdRow({
    shopInfo: shopInfo === null ? undefined : { shopName: '合成京东小店', ...shopInfo },
    ...overrides,
  });
}

/** Whether the DTO has `name` as an own key. */
export function has(value: object, name: string): boolean {
  return Object.hasOwn(value, name);
}

/** The own keys of a DTO among the five fields. */
export function extrasPresent(value: object): ExtraField[] {
  return EXTRA_FIELDS.filter((name) => has(value, name));
}

/** `ms` as Beijing wall time with +08:00, whole seconds, e.g. 2025-10-10T23:59:59+08:00. */
export function beijing(ms: number): string {
  return `${new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 19)}+08:00`;
}

/** coupon_end_at is an ISO 8601 +08:00 time for exactly `ms` (a .000 fraction is accepted). */
export function expectBeijingInstant(value: unknown, ms: number): void {
  expect(value).toBeTypeOf('string');
  const text = value as string;
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?\+08:00$/);
  expect(text.replace('.000', '')).toBe(beijing(ms));
  expect(Date.parse(text)).toBe(ms);
}

/** shop_scores as a key → value map; absent and [] both give {}. Checks the item shape. */
export function scoresOf(value: UnionItemDetail): Record<string, string> {
  const scores: readonly UnionShopScore[] = value.shop_scores ?? [];
  expect(Array.isArray(scores)).toBe(true);
  expect(scores.length).toBeLessThanOrEqual(SCORE_KEYS.length);
  const out: Record<string, string> = {};
  for (const score of scores) {
    expect(Object.keys(score).sort()).toEqual(['key', 'value']);
    expect(SCORE_KEYS).toContain(score.key);
    expect(has(out, score.key), `shop_scores key ${score.key} twice`).toBe(false);
    expect(score.value).toBeTypeOf('string');
    expect(score.value).not.toBe('');
    out[score.key] = score.value;
  }
  return out;
}

/** No scores: the field is absent or []. */
export function expectNoScores(value: UnionItemDetail): void {
  if (has(value, 'shop_scores')) expect(value.shop_scores).toEqual([]);
}
