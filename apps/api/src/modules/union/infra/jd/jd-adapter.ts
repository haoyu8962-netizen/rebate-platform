// 京东联盟适配器的请求底座（B1-04za）。规则测试：test/spec/union/jd-core/**。
// 公共参数（method、app_key、timestamp、format=json、v=1.0、sign_method=md5）+ 360buy_param_json
// （业务对象的 JSON 串，业务参数唯一的载体，业务名与公共参数同名也不冲突）+ md5 签名。
// 凭据经构造参数注入（每次请求取一次）、经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl
// （全部参数在请求体，URL 不带查询串，Content-Type application/x-www-form-urlencoded;charset=utf-8）、
// 按调用方登记的外层键与结果键解包（见 response.ts）。业务对象无法序列化或含非有限数 → invalid_dto，
// 不取凭据、不发请求。传输抛错 → upstream_unavailable（不带原文）。调用方的 AbortSignal 与归档上下文
// 原样挂在传输请求上。convert（B1-04zd）走 promotion.common.get，参数与映射在 promotion.ts，
// 规则测试：test/spec/union/jd-convert/**。
// 不读 process.env、不读文件；app_secret 只在内存参与签名。
// listOrders（B1-04zb）的时间窗、游标与映射在 orders.ts；每次调用取一页，每页都单独经配额治理。
// searchItems / getItem / resolveLink（B1-04zc）的参数、游标、选券与映射在 goods.ts，经 request 走
// goods.query；内层 code 按端口细分（201 空结果、202 分页上限，410、411 识别不了）。
import type { Clock } from '../../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type OrderQueryOpt,
  type Page,
  type ResolvedLink,
  type SearchQuery,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
} from '../../domain/types.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import {
  JD_DETAIL_INNER_CODES,
  JD_GOODS_KEYS,
  JD_GOODS_QUERY,
  JD_GOODS_SCENE,
  JD_LINK_INNER_CODES,
  JD_SEARCH_INNER_CODES,
  jdDetailItemId,
  jdGoodsCursor,
  jdGoodsHasMore,
  jdGoodsRef,
  jdGoodsRows,
  jdKeywordQuery,
  jingfenItemId,
  mapJdGoods,
  parseJdGoodsCursor,
  type JdGoodsPage,
} from './goods.ts';
import {
  checkJdProductKeyMode,
  JD_ORDER_KEYS,
  JD_ORDER_PAGE_SIZE,
  JD_ORDER_QUERY_BY_UPDATE_TIME,
  JD_ORDER_ROW_QUERY,
  JD_ORDER_WINDOW_TOO_LARGE_CODES,
  jdOrderCursor,
  jdOrderRows,
  jdOrderWindow,
  mapJdOrder,
  parseJdOrderCursor,
  type JdProductKeyMode,
} from './orders.ts';
import {
  JD_PROMOTION_COMMON_GET,
  JD_PROMOTION_INNER_CODES,
  JD_PROMOTION_KEYS,
  JD_PROMOTION_WARN_CODES,
  jdIdentityParameters,
  jdPromotionCodeReq,
  mapJdConvertResult,
} from './promotion.ts';
import {
  unwrapJdResponse,
  type JdInner,
  type JdInnerCodeMap,
  type JdResponseKeys,
  type JdWarning,
} from './response.ts';
import { jdTimestamp, signJdParameters, type JdParameters } from './sign.ts';

export type { JdInner, JdInnerCodeMap, JdResponseKeys, JdWarning } from './response.ts';

/** Application-level key pair; fetched once per request, never stored on the adapter. */
export interface JdCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface JdAdapterOptions {
  readonly credentials: () => Promise<JdCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: JdWarning) => void;
  /** BR-PROD-03 / 05：listOrders、convert 与商品三个端口每次按 ctx.appId 读一次；缺省 item。 */
  readonly productKeyMode?: { read(appId: string): Promise<JdProductKeyMode> };
  /** D10-500 ①：promotion.common.get 的 siteId，十进制文本；缺失时 convert 报 adapter_unimplemented。 */
  readonly siteId?: string | null;
}

/** The business object; 360buy_param_json is its JSON text and its only carrier. */
export type JdBusinessParameters = Readonly<Record<string, unknown>>;

