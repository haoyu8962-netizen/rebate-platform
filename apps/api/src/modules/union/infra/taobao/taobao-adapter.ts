// 淘宝联盟适配器的请求底座（B1-04j）：公共参数（method、app_key、timestamp、
// format=json、v=2.0、sign_method=md5）+ TOP md5 签名、凭据经构造参数注入（每次请求取一次）、
// 经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl（参数含 sign 全在请求体，URL 不带查询串，
// Content-Type application/x-www-form-urlencoded;charset=utf-8）、按调用方给出的外层键解包。
// 业务参数与公共参数同名 → invalid_dto，不发请求。传输抛错 → upstream_unavailable（不带原文）。
// 调用方的 AbortSignal 与归档上下文原样挂在传输请求上。searchItems / resolveLink /
// listOrders（与未打开大淘客转链时的 convert）仍是 adapter_unimplemented，不取凭据、不发请求。不读 process.env、不读文件；
// app_secret 只在内存参与签名。
//
// B1-04l（② 段）：
// - getItem：taobao.tbk.item.info.upgrade.get，参数 item_id（ItemRef.item_id 原样，一次一个）、
//   biz_scene_id=1；外层键 tbk_item_info_upgrade_get_response（TODO 待详情录制核对）；results 下按
//   「单键包装取其数组」通用解包（不写死包装名），取第一条；空 → item_unavailable。映射见 goods.ts；
//   价格配置 priceSettings.read(ctx.appId) 每次 getItem 读一次（不缓存）。错误：15 + 50001 →
//   item_unavailable，15 + 1911 → upstream_rejected，其余按 B1-04j。归档 kind = query。
// - taobaoShareCode：taobao.tbk.tpwd.create，只传 url；15 + 26 / 23 → link_unrecognized。
//   归档 kind = convert。见 links.ts。
// - shortenTaobaoUrl：taobao.tbk.spread.get，requests = [{url}] 的 JSON 串。归档 kind = convert。
//   见 links.ts。
// 入参不合格一律 invalid_dto，不取凭据、不发请求。
//
// B1-04d（D10-503 ①）：convertSource='dataoke' 且有 orderSource 时，convert 经大淘客
// GET /api/tb-service/get-privilege-link（version v1.3.1）转链，参数与映射见 privilege-link.ts；
// 归档 kind = convert。否则 convert 保持 adapter_unimplemented（不取凭据、不发请求）。
//
// B1-04zh（D10-503 ② / D10-504）：searchSource='dataoke' 且有 orderSource 时，searchItems 经大淘客
// GET /api/goods/get-dtk-search-goods（version v2.1.2）搜索，goodsId 经 item.info.upgrade.get 换成
// 凑狸口径 item_id（换不到不返回），映射与缓存见 dataoke-search.ts；两种请求归档 kind 都是 query。
// 否则 searchItems 保持 adapter_unimplemented（不取凭据、不发请求）。
// B1-04zx（D10-504 / D10-582）：searchSource 为 official（缺省也是）且有 searchSlot 时，searchItems 走官方
// taobao.tbk.dg.material.optional.upgrade，搜索 item_id 经 item.info.upgrade.get 按最后一段换成详情口径，
// 不依赖 orderSource；口径见 official-search.ts，两种请求归档 kind 都是 query。没有 searchSlot 保持
// adapter_unimplemented（不取凭据、不发请求）。
// B1-04zy（D10-582）：searchSource 为 official_first 且 searchSlot、orderSource 都有时，第 1 页官方优先、失败或
// 0 条回落大淘客，续页按游标前缀走；官方这一步单独限时，失败后进程内冷却。口径见 search-fallback.ts，三种开关都
// 经 searchCounter 计数（search-counter.ts）。两个来源的 ID 缓存分开（见 #officialItemIdCache）。
// B1-04f（D10-486 ② / D10-488）：listOrders 经注入的大淘客订单源（orderSource）GET
// /api/tb-service/get-order-details（v1.0.0），只留 orderSlots 给出的推广位的订单；两者缺一即
// adapter_unimplemented。每次调用取一个上游页（listOrdersMetering = per_request，经 ctx.gateUpstream）。
// 口径、切窗、游标、映射与推广位过滤见 orders.ts。归档 kind = order。
// B1-04z（D10-486 ③ / D10-488 ②③ / D10-491）：listRefunds 经 orderSource GET get-order-refund（见
// refunds.ts，不过滤推广位；没有 orderSource → adapter_unimplemented），listPunishments 经 orderSource
// GET get-foul-order-list（见 punishments.ts，只留 orderSlots 的推广位；缺一即 adapter_unimplemented）。
// 两者都是每次调用取一个上游页（per_request，经 ctx.gateUpstream），归档 kind = order。
import { systemScheduler, type Clock, type Scheduler } from '../../../platform/index.ts';
import type { TaobaoPriceOptions, TaobaoPriceSettingsReader } from '../../domain/taobao-price.ts';
import {
  UnionError,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type OrderPage,
  type OrderQueryOpt,
  type Page,
  type PunishmentQueryOpt,
  type RefundQueryOpt,
  type ResolvedLink,
  type SearchQuery,
  type TaobaoShareCode,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
  type UnionPunish,
  type UnionRefund,
  type UnionRightsSources,
  type UpstreamGate,
} from '../../domain/types.ts';
import type { DataokeClient } from '../dataoke/dataoke-client.ts';
import { collectOrderRows } from '../order-row.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import {
  createTaobaoItemIdCache,
  DATAOKE_SEARCH_PATH,
  DATAOKE_SEARCH_VERSION,
  dataokeSearchCandidates,
  dataokeSearchNextCursor,
  dataokeSearchPage,
  dataokeSearchParameters,
  isDataokeSearchCursor,
  mapDataokeSearchItem,
  matchConvertedItemIds,
  parseDataokeSearchCursor,
  reportDroppedImageHosts,
  taobaoItemIdBatches,
  type DataokeDroppedImageHosts,
  type TaobaoItemIdCache,
} from './dataoke-search.ts';
import {
  firstPerItemId,
  matchSearchItemIds,
  officialSearchCandidates,
  officialSearchNextCursor,
  officialSearchPage,
  officialSearchParameters,
  parseOfficialSearchCursor,
  reportSearchSkip,
  searchAdzone,
  TAOBAO_OFFICIAL_SEARCH,
  TAOBAO_OFFICIAL_SEARCH_ENVELOPE,
  TAOBAO_OFFICIAL_SEARCH_SUB_CODES,
  type TaobaoSearchSlotReader,
  type TaobaoSearchWarning,
} from './official-search.ts';
import {
  detailItemId,
  detailRows,
  mapTaobaoDetail,
  TAOBAO_ITEM_DETAIL,
  TAOBAO_ITEM_DETAIL_ENVELOPE,
  TAOBAO_ITEM_DETAIL_SCENE,
} from './goods.ts';
import {
  checkShareLink,
  checkSpreadLink,
  parseShareCode,
  parseShortLink,
  TAOBAO_SPREAD_GET,
  TAOBAO_SPREAD_GET_ENVELOPE,
  TAOBAO_TPWD_CREATE,
  TAOBAO_TPWD_CREATE_ENVELOPE,
  TAOBAO_TPWD_SUB_CODES,
} from './links.ts';
import {
  DATAOKE_PRIVILEGE_LINK_CODES,
  DATAOKE_PRIVILEGE_LINK_PATH,
  DATAOKE_PRIVILEGE_LINK_VERSION,
  mapPrivilegeLink,
  privilegeLinkParameters,
} from './privilege-link.ts';
import {
  mapTaobaoSlotOrder,
  nextTaobaoOrderCursor,
  ourRows,
  parseTaobaoOrderBody,
  planTaobaoOrders,
  requireTaobaoSlotOrder,
  slotAdzones,
  taobaoOrderArchiveBody,
  taobaoOrderParameters,
  taobaoRowIdentity,
  TAOBAO_ORDER_PATH,
  TAOBAO_ORDER_VERSION,
  type TaobaoOrderSlotReader,
  type TaobaoOrderWarning,
} from './orders.ts';
import {
  mapTaobaoPunish,
  nextTaobaoPunishCursor,
  ourPunishRows,
  parseTaobaoPunishBody,
  planTaobaoPunishments,
  taobaoPunishParameters,
  TAOBAO_PUNISH_PATH,
  TAOBAO_PUNISH_VERSION,
  type TaobaoPunishWarning,
} from './punishments.ts';
import {
  mapTaobaoRefund,
  nextTaobaoRefundCursor,
  parseTaobaoRefundBody,
  planTaobaoRefunds,
  taobaoRefundParameters,
  TAOBAO_REFUND_PATH,
  TAOBAO_REFUND_VERSION,
  type TaobaoRefundWarning,
} from './refunds.ts';
import { unwrapTaobaoResponse, type TaobaoSubCodeMap, type TaobaoWarning } from './response.ts';
import type { TaobaoSearchCounter, TaobaoSearchMetricSource } from './search-counter.ts';
import {
  dataokeFailureReason,
  officialFailureReason,
  officialStepLimitMs,
  TAOBAO_OFFICIAL_COOLDOWN_MS,
  type TaobaoSearchFallbackReason,
  type TaobaoSearchFallbackWarning,
} from './search-fallback.ts';
import {
  signTaobaoParameters,
  taobaoSignedEntries,
  taobaoTimestamp,
  type TaobaoParameters,
} from './sign.ts';

