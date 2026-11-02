// Unified union DTOs and the UnionAdapter port (规划/02 §6.1). Platform differences (signing,
// field names, paging, time-window limits) stay inside each adapter; everything here is domain
// data, never an upstream response format.
import type { components } from '@couli/contracts-ts';
import type { QuotaPurpose } from '../../platform/index.ts';
import type { PriceAnomalyReason } from './taobao-price.ts';

export type Platform = components['schemas']['PlatformCode'];
export type RegisteredPlatform = Extract<Platform, 'jd' | 'pdd' | 'taobao'>;
export type UnionMode = 'demo' | 'replay' | 'live';
export type UnionEnvironment = 'local' | 'test' | 'staging' | 'prod';

/** Exhaustive at compile time: adding a PlatformCode to the contract fails the build here. */
const PLATFORM_CODES: Readonly<Record<Platform, true>> = {
  taobao: true,
  jd: true,
  pdd: true,
  meituan: true,
  vip: true,
  douyin: true,
  eleme: true,
  kuaishou: true,
  suning: true,
};

export const REGISTERED_PLATFORMS: readonly RegisteredPlatform[] = ['jd', 'pdd', 'taobao'];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && Object.hasOwn(PLATFORM_CODES, value);
}

export function isRegisteredPlatform(value: unknown): value is RegisteredPlatform {
  return typeof value === 'string' && (REGISTERED_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Internal failures, not new HTTP error codes. Adapters report what the platform answered:
 * a business refusal (item_unavailable, link_unrecognized, upstream_rejected) or a dependency
 * failure (upstream_unavailable: network error or 5xx; rate_limited: upstream throttling).
 */
export type UnionErrorCode =
  | 'adapter_unimplemented'
  | 'invalid_endpoint'
  | 'unsafe_mode'
  | 'invalid_dto'
  | 'invalid_identity'
  | 'item_unavailable'
  | 'link_unrecognized'
  | 'upstream_rejected'
  | 'upstream_unavailable'
  | 'rate_limited';

/** The UnionError codes that mean the dependency itself failed (02 §6.2: retry and breaker). */
const DEPENDENCY_FAILURE_CODES: ReadonlySet<UnionErrorCode> = new Set<UnionErrorCode>([
  'upstream_unavailable',
  'rate_limited',
]);

export class UnionError extends Error {
  readonly code: UnionErrorCode;
  readonly platform: Platform | null;
  /**
   * B1-04zt: the order query refused this time window as too large, whatever the code says; orders
   * halves the window on it (application/fetch-window.ts) without knowing the platform.
   */
  readonly windowTooLarge: boolean;

  constructor(
    code: UnionErrorCode,
    message: string,
    platform: Platform | null = null,
    options: { readonly windowTooLarge?: boolean } = {},
  ) {
    super(message);
    this.name = 'UnionError';
    this.code = code;
    this.platform = platform;
    this.windowTooLarge = options.windowTooLarge ?? false;
  }
}

/**
 * Governor classification of an adapter error. A UnionError with a business code means the
 * platform (or this module) answered and said no: `rejected`, never retried, not a breaker
 * failure. Dependency-failure UnionErrors and every other error (network errors, unknown
 * throws) are `failure`; the Governor's own timeout is always a failure.
 */
export function classifyUnionError(error: unknown): 'failure' | 'rejected' {
  if (error instanceof UnionError && !DEPENDENCY_FAILURE_CODES.has(error.code)) return 'rejected';
  return 'failure';
}

export interface UnionEndpoint {
  readonly platform: RegisteredPlatform;
  readonly mode: UnionMode;
  /** No upstream URL is invented for demo. Replay points at the configured WireMock. */
  readonly baseUrl: string | null;
  readonly quotaKey: string;
}

export interface CallCtx {
  readonly appId: string;
  readonly requestId: string;
  readonly purpose: QuotaPurpose;
  readonly scenario?: string;
  /** Supplied by the governed wrapper to the adapter. */
  readonly signal?: AbortSignal;
  readonly baseUrl?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * B1-04w: runs one upstream request under governance (quota token, per-request timeout,
   * retry, breaker). Supplied only by the governed wrapper, and only to an operation the adapter
   * declares as metered per request (UnionAdapter.listOrdersMetering); the wrapper always
   * replaces or removes a caller-supplied value. Absent on direct construction: the adapter then
   * sends the request itself with `signal`.
   */
  readonly gateUpstream?: UpstreamGate;
}

/** B1-04w: see CallCtx.gateUpstream. The request receives the signal of its own attempt. */
export type UpstreamGate = <T>(request: (signal: AbortSignal) => Promise<T>) => Promise<T>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Structurally compatible with packages/domain UnionProductPayload (B1-05b). */
export interface ItemRef {
  readonly platform: Platform;
  readonly item_id?: string | null;
  readonly itemId?: string | null;
  readonly skuId?: string | null;
  readonly goods_id?: string | null;
  readonly goods_sign?: string | null;
}

/** BR-PRICE-01 three price fields in integer fen, commission rate in bp, fetch time. */
export interface UnionItem extends ItemRef {
  readonly title: string;
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly commission_rate_bp: bigint;
  readonly quoted_at: string;
  readonly coupon_ids?: string;
  readonly price_status?: 'ok' | 'anomaly';
  readonly price_anomaly_reason?: PriceAnomalyReason;
  /**
   * B1-04l (FU-CATEGORY-BLOCKLIST): the union's level-one category id, as a decimal string (Taobao
   * level_one_category_id). Filled only by the live Taobao adapter; jd / pdd / demo leave it absent,
   * and so does Taobao when the upstream gave none.
   */
  readonly category_l1_id?: string;
  /** B1-04l: the union's level-one category name as given (Taobao level_one_category_name). */
  readonly category_l1_name?: string;
}

export interface UnionItemDetail extends UnionItem {
  readonly description?: string;
  /**
   * B1-22s (BR-ATTR-10 素材图): main image, an https address as the union returned it; absent
   * when the upstream gave none or it failed normalizeItemImages (domain/item-images.ts).
   */
  readonly main_image_url?: string;
  /**
   * B1-22s: the upstream multi-image list after normalizeItemImages — https only, deduplicated,
   * upstream order, 1–9 entries; the main image is neither added nor removed. Absent when empty.
   */
  readonly image_urls?: readonly string[];
}

/** Domain data, never an invented upstream response format. Percent is e.g. "12.34". */
export interface ItemInput extends ItemRef {
  readonly title: string;
  readonly price_fen: unknown;
  readonly coupon_fen: unknown;
  readonly final_price_fen: unknown;
  readonly commission_percent: string;
}

/**
 * PDD-only internal order data; absent on other platforms. Missing upstream fields are null.
 * Times retain integer Unix seconds (UTC), not milliseconds or local-time strings.
 * Rates retain integer per-mille units as bigint, not the product DTO's basis points.
 * subsidy_* are internal channel data, never user-visible amounts or commission components.
 */
export interface PddOrderFields {
  readonly platform_order_id?: string | null;
  readonly pid?: string | null;
  readonly custom_parameters?: string | null;
  readonly order_status?: number | null;
  readonly order_status_desc?: string | null;
  readonly fail_reason?: string | null;
  /** Detail-only; missing is null, not an inferred no-after-sales status. */
  readonly return_status?: number | null;
  readonly service_fee_fen?: bigint | null;
  readonly goods_price_fen?: bigint | null;
  readonly platform_discount_fen?: bigint | null;
  readonly sep_market_fee_fen?: bigint | null;
  readonly promotion_rate?: bigint | null;
  readonly sep_rate?: bigint | null;
  readonly order_create_time?: number | null;
  readonly order_pay_time?: number | null;
  readonly order_group_success_time?: number | null;
  readonly order_receive_time?: number | null;
  readonly order_verify_time?: number | null;
  readonly order_settle_time?: number | null;
  readonly order_modify_at?: number | null;
  readonly url_last_generate_time?: number | null;
  readonly subsidy_duo_amount_level?: bigint | null;
  readonly subsidy_duo_amount_ten_million?: bigint | null;
  readonly subsidy_type?: number | null;
  /** Probe confirmed only the array, not its member schema; no nested field mapping. */
  readonly subsidy_list?: readonly unknown[] | null;
}

/**
 * B1-04f: Taobao-only internal order data (大淘客 get-order-details, the official
 * publisher_order_dto field of the same name); absent on other platforms. Missing or invalid
 * upstream values are null. Amounts are integer fen (BR-CALC-26 yuanStrToFen, from the wire text),
 * rates are bp (pctStrToBp). Ids that are JSON integers upstream are kept as decimal strings.
 * None of these is the attribution N: the Taobao N mapping lives in orders (D10-488).
 */
export interface TaobaoOrderFields {
  /** tk_status as the integer the union sent (e.g. 12 / 13 / 14 / 3); mapping is in orders. */
  readonly tk_status?: number | null;
  readonly refund_tag?: number | null;
  readonly tk_order_role?: number | null;
  readonly item_num?: number | null;
  /** site_id as a decimal string. */
  readonly site_id?: string | null;
  /** special_id as a decimal string; present only on channel orders. */
  readonly special_id?: string | null;
  /** item_price. */
  readonly item_price_fen?: bigint | null;
  /** alimama_share_fee. */
  readonly alimama_share_fen?: bigint | null;
  /** subsidy_fee. */
  readonly subsidy_fen?: bigint | null;
  /** total_commission_fee. */
  readonly total_commission_fen?: bigint | null;
  /** alimm_share_info_dto.alimm_tech_service_fee. */
  readonly tech_service_fee_fen?: bigint | null;
  /** alimm_share_info_dto.alimm_tech_service_pre_fee. */
  readonly tech_service_pre_fee_fen?: bigint | null;
  /** income_rate. */
  readonly income_rate_bp?: bigint | null;
  /** pub_share_rate. */
  readonly pub_share_rate_bp?: bigint | null;
  /** total_commission_rate. */
  readonly total_commission_rate_bp?: bigint | null;
}

/**
 * B1-08e（D10-20）：跨平台归因参数，原样字符串；union 不解析（用户归属在 orders，BR-ATTR-06）。
 * 拼多多只填 custom_parameters。
 */
export interface UnionOrderAttrParams {
  readonly relation_id: string | null;
  readonly custom_parameters: string | null;
  readonly sub_union_id: string | null;
}

/**
 * B1-08e（D10-20）：平台无关的订单字段，由各平台适配器的映射层填写（makeUnionOrder 不补，所以在
 * UnionOrder 上是可选的；拼多多映射总是全部给出，缺失一律显式 null）。
 * TODO(规划/11 §4.5): 淘宝 / 京东的订单映射 — blocked on 推广位 / siteId
 */
export interface UnionOrderNeutralFields {
  /** 订单唯一键里的子订单号（BR-ATTR-22）；拼多多 = order_sn。 */
  readonly sub_order_id: string;
  /** 拼多多没有父单：null。 */
  readonly parent_order_id: string | null;
  /** 推广位；拼多多 = pid（列表 p_id、详情 pid）。 */
  readonly promotion_slot: string | null;
  readonly attr_params: UnionOrderAttrParams;
  /** 平台原始状态码的字符串形式；状态映射在 orders（B1-08f）。 */
  readonly raw_status: string | null;
  readonly deposit_paid_at: Date | null;
  readonly paid_at: Date | null;
  readonly received_at: Date | null;
  readonly settled_at: Date | null;
  readonly modified_at: Date | null;
  /** 预估佣金（整数分）；拼多多 = commission_fen（promotion_amount，含服务费）。 */
  readonly est_commission_fen: bigint | null;
  /** 结算佣金（整数分）；拼多多暂无单独字段 → null（TODO 待 CAP-PDD-07）。 */
  readonly settle_commission_fen: bigint | null;
  /** 该订单所在那页报文在 union_raw_payloads 的 id（十进制字符串）；未归档为 null。 */
  readonly raw_payload_id: string | null;
}

export interface UnionOrder
  extends ItemRef, PddOrderFields, TaobaoOrderFields, Partial<UnionOrderNeutralFields> {
  /** B1-08p：undefined = 平台无店铺字段；null = 本条缺失 / 非法；字符串 = 店铺标识。
   * 拼多多来源：pdd.ddk.order.list.increment.get / list.range.get / detail.get 的 mall_id。
   * 字段资料：docs-mirror/pdd/api/<接口名>.md；不以 mall_name / seller_nick 替代 ID。
   * 淘宝订单接口没有与商品侧同口径的店铺 ID，映射做出来时也不加此键；京东订单映射未做（字段待定）。
   */
  readonly shop_id?: string | null;
  readonly order_id: string;
  readonly paid_fen: bigint;
  /** PDD: promotion_amount 含软件服务费，不是可分配基数；基数 = promotion_amount −
   * duo_id_service_fee，在 orders / 分账层扣。subsidy_* 不并入此金额。 */
  readonly commission_fen: bigint;
}

export interface OrderInput extends ItemRef {
  readonly order_id: unknown;
  readonly paid_fen: unknown;
  readonly commission_fen: unknown;
}

/**
 * A refund (维权) the union reports against one order. The optional fields are filled by the
 * Taobao mapping (B1-04z, 大淘客 get-order-refund; D10-488 ② / D10-491) and absent elsewhere.
 * Amounts are integer fen (BR-CALC-26 yuanStrToFen of the wire text, floored past two decimals);
 * times are platform times (Beijing "YYYY-MM-DD HH:MM:SS"), null when "--" or missing.
 */
export interface UnionRefund {
  readonly order_id: string;
  readonly refund_id: string;
  /** Commission to take back; Taobao: = base_refund_fen (the only amount a refund deducts). */
  readonly refund_fen: bigint;
  /**
   * Taobao: tk_commission_fee_refund − tk_commission_alimm_refund_fee −
   * tk_commission_agent_refund_fee (never negative; a negative result skips the refund).
   */
  readonly base_refund_fen?: bigint;
  /**
   * Taobao: tk_subsidy_fee_refund − tk_subsidy_alimm_refund_fee − tk_subsidy_agent_refund_fee
   * (never negative). Kept for reference; not part of refund_fen.
   */
  readonly subsidy_refund_fen?: bigint;
  /** Taobao show_return_fee as is (no part in any amount); null when missing or invalid. */
  readonly show_return_fen?: bigint | null;
  /** Taobao refund_status as the union sent it (JSON number → its literal); null when missing. */
  readonly refund_status?: string | null;
  /** Taobao tk_refund_time. */
  readonly refund_created_at?: Date | null;
  /** Taobao tk_refund_suit_time. */
  readonly refund_finished_at?: Date | null;
  /** Taobao modified_time. */
  readonly modified_at?: Date | null;
  /** Taobao earning_time. */
  readonly earning_at?: Date | null;
}

/**
 * A punishment (违规) of one order. Taobao (B1-04z, 大淘客 get-foul-order-list) has no deduction
 * amount: deduction_fen is null and the order is clawed back in full under BR-FUND (PUNISH,
 * D10-488 ②). The optional strings are the union's values as sent (JSON number → its literal).
 */
export interface UnionPunish {
  readonly order_id: string;
  /** Taobao: `<tb_trade_id>:<settle_month>`. */
  readonly punishment_id: string;
  readonly deduction_fen: bigint | null;
  /** Taobao punish_status (0 frozen / 1 unfrozen). */
  readonly punish_status?: string | null;
  /** Taobao violation_type (1 / 2). */
  readonly violation_type?: string | null;
  readonly settle_month?: string | null;
}

export interface SearchQuery {
  readonly keyword: string;
  readonly cursor?: string;
}
export interface ResolvedLink {
  readonly item: ItemRef;
}
export interface ConvertReq {
  readonly item: ItemRef;
  readonly idempotencyKey: string;
}
export interface IdentityClaims {
  readonly appId: string;
  readonly userId: string;
  readonly platform: Platform;
  readonly promotionSlot: string;
  readonly relationId: string | null;
}

/** Instances built through the UnionIdentity constructor; a forged prototype is not one. */
const constructedIdentities = new WeakSet<object>();

/**
 * The server-side identity for a conversion (BR-ATTR-05, BR-AI-03). Only a trusted linking
 * subclass constructs it; no JSON or plain object is an identity, and union exposes no public
 * factory or constructor.
 */
export abstract class UnionIdentity {
  declare private readonly identityBrand: void;
  readonly claims: IdentityClaims;

  protected constructor(claims: IdentityClaims) {
    this.claims = Object.freeze({
      appId: claims.appId,
      userId: claims.userId,
      platform: claims.platform,
      promotionSlot: claims.promotionSlot,
      relationId: claims.relationId,
    });
    constructedIdentities.add(this);
  }
}

/** True only for an object produced by a UnionIdentity subclass constructor. */
export function isServerIdentity(value: unknown): value is UnionIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    value instanceof UnionIdentity &&
    constructedIdentities.has(value)
  );
}

