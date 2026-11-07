// Adapter registry. jd, pdd and taobao are pre-registered: there is no real recording,
// promotion slot or approved API yet (规划/09 §0.2 硬规则 3; 规划/11 §4.5), so a live or replay
// platform rejects every call with `adapter_unimplemented` instead of returning invented data.
// With endpoint options, a platform configured as mode=demo gets the DemoUnionAdapter (B1-04o);
// the endpoint set is validated again, so prod with any demo endpoint refuses to assemble.
// B1-04t: only when the caller passes `pddLive` (credentials provider + transport) does a pdd
// endpoint with mode=live get the real PddUnionAdapter of B1-04g, returned as is: governance is
// wrapped once by the existing caller (app.module.ts governedUnion), not here. Without `pddLive`,
// pdd live / replay stay `adapter_unimplemented`; which environments may pass `pddLive` is decided
// by union.module.ts. B1-04x: `pddLive.queryIdentity` (assembled by union.module.ts) is handed to
// the adapter as is; without it every goods call is refused `upstream_rejected` by the adapter.
// B1-04k: likewise only `taobaoLive` (credentials provider + transport) turns a taobao endpoint with
// mode=live into the real TaobaoUnionAdapter of B1-04j, returned as is; without it taobao live /
// replay stay `adapter_unimplemented`; union.module.ts decides which environments may pass it.
// B1-04e: `taobaoLive.orderSource` (大淘客 dependencies) becomes one DataokeClient over the registry
// clock, handed to that adapter as `orderSource`; without it the adapter gets none.
// B1-04d: `taobaoLive.convertSource` is handed to that adapter as is (default 'baichuan').
// B1-04zn (D10-530): likewise `taobaoLive.searchSource` / `orderSlots` / `orderWarn`; absent, the
// adapter options stay as before.
// B1-04zx (D10-582): likewise `taobaoLive.searchSlot` / `searchWarn`; absent, the adapter options
// stay as before and the official search stays `adapter_unimplemented`.
// B1-04zy (D10-582): likewise `taobaoLive.searchCounter` / `fallbackWarn`.
// B1-04ze: likewise only `jdLive` (credentials provider + transport) turns a jd endpoint with
// mode=live into the real JdUnionAdapter of B1-04za, returned as is; without it jd live / replay
// stay `adapter_unimplemented`; union.module.ts decides which environments may pass it.
// `jdLive.productKeyMode` (BR-PROD-03) is handed to the adapter as is.
// B1-22s: real jd / taobao adapters must not map UnionItemDetail image fields until tested; when
// wired they go through normalizeItemImages (domain/item-images.ts).
// TODO(规划/09 CAP-TB-02、CAP-JD-02、CAP-PDD-02): 商品素材图字段 — blocked on 联盟接口实测记录
import {
  REGISTERED_PLATFORMS,
  UnionError,
  type CallCtx,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../domain/types.ts';
import {
  DataokeClient,
  type DataokeCredentials,
  type DataokeRandom,
  type DataokeWarning,
} from './dataoke/dataoke-client.ts';
import { DemoUnionAdapter, type DemoUnionRegistryOptions } from './demo/demo-adapter.ts';
import { parseUnionEndpoints } from './endpoints.ts';
import { JdUnionAdapter, type JdCredentials, type JdWarning } from './jd/jd-adapter.ts';
import type { JdProductKeyMode } from './jd/orders.ts';
import { PddUnionAdapter, type PddCredentials, type PddQueryIdentity } from './pdd/pdd-adapter.ts';
import type { PddWarning } from './pdd/response.ts';
import type { UnionTransport } from './replay.ts';
import type { TaobaoSearchCounter } from './taobao/search-counter.ts';
import type { TaobaoSearchFallbackWarning } from './taobao/search-fallback.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoConvertSource,
  type TaobaoCredentials,
  type TaobaoOrderSlotReader,
  type TaobaoOrderWarning,
  type TaobaoOwnOrderReader,
  type TaobaoSearchSlotReader,
  type TaobaoSearchSource,
  type TaobaoSearchWarning,
  type TaobaoWarning,
} from './taobao/taobao-adapter.ts';

