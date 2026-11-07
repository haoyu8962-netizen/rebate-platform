// Governance wiring of a union adapter (规划/02 §6.2): every call runs through the
// platform/http Governor with the union policy. Online calls (3 s) and offline calls (order
// sync, pool refresh, reminders: 10 s) use two governors because the time limit is per
// governor; each keeps its own breaker, shared by every method of that class. Idempotent reads
// retry; writes (convert, convertShop, bindPublisher, createTaolijin) never do — the client
// replays the same idempotency key instead. The quota limiter is shared and takes one token per attempt
// for the call's purpose; its bucket key comes from configuration (CAP-*-12 decide the unit).
// B1-22v: the limiter may answer with a promise (app.module's shared Redis bucket); the governor
// awaits it before each attempt, here and for every gated request of B1-04w, and a refusal or a
// failed answer ends the call with quota_exceeded.
// Business refusals from the adapter (UnionError with a business code) are classified
// `rejected`: not retried and not counted by the breaker; only timeouts, upstream throttling,
// network and 5xx failures are.
// B1-04w: an adapter that declares `listOrdersMetering: 'per_request'` (the live Pinduoduo
// adapter: tail-page probing plus reverse paging) gets no outer governance for listOrders;
// instead it receives `CallCtx.gateUpstream`, and every upstream request it actually sends
// runs through the same offline governor: one token per attempt, a per-request timeout, retries
// of that request only. A local quota refusal ends the whole traversal with `quota_exceeded`
// (nothing replayed, nothing counted by the breaker). The traversal as a whole has no time
// limit here: its duration is bounded by the caller (order-sync), which may abort between
// requests with its own `ctx.signal`. Every other operation, and listOrders of an adapter that
// does not declare it, keeps one token per attempt of the whole call.
// B1-04z: the same per-request metering for listRefunds / listPunishments of an adapter that
// declares `listRefundsMetering` / `listPunishmentsMetering: 'per_request'` (the Taobao adapter
// over 大淘客). Their third argument (cursor, Taobao timeBasis) is passed through as given.
// B1-14d: the online governor takes its whole policy (timeout, retries, breaker) from the public
// resilience registry row `union.search` (规划/02 §14; default `unionPolicy('online')`), read once
// when the adapter is assembled. The registry has no offline row, so the offline governor keeps
// `unionPolicy('offline')`. A breaker that is open fails the call with
// `GovernanceError('circuit_open')` before anything is sent; catalog / linking own the degrade.
// TODO(规划/11 §4.5): app.module 按配置传登记表覆盖 — blocked on 配置项未定（B1-14d 只接登记表默认值）
import {
  createGovernor,
  createResilienceRegistry,
  unionPolicy,
  type CallKind,
  type Governor,
  type QuotaLimiter,
  type ResilienceRegistry,
  type Scheduler,
} from '../../platform/index.ts';
import {
  classifyUnionError,
  isServerIdentity,
  UnionError,
  type CallCtx,
  type ShopConvertReq,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UpstreamGate,
} from '../domain/types.ts';

export interface GovernedAdapterOptions {
  readonly endpoint: UnionEndpoint;
  readonly scheduler: Scheduler;
  /** Must match endpoint.quotaKey. Shared instances allow account-wide quota sharing. */
  readonly quota: QuotaLimiter;
  /**
   * B1-14d: source of the online policy (row `union.search`). Absent: the registry defaults,
   * which equal `unionPolicy('online')`.
   */
  readonly resilience?: ResilienceRegistry;
}

/** Wraps every supported operation; optional operations the adapter lacks stay absent. */
export function createGovernedAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): UnionAdapter {
  return governAdapter(adapter, options).adapter;
}

/**
 * B1-08n: the governed adapter together with its two governors, for callers inside union that
 * must read a breaker (order-sync-ports.ts createGovernedSyncAdapter). Same wrapping as
 * createGovernedAdapter; nothing here starts a timer or calls the adapter.
 */
