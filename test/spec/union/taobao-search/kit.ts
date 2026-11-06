import { inspect } from 'node:util';
import { expect, vi, type Mock } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type Page,
  type SearchQuery,
  type UnionEndpoint,
  type UnionErrorCode,
  type UnionItem,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type { DataokeSearchWarningCode } from '../../../../apps/api/src/modules/union/infra/taobao/dataoke-search.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoCredentials,
  type TaobaoSearchSource,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';

// Task-local AC labels ([AC-B1-04zh#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：只用任务书第 9 节「已录形状」的字段名与类型（路径 / 类型，无原值）构造报文；商品 ID、
// 标题、链接、金额、店铺、类目都是合成值，不读私有录制、不联网、不监听端口。secret 是低熵重复串。
// TODO(规划/09 CAP-TB-02): 凑狸 item.info.upgrade.get 批量换算的返回顺序待录制核对 — blocked on 详情录制

export const SEARCH_PATH = '/api/goods/get-dtk-search-goods';
export const SEARCH_VERSION = 'v2.1.2';
export const DETAIL = 'taobao.tbk.item.info.upgrade.get';
export const DETAIL_ENVELOPE = 'tbk_item_info_upgrade_get_response';

/** 大淘客 public query parameters (B1-04m); everything else in the query is a business parameter. */
export const DATAOKE_PUBLIC = ['appKey', 'version', 'timer', 'nonce', 'signRan'] as const;
/** TOP public form parameters (B1-04j). */
export const TOP_PUBLIC = ['method', 'app_key', 'timestamp', 'format', 'v', 'sign_method', 'sign'];

export const DATAOKE_BASE = 'https://dataoke-search.invalid';
export const DATAOKE_APP_KEY = 'fake-dataoke-search-key';
export const DATAOKE_SECRET = 'srch-srch-srch-srch-srch';
export const TAOBAO_APP_KEY = 'fake-taobao-search-key';
export const TAOBAO_SECRET = 'look-look-look-look-look';
export const endpoint: UnionEndpoint = {
  platform: 'taobao',
  mode: 'live',
  baseUrl: 'https://taobao-search.invalid/router/rest',
  quotaKey: 'fake-taobao-search-account',
};
/** The injected clock before the search; transports may move it while "on the wire". */
export const instant = '2026-11-01T04:05:06.000Z';
export const ctx: CallCtx = {
  appId: 'fake-search-app',
  requestId: 'fake-search-request',
  purpose: 'online',
};
export const KEYWORD = '合成 抽纸 100抽';
export const query: SearchQuery = { keyword: KEYWORD };

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** 大淘客口径 goodsId: 47 characters, exactly one "-" (front and back segments are synthetic). */
export function dtkGoodsId(n: number): string {
  return `${dtkFront(n)}-${dtkBack(n)}`;
}
export function dtkFront(n: number): string {
  return `DtkSynthFront${pad(n)}xYz`;
}
export function dtkBack(n: number): string {
  return `DtkSynthBack${pad(n)}AbCdEfGhIj`;
}

/** 凑狸应用口径 item_id for the same synthetic goods: both segments differ from the 大淘客 id. */
export function couliItemId(n: number): string {
  return `CouliFront${pad(n)}Qw-CouliBack${pad(n)}Er`;
}

/** The synthetic goods number of a 大淘客 goodsId, or undefined for anything else. */
export function goodsNumber(goodsId: string): number | undefined {
  const match = /^DtkSynthFront([0-9]{4})xYz-DtkSynthBack([0-9]{4})AbCdEfGhIj$/.exec(goodsId);
  if (match === null || match[1] !== match[2]) return undefined;
  return Number(match[1]);
}

export function titleOf(n: number): string {
  return `合成搜索商品 ${pad(n)}`;
}
export function mainPicOf(n: number): string {
  return `https://img.synthetic.alicdn.com/dtk/main-${pad(n)}.jpg`;
}

/** Values that must never be exposed (estimateAmount, links, ids, signs, sellers). */
export const ESTIMATE_BASE = 8_765_400;
export const HIDDEN_MARKERS = [
  'DtkSynthFront',
  'DtkSynthBack',
  'DtkSign',
  'synthetic-coupon-link',
  'synthetic-item-link',
  'synthetic-seller',
  '87654',
  '3100000',
] as const;