export type ConvertResult =
  | ({ readonly kind: 'url'; readonly url: string } & PddPromotionUrlExtras &
      TaobaoPromotionUrlExtras)
  | {
      readonly kind: 'baichuan';
      readonly item: ItemRef;
      readonly promotionSlot: string;
      readonly relationId: string;
    };

/** Optional PDD fields confirmed by the B1-04h probe; absent on other platforms. */
export interface PddPromotionUrlExtras {
  readonly schema_url?: string;
  readonly tz_schema_url?: string;
  readonly short_url?: string;
  readonly mobile_short_url?: string;
  /** Upstream `url`: browser entry preferring WeChat; never replaces the mobile URL. */
  readonly browser_url?: string;
  readonly we_app_web_view_url?: string;
  readonly we_app_web_view_short_url?: string;
}

/**
 * B1-04d (D10-503 ①): optional Taobao fields of a conversion through the 大淘客 privilege link
 * (GET /api/tb-service/get-privilege-link v1.3.1); absent on other platforms and on the baichuan
 * form. Picked one by one from the response `data`, never spread: tpwd / longTpwd as non-empty text,
 * shortUrl / couponClickUrl only as absolute https URLs (anything else, `//…` included, is treated
 * as absent). ConvertResult.url is short_url, else coupon_click_url, else upstream_unavailable.
 * kuaiZhanUrl, itemUrl, itemId (D10-504), title and the commission rates are never exposed.
 */