/** The real Pinduoduo adapter's injected dependencies (B1-04t); used only for mode=live. */
export interface PddLiveOptions {
  /** Hands out the credentials already read at startup; never reads a file or the environment. */
  readonly credentials: () => Promise<PddCredentials>;
  readonly transport: UnionTransport;
  readonly warn?: (event: PddWarning) => void;
  /** Query identity provider of the goods ports (B1-04x), called with the CallCtx of each call. */
  readonly queryIdentity?: (ctx: CallCtx) => Promise<PddQueryIdentity>;
}

/** The real Taobao adapter's injected dependencies (B1-04k); used only for mode=live. */
export interface TaobaoLiveOptions {
  /** Hands out the credentials already read at startup; never reads a file or the environment. */
  readonly credentials: () => Promise<TaobaoCredentials>;
  readonly transport: UnionTransport;
  readonly warn?: (event: TaobaoWarning) => void;
  /**
   * B1-04e (D10-486 ①): the 大淘客 order source. When given, the registry constructs one
   * DataokeClient from it (plus the registry clock) and hands it to TaobaoUnionAdapter as
   * `orderSource`; without it the adapter gets none. Never used for taobao replay / demo.
   */
  readonly orderSource?: TaobaoOrderSourceOptions;
  /**
   * B1-04d (D10-503 ①): handed to TaobaoUnionAdapter as `convertSource`; 'dataoke' converts
   * through the client built from `orderSource`. Absent (the default 'baichuan') or without
   * `orderSource`, taobao convert is unchanged.
   */
  readonly convertSource?: TaobaoConvertSource;
  /**
   * B1-04zn (D10-530): handed to TaobaoUnionAdapter as `searchSource` (B1-04zh); 'dataoke' searches
   * through the client built from `orderSource`. Absent (the default 'official') searches
   * officially when `searchSlot` is given (B1-04zx).
   */
  readonly searchSource?: TaobaoSearchSource;
  /** B1-04zx (D10-582): handed to TaobaoUnionAdapter as `searchSlot` (official search adzone). */
  readonly searchSlot?: TaobaoSearchSlotReader;
  /** B1-04zx: handed to TaobaoUnionAdapter as `searchWarn` (skipped official search rows). */
  readonly searchWarn?: (event: TaobaoSearchWarning) => void;
  /** B1-04zy (D10-582): handed to TaobaoUnionAdapter as `searchCounter`. */
  readonly searchCounter?: TaobaoSearchCounter;
  /** B1-04zy (D10-582): handed to TaobaoUnionAdapter as `fallbackWarn`. */
  readonly fallbackWarn?: (event: TaobaoSearchFallbackWarning) => void;
  /**
   * B1-04zn (D10-530): handed to TaobaoUnionAdapter as `orderSlots` (B1-04f): every Taobao PID of
   * ctx.appId in union_pids, retired ones included. Without it listOrders stays unimplemented.
   */
  readonly orderSlots?: TaobaoOrderSlotReader;
  /** B1-04zn: handed to TaobaoUnionAdapter as `orderWarn` (order mapping / slot-filter warnings). */
  readonly orderWarn?: (event: TaobaoOrderWarning) => void;
  /**
   * B1-04zzu (D10-796 ② 甲): handed to TaobaoUnionAdapter as `ownOrders` (the refund archive keeps
   * only 凑狸's stored orders). Absent, the refund archive is the body as received.
   */
  readonly ownOrders?: TaobaoOwnOrderReader;
}

/**
 * The DataokeClient dependencies of the Taobao order source (B1-04e). union.module.ts passes the
 * credentials read at startup (DATAOKE_APP_KEY / DATAOKE_APP_SECRET_FILE), its own archived HTTPS
 * transport (separate from taobao's), node:crypto randomInt, the fixed gateway
 * `https://openapi.dataoke.com` and a warn hook logging only path and code.
 */
export interface TaobaoOrderSourceOptions {
  /** Hands out the credentials already read at startup; never reads a file or the environment. */
  readonly credentials: () => Promise<DataokeCredentials>;
  readonly transport: UnionTransport;
  readonly random: DataokeRandom;
  /** Gateway origin, https only (tests pass a synthetic https address). */
  readonly baseUrl: string;
  readonly warn?: (event: DataokeWarning) => void;
}