export function governAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): {
  readonly adapter: UnionAdapter;
  readonly governors: Readonly<Record<'online' | 'offline', Governor>>;
} {
  const { endpoint, scheduler, quota, resilience } = options;
  if (adapter.platform !== endpoint.platform) {
    throw new UnionError(
      'invalid_endpoint',
      `Endpoint for ${endpoint.platform} cannot govern the ${adapter.platform} adapter`,
      adapter.platform,
    );
  }
  if (quota.bucketKey !== endpoint.quotaKey) {
    throw new UnionError(
      'invalid_endpoint',
      `Quota bucket does not match the configured key for ${endpoint.platform}`,
      endpoint.platform,
    );
  }
  const deps = { scheduler, quota };
  const onlinePolicy = (resilience ?? createResilienceRegistry()).entry('union.search').policy;
  const governors = {
    online: createGovernor(`union:${endpoint.platform}:online`, onlinePolicy, deps),
    offline: createGovernor(`union:${endpoint.platform}:offline`, unionPolicy('offline'), deps),
  };
  const governorFor = (ctx: CallCtx): Governor =>
    ctx.purpose === 'online' ? governors.online : governors.offline;

  /**
   * A copy of the caller's context; base URL and headers come from configuration. A caller's
   * signal and gateUpstream are never passed through (the wrapper supplies its own).
   */
  const baseCtx = (ctx: CallCtx): CallCtx => {
    const copy: { -readonly [K in keyof CallCtx]: CallCtx[K] } = {
      ...ctx,
      baseUrl: endpoint.baseUrl,
      headers:
        endpoint.mode === 'replay' && ctx.scenario !== undefined
          ? { 'X-Scenario': ctx.scenario }
          : {},
    };
    delete copy.signal;
    delete copy.gateUpstream;
    return copy;
  };
  const callCtx = (ctx: CallCtx, signal: AbortSignal): CallCtx => ({ ...baseCtx(ctx), signal });

  const run = <T>(
    kind: CallKind,
    ctx: CallCtx,
    operation: (governed: CallCtx) => Promise<T>,
  ): Promise<T> =>
    governorFor(ctx).call((signal) => operation(callCtx(ctx, signal)), {
      kind,
      purpose: ctx.purpose,
      classify: classifyUnionError,
    });

  /**
   * B1-04w: the context of an operation metered per request. Each gated request is one governed
   * call (idempotent read); the caller's own signal only stops the traversal between requests.
   */
  const perRequestCtx = (ctx: CallCtx): CallCtx => {
    const governor = governorFor(ctx);
    const caller = ctx.signal;
    const gateUpstream: UpstreamGate = (request) => {
      caller?.throwIfAborted();
      return governor.call(request, {
        kind: 'idempotent_read',
        purpose: ctx.purpose,
        classify: classifyUnionError,
      });
    };
    return { ...baseCtx(ctx), gateUpstream };
  };

  const {
    bindPublisher,
    listRefunds,
    listPunishments,
    materialFeed,
    channelCategories,
    channelRanking,
    createTaolijin,
    getPddOrderDetail,
    queryPddAuthority,
    pddAuthorityUrl,
    taobaoShareCode,
    shortenTaobaoUrl,
    convertShop,
  } = adapter;
  // B1-04zzt: the adapter's configured shop convert source, read once here.
  const shopConvertSources = adapter.shopConvertSources;
  const rightsSources =
    adapter.rightsSources === undefined
      ? undefined
      : {
          refunds: adapter.rightsSources.refunds,
          punishments: adapter.rightsSources.punishments,
        };

  const orderSources = adapter.orderSources;

  /** UnionIdentity is built only by linking on the server (BR-ATTR-05, BR-AI-03). */
  const assertIdentity = (identity: UnionIdentity, ctx: CallCtx, operation: string): void => {
    if (
      !isServerIdentity(identity) ||
      identity.claims.appId !== ctx.appId ||
      identity.claims.platform !== endpoint.platform
    ) {
      throw new UnionError(
        'invalid_identity',
        `${operation} requires a server-side identity of the same app and platform`,
        endpoint.platform,
      );
    }
  };
  const governed: UnionAdapter = {
    platform: adapter.platform,
    searchItems: (q, ctx) => run('idempotent_read', ctx, (c) => adapter.searchItems(q, c)),
    getItem: (ref, ctx) => run('idempotent_read', ctx, (c) => adapter.getItem(ref, c)),
    resolveLink: (raw, ctx) => run('idempotent_read', ctx, (c) => adapter.resolveLink(raw, c)),
    listOrders: (win, opt, ctx) =>
      adapter.listOrdersMetering === 'per_request'
        ? adapter.listOrders(win, opt, perRequestCtx(ctx))
        : run('idempotent_read', ctx, (c) => adapter.listOrders(win, opt, c)),
    async convert(req, identity, ctx) {
      assertIdentity(identity, ctx, 'convert');
      return await run('write', ctx, (c) => adapter.convert(req, identity, c));
    },
    // B1-04zzt (S-17 S17-u2, D10-806): a shop promotion link is a write of a server-built identity
    // of this app and platform, always on the online governor (quota purpose online), never retried.
    ...(convertShop === undefined
      ? {}
      : {
          async convertShop(req: ShopConvertReq, identity: UnionIdentity, ctx: CallCtx) {
            assertIdentity(identity, ctx, 'convertShop');
            const online: CallCtx = { ...ctx, purpose: 'online' };
            return await run('write', online, (c) => convertShop.call(adapter, req, identity, c));
          },
        }),
    ...(shopConvertSources === undefined ? {} : { shopConvertSources }),
    ...(bindPublisher === undefined
      ? {}
      : {
          bindPublisher: (req, ctx) =>
            run('write', ctx, (c) => bindPublisher.call(adapter, req, c)),
        }),
    // B1-04zza (money r1 S2 ①): the adapter's configured rights sources, read once here.
    ...(rightsSources === undefined ? {} : { rightsSources }),
    // B1-04zzb (D10-741 ③): the adapter's configured order source, read once here.
    ...(orderSources === undefined ? {} : { orderSources }),
    // B1-04z: `opt` goes through as given (and is left out when the caller left it out).
    ...(listRefunds === undefined
      ? {}
      : {
          listRefunds: (win, ctx, ...opt) =>
            adapter.listRefundsMetering === 'per_request'
              ? listRefunds.call(adapter, win, perRequestCtx(ctx), ...opt)
              : run('idempotent_read', ctx, (c) => listRefunds.call(adapter, win, c, ...opt)),
        }),
    ...(listPunishments === undefined
      ? {}
      : {
          listPunishments: (win, ctx, ...opt) =>
            adapter.listPunishmentsMetering === 'per_request'
              ? listPunishments.call(adapter, win, perRequestCtx(ctx), ...opt)
              : run('idempotent_read', ctx, (c) => listPunishments.call(adapter, win, c, ...opt)),
        }),
    ...(materialFeed === undefined
      ? {}
      : {
          materialFeed: (req, ctx) =>
            run('idempotent_read', ctx, (c) => materialFeed.call(adapter, req, c)),
        }),
    // B1-22p: material-channel categories and ranking pages are idempotent reads.
    ...(channelCategories === undefined
      ? {}
      : {
          channelCategories: (req, ctx) =>
            run('idempotent_read', ctx, (c) => channelCategories.call(adapter, req, c)),
        }),
    ...(channelRanking === undefined
      ? {}
      : {
          channelRanking: (req, ctx) =>
            run('idempotent_read', ctx, (c) => channelRanking.call(adapter, req, c)),
        }),
    ...(createTaolijin === undefined
      ? {}
      : {
          createTaolijin: (req, ctx) =>
            run('write', ctx, (c) => createTaolijin.call(adapter, req, c)),
        }),
    // B1-04i: the Pinduoduo order detail (after-sales status) is an idempotent read.
    ...(getPddOrderDetail === undefined
      ? {}
      : {
          getPddOrderDetail: (orderSn: string, ctx: CallCtx) =>
            run('idempotent_read', ctx, (c) => getPddOrderDetail.call(adapter, orderSn, c)),
        }),
    // B1-06v: the Pinduoduo authority query is an idempotent read of a server-built identity.
    ...(queryPddAuthority === undefined
      ? {}
      : {
          async queryPddAuthority(identity: UnionIdentity, ctx: CallCtx) {
            assertIdentity(identity, ctx, 'queryPddAuthority');
            return await run('idempotent_read', ctx, (c) =>
              queryPddAuthority.call(adapter, identity, c),
            );
          },
        }),
    // B1-04h: generating the PDD filing (channel_type=10) link creates no state on our side and
    // returns an equivalent link on repeat, so it is governed as an idempotent read.
    ...(pddAuthorityUrl === undefined
      ? {}
      : {
          async pddAuthorityUrl(identity: UnionIdentity, ctx: CallCtx) {
            assertIdentity(identity, ctx, 'pddAuthorityUrl');
            return await run('idempotent_read', ctx, (c) =>
              pddAuthorityUrl.call(adapter, identity, c),
            );
          },
        }),
    // B1-04l: a share code / short link of one of our own Taobao links creates no state on our
    // side and is equivalent on repeat, so both are governed as idempotent reads.
    ...(taobaoShareCode === undefined
      ? {}
      : {
          taobaoShareCode: (url: string, ctx: CallCtx) =>
            run('idempotent_read', ctx, (c) => taobaoShareCode.call(adapter, url, c)),
        }),
    ...(shortenTaobaoUrl === undefined
      ? {}
      : {
          shortenTaobaoUrl: (url: string, ctx: CallCtx) =>
            run('idempotent_read', ctx, (c) => shortenTaobaoUrl.call(adapter, url, c)),
        }),
  };
  return { adapter: Object.freeze(governed), governors };
}