export interface TaobaoPromotionUrlExtras {
  /** Upstream `tpwd`: the share code (淘口令) as given. */
  readonly tpwd?: string;
  /** Upstream `longTpwd`: the long share text as given. */
  readonly long_tpwd?: string;
  /** Upstream `shortUrl` (https only). */
  readonly short_url?: string;
  /** Upstream `couponClickUrl` (https only). */
  readonly coupon_click_url?: string;
  /** Price re-fetched for the open (BR-PRICE-11); absent when either amount is invalid. */
  readonly requote?: TaobaoRequote;
}

/**
 * B1-04d: the price the 大淘客 privilege link answered with. Amounts go through yuanStrToFen only;
 * an invalid originalPrice / actualPrice drops the whole `requote` and sends one warning
 * ({ method: the request path, code: 'invalid_amount' }, no raw value) without failing the
 * conversion. Coupon fields are the upstream values as given (absent stays absent). `quoted_at` is
 * the injected Clock read once the 大淘客 response was received, as an ISO-8601 string.
 * No commission ratio here.
 */
export interface TaobaoRequote {
  /** Upstream `originalPrice` in fen. */
  readonly price_fen: bigint;
  /** Upstream `actualPrice` in fen. */
  readonly final_price_fen: bigint;
  readonly coupon_info?: string;
  readonly coupon_start_time?: string;
  readonly coupon_end_time?: string;
  readonly coupon_total_count?: string | number;
  readonly coupon_remain_count?: string | number;
  readonly quoted_at: string;
}