/** The real Jingdong adapter's injected dependencies (B1-04ze); used only for mode=live. */
export interface JdLiveOptions {
  /** Hands out the credentials already read at startup; never reads a file or the environment. */
  readonly credentials: () => Promise<JdCredentials>;
  readonly transport: UnionTransport;
  readonly warn?: (event: JdWarning) => void;
  /** BR-PROD-03: read with ctx.appId on every listOrders; without it the adapter uses item. */
  readonly productKeyMode?: { read(appId: string): Promise<JdProductKeyMode> };
  /** D10-500 ①: handed to the adapter as is; without it convert is `adapter_unimplemented`. */
  readonly siteId?: string | null;
}

export interface UnionRegistryOptions extends DemoUnionRegistryOptions {
  readonly pddLive?: PddLiveOptions;
  readonly taobaoLive?: TaobaoLiveOptions;
  readonly jdLive?: JdLiveOptions;
}

export interface UnionRegistration {
  readonly platform: RegisteredPlatform;
  /**
   * True for a demo adapter and for the real pdd / taobao / jd adapter assembled through `pddLive` /
   * `taobaoLive` / `jdLive`.
   */
  readonly implemented: boolean;
}

export interface UnionRegistry {
  registrations(): readonly UnionRegistration[];
  get(platform: RegisteredPlatform): UnionAdapter;
}

function unimplementedAdapter(platform: RegisteredPlatform): UnionAdapter {
  const reject = (operation: string): Promise<never> =>
    Promise.reject(
      new UnionError(
        'adapter_unimplemented',
        `Union adapter for ${platform} is registered but not implemented (${operation})`,
        platform,
      ),
    );
  return Object.freeze({
    platform,
    searchItems: () => reject('searchItems'),
    getItem: () => reject('getItem'),
    resolveLink: () => reject('resolveLink'),
    convert: () => reject('convert'),
    listOrders: () => reject('listOrders'),
    // B1-06v: the Pinduoduo authority query is optional; the placeholder refuses it like the rest.
    // TODO(规划/11 §4.5): 真实备案查询 — blocked on CAP-PDD-05。
    ...(platform === 'pdd' ? { queryPddAuthority: () => reject('queryPddAuthority') } : {}),
    // B1-22p: channelCategories / channelRanking stay absent, so the ranking port answers a union
    // outage (upstream_unavailable) without any request.
    // TODO(规划/09 CAP-TB-10、CAP-JD-10、CAP-PDD-10): 按频道取榜单 — blocked on 联盟接口实测记录
  });
}

/**
 * Exactly jd, pdd and taobao registered. Without options every call rejects
 * `adapter_unimplemented`; with options, mode=demo endpoints get a demo adapter, and a pdd
 * endpoint with mode=live gets the real PddUnionAdapter when `pddLive` is given, a taobao endpoint
 * with mode=live the real TaobaoUnionAdapter when `taobaoLive` is given, a jd endpoint with
 * mode=live the real JdUnionAdapter when `jdLive` is given.
 */