export type { TaobaoParameter, TaobaoParameters } from './sign.ts';
export type {
  TaobaoSearchSkipReason,
  TaobaoSearchSlotReader,
  TaobaoSearchWarning,
} from './official-search.ts';
export type { TaobaoSearchFallbackWarning } from './search-fallback.ts';
export type { TaobaoWarning } from './response.ts';
export type {
  TaobaoOrderSlotReader,
  TaobaoOrderWarning,
  TaobaoOrderWarningEvent,
} from './orders.ts';
export type { TaobaoRefundWarning, TaobaoRefundWarningEvent } from './refunds.ts';
export type { TaobaoPunishWarning, TaobaoPunishWarningEvent } from './punishments.ts';

/** Application-level key pair; fetched once per request, never stored on the adapter. */
export interface TaobaoCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface TaobaoAdapterOptions {
  readonly credentials: () => Promise<TaobaoCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: TaobaoWarning) => void;
  /**
   * B1-04l (D10-479): BR-PRICE-02 settings (price.taobao.*), read with ctx.appId once per getItem
   * and passed to mapTaobaoPrice. Without it the BR-PRICE-02 defaults apply.
   */
  readonly priceSettings?: TaobaoPriceSettingsReader;
  /**
   * B1-04e (D10-486 ①): the 大淘客 client the order / refund / punishment ports will read from
   * (mapping is B1-04f / B1-04z). Assembled by the registry from `taobaoLive.orderSource` only in
   * staging with taobao live and both DATAOKE_* variables set. Without it listOrders,
   * listRefunds and listPunishments are adapter_unimplemented (nothing fetched or sent).
   */
  readonly orderSource?: DataokeClient;
  /**
   * B1-04d (D10-503 ①): where convert gets its link until the official 万能转链 is approved.
   * 'dataoke' with an `orderSource` converts through that client (privilege-link.ts); absent,
   * 'baichuan', or no `orderSource` leaves convert exactly as before (adapter_unimplemented,
   * nothing fetched or sent).
   */
  readonly convertSource?: TaobaoConvertSource;
  /**
   * B1-04zh (D10-503 ②), B1-04zx: where searchItems gets its results. 'dataoke' with an
   * `orderSource` searches through that client (dataoke-search.ts), without one it stays
   * adapter_unimplemented; absent or 'official' searches officially when `searchSlot` is given
   * (official-search.ts), and stays adapter_unimplemented without it (nothing fetched or sent).
   * B1-04zy: 'official_first' asks the official search first and falls back to 大淘客 (see
   * search-fallback.ts); it needs both, and stays adapter_unimplemented without either.
   */
  readonly searchSource?: TaobaoSearchSource;
  /**
   * B1-04zy (D10-582): the waits of 'official_first' (the official step's own time limit, half the
   * call's budget). Without it the system scheduler; the cooldown reads `clock`, not this.
   */
  readonly scheduler?: Scheduler;
  /**
   * B1-04zy (D10-582): couli_taobao_search_total, under every searchSource (see search-counter.ts);
   * UnionModule passes the one it provides. Without it nothing is counted.
   */
  readonly searchCounter?: TaobaoSearchCounter;
  /**
   * B1-04zx (D10-582): the calling app's active query PID, for the official search's adzone_id
   * (see official-search.ts). Without it searchItems stays adapter_unimplemented under 'official'.
   */
  readonly searchSlot?: TaobaoSearchSlotReader;
  /** B1-04zx: skipped official search rows (see TaobaoSearchWarning); never through `warn`. */
  readonly searchWarn?: (event: TaobaoSearchWarning) => void;
  /** B1-04zy: fallbacks of 'official_first' (see TaobaoSearchFallbackWarning). */
  readonly fallbackWarn?: (event: TaobaoSearchFallbackWarning) => void;
  /**
   * B1-04f (D10-488 ③): every Taobao PID registered in union_pids, retired ones included; listOrders
   * keeps only the orders of these promotion slots (see orders.ts). Without it listOrders is
   * adapter_unimplemented, like without orderSource.
   */
  readonly orderSlots?: TaobaoOrderSlotReader;
  /** B1-04f: order mapping and slot-filter warnings (see TaobaoOrderWarning in orders.ts). */
  readonly orderWarn?: (event: TaobaoOrderWarning) => void;
  /** B1-04z: refund mapping warnings (see TaobaoRefundWarning in refunds.ts). */
  readonly refundWarn?: (event: TaobaoRefundWarning) => void;
  /** B1-04z: punishment mapping and slot-filter warnings (see punishments.ts). */
  readonly punishWarn?: (event: TaobaoPunishWarning) => void;
}