export type Row = Record<string, unknown>;

/**
 * One 大淘客 search list entry with the documented key set (synthetic values). Defaults: originalPrice
 * 59.9 (float), couponPrice 20 (int), actualPrice 39.9 = 59.9 − 20 (consistent), commissionRate 20.5.
 */
export function dtkRow(n: number, overrides: Row = {}): Row {
  return {
    id: 31_000_000 + n,
    goodsId: dtkGoodsId(n),
    goodsSign: `DtkSignFront${pad(n)}-DtkSignBack${pad(n)}`,
    title: titleOf(n),
    dtitle: `合成短标题 ${pad(n)}`,
    mainPic: mainPicOf(n),
    smallImages: [],
    originalPrice: 59.9,
    actualPrice: 39.9,
    couponPrice: 20,
    couponConditions: '50',
    couponLink: `https://uland.taobao.com/quan/detail?activityId=synthetic-coupon-link-${pad(n)}`,
    couponId: `synthetic-coupon-id-${pad(n)}`,
    couponStartTime: '2026-10-31 00:00:00',
    couponEndTime: '2026-11-11 23:59:59',
    commissionRate: 20.5,
    commissionType: 3,
    monthSales: 1200,
    dailySales: 34,
    twoHoursSales: 5,
    shopName: '合成店铺',
    shopType: 1,
    sellerId: `synthetic-seller-${pad(n)}`,
    cid: 4,
    tbcid: 50_012_345,
    itemLink: `https://detail.tmall.com/item.htm?id=synthetic-item-link-${pad(n)}`,
    estimateAmount: ESTIMATE_BASE + n,
    ...overrides,
  };
}

/** `dtkRow(n)` without the named keys. */
export function rowWithout(n: number, ...keys: string[]): Row {
  const row = dtkRow(n);
  for (const key of keys) delete row[key];
  return row;
}

/** A row without any coupon: couponPrice 0, no coupon link / conditions / id / times. */
export function noCouponRow(n: number, overrides: Row = {}): Row {
  const row = dtkRow(n, { couponPrice: 0 });
  for (const key of [
    'couponConditions',
    'couponLink',
    'couponId',
    'couponStartTime',
    'couponEndTime',
  ]) {
    delete row[key];
  }
  return { ...row, ...overrides };
}

/** The search `data` (after the 大淘客 envelope is unwrapped). */
export function searchData(rows: readonly unknown[], totalNum = 165, pageId = 1): Row {
  return { list: [...rows], totalNum, pageId, brandList: [] };
}

export function response(body: unknown, status = 200): UnionTransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/** The documented 大淘客 success envelope around `data`. */
export function dataokeEnvelope(data: unknown): Row {
  return { time: 1_793_500_000_000, code: 0, msg: '成功', data };
}

/** One TOP detail row for a converted item; its own title / image / prices are never the search's. */
export function topRow(itemId: string): Row {
  return {
    item_id: itemId,
    item_basic_info: {
      title: 'TOP-only synthetic title',
      pict_url: 'https://img.synthetic.invalid/top/only.jpg',
    },
    price_promotion_info: { zk_final_price: '1.00', final_promotion_price: '1.00' },
    publish_info: { income_info: { commission_rate: '1' } },
  };
}

export function topBody(rows: readonly Row[], wrapper = 'tbk_item_detail'): Row {
  return {
    [DETAIL_ENVELOPE]: { results: { [wrapper]: [...rows] }, request_id: 'synthetic-request-id' },
  };
}

export function topError(code: number | string, subCode?: number | string): Row {
  const sub = subCode === undefined ? {} : { sub_code: subCode, sub_msg: '合成错误说明' };
  return { error_response: { code, msg: 'synthetic remote error', ...sub } };
}

/**
 * A truthful fake of the 凑狸 TOP detail: rows for the requested ids that `available` converts,
 * in request order; none at all → 15 / 50001.
 */
export function truthfulTop(
  ids: readonly string[],
  available: (goodsId: string) => string | undefined,
): Row {
  const rows: Row[] = [];
  for (const id of ids) {
    const itemId = available(id);
    if (itemId !== undefined) rows.push(topRow(itemId));
  }
  return rows.length === 0 ? topError(15, 50001) : topBody(rows);
}

