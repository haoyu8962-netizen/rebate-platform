// 拼多多联盟适配器的请求底座（4_PDD_附 §3.1–§3.4）：公共参数 + MD5 签名、凭据经构造参数注入、
// 经注入的 UnionTransport 发 POST JSON、按登记的外层键解包、error_response 分类到 UnionError。
// 订单端口（listOrders 的 increment / pay_time、getPddOrderDetail）的参数与映射在 orders.ts（B1-04i）；
// 商品端口（searchItems / getItem / resolveLink / materialFeed）的参数、游标与映射在 goods.ts（B1-04u），
// 每次调用都带服务端注入的查询身份（D-u2；B1-04x 起提供者按调用上下文的 app 取查询推广位）；转链、备案查询、备案链接（B1-04h）的参数与映射在 promotion.ts，
// 它们只用调用方传入的服务端身份（推广位 + custom_parameters），不用查询身份。
// 不读 process.env、不读文件；client_secret 只在内存里参与签名。
import type { Clock } from '../../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type MaterialReq,
  type OrderPage,
  type OrderQueryOpt,
  type Page,
  type PddAuthority,
  type PddAuthorityUrl,
  type ResolvedLink,
  type SearchQuery,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
  type UpstreamGate,
} from '../../domain/types.ts';
import { collectOrderRows } from '../order-row.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import { pddParameterText, signPddParameters, type PddParameters } from './sign.ts';
import { pddEnvelopeKey, unwrapPddResponse, type PddWarning } from './response.ts';
import {
  checkQueryIdentity,
  envelopeCount,
  envelopeListId,
  feedCursor,
  goodsRows,
  mapPddGoods,
  parseFeedCursor,
  parseSearchCursor,
  pddGoodsRef,
  PDD_FEED_CHANNEL,
  PDD_FEED_LIMIT,
  PDD_GOODS_DETAIL,
  PDD_GOODS_RECOMMEND,
  PDD_GOODS_SEARCH,
  PDD_SEARCH_PAGE_SIZE,
  PDD_URL_SHORT_PARSE,
  searchCursor,
  type PddGoodsSource,
  type PddQueryIdentity,
} from './goods.ts';
import {
  incrementCursor,
  incrementWindow,
  lastOrderId,
  mapPddOrder,
  type PddOrderPage,
  type PddOrderSource,
  orderList,
  parseIncrementCursor,
  parsePddOrderEnvelope,
  parseRangeCursor,
  PDD_INCREMENT_MAX_PAGE,
  PDD_INCREMENT_PAGE_SIZE,
  PDD_ORDER_DETAIL,
  PDD_ORDER_INCREMENT,
  PDD_ORDER_RANGE,
  pddRowIdentity,
  rangeCursor,
  rangeWindow,
} from './orders.ts';
import {
  convertGoodsSign,
  mapAuthorized,
  mapAuthorityUrl,
  mapConvertResult,
  pddIdentityParameters,
  PDD_AUTHORITY_CHANNEL,
  PDD_AUTHORITY_QUERY,
  PDD_PROMOTION_URL_GENERATE,
  PDD_RP_PROM_URL_GENERATE,
} from './promotion.ts';

export interface PddCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export type { PddQueryIdentity } from './goods.ts';

export interface PddAdapterOptions {
  readonly credentials: () => Promise<PddCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: PddWarning) => void;
  /**
   * 查询身份提供者（D-u2 / B1-04x）：每次商品调用以当前 CallCtx 调用一次；装配方
   * （union.module.ts）只读 ctx.appId 取该 app 的 active 查询推广位，custom_parameters 来自服务端配置。
   */
  readonly queryIdentity?: (ctx: CallCtx) => Promise<PddQueryIdentity>;
}

/** 公共参数名；业务参数不得占用（4_PDD_附 §3.2）。 */
const PUBLIC_PARAMETERS: ReadonlySet<string> = new Set([
  'type',
  'client_id',
  'timestamp',
  'sign',
  'data_type',
]);

type WireValue = string | number | boolean;

/**
 * B1-04p：每次上游请求的归档用途（union_raw_payloads.kind）。订单类 = order，转链 = convert，
 * 备案查询与备案链接 = authority，其余（商品、短链展开、推广位等）= query。
 */