/** Filing page generated for the same promotion slot used by convert. */
export interface PddAuthorityUrl {
  readonly url: string;
  readonly schema_url?: string;
  readonly mobile_short_url?: string;
  readonly short_url?: string;
  /** Upstream `url`, kept separate from the mobile landing page. */
  readonly browser_url?: string;
}
/**
 * B1-04l: a Taobao share code (淘口令) generated from one of our own promotion links
 * (taobao.tbk.tpwd.create). `password_simple` is the bare code (￥…￥), `model` the full share
 * text with code and link, both exactly as the union returned them.
 */
export interface TaobaoShareCode {
  readonly password_simple: string;
  readonly model: string;
}
export interface BindReq {
  readonly authorizationCode: string;
}
export interface BindResult {
  readonly relationId: string;
}
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}
/**
 * B1-04f: which order time a Taobao window filters on (大淘客 queryType: update 4, pay 2,
 * settle 3, create 1). Omitted = update (D10-488 ①).
 */
export type OrderTimeBasis = 'update' | 'pay' | 'settle' | 'create';

export interface OrderQueryOpt {
  readonly cursor?: string;
  /** PDD: omitted = increment (update time); pay_time uses the payment-time range API. */
  readonly queryMode?: 'increment' | 'pay_time';
  /** B1-04f: Taobao only (see OrderTimeBasis); other platforms ignore it. */
  readonly timeBasis?: OrderTimeBasis;
}