/** B1-04d: the convert data-source switch; the default is 'baichuan' (behaviour unchanged). */
export type TaobaoConvertSource = 'baichuan' | 'dataoke';

/**
 * B1-04zh: the search data-source switch; the default is 'official'. B1-04zy: 'official_first' asks
 * the official search first and falls back to 大淘客.
 */
export type TaobaoSearchSource = 'official' | 'dataoke' | 'official_first';

export interface TaobaoRequestOptions {
  /** The response envelope key registered for this method by the caller (never derived). */
  readonly envelope: string;
  readonly signal?: AbortSignal;
  /** B1-04p: rides on the transport request for the archiving transport only. */
  readonly archive?: ArchiveContext;
  /** B1-04l: per-method refinement of code 15 by sub_code (see response.ts). */
  readonly businessSubCodes?: TaobaoSubCodeMap;
}

/** 公共参数名；业务参数不得占用（同名 → invalid_dto，不发请求）。 */
const PUBLIC_PARAMETERS: ReadonlySet<string> = new Set([
  'method',
  'app_key',
  'timestamp',
  'format',
  'v',
  'sign_method',
  'sign',
]);

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

/** item.info.upgrade.get 的 15 细分：50001 无结果（不存在 / 不可推广）、1911 scene 不支持。 */
const DETAIL_SUB_CODES: TaobaoSubCodeMap = Object.freeze({
  '50001': 'item_unavailable',
  '1911': 'upstream_rejected',
});

function archiveOf(ctx: CallCtx, kind: 'query' | 'convert' | 'order'): ArchiveContext {
  return { appId: ctx.appId, kind };
}

function unimplemented(name: string): UnionError {
  return new UnionError('adapter_unimplemented', `taobao ${name}: not implemented`, 'taobao');
}

export class TaobaoUnionAdapter implements UnionAdapter {
  readonly platform = 'taobao' as const;
  readonly #credentials: () => Promise<TaobaoCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: TaobaoWarning) => void) | undefined;
  readonly #priceSettings: TaobaoPriceSettingsReader | undefined;
  readonly #orderSource: DataokeClient | undefined;
  readonly #convertSource: TaobaoConvertSource;
  readonly #searchSource: TaobaoSearchSource;
  readonly #searchSlot: TaobaoSearchSlotReader | undefined;
  readonly #searchWarn: ((event: TaobaoSearchWarning) => void) | undefined;
  readonly #fallbackWarn: ((event: TaobaoSearchFallbackWarning) => void) | undefined;
  readonly #scheduler: Scheduler;
  readonly #searchCounter: TaobaoSearchCounter | undefined;
  /** B1-04zy: first pages skip the official search before this instant (epoch ms, on `clock`). */
  #officialCooldownUntil = 0;
  /** B1-04zh: goodsId → 凑狸 item_id, one per adapter instance (see dataoke-search.ts ④). */
  readonly #itemIdCache: TaobaoItemIdCache;
  /**
   * B1-04zx: the official search ID → detail item_id, under the same TTL. B1-04zy: official_first
   * uses both searches on one adapter, and no recording shows the two ID spaces are disjoint; the
   * two conversions also mean different things (last segment, position), so they share no cache.
   */
  readonly #officialItemIdCache: TaobaoItemIdCache;
  readonly #orderSlots: TaobaoOrderSlotReader | undefined;
  readonly #orderWarn: ((event: TaobaoOrderWarning) => void) | undefined;
  readonly #refundWarn: ((event: TaobaoRefundWarning) => void) | undefined;
  readonly #punishWarn: ((event: TaobaoPunishWarning) => void) | undefined;