/** Every synthetic goods converts to its 凑狸 id. */
export function convertAll(goodsId: string): string | undefined {
  const n = goodsNumber(goodsId);
  return n === undefined ? undefined : couliItemId(n);
}

export interface SetupOptions {
  /** The search `data` for a query's pageId; default: rows 1..3, totalNum 165. */
  readonly data?: (pageId: string | null) => unknown;
  /** Which goodsIds the TOP detail converts; default convertAll. Read on every TOP call. */
  readonly available?: (goodsId: string) => string | undefined;
  /** Replaces the whole TOP body for a call with these ids. */
  readonly topReply?: (ids: readonly string[]) => unknown;
  /** 'absent' leaves the switch out of the adapter options. Default 'dataoke'. */
  readonly searchSource?: TaobaoSearchSource | 'absent';
  /** Whether the adapter gets the 大淘客 client as orderSource. Default true. */
  readonly withSource?: boolean;
  /** Run inside the transports, before they answer. */
  readonly onDataokeSend?: (clock: FixedClock) => void;
  readonly onTopSend?: (clock: FixedClock) => void;
}

/** The decoded form of a TOP request (lenient: never throws). */
export function formOf(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(request.body ?? '')) out[name] = value;
  return out;
}

export function setup(options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const taobaoCredentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  }));
  const available = options.available ?? convertAll;
  const taobaoTransport = vi.fn<UnionTransport>(async (request) => {
    options.onTopSend?.(clock);
    const form = formOf(request);
    if (form['method'] !== DETAIL) return response(topError('synthetic-unexpected-method'));
    const ids = (form['item_id'] ?? '').split(',');
    const body =
      options.topReply === undefined ? truthfulTop(ids, available) : options.topReply(ids);
    return response(body);
  });
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: DATAOKE_APP_KEY,
    appSecret: DATAOKE_SECRET,
  }));
  const random = vi.fn<DataokeRandom>().mockReturnValue(42);
  const dataokeTransport = vi.fn<UnionTransport>(async (request) => {
    options.onDataokeSend?.(clock);
    let pageId: string | null = null;
    try {
      pageId = new URL(request.url).searchParams.get('pageId');
    } catch {
      pageId = null;
    }
    const data =
      options.data === undefined
        ? searchData([dtkRow(1), dtkRow(2), dtkRow(3)])
        : options.data(pageId);
    return response(dataokeEnvelope(data));
  });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const dataokeWarn = vi.fn<(event: DataokeWarning) => void>();
  const orderSource = new DataokeClient({
    credentials: dataokeCredentials,
    transport: dataokeTransport,
    clock,
    random,
    baseUrl: DATAOKE_BASE,
    warn: dataokeWarn,
  });
  const searchSource = options.searchSource ?? 'dataoke';
  const adapter = new TaobaoUnionAdapter({
    credentials: taobaoCredentials,
    transport: taobaoTransport,
    clock,
    endpoint,
    warn,
    ...(options.withSource === false ? {} : { orderSource }),
    ...(searchSource === 'absent' ? {} : { searchSource }),
  });
  return {
    adapter,
    clock,
    taobaoCredentials,
    taobaoTransport,
    dataokeCredentials,
    dataokeTransport,
    random,
    warn,
    dataokeWarn,
  };
}

export type Harness = ReturnType<typeof setup>;

/** Runs a search that must succeed; any rejection is an assertion failure. */
export async function searched(run: () => Promise<Page<UnionItem>>): Promise<Page<UnionItem>> {
  let page: Page<UnionItem> | undefined;
  let failure: unknown;
  try {
    page = await run();
  } catch (error) {
    failure = error;
  }
  expect(failure, 'searchItems must succeed').toBeUndefined();
  expect(page).toBeDefined();
  expect(Array.isArray(page?.items)).toBe(true);
  return page as Page<UnionItem>;
}

/** One successful search on the harness. */
export function search(
  h: Harness,
  q: SearchQuery = query,
  context: CallCtx = ctx,
): Promise<Page<UnionItem>> {
  return searched(() => h.adapter.searchItems(q, context));
}