const ORDER_METHODS: ReadonlySet<string> = new Set([
  PDD_ORDER_INCREMENT,
  PDD_ORDER_RANGE,
  PDD_ORDER_DETAIL,
]);
const AUTHORITY_METHODS: ReadonlySet<string> = new Set([
  PDD_AUTHORITY_QUERY,
  PDD_RP_PROM_URL_GENERATE,
]);

export function pddArchiveKind(method: string): string {
  if (ORDER_METHODS.has(method)) return 'order';
  if (method === PDD_PROMOTION_URL_GENERATE) return 'convert';
  if (AUTHORITY_METHODS.has(method)) return 'authority';
  return 'query';
}

/** 调用上下文的 app（服务端注入的 ctx.appId）与该方法的用途；没有 app 时不带归档上下文。 */
/** B1-04zv：一页订单行；ctx.rowErrors 为 collect 时 mapper 拒绝的行进 rejected，否则整页报错。 */
function orderRows(
  rows: readonly unknown[],
  source: PddOrderSource,
  meta: PddOrderPage,
  ctx: CallCtx,
): Pick<OrderPage, 'items' | 'rejected'> {
  const map = (row: unknown): UnionOrder => mapPddOrder(row, source, meta);
  return ctx?.rowErrors === 'collect'
    ? collectOrderRows(rows, meta.rawPayloadId, map, pddRowIdentity)
    : { items: rows.map(map) };
}

function archiveContext(method: string, ctx: CallCtx | undefined): ArchiveContext | undefined {
  const appId = ctx?.appId;
  return typeof appId === 'string' ? { appId, kind: pddArchiveKind(method) } : undefined;
}

/** 订单接口的一次上游请求（B1-04w：见 PddUnionAdapter#orderSender）。 */
type OrderSender = (method: string, parameters: PddParameters) => Promise<OrderReply>;

/** B1-08e：订单接口一次响应解出的信封，与这页报文的元数据（归档行 id）。 */
interface OrderReply {
  readonly envelope: unknown;
  readonly page: PddOrderPage;
}

// B1-22p：按物料频道取类目 / 榜单（channelCategories / channelRanking）不实现：频道参数、类目与排序
// 依据未实测，端口按联盟故障（upstream_unavailable）答，不发请求、不取凭据、不伪造报文。
// TODO(规划/09 CAP-TB-10、CAP-JD-10、CAP-PDD-10): 按频道取榜单 — blocked on 联盟接口实测记录
export class PddUnionAdapter implements UnionAdapter {
  readonly platform = 'pdd' as const;
  /**
   * B1-04w：listOrders 一次调用会发多次上游请求（探尾页 + 倒序翻页），每次实际请求都经
   * CallCtx.gateUpstream 各自计量（治理包装据此不再在外层整体扣一个 token）。
   */
  readonly listOrdersMetering = 'per_request' as const;
  readonly #credentials: () => Promise<PddCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: PddWarning) => void) | undefined;
  readonly #queryIdentity: ((ctx: CallCtx) => Promise<PddQueryIdentity>) | undefined;

  constructor(options: PddAdapterOptions) {
    if (options.endpoint.platform !== 'pdd') {
      throw new UnionError('invalid_endpoint', 'pdd adapter: endpoint is not for pdd', 'pdd');
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
    this.#queryIdentity = options.queryIdentity;
  }

  /**
   * Internal request foundation; not exported through the union module's public port. The
   * optional `archive` (B1-04p) rides on the transport request for the archiving transport only;
   * a direct call without it sends no archive context.
   */
  async request(
    method: string,
    parameters: PddParameters,
    signal?: AbortSignal,
    archive?: ArchiveContext,
  ): Promise<unknown> {
    return unwrapPddResponse(
      method,
      await this.#send(method, parameters, signal, archive),
      this.#warn,
    );
  }

  /** 公开端口的请求：带上 ctx.appId 与该方法的归档用途。 */
  #call(method: string, parameters: PddParameters, ctx: CallCtx): Promise<unknown> {
    return this.request(method, parameters, ctx?.signal, archiveContext(method, ctx));
  }