  /**
   * B1-04f: listOrders sends one upstream request per call, each through CallCtx.gateUpstream
   * (one quota token per request, like the Pinduoduo adapter of B1-04w).
   */
  readonly listOrdersMetering = 'per_request' as const;
  /** B1-04z: one upstream request per listRefunds / listPunishments call, each gated. */
  readonly listRefundsMetering = 'per_request' as const;
  readonly listPunishmentsMetering = 'per_request' as const;

  /**
   * B1-04zza (money r1 S2 ①): listRefunds needs the 大淘客 order source, listPunishments also the
   * order slots (same conditions as the methods below); without them the methods stay
   * adapter_unimplemented and the order sync dispatches nothing for them.
   */
  get rightsSources(): UnionRightsSources {
    const refunds = this.#orderSource !== undefined;
    return { refunds, punishments: refunds && this.#orderSlots !== undefined };
  }

  /**
   * B1-04zzb (D10-741 ③): listOrders needs both the 大淘客 order source and the order slot reader
   * (registered PIDs). Only what was injected counts: nothing is read or requested here. false:
   * the order sync scheduler skips taobao this round, so listOrders' own taobao_order_no_slots
   * (#2464) is never the gate.
   */
  get orderSources(): boolean {
    return this.#orderSource !== undefined && this.#orderSlots !== undefined;
  }

  constructor(options: TaobaoAdapterOptions) {
    if (options.endpoint.platform !== 'taobao') {
      throw new UnionError(
        'invalid_endpoint',
        'taobao adapter: endpoint is not for taobao',
        'taobao',
      );
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
    this.#priceSettings = options.priceSettings;
    this.#orderSource = options.orderSource;
    // 只有明确的 'dataoke' 打开大淘客转链；缺省与其他值一律是 baichuan（行为不变）。
    this.#convertSource = options.convertSource === 'dataoke' ? 'dataoke' : 'baichuan';
    // 只有明确的 'dataoke' / 'official_first' 用大淘客搜索；缺省与其他值一律是 official（行为不变）。
    this.#searchSource =
      options.searchSource === 'dataoke' || options.searchSource === 'official_first'
        ? options.searchSource
        : 'official';
    this.#searchSlot = options.searchSlot;
    this.#searchWarn = options.searchWarn;
    this.#fallbackWarn = options.fallbackWarn;
    this.#scheduler = options.scheduler ?? systemScheduler();
    this.#searchCounter = options.searchCounter;
    this.#itemIdCache = createTaobaoItemIdCache(options.clock);
    this.#officialItemIdCache = createTaobaoItemIdCache(options.clock);
    this.#orderSlots = options.orderSlots;
    this.#orderWarn = options.orderWarn;
    this.#refundWarn = options.refundWarn;
    this.#punishWarn = options.punishWarn;
  }

  /** Internal request foundation; returns the inner object of `options.envelope`. */
  async request(
    method: string,
    parameters: TaobaoParameters,
    options: TaobaoRequestOptions,
  ): Promise<unknown> {
    const { envelope } = options;
    // 先做不需要凭据的同步检查，再取凭据：没有外层键的调用不取凭据、不发请求。
    if (typeof envelope !== 'string' || envelope === '') throw unimplemented(method);
    const response = await this.#send(method, parameters, options);
    return unwrapTaobaoResponse(method, envelope, response, this.#warn, options.businessSubCodes);
  }

  async #send(
    method: string,
    parameters: TaobaoParameters,
    { signal, archive }: TaobaoRequestOptions,
  ): Promise<UnionTransportResponse> {
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError(
        'invalid_endpoint',
        'taobao adapter: no gateway URL configured',
        'taobao',
      );
    }
    this.#checkBusinessParameters(method, parameters);
    const { appKey, appSecret } = await this.#credentials();

    const unsigned: TaobaoParameters = {
      ...parameters,
      method,
      app_key: appKey,
      timestamp: taobaoTimestamp(this.#clock.now()),
      format: 'json',
      v: '2.0',
      sign_method: 'md5',
    };
    // 表单值与签名用同一份文本（空值不进表单也不进签名）；请求体里只有 sign，没有 secret。
    const form = new URLSearchParams(taobaoSignedEntries(unsigned));
    form.append('sign', signTaobaoParameters(unsigned, appSecret));

    try {
      return await this.#transport({
        platform: 'taobao',
        url,
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: form.toString(),
        ...(signal === undefined ? {} : { signal }),
        ...(archive === undefined ? {} : { archive }),
      });
    } catch (error) {
      if (error instanceof UnionError) throw error;
      // 未知传输错误不带原文与 cause，避免请求内容进入错误信息。
      throw new UnionError('upstream_unavailable', `taobao ${method}: transport failed`, 'taobao');
    }
  }