/** A search over `rows` (one page, totalNum = rows.length) on a fresh harness. */
export async function searchRows(rows: readonly unknown[], options: SetupOptions = {}) {
  const h = setup({ data: () => searchData(rows, rows.length), ...options });
  const page = await search(h);
  return { h, page };
}

/** The single item a one-row search returned. */
export async function one(row: Row, options: SetupOptions = {}): Promise<UnionItemDetail> {
  const { page } = await searchRows([row], options);
  expect(page.items).toHaveLength(1);
  return page.items[0] as UnionItemDetail;
}

export async function unionFailure(
  run: () => unknown | Promise<unknown>,
  code: UnionErrorCode,
): Promise<UnionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UnionError);
  expect(caught).toMatchObject({ code, platform: 'taobao' });
  return caught as UnionError;
}

/** The request a transport received on call `index`. */
export function sent(transport: Mock<UnionTransport>, index = 0): UnionTransportRequest {
  const call = transport.mock.calls[index];
  expect(call, `transport call ${index}`).toBeDefined();
  return call![0];
}

/** Decoded query string of a 大淘客 request; every name must appear once. */
export function queryFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new URL(request.url).searchParams) {
    expect(Object.hasOwn(out, name), `query field ${name} appears once`).toBe(false);
    out[name] = value;
  }
  return out;
}

/** The business fields of 大淘客 request `index` (public parameters removed). */
export function searchFields(h: Harness, index = 0): Record<string, string> {
  const fields = queryFields(sent(h.dataokeTransport, index));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!(DATAOKE_PUBLIC as readonly string[]).includes(name)) out[name] = value;
  }
  return out;
}

/** The business fields of TOP request `index` (public parameters removed). */
export function topFields(h: Harness, index = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(formOf(sent(h.taobaoTransport, index)))) {
    if (!TOP_PUBLIC.includes(name)) out[name] = value;
  }
  return out;
}

/** The goodsIds of every TOP call, in call order. */
export function topIdLists(h: Harness): string[][] {
  return h.taobaoTransport.mock.calls.map(([request]) =>
    (formOf(request)['item_id'] ?? '').split(','),
  );
}

/** Nothing was fetched or sent on either side. */
export function expectNothingSent(h: Harness): void {
  expect(h.dataokeCredentials).not.toHaveBeenCalled();
  expect(h.dataokeTransport).not.toHaveBeenCalled();
  expect(h.random).not.toHaveBeenCalled();
  expect(h.taobaoCredentials).not.toHaveBeenCalled();
  expect(h.taobaoTransport).not.toHaveBeenCalled();
}

/** The search warning `code` was sent (path + fixed code only). */
export function expectWarned(h: Harness, code: DataokeSearchWarningCode): void {
  expect(h.warn).toHaveBeenCalledWith({ method: SEARCH_PATH, code });
}

/** Everything a value would show when printed, serialized (bigint as text) or inspected. */
export function visible(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? `${item}n` : item,
  );
  return `${String(value)}\n${json}\n${inspect(value, { depth: null })}`;
}

/** The only keys a searched Taobao item may carry. */
export const ALLOWED_ITEM_KEYS: ReadonlySet<string> = new Set([
  'platform',
  'item_id',
  'title',
  'price_fen',
  'coupon_fen',
  'final_price_fen',
  'commission_rate_bp',
  'quoted_at',
  'coupon_ids',
  'price_status',
  'price_anomaly_reason',
  'main_image_url',
  'image_urls',
  'shop_name',
]);

/** The synthetic number behind a returned item: from its 凑狸 item_id. */
export function itemNumber(item: UnionItem): number | undefined {
  const match = /^CouliFront([0-9]{4})Qw-CouliBack([0-9]{4})Er$/.exec(String(item.item_id));
  if (match === null || match[1] !== match[2]) return undefined;
  return Number(match[1]);
}

/**
 * Every returned item carries the 凑狸 id of the very goods its title came from (never another
 * goods' id, never a 大淘客 id); returns the numbers in result order.
 */
export function expectTrueIdentities(page: Page<UnionItem>): number[] {
  return page.items.map((item) => {
    const n = itemNumber(item);
    expect(n, `item_id ${String(item.item_id)} is a 凑狸 id`).toBeDefined();
    expect(item.title).toBe(titleOf(n!));
    return n!;
  });
}