export interface JdRequestOptions extends JdResponseKeys {
  readonly signal?: AbortSignal;
  /** Rides on the transport request for the archiving transport only. */
  readonly archive?: ArchiveContext;
  /** Per-method refinement of the inner code (see response.ts). */
  readonly innerCodes?: JdInnerCodeMap;
  /** Inner codes warned once on top of 403, by the same rule (method and code only). */
  readonly warnCodes?: ReadonlySet<string>;
}

/** 订单接口一次响应的内层对象，与这页报文的归档行 id（没有为 null）。 */
interface JdOrderReply {
  readonly inner: JdInner;
  readonly rawPayloadId: string | null;
}

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

function unimplemented(name: string): UnionError {
  return new UnionError('adapter_unimplemented', `jd ${name}: not implemented`, 'jd');
}

/** JSON.stringify turns a non-finite number into null; a request must not silently change. */
function rejectNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('non-finite number');
  }
  return value;
}

/** The business object as JSON text; the error carries no parameter content. */
function businessPayload(method: string, parameters: JdBusinessParameters): string {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(parameters, rejectNonFinite) as string | undefined;
  } catch {
    payload = undefined;
  }
  if (payload === undefined) {
    throw new UnionError('invalid_dto', `jd ${method}: invalid business parameters`, 'jd');
  }
  return payload;
}

export class JdUnionAdapter implements UnionAdapter {
  readonly platform = 'jd' as const;
  /** 每次上游翻页都经 CallCtx.gateUpstream 各自计量，治理包装不再在外层整体扣 token（B1-04w）。 */
  readonly listOrdersMetering = 'per_request' as const;
  readonly #credentials: () => Promise<JdCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: JdWarning) => void) | undefined;
  readonly #productKeyMode: JdAdapterOptions['productKeyMode'];
  readonly #siteId: string | null | undefined;

  constructor(options: JdAdapterOptions) {
    if (options.endpoint.platform !== 'jd') {
      throw new UnionError('invalid_endpoint', 'jd adapter: endpoint is not for jd', 'jd');
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
    this.#productKeyMode = options.productKeyMode;
    this.#siteId = options.siteId;
  }

  /** Internal request foundation; returns the inner object of the registered result key. */
  async request(
    method: string,
    parameters: JdBusinessParameters,
    options: JdRequestOptions,
  ): Promise<JdInner> {
    const { envelope, resultKey, innerCodes, warnCodes } = options;
    // 先做不需要凭据的同步检查，再取凭据：没有登记键的调用不取凭据、不发请求。
    if (typeof envelope !== 'string' || envelope === '') throw unimplemented(method);
    if (typeof resultKey !== 'string' || resultKey === '') throw unimplemented(method);
    const response = await this.#send(method, parameters, options);
    return unwrapJdResponse(
      method,
      { envelope, resultKey },
      response,
      this.#warn,
      innerCodes,
      warnCodes,
    );
  }

  async #send(
    method: string,
    parameters: JdBusinessParameters,
    { signal, archive }: JdRequestOptions,
  ): Promise<UnionTransportResponse> {
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError('invalid_endpoint', 'jd adapter: no gateway URL configured', 'jd');
    }
    const payload = businessPayload(method, parameters);
    const { appKey, appSecret } = await this.#credentials();

    const unsigned: JdParameters = {
      method,
      app_key: appKey,
      timestamp: jdTimestamp(this.#clock.now()),
      format: 'json',
      v: '1.0',
      sign_method: 'md5',
      '360buy_param_json': payload,
    };
    // 表单值与签名用同一份文本；请求体里只有 sign，没有 secret。
    const form = new URLSearchParams(unsigned);
    form.append('sign', signJdParameters(unsigned, appSecret));

    try {
      return await this.#transport({
        platform: 'jd',
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
      throw new UnionError('upstream_unavailable', `jd ${method}: transport failed`, 'jd');
    }
  }