export function createUnionRegistry(options?: UnionRegistryOptions): UnionRegistry {
  const demoPlatforms = new Set<RegisteredPlatform>();
  let pddLive: UnionAdapter | undefined;
  let taobaoLive: UnionAdapter | undefined;
  let jdLive: UnionAdapter | undefined;
  if (options !== undefined) {
    // Same validation as startup: incomplete sets, and demo / replay in prod, are refused.
    for (const endpoint of parseUnionEndpoints(options.endpoints, options.environment)) {
      if (endpoint.mode === 'demo') demoPlatforms.add(endpoint.platform);
      if (endpoint.platform === 'pdd' && endpoint.mode === 'live' && options.pddLive) {
        const live = options.pddLive;
        pddLive = new PddUnionAdapter({
          credentials: live.credentials,
          transport: live.transport,
          clock: options.clock,
          endpoint,
          ...(live.warn === undefined ? {} : { warn: live.warn }),
          ...(live.queryIdentity === undefined ? {} : { queryIdentity: live.queryIdentity }),
        });
      }
      if (endpoint.platform === 'taobao' && endpoint.mode === 'live' && options.taobaoLive) {
        const live = options.taobaoLive;
        // B1-04e: one 大淘客 client per taobao live adapter, over the registry clock.
        const source = live.orderSource;
        const orderSource =
          source === undefined
            ? undefined
            : new DataokeClient({
                credentials: source.credentials,
                transport: source.transport,
                clock: options.clock,
                random: source.random,
                baseUrl: source.baseUrl,
                ...(source.warn === undefined ? {} : { warn: source.warn }),
              });
        taobaoLive = new TaobaoUnionAdapter({
          credentials: live.credentials,
          transport: live.transport,
          clock: options.clock,
          endpoint,
          ...(live.warn === undefined ? {} : { warn: live.warn }),
          // B1-04l (D10-479): the same BR-PRICE-02 settings port the demo adapter gets.
          ...(options.taobaoPriceSettings === undefined
            ? {}
            : { priceSettings: options.taobaoPriceSettings }),
          ...(orderSource === undefined ? {} : { orderSource }),
          // B1-04d: the convert switch as is; the adapter only acts on it with an orderSource.
          ...(live.convertSource === undefined ? {} : { convertSource: live.convertSource }),
          // B1-04zn: the search switch, the order slot reader and the order warn hook as they are.
          ...(live.searchSource === undefined ? {} : { searchSource: live.searchSource }),
          // B1-04zx: the official search's slot reader and skip hook as they are.
          ...(live.searchSlot === undefined ? {} : { searchSlot: live.searchSlot }),
          ...(live.searchWarn === undefined ? {} : { searchWarn: live.searchWarn }),
          // B1-04zy: the search counter and the fallback warn hook as they are.
          ...(live.searchCounter === undefined ? {} : { searchCounter: live.searchCounter }),
          ...(live.fallbackWarn === undefined ? {} : { fallbackWarn: live.fallbackWarn }),
          ...(live.orderSlots === undefined ? {} : { orderSlots: live.orderSlots }),
          ...(live.orderWarn === undefined ? {} : { orderWarn: live.orderWarn }),
          // B1-04zzu: the refund archive's own-order lookup as it is.
          ...(live.ownOrders === undefined ? {} : { ownOrders: live.ownOrders }),
        });
      }
      if (endpoint.platform === 'jd' && endpoint.mode === 'live' && options.jdLive) {
        const live = options.jdLive;
        jdLive = new JdUnionAdapter({
          credentials: live.credentials,
          transport: live.transport,
          clock: options.clock,
          endpoint,
          ...(live.warn === undefined ? {} : { warn: live.warn }),
          ...(live.productKeyMode === undefined ? {} : { productKeyMode: live.productKeyMode }),
          // B1-04zd (D10-500 ①): as is; without it the adapter refuses convert.
          ...(live.siteId === undefined ? {} : { siteId: live.siteId }),
        });
      }
    }
  }
  const adapterFor = (platform: RegisteredPlatform): UnionAdapter => {
    if (platform === 'pdd' && pddLive !== undefined) return pddLive;
    if (platform === 'taobao' && taobaoLive !== undefined) return taobaoLive;
    if (platform === 'jd' && jdLive !== undefined) return jdLive;
    if (options !== undefined && demoPlatforms.has(platform)) {
      return new DemoUnionAdapter({
        platform,
        seed: options.seed,
        clock: options.clock,
        environment: options.environment,
        ...(options.warn === undefined ? {} : { warn: options.warn }),
        ...(options.taobaoPriceSettings === undefined
          ? {}
          : { taobaoPriceSettings: options.taobaoPriceSettings }),
      });
    }
    return unimplementedAdapter(platform);
  };
  const adapters = new Map<RegisteredPlatform, UnionAdapter>(
    REGISTERED_PLATFORMS.map((platform) => [platform, adapterFor(platform)]),
  );
  const registrations = Object.freeze(
    REGISTERED_PLATFORMS.map((platform) =>
      Object.freeze({
        platform,
        implemented:
          demoPlatforms.has(platform) ||
          (platform === 'pdd' && pddLive !== undefined) ||
          (platform === 'taobao' && taobaoLive !== undefined) ||
          (platform === 'jd' && jdLive !== undefined),
      }),
    ),
  );
  return {
    registrations: () => registrations,
    get(platform) {
      const adapter = adapters.get(platform);
      if (adapter === undefined) {
        throw new UnionError(
          'adapter_unimplemented',
          `No union adapter is registered for ${String(platform)}`,
        );
      }
      return adapter;
    },
  };
}
