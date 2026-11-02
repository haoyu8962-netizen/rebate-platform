import { expect, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { TaobaoPriceSettingsReader } from '../../../../apps/api/src/modules/union/domain/taobao-price.ts';
import type {
  CallCtx,
  Page,
  SearchQuery,
  UnionItem,
  UnionItemDetail,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import type {
  UnionTransport,
  UnionTransportRequest,
} from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoCredentials,
  type TaobaoSearchSkipReason,
  type TaobaoSearchSlotReader,
  type TaobaoSearchSource,
  type TaobaoSearchWarning,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  convertAll,
  ctx,
  DATAOKE_BASE,
  dataokeEnvelope,
  DETAIL,
  dtkRow,
  endpoint,
  formOf,
  instant,
  query,
  response,
  searchData,
  searched,
  TOP_PUBLIC,
  topError,
  truthfulTop,
} from '../taobao-search/kit.ts';

export {
  ctx,
  DETAIL,
  endpoint,
  formOf,
  instant,
  KEYWORD,
  query,
  topBody,
  topError,
  topRow,
  unionFailure,
  visible,
} from '../taobao-search/kit.ts';

// Task-local AC labels ([AC-B1-04zx#n]) identify this task's acceptance points, not business rules.
// 合成、非录制：报文按任务书「报文形状」自造，字段名与嵌套照抄任务书，ID、标题、链接、金额、类目都是
// 合成值，不读私有库、不联网、不监听端口。secret 是低熵重复串。

export const OFFICIAL_SEARCH = 'taobao.tbk.dg.material.optional.upgrade';
export const SEARCH_ENVELOPE = 'tbk_dg_material_optional_upgrade_response';

export const APP_KEY = 'fake-official-search-key';
export const SECRET = 'offi-offi-offi-offi-offi';

export const ADZONE = '987654321012';
/** The query PID the fake reader answers: mm_<member>_<site>_<adzone>. */
export const SLOT_PID = `mm_1000000001_3000000001_${ADZONE}`;

export type Row = Record<string, unknown>;

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/** The segment the search, detail and order ids of one synthetic goods have in common. */
export function sharedTail(n: number): string {
  return `SharedTail${pad(n)}Zz`;
}

/** 搜索口径 item_id: exactly one "-"; the whole string differs from the detail id. */
export function searchItemId(n: number): string {
  return `SrchFront${pad(n)}Qa-${sharedTail(n)}`;
}

/** 详情口径 item_id of the same goods. */
export function detailItemId(n: number): string {
  return `DetlFront${pad(n)}Wb-${sharedTail(n)}`;
}

/** 订单口径 item_id of the same goods. */
export function orderItemId(n: number): string {
  return `OrdrFront${pad(n)}Xc-${sharedTail(n)}`;
}

/** The synthetic goods number of a search id, or undefined for anything else. */
export function searchNumber(id: string): number | undefined {
  const match = /^SrchFront([0-9]{4})Qa-SharedTail([0-9]{4})Zz$/.exec(id);
  if (match === null || match[1] !== match[2]) return undefined;
  return Number(match[1]);
}

/** The synthetic goods number of a detail id, or undefined for anything else. */
export function detailNumber(id: string): number | undefined {
  const match = /^DetlFront([0-9]{4})Wb-SharedTail([0-9]{4})Zz$/.exec(id);
  if (match === null || match[1] !== match[2]) return undefined;
  return Number(match[1]);
}

export function titleOf(n: number): string {
  return `合成官方搜索商品 ${pad(n)}`;
}

export function shortTitleOf(n: number): string {
  return `合成短标题 ${pad(n)}`;
}

export function mainPicOf(n: number): string {
  return `https://img.synthetic.invalid/official/main-${pad(n)}.jpg`;
}

export function smallPicsOf(n: number): string[] {
  return [
    `https://img.synthetic.invalid/official/small-${pad(n)}-1.jpg`,
    `https://img.synthetic.invalid/official/small-${pad(n)}-2.jpg`,
  ];
}

export function couponIdOf(n: number): string {
  return `syn-coupon-${pad(n)}`;
}

/** A promotion's validity on the wire: 13-digit millisecond strings, either end may be absent. */
export interface PromotionWindow {
  readonly start?: unknown;
  readonly end?: unknown;
}

/** One final_promotion_path_map_data entry (yuan string, or a JSON number where a test wants it). */
export function promotion(
  title: string,
  fee: unknown,
  id: string,
  window: PromotionWindow = {},
): Row {
  return {
    promotion_title: title,
    promotion_fee: fee,
    promotion_id: id,
    ...(window.start === undefined ? {} : { promotion_start_time: window.start }),
    ...(window.end === undefined ? {} : { promotion_end_time: window.end }),
  };
}

export interface RowParts {
  readonly top?: Row;
  readonly basic?: Row;
  readonly price?: Row;
  /** Merged into publish_info.income_info. */
  readonly income?: Row;
  /** Replaces the promotion path entries. */
  readonly promotions?: readonly Row[];
}

/**
 * One map_data entry. Defaults: discount price 59.90, a 商品券 of 10.00 and an 88VIP item of 5.00,
 * promotion final price 44.90 (so price 59.90, coupon 10.00, final 49.90 under BR-PRICE-02);
 * commission_rate "2050". A field set to undefined in `parts` is absent on the wire.
 */
export function searchRow(n: number, parts: RowParts = {}): Row {
  const promotions = parts.promotions ?? [
    promotion('商品券', '10.00', couponIdOf(n)),
    promotion('88VIP', '5.00', `syn-member-${pad(n)}`),
  ];
  return {
    item_id: searchItemId(n),
    item_basic_info: {
      title: titleOf(n),
      short_title: shortTitleOf(n),
      pict_url: mainPicOf(n),
      small_images: { string: smallPicsOf(n) },
      level_one_category_id: 50_008_090,
      level_one_category_name: '合成一级类目',
      volume: 1200,
      ...parts.basic,
    },
    price_promotion_info: {
      zk_final_price: '59.90',
      final_promotion_price: '44.90',
      final_promotion_path_list: { final_promotion_path_map_data: [...promotions] },
      ...parts.price,
    },
    publish_info: {
      income_info: { commission_rate: '2050', commission_amount: '7.77', ...parts.income },
      click_url: `https://s.click.synthetic.invalid/synthetic-click-${pad(n)}`,
      coupon_share_url: `https://uland.synthetic.invalid/synthetic-share-${pad(n)}`,
    },
    ...parts.top,
  };
}

/** The whole response body; `total` undefined leaves total_results out. */
export function searchBody(rows: readonly unknown[], total?: number): Row {
  return {
    [SEARCH_ENVELOPE]: {
      result_list: { map_data: [...rows] },
      ...(total === undefined ? {} : { total_results: total }),
      request_id: 'synthetic-request-id',
    },
  };
}

/** Rows numbered from `from`. */
export function rowsFrom(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_unused, i) => searchRow(from + i));
}