  /** 订单接口的一次请求；归档行 id 只取传输回传的元数据，不读报文里的同名值。 */
  async #requestOrders(
    parameters: JdBusinessParameters,
    signal: AbortSignal | undefined,
    archive: ArchiveContext | undefined,
  ): Promise<JdOrderReply> {
    const response = await this.#send(JD_ORDER_ROW_QUERY, parameters, {
      ...JD_ORDER_KEYS,
      ...(signal === undefined ? {} : { signal }),
      ...(archive === undefined ? {} : { archive }),
    });
    const inner = unwrapJdResponse(
      JD_ORDER_ROW_QUERY,
      JD_ORDER_KEYS,
      response,
      this.#warn,
      undefined,
      undefined,
      JD_ORDER_WINDOW_TOO_LARGE_CODES,
    );
    const id: unknown = Reflect.get(response, 'raw_payload_id');
    return { inner, rawPayloadId: typeof id === 'string' && /^[0-9]+$/.test(id) ? id : null };
  }

  /**
   * 经治理包装时走 ctx.gateUpstream（每次尝试扣一个 token、单独超时与重试，取消信号是该次尝试的）；
   * 直接构造、没有回调时用 ctx.signal 直接发。两条路都带归档上下文。
   */
  #fetchOrders(parameters: JdBusinessParameters, ctx: CallCtx): Promise<JdOrderReply> {
    const appId = ctx?.appId;
    const archive = typeof appId === 'string' ? { appId, kind: 'order' } : undefined;
    const gate = ctx?.gateUpstream;
    if (gate === undefined) return this.#requestOrders(parameters, ctx?.signal, archive);
    return gate((signal) => this.#requestOrders(parameters, signal, archive));
  }

  /** 商品键模式：每次调用读一次，不缓存；缺省 item，其他值 invalid_dto。 */
  async #keyMode(ctx: CallCtx): Promise<JdProductKeyMode> {
    const modes = this.#productKeyMode;
    return checkJdProductKeyMode(modes === undefined ? 'item' : await modes.read(ctx?.appId));
  }

  /** goods.query 的一次请求：带取消信号与归档上下文（kind=query）。 */
  #queryGoods(
    goodsReqDTO: JdBusinessParameters,
    innerCodes: JdInnerCodeMap,
    ctx: CallCtx,
  ): Promise<JdInner> {
    const appId = ctx?.appId;
    const signal = ctx?.signal;
    return this.request(
      JD_GOODS_QUERY,
      { goodsReqDTO },
      {
        ...JD_GOODS_KEYS,
        innerCodes,
        ...(signal === undefined ? {} : { signal }),
        ...(typeof appId === 'string' ? { archive: { appId, kind: 'query' } } : {}),
      },
    );
  }

  #goodsPage(productKeyMode: JdProductKeyMode): JdGoodsPage {
    return { now: this.#clock.now(), productKeyMode, warn: this.#warn };
  }

  /**
   * goods.query 按 keyword 取一页，pageIndex 从 1、pageSize 固定 JD_GOODS_PAGE_SIZE，游标 `jd-goods:<页码>`。
   * 游标与商品键模式都在取凭据、发请求之前校验。内层 201、202 是空页、翻页结束，不是错误。
   * 价格或佣金异常的商品不出卡，但计入已取条数，不让翻页提前结束。
   */
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    if (typeof q?.keyword !== 'string' || q.keyword.trim() === '') {
      throw new UnionError('invalid_dto', 'jd searchItems: keyword is blank', 'jd');
    }
    const pageIndex = q.cursor === undefined ? 1 : parseJdGoodsCursor(q.cursor);
    const productKeyMode = await this.#keyMode(ctx);
    let inner: JdInner;
    try {
      inner = await this.#queryGoods(
        jdKeywordQuery(q.keyword, pageIndex),
        JD_SEARCH_INNER_CODES,
        ctx,
      );
    } catch (error) {
      if (error instanceof UnionError && error.code === 'item_unavailable') {
        return { items: [], nextCursor: null };
      }
      throw error;
    }
    const rows = jdGoodsRows(inner);
    const page = this.#goodsPage(productKeyMode);
    return {
      items: rows.map((row) => mapJdGoods(row, page)).filter((i) => i.price_status === 'ok'),
      nextCursor: jdGoodsHasMore(inner, rows.length, pageIndex)
        ? jdGoodsCursor(pageIndex + 1)
        : null,
    };
  }

  /**
   * goods.query 按 itemIds 取一个商品，只用于 item 模式；sku 模式没有 sceneId=2 权限，不发请求，
   * 报 item_unavailable。空结果 item_unavailable，不伪造 0 元商品；价格异常照样返回 price_status='anomaly'。
   */
  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const productKeyMode = await this.#keyMode(ctx);
    const itemId = jdDetailItemId(ref, productKeyMode);
    const inner = await this.#queryGoods(
      { itemIds: [itemId], sceneId: JD_GOODS_SCENE },
      JD_DETAIL_INNER_CODES,
      ctx,
    );
    const rows = jdGoodsRows(inner);
    if (rows.length === 0) {
      throw new UnionError('item_unavailable', 'jd getItem: no goods returned', 'jd');
    }
    return mapJdGoods(rows[0], this.#goodsPage(productKeyMode));
  }

  /**
   * CAP-JD-01。item 模式的 jingfen 详情页直接得 itemId，不取凭据、不调上游。其余链接（含 sku 模式的
   * jingfen 链接）原样作 keyword 走 goods.query，取第一条：身份只取响应，第一条价格异常也不换，
   * 取不到当前模式的键 → link_unrecognized。不跟随跳转、不抓页面，不从链接里抽 skuId。
   */
  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new UnionError('link_unrecognized', 'jd resolveLink: empty link', 'jd');
    }
    const link = raw.trim();
    const productKeyMode = await this.#keyMode(ctx);
    const itemId = productKeyMode === 'item' ? jingfenItemId(link) : null;
    if (itemId !== null) return { item: { platform: 'jd', item_id: itemId, itemId } };
    const inner = await this.#queryGoods(jdKeywordQuery(link, 1), JD_LINK_INNER_CODES, ctx);
    const rows = jdGoodsRows(inner);
    const item = rows.length === 0 ? null : jdGoodsRef(rows[0], productKeyMode);
    if (item === null) {
      throw new UnionError('link_unrecognized', 'jd resolveLink: no goods recognized', 'jd');
    }
    return { item };
  }

  /**
   * promotion.common.get，一次一个 materialId。顺序：siteId → 身份 → 商品键模式 → 商品，都在取凭据、
   * 发请求之前。没配 siteId 报 adapter_unimplemented（下游出 50303）。sku 模式存的是 skuId，官方只接受
   * 完整联盟商品 ID（2001707），换不了，报 link_unrecognized，不猜。写操作，治理层与适配器都不重试。
   */
  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    const siteId = this.#siteId;
    if (typeof siteId !== 'string' || siteId.trim() === '') {
      throw new UnionError('adapter_unimplemented', 'jd convert: no site id configured', 'jd');
    }
    jdIdentityParameters(identity);
    if ((await this.#keyMode(ctx)) === 'sku') {
      throw new UnionError('link_unrecognized', 'jd convert: sku mode has no union item id', 'jd');
    }
    const promotionCodeReq = jdPromotionCodeReq(req, identity, siteId);
    const appId = ctx?.appId;
    const signal = ctx?.signal;
    const inner = await this.request(
      JD_PROMOTION_COMMON_GET,
      { promotionCodeReq },
      {
        ...JD_PROMOTION_KEYS,
        innerCodes: JD_PROMOTION_INNER_CODES,
        warnCodes: JD_PROMOTION_WARN_CODES,
        ...(signal === undefined ? {} : { signal }),
        ...(typeof appId === 'string' ? { archive: { appId, kind: 'convert' } } : {}),
      },
    );
    return mapJdConvertResult(inner);
  }

  /**
   * 按更新时间取一页：hasMore 为 true 时 nextCursor 指下一页，调用方循环取完。时间窗、查询方式、
   * 游标与商品键模式都在取凭据、发请求之前校验；商品键模式每次调用读一次，不缓存。
   * 不带推广位参数（positionId 不是过滤参数），不按推广位或 validCode 过滤。
   */
  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    if ((opt?.queryMode ?? 'increment') !== 'increment') {
      throw new UnionError('invalid_dto', 'jd listOrders: unsupported queryMode', 'jd');
    }
    const window = jdOrderWindow(win, this.#clock.now());
    const pageIndex = opt?.cursor === undefined ? 1 : parseJdOrderCursor(opt.cursor);
    const productKeyMode = await this.#keyMode(ctx);
    const { inner, rawPayloadId } = await this.#fetchOrders(
      {
        orderReq: {
          pageIndex,
          pageSize: JD_ORDER_PAGE_SIZE,
          type: JD_ORDER_QUERY_BY_UPDATE_TIME,
          ...window,
        },
      },
      ctx,
    );
    const { rows, hasMore } = jdOrderRows(inner);
    const page = { rawPayloadId, like: this.#clock.now(), productKeyMode };
    return {
      items: rows.map((row) => mapJdOrder(row, page)),
      nextCursor: hasMore ? jdOrderCursor(pageIndex + 1) : null,
    };
  }
}