/**
 * B1-04z: which time a Taobao refund window filters on (大淘客 get-order-refund queryType:
 * refund_created 1, settle 2, refund_finished 3, create 4, update 5). Omitted = update. create /
 * update cannot start before Beijing 2022-12-20 00:00:00 (invalid_dto, nothing sent).
 */
export type RefundTimeBasis = 'refund_created' | 'settle' | 'refund_finished' | 'create' | 'update';

/** B1-04z: listRefunds options; cursor is the opaque nextCursor of the previous page. */
export interface RefundQueryOpt {
  readonly cursor?: string;
  readonly timeBasis?: RefundTimeBasis;
}

/** B1-04z: listPunishments options; cursor is the opaque nextCursor of the previous page. */
export interface PunishmentQueryOpt {
  readonly cursor?: string;
}
export interface MaterialReq {
  readonly cursor?: string;
}

/** B1-22p: one category a material channel offers, as the union reports it. */
export interface ChannelRankingCategory {
  readonly categoryId: string;
  readonly name: string;
}

/** B1-22p: one channel position; salesText is the union's sales field as is, null when absent. */
export interface ChannelRankingEntry {
  readonly item: UnionItem;
  readonly salesText: string | null;
}

/** B1-22p: one channel page, in the channel's own order. */
export interface ChannelRankingPage {
  readonly items: readonly ChannelRankingEntry[];
  readonly hasMore: boolean;
}

