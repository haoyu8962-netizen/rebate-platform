// 淘宝官方搜索 taobao.tbk.dg.material.optional.upgrade（B1-04zx，D10-504 / D10-582；BR-PRICE-01、
// BR-PRICE-11）：请求参数、游标、result_list 解包、跳行判断与搜索 ID 换算的匹配；发请求在
// taobao-adapter.ts。规则测试 test/spec/union/taobao-official-search/**。
//
// 开关：searchSource 为 official（未设也是）且注入了 searchSlot 时 searchItems 走官方；没有 searchSlot
// 保持 adapter_unimplemented，不取凭据、不发请求。不依赖 orderSource：只有官方凭据、没有大淘客也能走。
// dataoke 行为不变，不读 searchSlot。
//
// ① 请求：业务参数只有 q（SearchQuery.keyword 原样）、page_no、page_size 20、adzone_id；不传 sort。
//   adzone_id 取 searchSlot 给出的 query 场景 PID 第 3 段（mm_<member>_<site>_<adzone> 的 adzone，只作
//   请求参数，返回的链接不用；BR-PROD-07）；searchSlot 给 null 或 PID 取不出 adzone →
//   adapter_unimplemented，不发请求。空白关键词 invalid_dto，不发请求。归档 kind = query；ctx.signal
//   原样带上。
// ② 游标：taobao-search:<页码>；大淘客、别的接口的游标与畸形游标都 invalid_dto，不发请求。下一页：
//   本页原始条数（跳过 / 换不到的照样计数）满 20 且（页码 × 20 < total_results，缺失时只看满页）。
// ③ 无结果：空 map_data、{ total_results: 0 } 没有 result_list / map_data、15/50001 都是空页
//   { items: [], nextCursor: null }，不报错、不调换算（回落按这个判断）。
// ④ 映射：合格的行整行交 goods.ts mapTaobaoDetail，三价、佣金、类目、图片、优惠时间窗都与详情同一份
//   解析，价格配置同样按 ctx.appId 读；时间窗与 quoted_at 都取收到搜索响应时的注入时钟。click_url、
//   coupon_share_url、commission_amount、short_title、volume、搜索 item_id 都不外露。
// ⑤ 商品 ID：搜索 item_id 经 item.info.upgrade.get 换成详情口径（一页一次批量，缓存命中不再调）。
//   换算结果按 item_id 最后一段（deriveProductKey 同口径）与搜索 ID 匹配，不按位置：乱序、少条都能
//   各得其所，不逐个重查；最后一段对不上的不返回、不写缓存，不用搜索 ID 兜底。15/50001 或 results 为空
//   是本批换不到；其余失败（code 7、传输抛错、限流、超时）原样抛出，不当作换不到，catalog 才判得出
//   故障。大淘客的 goodsId 两段都与详情口径不同，那一路仍按位置对应（dataoke-search.ts）。
// ⑥ 价格不合格不跳行：字段缺失、非法文本、coupon ≥ price、final ≤ 0、calc_diff、unknown_promo、优惠
//   不在时间窗内都与详情一样出 price_status = 'anomaly'，三价 0，留在 items 里，不废页。
// ⑦ 跳行只有缺标题、佣金非法、换不到 ID（含搜索 item_id 本身不合格）：经 searchWarn 发
//   taobao_search_row_skipped，字段只有 reason，不含取值；不走适配器 warn（那是 API 权限告警）。
//   整页每行都因缺标题或佣金非法而跳过 → invalid_dto（不调换算）；换不到不算非法，本页照常返回。
// ⑧ 外层：外层键缺失或不是对象 → upstream_unavailable（request() 的做法）；result_list / map_data
//   损坏 → invalid_dto；code 11 → upstream_rejected。
// ⑨ 同页去重（B1-04zzj，D10-692 S2-4）：同一页里换回的凑狸 item_id（详情口径）相同的行只保留首条
//   能返回的那条（被跳过 / 换不到的行不算首条），其余不出现，顺序不变；不报错、不另发告警。
//   nextCursor 仍按原始条数（②）。只在同一页内去重，不跨页。
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import { UnionError, type CallCtx } from '../../domain/types.ts';
import { detailRowFault } from './goods.ts';
import { slotAdzones } from './orders.ts';
import type { TaobaoSubCodeMap } from './response.ts';