/** Every synthetic search id converts to its detail id; 大淘客 ids as in B1-04zh. */
export function convertToDetail(id: string): string | undefined {
  const n = searchNumber(id);
  return n === undefined ? convertAll(id) : detailItemId(n);
}

export interface GatewayOptions {
  /** The whole body of a search with this page_no; default rows 1..3, total_results 3. */
  readonly page?: (pageNo: number) => unknown;
  /** Which ids the TOP detail converts; default convertToDetail. Read on every detail call. */
  readonly available?: (id: string) => string | undefined;
  /** Replaces the whole TOP detail body for a call with these ids. */
  readonly detailReply?: (ids: readonly string[]) => unknown;
  /** Run inside the transport, before it answers. */
  readonly onSearchSend?: (clock: FixedClock) => void;
  readonly onDetailSend?: (clock: FixedClock) => void;
}

/** A fake TOP gateway answering the official search and the item detail; others are refused. */
export function gateway(clock: FixedClock, options: GatewayOptions = {}) {
  const available = options.available ?? convertToDetail;
  return vi.fn<UnionTransport>(async (request) => {
    const form = formOf(request);
    if (form['method'] === OFFICIAL_SEARCH) {
      options.onSearchSend?.(clock);
      const body =
        options.page === undefined
          ? searchBody(rowsFrom(1, 3), 3)
          : options.page(Number(form['page_no'] ?? '0'));
      return response(body);
    }
    if (form['method'] === DETAIL) {
      options.onDetailSend?.(clock);
      const ids = (form['item_id'] ?? '').split(',');
      const body =
        options.detailReply === undefined ? truthfulTop(ids, available) : options.detailReply(ids);
      return response(body);
    }
    return response(topError('synthetic-unexpected-method'));
  });
}

export interface SetupOptions extends GatewayOptions {
  /** 'absent' leaves the switch out of the adapter options. Default 'official'. */
  readonly searchSource?: TaobaoSearchSource | 'absent';
  /** What the slot reader answers. Default SLOT_PID. */
  readonly slot?: string | null;
  /** Whether the adapter gets the slot reader. Default true. */
  readonly withSlotReader?: boolean;
  /** Whether the adapter gets a 大淘客 client. Default false. */
  readonly withDataoke?: boolean;
  readonly priceSettings?: TaobaoPriceSettingsReader;
}