/** B1-22p: the categories of one material channel. */
export interface ChannelCategoriesReq {
  readonly channelId: string;
}

/** B1-22p: one page of a material channel; categoryId null is the whole list, pageNo from 1. */
export interface ChannelRankingReq {
  readonly channelId: string;
  readonly categoryId: string | null;
  readonly pageNo: number;
  readonly pageSize: number;
}
export interface TljCreateReq {
  readonly item: ItemRef;
  readonly amount_fen: bigint;
  readonly idempotencyKey: string;
}
export interface TljCreateResult {
  readonly id: string;
}

export interface UnionAdapter {
  readonly platform: Platform;
  /**
   * B1-04w: declared by an adapter whose listOrders sends several upstream requests and runs
   * each through CallCtx.gateUpstream. The governed wrapper then takes no token of its own for
   * listOrders (each request takes one); without the declaration it governs listOrders as one
   * call. Declared on the adapter object or class, never on the method.
   */
  readonly listOrdersMetering?: 'per_request';
  /**
   * B1-04z: same as listOrdersMetering, for listRefunds / listPunishments: the governed wrapper
   * takes no token of its own for that operation and hands the adapter CallCtx.gateUpstream (one
   * token per upstream request); without the declaration the operation is governed as one call.
   */
  readonly listRefundsMetering?: 'per_request';
  readonly listPunishmentsMetering?: 'per_request';
  searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>>;
  getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail>;
  resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink>;
  convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult>;
  bindPublisher?(req: BindReq, ctx: CallCtx): Promise<BindResult>;
  listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>>;
  /** PDD detail, including optional after-sales status; an idempotent read. */
  getPddOrderDetail?(orderSn: string, ctx: CallCtx): Promise<UnionOrder>;
  /** An idempotent read; B1-04z: `opt` (cursor, Taobao timeBasis) is passed through as is. */
  listRefunds?(win: TimeWindow, ctx: CallCtx, opt?: RefundQueryOpt): Promise<Page<UnionRefund>>;
  /** An idempotent read; B1-04z: `opt` (cursor) is passed through as is. */
  listPunishments?(
    win: TimeWindow,
    ctx: CallCtx,
    opt?: PunishmentQueryOpt,
  ): Promise<Page<UnionPunish>>;
  materialFeed?(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>>;
  /** B1-22p: categories of a material channel (BR-TEXT-17 细则「联盟物料频道」); an idempotent read. */
  channelCategories?(
    req: ChannelCategoriesReq,
    ctx: CallCtx,
  ): Promise<readonly ChannelRankingCategory[]>;
  /** B1-22p: one page of a material channel in the channel's own order; an idempotent read. */
  channelRanking?(req: ChannelRankingReq, ctx: CallCtx): Promise<ChannelRankingPage>;
  createTaolijin?(req: TljCreateReq, ctx: CallCtx): Promise<TljCreateResult>;
  /**
   * B1-06v: whether the user the server-built identity names (Pinduoduo custom_parameters
   * {app, uid=attr_code, sc}, never a user_id) is filed (备案) under the identity's promotion slot
   * (BR-ID-22: only an authorized answer turns a binding active). An idempotent read; Pinduoduo
   * only. The live adapter calls pdd.ddk.member.authority.query (B1-04h, CAP-PDD-05).
   */
  queryPddAuthority?(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthority>;
  /**
   * B1-04h: PDD channel_type=10 filing URL for the identity's own promotion slot (the slot convert
   * uses; filing is per slot). Governed as an idempotent read; Pinduoduo only.
   */
  pddAuthorityUrl?(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthorityUrl>;
  /**
   * B1-04l: the share code (淘口令) of one of our own Taobao promotion links (https
   * s.click.taobao.com / uland.taobao.com only; anything else is invalid_dto without a request).
   * The caller passes our own link (BR-ATTR-10). Governed as an idempotent read; live Taobao only,
   * absent on demo and other platforms.
   */
  taobaoShareCode?(url: string, ctx: CallCtx): Promise<TaobaoShareCode>;
  /**
   * B1-04l: the https://s.click.taobao.com/ short link of a Taobao promotion link (https
   * uland / s.click / ai / temai.taobao.com only; anything else is invalid_dto without a request).
   * Governed as an idempotent read; live Taobao only, absent on demo and other platforms.
   */
  shortenTaobaoUrl?(url: string, ctx: CallCtx): Promise<string>;
}

/** B1-06v: the answer of UnionAdapter.queryPddAuthority. */
export interface PddAuthority {
  readonly authorized: boolean;
}