/** The TOP method of the official material search. */
export type TaobaoOfficialSearchMethod = 'taobao.tbk.dg.material.optional.upgrade';

/** The response envelope key registered for that method. */
export type TaobaoOfficialSearchEnvelope = 'tbk_dg_material_optional_upgrade_response';

/** Rows asked per search page (page_size). */
export type TaobaoOfficialSearchPageSize = 20;

/**
 * The calling app's active Taobao query PID (mm_<member>_<site>_<adzone>), or null when it has
 * none. Called with the searchItems CallCtx, before the search request; the adzone only fills the
 * request parameter.
 */
export type TaobaoSearchSlotReader = (ctx: CallCtx) => Promise<string | null>;

/** Why a search row was left out of the result. */
export type TaobaoSearchSkipReason = 'title_missing' | 'commission_invalid' | 'item_unconverted';

/** One skipped search row; carries no value of that row. */
export interface TaobaoSearchWarning {
  readonly event: 'taobao_search_row_skipped';
  readonly reason: TaobaoSearchSkipReason;
}

export const TAOBAO_OFFICIAL_SEARCH: TaobaoOfficialSearchMethod =
  'taobao.tbk.dg.material.optional.upgrade';
export const TAOBAO_OFFICIAL_SEARCH_ENVELOPE: TaobaoOfficialSearchEnvelope =
  'tbk_dg_material_optional_upgrade_response';
/** 15 / 50001 无结果：调用方当空页。 */
export const TAOBAO_OFFICIAL_SEARCH_SUB_CODES: TaobaoSubCodeMap = Object.freeze({
  '50001': 'item_unavailable',
});

const TAOBAO_OFFICIAL_SEARCH_PAGE_SIZE: TaobaoOfficialSearchPageSize = 20;
/** 游标页码上限，同大淘客搜索；越界的游标按非法处理。 */
const MAX_SEARCH_PAGE = 9_999;
const CURSOR_PREFIX = 'taobao-search:';
const CURSOR_PATTERN = /^taobao-search:([1-9][0-9]{0,3})$/;
/** 只作匹配键：前缀不进结果，最后一段的切分交给 deriveProductKey（BR-PROD-03）。 */
const MATCH_PLATFORM = { platform: 'taobao', keyPrefix: 'tb' } as const;

/** One search response, reduced to what paging needs. */
export interface TaobaoOfficialSearchPage {
  /** result_list.map_data as given (one entry per upstream row, valid or not). */
  readonly rows: readonly unknown[];
  /** total_results when a non-negative safe integer, else null. */
  readonly total: number | null;
}

/** One row that passed the title / commission / item_id checks, before conversion. */
export interface TaobaoOfficialSearchCandidate {
  readonly searchId: string;
  readonly row: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): UnionError {
  return new UnionError('invalid_dto', `taobao searchItems: ${message}`, 'taobao');
}

/** The opaque cursor of search page `page` (≥ 2). */
function officialSearchCursor(page: number): string {
  return `${CURSOR_PREFIX}${page}`;
}

/** The page a cursor of this search carries; anything else → invalid_dto. */
export function parseOfficialSearchCursor(cursor: string): number {
  const match = typeof cursor === 'string' ? CURSOR_PATTERN.exec(cursor) : null;
  const page = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(page) || page < 2 || page > MAX_SEARCH_PAGE) {
    throw invalid('cursor does not belong to the official search');
  }
  return page;
}

/** The adzone of a query PID; undefined when the PID has none. */
export function searchAdzone(pid: string): string | undefined {
  const [adzone] = slotAdzones([pid]);
  return adzone;
}

/** Business parameters q / page_no / page_size / adzone_id of one search request. */
export function officialSearchParameters(
  keyword: string,
  page: number,
  adzone: string,
): Readonly<Record<string, string | number>> {
  return {
    q: keyword,
    page_no: page,
    page_size: TAOBAO_OFFICIAL_SEARCH_PAGE_SIZE,
    adzone_id: adzone,
  };
}