export function setup(options: SetupOptions = {}) {
  const clock = new FixedClock(instant);
  const credentials = vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
    appKey: APP_KEY,
    appSecret: SECRET,
  }));
  const transport = gateway(clock, options);
  const slot = options.slot === undefined ? SLOT_PID : options.slot;
  const searchSlot = vi.fn<TaobaoSearchSlotReader>(async () => slot);
  const dataokeTransport = vi.fn<UnionTransport>(async () =>
    response(dataokeEnvelope(searchData([dtkRow(1), dtkRow(2)], 2))),
  );
  const dataokeCredentials = vi.fn<() => Promise<DataokeCredentials>>(async () => ({
    appKey: 'fake-official-dataoke-key',
    appSecret: 'dtko-dtko-dtko-dtko-dtko',
  }));
  const orderSource = new DataokeClient({
    credentials: dataokeCredentials,
    transport: dataokeTransport,
    clock,
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    baseUrl: DATAOKE_BASE,
  });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  const searchWarn = vi.fn<(event: TaobaoSearchWarning) => void>();
  const searchSource = options.searchSource ?? 'official';
  const adapter = new TaobaoUnionAdapter({
    credentials,
    transport,
    clock,
    endpoint,
    warn,
    searchWarn,
    ...(searchSource === 'absent' ? {} : { searchSource }),
    ...(options.withSlotReader === false ? {} : { searchSlot }),
    ...(options.withDataoke === true ? { orderSource } : {}),
    ...(options.priceSettings === undefined ? {} : { priceSettings: options.priceSettings }),
  });
  return { adapter, clock, credentials, transport, searchSlot, dataokeTransport, warn, searchWarn };
}

export type Harness = ReturnType<typeof setup>;

/** One successful search on the harness. */
export function search(
  h: Harness,
  q: SearchQuery = query,
  context: CallCtx = ctx,
): Promise<Page<UnionItem>> {
  return searched(() => h.adapter.searchItems(q, context));
}

/** A search over `rows` (one page, total_results = rows.length) on a fresh harness. */
export async function searchRows(rows: readonly unknown[], options: SetupOptions = {}) {
  const h = setup({ page: () => searchBody(rows, rows.length), ...options });
  const page = await search(h);
  return { h, page };
}

/** The single item a one-row search returned. */
export async function one(row: Row, options: SetupOptions = {}): Promise<UnionItemDetail> {
  const { page } = await searchRows([row], options);
  expect(page.items).toHaveLength(1);
  return page.items[0] as UnionItemDetail;
}

/** The transport requests of one TOP method, in call order. */
export function requestsOf(h: Pick<Harness, 'transport'>, method: string): UnionTransportRequest[] {
  return h.transport.mock.calls
    .map(([request]) => request)
    .filter((request) => formOf(request)['method'] === method);
}

/** The official search requests so far. */
export function searchRequests(h: Pick<Harness, 'transport'>): UnionTransportRequest[] {
  return requestsOf(h, OFFICIAL_SEARCH);
}

/** The skip reasons reported so far, in call order; a report of another event fails. */
export function skipReasons(h: Pick<Harness, 'searchWarn'>): TaobaoSearchSkipReason[] {
  return h.searchWarn.mock.calls.map(([warning]) => {
    expect(warning.event).toBe('taobao_search_row_skipped');
    return warning.reason;
  });
}

/** The BR-PRICE-01 fields a search item and a detail must agree on. */
export function priceFields(item: UnionItem) {
  return {
    price_fen: item.price_fen,
    coupon_fen: item.coupon_fen,
    final_price_fen: item.final_price_fen,
    coupon_ids: item.coupon_ids,
    price_status: item.price_status,
    price_anomaly_reason: item.price_anomaly_reason,
  };
}

/** The id list of every item detail call, in call order. */
export function detailIdLists(h: Harness): string[][] {
  return requestsOf(h, DETAIL).map((request) => (formOf(request)['item_id'] ?? '').split(','));
}

/** Form fields of a sent request other than the TOP public parameters. */
export function businessFields(request: UnionTransportRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(formOf(request))) {
    if (!TOP_PUBLIC.includes(name)) out[name] = value;
  }
  return out;
}

/** Nothing was fetched or sent. */
export function expectNothingSent(h: Harness): void {
  expect(h.credentials).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
}

/**
 * Every returned item carries the detail id of the very goods its title came from (never another
 * goods' id, never a search id); returns the numbers in result order.
 */
export function identities(page: Page<UnionItem>): number[] {
  return page.items.map((item) => {
    const n = detailNumber(String(item.item_id));
    expect(n, `item_id ${String(item.item_id)} is a detail id`).toBeDefined();
    expect(item.title).toBe(titleOf(n!));
    return n!;
  });
}

/** The only keys a searched item may carry. */
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
  'category_l1_id',
  'category_l1_name',
  'main_image_url',
  'image_urls',
]);