  /** Business parameters may not take a public parameter name nor a non-finite number. */
  #checkBusinessParameters(method: string, parameters: TaobaoParameters): void {
    for (const name of Object.keys(parameters)) {
      if (PUBLIC_PARAMETERS.has(name)) {
        throw new UnionError(
          'invalid_dto',
          `taobao ${method}: reserved parameter ${name}`,
          'taobao',
        );
      }
      const value = parameters[name];
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new UnionError(
          'invalid_dto',
          `taobao ${method}: non-finite parameter ${name}`,
          'taobao',
        );
      }
    }
  }

  // 端口方法：resolveLink 仍 adapter_unimplemented，不取凭据、不发请求
  // （convert 见 B1-04d，searchItems 见 B1-04zh / B1-04zx，listOrders 见 B1-04f）。

  /**
   * B1-04zh: 大淘客 search when switched on (see dataoke-search.ts). B1-04zx: otherwise the official
   * search when a slot reader is injected (see official-search.ts). Neither: unimplemented.
   * B1-04zy: 'official_first' needs both (see search-fallback.ts).
   */
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    const source = this.#orderSource;
    if (this.#searchSource === 'dataoke') {
      if (source === undefined) throw unimplemented('searchItems');
      return this.#countedSearch('dataoke', () => this.#dataokeSearch(source, q, ctx));
    }
    const readSlot = this.#searchSlot;
    if (readSlot === undefined) throw unimplemented('searchItems');
    if (this.#searchSource === 'official') {
      return this.#countedSearch('official', () => this.#officialSearch(readSlot, q, ctx));
    }
    if (source === undefined) throw unimplemented('searchItems');
    return this.#officialFirstSearch(readSlot, source, q, ctx);
  }

  /** B1-04zy: official_first (see search-fallback.ts). */
  async #officialFirstSearch(
    readSlot: TaobaoSearchSlotReader,
    source: DataokeClient,
    q: SearchQuery,
    ctx: CallCtx,
  ): Promise<Page<UnionItem>> {
    const dataoke = () => this.#countedSearch('dataoke', () => this.#dataokeSearch(source, q, ctx));
    const cursor = q?.cursor;
    if (cursor !== undefined) {
      // 续页留在第 1 页的来源：不回落、不换源，也不看冷却。
      return isDataokeSearchCursor(cursor)
        ? dataoke()
        : this.#countedSearch('official', () => this.#officialSearch(readSlot, q, ctx));
    }
    if (this.#clock.now().getTime() < this.#officialCooldownUntil) return dataoke();

    const limit = new AbortController();
    let reason: TaobaoSearchFallbackReason | undefined;
    try {
      const page = await this.#limitedOfficialSearch(readSlot, q, ctx, limit);
      if (page.items.length > 0) {
        this.#searchCounter?.record('official', 'ok');
        return page;
      }
      ctx.signal?.throwIfAborted();
      reason = 'empty';
    } catch (error) {
      // 调用方取消先判：取消时传输层也报 upstream_unavailable，只看错误码分不出来。
      if (ctx.signal?.aborted !== true) {
        reason = limit.signal.aborted ? 'timeout' : officialFailureReason(error);
      }
      if (reason === undefined) {
        this.#searchCounter?.record('official', 'error');
        throw error;
      }
      this.#officialCooldownUntil = this.#clock.now().getTime() + TAOBAO_OFFICIAL_COOLDOWN_MS;
    }
    this.#searchCounter?.record('official', 'fallback');
    this.#fallbackWarn?.({ event: 'taobao_search_fallback', source: 'official', reason });
    try {
      return await dataoke();
    } catch (error) {
      this.#fallbackWarn?.({
        event: 'taobao_search_dataoke_failed',
        source: 'dataoke',
        reason: dataokeFailureReason(error),
      });
      throw error;
    }
  }

  /** B1-04zy: one source's search, counted: ok, empty (no items) or error. */
  async #countedSearch(
    source: TaobaoSearchMetricSource,
    search: () => Promise<Page<UnionItem>>,
  ): Promise<Page<UnionItem>> {
    let page: Page<UnionItem>;
    try {
      page = await search();
    } catch (error) {
      this.#searchCounter?.record(source, 'error');
      throw error;
    }
    this.#searchCounter?.record(source, page.items.length === 0 ? 'empty' : 'ok');
    return page;
  }

  /**
   * B1-04zy: the official step of official_first under its own limit (see search-fallback.ts ③).
   * At the limit `limit` aborts the official requests and this rejects, whether or not they stop;
   * the caller tells that from its own cancellation by `limit.signal`.
   */
  async #limitedOfficialSearch(
    readSlot: TaobaoSearchSlotReader,
    q: SearchQuery,
    ctx: CallCtx,
    limit: AbortController,
  ): Promise<Page<UnionItem>> {
    const signal =
      ctx.signal === undefined ? limit.signal : AbortSignal.any([ctx.signal, limit.signal]);
    const timer = new AbortController();
    const expired = new Promise<never>((_resolve, reject) => {
      void this.#scheduler.sleep(officialStepLimitMs(ctx.purpose), timer.signal).then(
        () => {
          reject(
            new UnionError(
              'upstream_unavailable',
              'taobao searchItems: official step timed out',
              'taobao',
            ),
          );
          limit.abort();
        },
        // 官方先答完：等待被释放，什么也不做。
        () => undefined,
      );
    });
    try {
      return await Promise.race([this.#officialSearch(readSlot, q, { ...ctx, signal }), expired]);
    } finally {
      timer.abort();
    }
  }

  /** B1-04zx: one page of the official search (see official-search.ts). */
  async #officialSearch(
    readSlot: TaobaoSearchSlotReader,
    q: SearchQuery,
    ctx: CallCtx,
  ): Promise<Page<UnionItem>> {
    if (typeof q?.keyword !== 'string' || q.keyword.trim() === '') {
      throw new UnionError('invalid_dto', 'taobao searchItems: keyword is blank', 'taobao');
    }
    // 关键词、游标先校验：不合格的调用不读推广位、不取凭据、不发请求。
    const page = q.cursor === undefined ? 1 : parseOfficialSearchCursor(q.cursor);
    const pid = await readSlot(ctx);
    const adzone = pid === null ? undefined : searchAdzone(pid);
    if (adzone === undefined) throw unimplemented('searchItems');
    let inner: unknown;
    try {
      inner = await this.request(
        TAOBAO_OFFICIAL_SEARCH,
        officialSearchParameters(q.keyword, page, adzone),
        {
          envelope: TAOBAO_OFFICIAL_SEARCH_ENVELOPE,
          archive: archiveOf(ctx, 'query'),
          businessSubCodes: TAOBAO_OFFICIAL_SEARCH_SUB_CODES,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        },
      );
    } catch (error) {
      // 15/50001：上游说没有结果，是空页不是故障。
      if (error instanceof UnionError && error.code === 'item_unavailable') {
        return { items: [], nextCursor: null };
      }
      throw error;
    }
    // BR-PRICE-11：quoted_at 与优惠时间窗都取收到搜索响应时的注入时钟（不是换算响应时）。
    const receivedAt = this.#clock.now();
    const { rows, total } = officialSearchPage(inner);
    if (rows.length === 0) return { items: [], nextCursor: null };
    const nextCursor = officialSearchNextCursor(page, rows.length, total);
    const candidates = officialSearchCandidates(rows, this.#searchWarn);
    if (candidates.length === 0) return { items: [], nextCursor };
    const itemIds = await this.#convertSearchIds(
      candidates.map((candidate) => candidate.searchId),
      ctx,
    );
    const priceOptions = await this.#priceOptions(ctx);
    const items: UnionItem[] = [];
    for (const candidate of candidates) {
      const itemId = itemIds.get(candidate.searchId);
      if (itemId === undefined) {
        // 换不到的不返回（商品暂不可用），不用搜索 ID 兜底。
        reportSearchSkip(this.#searchWarn, 'item_unconverted');
        continue;
      }
      items.push(mapTaobaoDetail(candidate.row, itemId, receivedAt, priceOptions));
    }
    // B1-04zzj (D10-692 S2-4)：同页换回同一个 item_id 的只留首条，顺序不变（official-search.ts ⑨）。
    return { items: firstPerItemId(items), nextCursor };
  }

  /** B1-04zh: one page of the 大淘客 search (see dataoke-search.ts). */
  async #dataokeSearch(
    source: DataokeClient,
    q: SearchQuery,
    ctx: CallCtx,
  ): Promise<Page<UnionItem>> {
    if (typeof q?.keyword !== 'string' || q.keyword.trim() === '') {
      throw new UnionError('invalid_dto', 'taobao searchItems: keyword is blank', 'taobao');
    }
    const page = q.cursor === undefined ? 1 : parseDataokeSearchCursor(q.cursor);
    const data = await source.request(
      'GET',
      DATAOKE_SEARCH_PATH,
      dataokeSearchParameters(q.keyword, page),
      {
        version: DATAOKE_SEARCH_VERSION,
        archive: archiveOf(ctx, 'query'),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    // BR-PRICE-11：quoted_at 取收到搜索响应时的注入时钟（不是换算响应时）。
    const receivedAt = this.#clock.now();
    const { rows, totalNum } = dataokeSearchPage(data);
    const nextCursor = dataokeSearchNextCursor(page, rows.length, totalNum);
    const candidates = dataokeSearchCandidates(rows, this.#warn);
    if (candidates.length === 0) return { items: [], nextCursor };
    const itemIds = await this.#convertItemIds(
      candidates.map((candidate) => candidate.goodsId),
      ctx,
    );
    const items: UnionItem[] = [];
    // B1-04zzj：白名单外的图按主机名记数，整页一次告警（dataoke-search.ts ⑥）。
    const droppedHosts: DataokeDroppedImageHosts = new Map();
    for (const candidate of candidates) {
      const itemId = itemIds.get(candidate.goodsId);
      // 换不到的不返回（商品暂不可用），不用大淘客 ID 兜底。
      if (itemId === undefined) continue;
      items.push(mapDataokeSearchItem(candidate, itemId, receivedAt, this.#warn, droppedHosts));
    }
    reportDroppedImageHosts(this.#warn, droppedHosts);
    return { items, nextCursor };
  }

  /**
   * B1-04zh (D10-504): 大淘客 goodsId → 凑狸 item_id. Cache hits are not asked again; misses go to
   * item.info.upgrade.get in batches of ≤ 20; a batch whose row count differs is retried one
   * goodsId per request. Only successful conversions are cached.
   */
  async #convertItemIds(
    goodsIds: readonly string[],
    ctx: CallCtx,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const misses = new Set<string>();
    for (const goodsId of goodsIds) {
      if (out.has(goodsId) || misses.has(goodsId)) continue;
      const cached = this.#itemIdCache.get(goodsId);
      if (cached === undefined) misses.add(goodsId);
      else out.set(goodsId, cached);
    }
    for (const batch of taobaoItemIdBatches([...misses])) {
      const rows = await this.#topItemRows(batch, ctx);
      // 15/50001 或 results 为空：本批都换不到，不返回、不写缓存。
      if (rows === null) continue;
      let matched = matchConvertedItemIds(batch, rows);
      if (matched === null) {
        // 条数不等无法按位置对应：逐个单查（一个对一个），换到的照常返回。
        const single = new Map<string, string>();
        for (const goodsId of batch) {
          const oneRows = await this.#topItemRows([goodsId], ctx);
          const itemId =
            oneRows === null ? undefined : matchConvertedItemIds([goodsId], oneRows)?.get(goodsId);
          if (itemId !== undefined) single.set(goodsId, itemId);
        }
        matched = single;
      }
      for (const [goodsId, itemId] of matched) {
        this.#itemIdCache.set(goodsId, itemId);
        out.set(goodsId, itemId);
      }
    }
    return out;
  }

  /**
   * B1-04zx (D10-582): official search ID → detail item_id, matched by last segment (see
   * official-search.ts ⑤), so no per-ID retry. Cache hits are not asked again; only successful
   * conversions are cached; a failed request rejects as it is, it is not "unconverted".
   */
  async #convertSearchIds(
    searchIds: readonly string[],
    ctx: CallCtx,
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const misses = new Set<string>();
    for (const searchId of searchIds) {
      if (out.has(searchId) || misses.has(searchId)) continue;
      const cached = this.#officialItemIdCache.get(searchId);
      if (cached === undefined) misses.add(searchId);
      else out.set(searchId, cached);
    }
    for (const batch of taobaoItemIdBatches([...misses])) {
      const rows = await this.#topItemRows(batch, ctx);
      // 15/50001 或 results 为空：本批都换不到，不返回、不写缓存。
      if (rows === null) continue;
      for (const [searchId, itemId] of matchSearchItemIds(batch, rows)) {
        this.#officialItemIdCache.set(searchId, itemId);
        out.set(searchId, itemId);
      }
    }
    return out;
  }

  /** item.info.upgrade.get rows for these IDs; 15/50001 or empty results → null. */
  async #topItemRows(
    goodsIds: readonly string[],
    ctx: CallCtx,
  ): Promise<readonly unknown[] | null> {
    try {
      const inner = await this.request(
        TAOBAO_ITEM_DETAIL,
        { item_id: goodsIds.join(','), biz_scene_id: TAOBAO_ITEM_DETAIL_SCENE },
        {
          envelope: TAOBAO_ITEM_DETAIL_ENVELOPE,
          archive: archiveOf(ctx, 'query'),
          businessSubCodes: DETAIL_SUB_CODES,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        },
      );
      return detailRows(inner);
    } catch (error) {
      if (error instanceof UnionError && error.code === 'item_unavailable') return null;
      throw error;
    }
  }

  /** B1-04l: taobao.tbk.item.info.upgrade.get (see the header). */
  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const itemId = detailItemId(ref);
    const inner = await this.request(
      TAOBAO_ITEM_DETAIL,
      { item_id: itemId, biz_scene_id: TAOBAO_ITEM_DETAIL_SCENE },
      {
        envelope: TAOBAO_ITEM_DETAIL_ENVELOPE,
        archive: archiveOf(ctx, 'query'),
        businessSubCodes: DETAIL_SUB_CODES,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    const rows = detailRows(inner);
    const priceOptions = await this.#priceOptions(ctx);
    return mapTaobaoDetail(rows[0], itemId, this.#clock.now(), priceOptions);
  }

  /** B1-04l: taobao.tbk.tpwd.create (see the header). */
  async taobaoShareCode(url: string, ctx: CallCtx): Promise<TaobaoShareCode> {
    const link = checkShareLink(url);
    const inner = await this.request(
      TAOBAO_TPWD_CREATE,
      { url: link },
      {
        envelope: TAOBAO_TPWD_CREATE_ENVELOPE,
        archive: archiveOf(ctx, 'convert'),
        businessSubCodes: TAOBAO_TPWD_SUB_CODES,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    return parseShareCode(inner);
  }

  /** B1-04l: taobao.tbk.spread.get (see the header). */
  async shortenTaobaoUrl(url: string, ctx: CallCtx): Promise<string> {
    const link = checkSpreadLink(url);
    const inner = await this.request(
      TAOBAO_SPREAD_GET,
      { requests: JSON.stringify([{ url: link }]) },
      {
        envelope: TAOBAO_SPREAD_GET_ENVELOPE,
        archive: archiveOf(ctx, 'convert'),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    return parseShortLink(inner);
  }

  /** The calling app's BR-PRICE-02 settings, read on every call; undefined → 08 defaults. */
  async #priceOptions(ctx: CallCtx): Promise<TaobaoPriceOptions | undefined> {
    return this.#priceSettings === undefined ? undefined : this.#priceSettings.read(ctx.appId);
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw unimplemented('resolveLink');
  }

  /** B1-04d: 大淘客 get-privilege-link when switched on (see the header); otherwise unimplemented. */
  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    const source = this.#orderSource;
    if (this.#convertSource !== 'dataoke' || source === undefined) throw unimplemented('convert');
    const parameters = privilegeLinkParameters(req, identity);
    const data = await source.request('GET', DATAOKE_PRIVILEGE_LINK_PATH, parameters, {
      version: DATAOKE_PRIVILEGE_LINK_VERSION,
      archive: archiveOf(ctx, 'convert'),
      outerCodes: DATAOKE_PRIVILEGE_LINK_CODES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    // BR-PRICE-11：quoted_at 取收到响应后的注入时钟。
    return mapPrivilegeLink(data, this.#clock.now(), this.#warn);
  }

  /**
   * B1-04f: one page of 大淘客 get-order-details (see the header and orders.ts). B1-04zv: under
   * ctx.rowErrors a row of ours the mapping skips goes to `rejected`; rows of other slots do not.
   * B1-04zzh: a row whose slot cannot be read is a bad row (rejected / skipped), a page of only such
   * rows throws upstream_unavailable, and an empty slot list throws before any request.
   */
  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<OrderPage> {
    const source = this.#orderSource;
    const readSlots = this.#orderSlots;
    if (source === undefined || readSlots === undefined) throw unimplemented('listOrders');
    // 口径、窗口、游标先校验：不合格的调用不读推广位、不取凭据、不发请求。
    const plan = planTaobaoOrders(win, opt);
    const adzones = slotAdzones(await readSlots(ctx));
    if (adzones.size === 0) {
      // B1-04zzh：凑狸总有登记过的淘宝推广位；空清单是配置错误，不当成「没有订单」返回空页推进水位。
      this.#orderWarn?.({ event: 'taobao_order_no_slots' });
      throw new UnionError(
        'adapter_unimplemented',
        'taobao listOrders: the slot reader gave no usable promotion slot',
        'taobao',
      );
    }
    const response = await this.#exchangeOrderData(
      source,
      TAOBAO_ORDER_PATH,
      TAOBAO_ORDER_VERSION,
      taobaoOrderParameters(plan),
      ctx,
      // B1-04zzc：订单详情的归档只存去掉别家推广位行的报文（维权、违规、搜索、转链不改写）。
      (body) => taobaoOrderArchiveBody(body, adzones),
    );
    const page = parseTaobaoOrderBody(response.body);
    // 归档行 id 只取归档传输挂在响应上的元数据（十进制字符串），不读报文里的同名值。
    const id: unknown = Reflect.get(response, 'raw_payload_id');
    const meta = {
      rawPayloadId: typeof id === 'string' && /^[0-9]+$/.test(id) ? id : null,
      like: this.#clock.now(),
    };
    const rows = ourRows(page.rows, adzones, this.#orderWarn);
    if (ctx?.rowErrors === 'collect') {
      return {
        ...collectOrderRows(
          rows,
          meta.rawPayloadId,
          (row) => requireTaobaoSlotOrder(row, meta, this.#orderWarn),
          (row) => taobaoRowIdentity(row, meta.like),
        ),
        nextCursor: nextTaobaoOrderCursor(plan, page),
      };
    }
    const items: UnionOrder[] = [];
    for (const row of rows) {
      const order = mapTaobaoSlotOrder(row, meta, this.#orderWarn);
      if (order !== null) items.push(order);
    }
    return { items, nextCursor: nextTaobaoOrderCursor(plan, page) };
  }

  /**
   * One gated GET to the 大淘客 order source (B1-04f / B1-04z): through ctx.gateUpstream when the
   * governed wrapper supplied it (one quota token per attempt), else with the caller's signal.
   */
  async #exchangeOrderData(
    source: DataokeClient,
    path: string,
    version: string,
    parameters: Readonly<Record<string, string | number>>,
    ctx: CallCtx,
    archiveBody?: (body: string) => string,
  ): Promise<UnionTransportResponse> {
    const archive = archiveOf(ctx, 'order');
    const send = (signal: AbortSignal | undefined) =>
      source.exchange('GET', path, parameters, {
        version,
        archive,
        ...(archiveBody === undefined ? {} : { archiveBody }),
        ...(signal === undefined ? {} : { signal }),
      });
    const gate: UpstreamGate | undefined = ctx?.gateUpstream;
    const { response } = gate === undefined ? await send(ctx?.signal) : await gate(send);
    return response;
  }

  /** B1-04z: one page of 大淘客 get-order-refund (see the header and refunds.ts). */
  async listRefunds(
    win: TimeWindow,
    ctx: CallCtx,
    opt?: RefundQueryOpt,
  ): Promise<Page<UnionRefund>> {
    const source = this.#orderSource;
    if (source === undefined) throw unimplemented('listRefunds');
    // 口径、窗口、游标先校验：不合格的调用不取凭据、不发请求。维权不读推广位（见 refunds.ts）。
    const plan = planTaobaoRefunds(win, opt);
    const response = await this.#exchangeOrderData(
      source,
      TAOBAO_REFUND_PATH,
      TAOBAO_REFUND_VERSION,
      taobaoRefundParameters(plan),
      ctx,
    );
    const page = parseTaobaoRefundBody(response.body);
    const like = this.#clock.now();
    const items: UnionRefund[] = [];
    for (const row of page.rows) {
      const refund = mapTaobaoRefund(row, like, this.#refundWarn);
      if (refund !== null) items.push(refund);
    }
    return { items, nextCursor: nextTaobaoRefundCursor(plan, page) };
  }

  /** B1-04z: one page of 大淘客 get-foul-order-list (see the header and punishments.ts). */
  async listPunishments(
    win: TimeWindow,
    ctx: CallCtx,
    opt?: PunishmentQueryOpt,
  ): Promise<Page<UnionPunish>> {
    const source = this.#orderSource;
    const readSlots = this.#orderSlots;
    if (source === undefined || readSlots === undefined) throw unimplemented('listPunishments');
    // 窗口、游标先校验：不合格的调用不读推广位、不取凭据、不发请求。
    const plan = planTaobaoPunishments(win, opt);
    const adzones = slotAdzones(await readSlots(ctx));
    if (adzones.size === 0) {
      this.#punishWarn?.({ event: 'taobao_punish_no_slots' });
      return { items: [], nextCursor: null };
    }
    const response = await this.#exchangeOrderData(
      source,
      TAOBAO_PUNISH_PATH,
      TAOBAO_PUNISH_VERSION,
      taobaoPunishParameters(plan),
      ctx,
    );
    const page = parseTaobaoPunishBody(response.body);
    const items: UnionPunish[] = [];
    for (const row of ourPunishRows(page.rows, adzones, this.#punishWarn)) {
      const punish = mapTaobaoPunish(row, this.#punishWarn);
      if (punish !== null) items.push(punish);
    }
    return { items, nextCursor: nextTaobaoPunishCursor(plan, page) };
  }
}