/** result_list.map_data and total_results of a search response (see the header ③ ⑧). */
export function officialSearchPage(inner: unknown): TaobaoOfficialSearchPage {
  const body = isRecord(inner) ? inner : {};
  const count = body.total_results;
  const total =
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  const list = body.result_list ?? undefined;
  if (list !== undefined && !isRecord(list)) throw invalid('result_list is not an object');
  const rows = isRecord(list) ? list.map_data : undefined;
  if (rows === undefined || rows === null) {
    if (total === 0) return { rows: [], total };
    throw invalid('result_list is missing');
  }
  if (!Array.isArray(rows)) throw invalid('map_data is not an array');
  return { rows, total };
}

/** nextCursor from the raw row count of this page (see the header ②). */
export function officialSearchNextCursor(
  page: number,
  rawCount: number,
  total: number | null,
): string | null {
  const more =
    rawCount >= TAOBAO_OFFICIAL_SEARCH_PAGE_SIZE &&
    page < MAX_SEARCH_PAGE &&
    (total === null || page * TAOBAO_OFFICIAL_SEARCH_PAGE_SIZE < total);
  return more ? officialSearchCursor(page + 1) : null;
}

/** The last-segment key of an item_id; undefined when deriveProductKey refuses it. */
function matchKey(itemId: string): string | undefined {
  try {
    return deriveProductKey(MATCH_PLATFORM, { item_id: itemId });
  } catch (error) {
    if (error instanceof ProductKeyUnderivable) return undefined;
    throw error;
  }
}

/** A search item_id that may go into the comma-joined item_id parameter. */
function searchIdOf(row: Record<string, unknown>): string | undefined {
  const id = row.item_id;
  if (typeof id !== 'string' || id === '' || id.includes(',') || /\s/u.test(id)) return undefined;
  return matchKey(id) === undefined ? undefined : id;
}

/** One skip report: the event and the reason, never a value of the row. */
export function reportSearchSkip(
  warn: ((event: TaobaoSearchWarning) => void) | undefined,
  reason: TaobaoSearchSkipReason,
): void {
  warn?.({ event: 'taobao_search_row_skipped', reason });
}

/**
 * Rows that may be returned, in search order; the others are reported through `warn`. Every row
 * of a non-empty page lacking a title or a valid commission → invalid_dto.
 */
export function officialSearchCandidates(
  rows: readonly unknown[],
  warn: ((event: TaobaoSearchWarning) => void) | undefined,
): readonly TaobaoOfficialSearchCandidate[] {
  const out: TaobaoOfficialSearchCandidate[] = [];
  let faulty = 0;
  for (const entry of rows) {
    const row = isRecord(entry) ? entry : {};
    const fault = detailRowFault(row);
    if (fault !== null) {
      faulty += 1;
      reportSearchSkip(warn, fault);
      continue;
    }
    const searchId = searchIdOf(row);
    if (searchId === undefined) {
      reportSearchSkip(warn, 'item_unconverted');
      continue;
    }
    out.push({ searchId, row });
  }
  if (rows.length > 0 && faulty === rows.length) throw invalid('every row is invalid');
  return out;
}

/**
 * Search ID → detail item_id for one batch by last segment (see the header ⑤), whatever the row
 * order or count; a search ID without a matching row is absent from the map.
 */
export function matchSearchItemIds(
  searchIds: readonly string[],
  rows: readonly unknown[],
): ReadonlyMap<string, string> {
  const byKey = new Map<string, string>();
  for (const row of rows) {
    const itemId = isRecord(row) ? row.item_id : undefined;
    if (typeof itemId !== 'string' || itemId.trim() === '') continue;
    const key = matchKey(itemId);
    if (key !== undefined && !byKey.has(key)) byKey.set(key, itemId);
  }
  const out = new Map<string, string>();
  for (const searchId of searchIds) {
    const key = matchKey(searchId);
    const itemId = key === undefined ? undefined : byKey.get(key);
    if (itemId !== undefined) out.set(searchId, itemId);
  }
  return out;
}

/**
 * B1-04zzj (D10-692 S2-4): the items of one page with only the first of each item_id kept, order
 * unchanged (see the header ⑨). An item without an item_id is never a duplicate.
 */
export function firstPerItemId<T extends { readonly item_id?: string | null }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (typeof item.item_id === 'string') {
      if (seen.has(item.item_id)) continue;
      seen.add(item.item_id);
    }
    out.push(item);
  }
  return out;
}