  /**
   * B1-04w：订单接口的请求。错误分类与外层键照 request 判，订单行另从原始 JSON 文本二次解析，
   * 使 goods_id 无损（parsePddOrderEnvelope）。
   */
  async #requestOrders(
    method: string,
    parameters: PddParameters,
    signal: AbortSignal | undefined,
    archive: ArchiveContext | undefined,
  ): Promise<OrderReply> {
    const response = await this.#send(method, parameters, signal, archive);
    unwrapPddResponse(method, response, this.#warn);
    const envelope = parsePddOrderEnvelope(response.body, pddEnvelopeKey(method)!);
    // B1-08e：归档行 id 只取传输回传的元数据（十进制字符串），不读报文里的同名值。
    const id: unknown = Reflect.get(response, 'raw_payload_id');
    const rawPayloadId = typeof id === 'string' && /^[0-9]+$/.test(id) ? id : null;
    return { envelope, page: { rawPayloadId, like: this.#clock.now() } };
  }

  /** 签名并发送；返回未解包的原始响应。 */
  async #send(
    method: string,
    parameters: PddParameters,
    signal: AbortSignal | undefined,
    archive: ArchiveContext | undefined,
  ): Promise<UnionTransportResponse> {
    // 先做不需要凭据的同步检查，再取凭据：取凭据之前不 await 别的东西。
    if (pddEnvelopeKey(method) === undefined) {
      throw new UnionError('adapter_unimplemented', `pdd ${method}: not implemented`, 'pdd');
    }
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError('invalid_endpoint', 'pdd adapter: no gateway URL configured', 'pdd');
    }
    const business = this.#businessParameters(method, parameters);
    const { clientId, clientSecret } = await this.#credentials();

    const unsigned: Record<string, WireValue> = {
      ...business,
      type: method,
      client_id: clientId,
      timestamp: String(Math.floor(this.#clock.now().getTime() / 1000)),
      data_type: 'JSON',
    };
    const body = JSON.stringify({ ...unsigned, sign: signPddParameters(unsigned, clientSecret) });

    try {
      return await this.#transport({
        platform: 'pdd',
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        ...(signal === undefined ? {} : { signal }),
        ...(archive === undefined ? {} : { archive }),
      });
    } catch (error) {
      if (error instanceof UnionError) throw error;
      // 未知传输错误不带原文与 cause，避免请求内容进入错误信息。
      throw new UnionError('upstream_unavailable', `pdd ${method}: transport failed`, 'pdd');
    }
  }

  /** Business parameters on the wire: structured values become the compact strings they sign as. */
  #businessParameters(method: string, parameters: PddParameters): Record<string, WireValue> {
    const wire: Record<string, WireValue> = {};
    for (const name of Object.keys(parameters)) {
      if (PUBLIC_PARAMETERS.has(name)) {
        throw new UnionError('invalid_dto', `pdd ${method}: reserved parameter ${name}`, 'pdd');
      }
      const value = parameters[name]!;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new UnionError('invalid_dto', `pdd ${method}: non-finite parameter ${name}`, 'pdd');
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        wire[name] = value;
      } else if (value === null || value === undefined) {
        throw new UnionError('invalid_dto', `pdd ${method}: empty parameter ${name}`, 'pdd');
      } else {
        wire[name] = pddParameterText(value);
      }
    }
    return wire;
  }

  /**
   * D-u2：每次商品调用读一次查询身份并校验；未注入报 upstream_rejected，非法报 invalid_identity，
   * 两者都不取凭据、不发请求。身份只来自服务端提供者：适配器只把 ctx 原样交给提供者（B1-04x，
   * 提供者只用 ctx.appId 选推广位），自己不从 ctx（headers 等）取 pid 或 custom_parameters。
   */
  async #identity(
    port: string,
    ctx: CallCtx,
  ): Promise<{ readonly pid: string; readonly custom_parameters: string }> {
    if (this.#queryIdentity === undefined) {
      throw new UnionError('upstream_rejected', `pdd ${port}: no query identity configured`, 'pdd');
    }
    return checkQueryIdentity(await this.#queryIdentity(ctx));
  }

  #onAnomaly(method: string): () => void {
    return () =>
      this.#warn?.({ error_code: 'PRICE_ANOMALY', event: 'PRICE_ANOMALY', type: method });
  }

  #mapRows(rows: readonly unknown[], source: PddGoodsSource, method: string): UnionItem[] {
    const now = this.#clock.now();
    return rows.map((row) => mapPddGoods(row, source, now, this.#onAnomaly(method)));
  }

  /**
   * goods.search：keyword 原样传送，page 从 1 开始，page_size 固定 PDD_SEARCH_PAGE_SIZE。
   * 游标 `pdd-search:<page>:<list_id base64url>`（见 goods.ts），续页带 list_id；满页且未到 total_count 才给下一页。
   * 价格异常的商品照样返回（price_status='anomaly'），出不出卡由 catalog 决定。
   */
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    if (typeof q?.keyword !== 'string' || q.keyword.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd searchItems: keyword is blank', 'pdd');
    }
    const cursor = q.cursor === undefined ? undefined : parseSearchCursor(q.cursor);
    const identity = await this.#identity('searchItems', ctx);
    const page = cursor?.page ?? 1;
    const envelope = await this.#call(
      PDD_GOODS_SEARCH,
      {
        keyword: q.keyword,
        page,
        page_size: PDD_SEARCH_PAGE_SIZE,
        ...(cursor?.listId == null ? {} : { list_id: cursor.listId }),
        ...identity,
      },
      ctx,
    );
    const rows = goodsRows(envelope, 'search');
    const items = this.#mapRows(rows, 'search', PDD_GOODS_SEARCH);
    const total = envelopeCount(envelope, 'total_count');
    const more =
      rows.length >= PDD_SEARCH_PAGE_SIZE &&
      (total === null || page * PDD_SEARCH_PAGE_SIZE < total);
    const listId = envelopeListId(envelope) ?? cursor?.listId ?? null;
    return { items, nextCursor: more ? searchCursor(page + 1, listId) : null };
  }

  /** goods.detail：只按 goods_sign 请求（不传 goods_id）；空 goods_details 报 item_unavailable。 */
  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const sign = ref?.goods_sign;
    if (ref?.platform !== 'pdd' || typeof sign !== 'string' || sign.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd getItem: goods_sign is required', 'pdd');
    }
    const identity = await this.#identity('getItem', ctx);
    const envelope = await this.#call(PDD_GOODS_DETAIL, { goods_sign: sign, ...identity }, ctx);
    const rows = goodsRows(envelope, 'detail');
    if (rows.length === 0) {
      throw new UnionError('item_unavailable', 'pdd getItem: no goods detail returned', 'pdd');
    }
    return mapPddGoods(rows[0], 'detail', this.#clock.now(), this.#onAnomaly(PDD_GOODS_DETAIL));
  }

  /**
   * 链接识别：先以原链接作 goods.search keyword（probe：商品链接与进宝短链都能识别）；无结果且是
   * http(s) 链接时，用 url.short.parse 展开一次（参数 original_url，与 probe 一致；不带查询身份），
   * 展开结果非空且不同于原链接才再搜一次。最多 3 次请求。身份只取响应的 goods_id + goods_sign，
   * 不从 URL 数字补出。网关错误原样上抛；只有短链展开被平台拒绝（upstream_rejected）时视为识别不了。
   */
  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new UnionError('link_unrecognized', 'pdd resolveLink: empty link', 'pdd');
    }
    const link = raw.trim();
    const identity = await this.#identity('resolveLink', ctx);
    const find = async (keyword: string): Promise<ResolvedLink | null> => {
      const envelope = await this.#call(
        PDD_GOODS_SEARCH,
        { keyword, page: 1, page_size: PDD_SEARCH_PAGE_SIZE, ...identity },
        ctx,
      );
      const rows = goodsRows(envelope, 'search');
      return rows.length === 0 ? null : { item: pddGoodsRef(rows[0]) };
    };
    const direct = await find(link);
    if (direct !== null) return direct;
    if (/^https?:\/\//i.test(link)) {
      let expanded: string | null = null;
      try {
        const envelope = await this.#call(PDD_URL_SHORT_PARSE, { original_url: link }, ctx);
        const value =
          typeof envelope === 'object' && envelope !== null
            ? (envelope as Record<string, unknown>).url
            : undefined;
        expanded = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      } catch (error) {
        if (!(error instanceof UnionError) || error.code !== 'upstream_rejected') throw error;
      }
      if (expanded !== null && expanded !== link) {
        const second = await find(expanded);
        if (second !== null) return second;
      }
    }
    throw new UnionError('link_unrecognized', 'pdd resolveLink: no goods recognized', 'pdd');
  }

  /**
   * goods.recommend.get：固定精选 channel_type=4（PDD_FEED_CHANNEL），offset / limit 分页；
   * 游标 `pdd-feed:<offset>`（recommend 的 probe 响应没有 list_id）。满页且未到 total 才给下一页。
   */
  async materialFeed(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>> {
    const offset = req?.cursor === undefined ? 0 : parseFeedCursor(req.cursor);
    const identity = await this.#identity('materialFeed', ctx);
    const envelope = await this.#call(
      PDD_GOODS_RECOMMEND,
      { channel_type: PDD_FEED_CHANNEL, offset, limit: PDD_FEED_LIMIT, ...identity },
      ctx,
    );
    const rows = goodsRows(envelope, 'feed');
    const items = this.#mapRows(rows, 'feed', PDD_GOODS_RECOMMEND);
    const total = envelopeCount(envelope, 'total');
    const more =
      rows.length >= PDD_FEED_LIMIT && (total === null || offset + PDD_FEED_LIMIT < total);
    return { items, nextCursor: more ? feedCursor(offset + PDD_FEED_LIMIT) : null };
  }

  /**
   * goods.promotion.url.generate：一次 1 个 goods_sign，p_id = identity.promotionSlot，固定单人团
   * multi_group=false（BR-PRICE-02 细则 G-48），请求 scheme 与短链（与 probe 一致）。
   * 这是写操作：治理层不重试，适配器也不重试（02 §6.2）；未备案 50001 / 60001 → upstream_rejected，
   * 错误信息带 sub_code，由 linking 按「未备案」处理。
   */
  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    const goodsSign = convertGoodsSign(req?.item);
    const { promotionSlot, customParameters } = pddIdentityParameters(identity, 'convert');
    const envelope = await this.#call(
      PDD_PROMOTION_URL_GENERATE,
      {
        p_id: promotionSlot,
        goods_sign_list: [goodsSign],
        custom_parameters: customParameters,
        multi_group: false,
        generate_schema_url: true,
        generate_short_url: true,
      },
      ctx,
    );
    return mapConvertResult(envelope);
  }

  /** member.authority.query：pid = identity.promotionSlot（备案按推广位分开，D-u3）；bind 为整数 1 才算已备案。 */
  async queryPddAuthority(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthority> {
    const { promotionSlot, customParameters } = pddIdentityParameters(
      identity,
      'queryPddAuthority',
    );
    const envelope = await this.#call(
      PDD_AUTHORITY_QUERY,
      { pid: promotionSlot, custom_parameters: customParameters },
      ctx,
    );
    return { authorized: mapAuthorized(envelope) };
  }

  /**
   * rp.prom.url.generate channel_type=10：备案链接必须用转链所用的那个推广位生成
   * （p_id_list 只含 identity.promotionSlot），否则用户备案后转链仍报 60001。只请求 scheme 版
   * （probe 的 scheme 与短链是分开两次调用，未验证同时请求）；短链版字段若出现也照样映射。
   */
  async pddAuthorityUrl(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthorityUrl> {
    const { promotionSlot, customParameters } = pddIdentityParameters(identity, 'pddAuthorityUrl');
    const envelope = await this.#call(
      PDD_RP_PROM_URL_GENERATE,
      {
        channel_type: PDD_AUTHORITY_CHANNEL,
        p_id_list: [promotionSlot],
        custom_parameters: customParameters,
        generate_schema_url: true,
      },
      ctx,
    );
    return mapAuthorityUrl(envelope);
  }

  /**
   * 不传 queryMode = increment（按更新时间，倒序翻页）；pay_time 按支付时间用 last_order_id 迭代。
   * 时间窗与游标在取凭据、发请求之前校验，不合法报 invalid_dto。游标编码见 orders.ts。
   * B1-04zv：ctx.rowErrors 为 collect 时，mapper 拒绝的行进 rejected，其余行与游标照常。
   */
  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<OrderPage> {
    const mode = opt?.queryMode ?? 'increment';
    const send = this.#orderSender(ctx);
    if (mode === 'pay_time') return await this.#listByPayTime(win, opt.cursor, send, ctx);
    if (mode !== 'increment') {
      throw new UnionError('invalid_dto', 'pdd listOrders: unknown queryMode', 'pdd');
    }
    return await this.#listIncrement(win, opt?.cursor, send, ctx);
  }

  /**
   * B1-04w：listOrders 的每次上游请求。经治理包装时走 ctx.gateUpstream（每次实际请求扣一个
   * token、单独超时与重试，取消信号是该次尝试的）；直接构造、没有回调时用 ctx.signal 直接发。
   * 缓存命中的页不再经过这里，所以不重复计量。
   */
  #orderSender(ctx: CallCtx): OrderSender {
    const gate: UpstreamGate | undefined = ctx?.gateUpstream;
    if (gate === undefined) {
      return (method, parameters) =>
        this.#requestOrders(method, parameters, ctx?.signal, archiveContext(method, ctx));
    }
    return (method, parameters) =>
      gate((signal) =>
        this.#requestOrders(method, parameters, signal, archiveContext(method, ctx)),
      );
  }

  async #listIncrement(
    win: TimeWindow,
    cursor: string | undefined,
    send: OrderSender,
    ctx: CallCtx,
  ): Promise<OrderPage> {
    const window = incrementWindow(win, this.#clock.now().getTime());
    // 缓存的是该页实际取回的那次响应：行与那次响应的归档行 id 一起，命中时不重新计量。
    interface FetchedPage {
      readonly rows: readonly unknown[];
      readonly meta: PddOrderPage;
    }
    const fetched = new Map<number, FetchedPage>();
    const fetchPage = async (page: number): Promise<FetchedPage> => {
      const cached = fetched.get(page);
      if (cached !== undefined) return cached;
      const reply = await send(PDD_ORDER_INCREMENT, {
        ...window,
        page,
        page_size: PDD_INCREMENT_PAGE_SIZE,
        return_count: false,
      });
      const result: FetchedPage = { rows: orderList(reply.envelope), meta: reply.page };
      fetched.set(page, result);
      return result;
    };
    const pageOf = (page: number, result: FetchedPage): OrderPage => ({
      ...orderRows(result.rows, 'increment', result.meta, ctx),
      nextCursor: page > 1 ? incrementCursor(page - 1) : null,
    });

    if (cursor !== undefined) {
      const page = parseIncrementCursor(cursor);
      return pageOf(page, await fetchPage(page));
    }
    // 首次调用：不依赖 total_count，先倍增再二分探出最后一个非空页，从它开始往回取。
    const full = async (page: number): Promise<boolean> =>
      (await fetchPage(page)).rows.length >= PDD_INCREMENT_PAGE_SIZE;
    if (!(await full(1))) return pageOf(1, await fetchPage(1));
    let lo = 1; // 已知满页
    let hi: number; // 已知不满（含空）的页
    for (;;) {
      if (lo >= PDD_INCREMENT_MAX_PAGE) {
        throw new UnionError(
          'invalid_dto',
          'pdd listOrders: increment window exceeds the page limit; split it',
          'pdd',
        );
      }
      const probe = Math.min(lo * 2, PDD_INCREMENT_MAX_PAGE);
      if (await full(probe)) {
        lo = probe;
      } else {
        hi = probe;
        break;
      }
    }
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (await full(mid)) lo = mid;
      else hi = mid;
    }
    const tail = (await fetchPage(hi)).rows.length > 0 ? hi : lo;
    return pageOf(tail, await fetchPage(tail));
  }

  async #listByPayTime(
    win: TimeWindow,
    cursor: string | undefined,
    send: OrderSender,
    ctx: CallCtx,
  ): Promise<OrderPage> {
    const window = rangeWindow(win);
    const token = cursor === undefined ? undefined : parseRangeCursor(cursor);
    const { envelope, page } = await send(PDD_ORDER_RANGE, {
      ...window,
      ...(token === undefined ? {} : { last_order_id: token }),
    });
    const rows = orderList(envelope);
    const next = lastOrderId(envelope);
    // 空批、没有迭代器、或迭代器原样不变都结束，避免死循环。空批看报文行数：一批全坏时 items 也是空的。
    const done = rows.length === 0 || next === null || next === token;
    return {
      ...orderRows(rows, 'range', page, ctx),
      nextCursor: done ? null : rangeCursor(next),
    };
  }

  /** order.detail.get：按 order_sn 查一单，补售后状态 return_status；空白订单号不发请求。 */
  async getPddOrderDetail(orderSn: string, ctx: CallCtx): Promise<UnionOrder> {
    if (typeof orderSn !== 'string' || orderSn.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd getPddOrderDetail: order_sn is blank', 'pdd');
    }
    const { envelope, page } = await this.#requestOrders(
      PDD_ORDER_DETAIL,
      { order_sn: orderSn },
      ctx?.signal,
      archiveContext(PDD_ORDER_DETAIL, ctx),
    );
    return mapPddOrder(envelope, 'detail', page);
  }
}
