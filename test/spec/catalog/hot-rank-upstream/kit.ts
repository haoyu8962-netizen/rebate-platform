// B1-28j rule-test kit: catalog's production hot list upstream (createUnionHotRankUpstream) over
// union's material-channel ranking port (B1-22p). The governed union is a call-recording double
// whose adapters return domain DTOs only: platform channel capabilities (规划/09 CAP-TB-10,
// CAP-JD-10, CAP-PDD-10) are not recorded, so no platform payload, channel id or field name is
// imitated. Whitelist entries are synthetic and handed in as the `channels` reader. Recorders are
// plain arrays, never vi.fn: a fixture per property run must not grow Vitest's mock registry
// (B1-28h ran out of heap that way).
import {
  createCatalogCardEntry,
  type CardQuoteContext,
  type RebateQuote,
  type RegisterLinkInput,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  getHotRank,
  type HotRankOptions,
  type HotRankQuery,
  type HotRankUpstream,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { cacheHotRankUpstream } from '../../../../apps/api/src/modules/catalog/infra/hot-rank-cache.ts';
import {
  createUnionHotRankUpstream,
  type UnionHotRankUpstreamOptions,
} from '../../../../apps/api/src/modules/catalog/infra/hot-rank-wiring.ts';
import type { PlatformRecord } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import type {
  CatalogConfigReader,
  GovernedUnion,
} from '../../../../apps/api/src/modules/catalog/ports.ts';
import {
  FixedClock,
  type MaterialChannelsSpec,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  CallCtx,
  ChannelCategoriesReq,
  ChannelRankingCategory,
  ChannelRankingEntry,
  ChannelRankingPage,
  ChannelRankingReq,
  Platform,
  RegisteredPlatform,
  UnionAdapter,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';

export const NOW = '2026-10-30T10:00:00.000Z';
/** The union's fetch time of the synthetic items; distinct from NOW (receivedAt). */
export const QUOTED_AT = '2026-10-30T09:58:00.000Z';
export const APP = 'synthetic_rank_wiring';
export const TB_CHANNEL = 'synthetic_tb_sales';
export const JD_CHANNEL = 'synthetic_jd_hot';
export const PDD_CHANNEL = 'synthetic_pdd_sales';
export const JD_MODE_KEY = 'product_key.jd.mode';
/** Contract HotRankData.items maxItems; the use case asks the union for pages of 20. */
export const PAGE_SIZE = 20;

export type ChannelEntry = MaterialChannelsSpec['channels'][number];

/** A synthetic whitelist entry (selectable sales channel by default); never a recorded channel. */
export function channel(
  platform: Platform,
  channelId: string,
  overrides: Partial<ChannelEntry> = {},
): ChannelEntry {
  return {
    platform,
    channel_id: channelId,
    name: `合成频道 ${channelId}`,
    sort_basis: 'sales',
    selectable: true,
    source: 'synthetic fixture, not a CAP record',
    ...overrides,
  };
}

export interface ItemOptions {
  readonly finalFen?: bigint;
  readonly commissionBp?: bigint;
  readonly quotedAt?: string;
}

type ItemIds = Pick<
  UnionItem,
  'platform' | 'item_id' | 'itemId' | 'skuId' | 'goods_id' | 'goods_sign'
>;

function priced(ids: ItemIds, title: string, options: ItemOptions): UnionItem {
  const final = options.finalFen ?? 1000n;
  return {
    ...ids,
    title,
    price_fen: final,
    coupon_fen: 0n,
    final_price_fen: final,
    commission_rate_bp: options.commissionBp ?? 1000n,
    quoted_at: options.quotedAt ?? QUOTED_AT,
  };
}

/** Taobao item: item_id `synthetic-<name>-<n>` (BR-PROD-03 stable id = the last `-` segment). */
export function tbItem(name: string, n: number, options: ItemOptions = {}): UnionItem {
  return priced(
    { platform: 'taobao', item_id: `synthetic-${name}-${String(n)}` },
    `synthetic-${name}`,
    options,
  );
}

/** JD item: itemId `synthetic_<n>` (item mode stable id `i_<n>`), skuId `sku<n>`. */
export function jdItem(name: string, n: number, options: ItemOptions = {}): UnionItem {
  return priced(
    { platform: 'jd', itemId: `synthetic_${String(n)}`, skuId: `sku${String(n)}` },
    `synthetic-${name}`,
    options,
  );
}

/** Pinduoduo item: goods_id `g<n>` (the key), goods_sign `sign-<n>` unless null (raw_item_id). */
export function pddItem(
  name: string,
  n: number,
  sign: string | null = `sign-${String(n)}`,
  options: ItemOptions = {},
): UnionItem {
  return priced(
    { platform: 'pdd', goods_id: `g${String(n)}`, goods_sign: sign },
    `synthetic-${name}`,
    options,
  );
}

export function position(item: UnionItem, salesText: string | null): ChannelRankingEntry {
  return { item, salesText };
}

export interface Call<R> {
  readonly req: R;
  readonly ctx: CallCtx;
}

export interface FakeAdapterSetup {
  readonly categories?: boolean;
  readonly ranking?: boolean;
}

/**
 * A call-recording adapter double of one platform. `categories: false` / `ranking: false` leave
 * out channelCategories / channelRanking (an adapter without the capability). Every other port
 * refuses and is recorded.
 */
export function fakeAdapter(platform: Platform, setup: FakeAdapterSetup = {}) {
  const categoryCalls: Call<ChannelCategoriesReq>[] = [];
  const rankingCalls: Call<ChannelRankingReq>[] = [];
  const otherCalls: string[] = [];
  const state: {
    categories: readonly ChannelRankingCategory[];
    page: ChannelRankingPage;
    failure: { readonly error: unknown } | null;
  } = {
    categories: [],
    page: { items: [], hasMore: false },
    failure: null,
  };
  const unexpected = (name: string) => async (): Promise<never> => {
    otherCalls.push(name);
    throw new Error(`synthetic adapter: unexpected ${name}`);
  };
  const adapter: UnionAdapter = {
    platform,
    searchItems: unexpected('searchItems'),
    getItem: unexpected('getItem'),
    resolveLink: unexpected('resolveLink'),
    convert: unexpected('convert'),
    listOrders: unexpected('listOrders'),
    materialFeed: unexpected('materialFeed'),
    ...(setup.categories === false
      ? {}
      : {
          async channelCategories(req: ChannelCategoriesReq, ctx: CallCtx) {
            categoryCalls.push({ req, ctx });
            if (state.failure !== null) throw state.failure.error;
            return state.categories;
          },
        }),
    ...(setup.ranking === false
      ? {}
      : {
          async channelRanking(req: ChannelRankingReq, ctx: CallCtx) {
            rankingCalls.push({ req, ctx });
            if (state.failure !== null) throw state.failure.error;
            return state.page;
          },
        }),
  };
  return {
    adapter,
    categoryCalls,
    rankingCalls,
    otherCalls,
    channelCalls: () => categoryCalls.length + rankingCalls.length,
    setCategories(list: readonly ChannelRankingCategory[]) {
      state.categories = list;
    },
    setPage(page: ChannelRankingPage) {
      state.page = page;
    },
    fail(error: unknown) {
      state.failure = { error };
    },
  };
}

export type FakeAdapter = ReturnType<typeof fakeAdapter>;

export function platformRow(code: string, keyPrefix: string | null): PlatformRecord {
  return {
    code,
    key_prefix: keyPrefix,
    key_stability: 'stable_7d',
    search_support: 'supported',
    convert_support: 'supported',
    order_sync_support: 'supported',
    stage: 'launched',
  };
}

/** Storage only: never expires rows, so freshness cannot rely on the physical TTL. */
export function memoryRedis() {
  const rows = new Map<string, string>();
  const redis: RedisNamespace = {
    get: async (key: string) => rows.get(key) ?? null,
    set: async (key: string, value: string, ttlSeconds: number) => {
      void ttlSeconds;
      rows.set(key, value);
    },
    eval: async () => {
      throw new Error('Unexpected Lua on the hot list cache');
    },
  };
  return { redis, rows };
}

export interface FixtureSetup {
  readonly whitelist?: readonly ChannelEntry[];
  readonly adapters?: Partial<Record<RegisteredPlatform, FakeAdapterSetup>>;
}

/** The governed union, platform rows, config, clock, whitelist reader and warn logger, recorded. */
export function fixture(setup: FixtureSetup = {}) {
  const clock = new FixedClock(NOW);
  let version = 1;
  let spec: MaterialChannelsSpec = {
    version: `synthetic-${String(version)}`,
    channels: [
      ...(setup.whitelist ?? [
        channel('taobao', TB_CHANNEL),
        channel('jd', JD_CHANNEL),
        channel('pdd', PDD_CHANNEL),
      ]),
    ],
  };
  const reads = { channels: 0 };
  const fakes = new Map<RegisteredPlatform, FakeAdapter>(
    (['taobao', 'jd', 'pdd'] as const).map((platform) => [
      platform,
      fakeAdapter(platform, setup.adapters?.[platform]),
    ]),
  );
  const lookups: string[] = [];
  const union: GovernedUnion = {
    adapter(platform: RegisteredPlatform): UnionAdapter {
      lookups.push(platform);
      const found = fakes.get(platform);
      if (found === undefined) throw new Error(`synthetic union: no adapter for ${platform}`);
      return found.adapter;
    },
  };
  let rows: PlatformRecord[] = [
    platformRow('taobao', 'tb'),
    platformRow('jd', 'jd'),
    platformRow('pdd', 'pdd'),
  ];
  const settings = new Map<string, string | number>();
  const config: CatalogConfigReader = {
    configValue: async (_appId: string, key: string) =>
      settings.has(key) ? { value: settings.get(key)!, version: 1 } : null,
  };
  const warnings: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  };
  const options: UnionHotRankUpstreamOptions = {
    union,
    catalog: { listPlatforms: async () => rows },
    config,
    clock,
    channels: () => {
      reads.channels += 1;
      return spec;
    },
    logger,
  };
  return {
    clock,
    options,
    reads,
    lookups,
    settings,
    warnings,
    fake(platform: RegisteredPlatform): FakeAdapter {
      const found = fakes.get(platform);
      if (found === undefined) throw new Error(`no fake adapter for ${platform}`);
      return found;
    },
    channelCalls(): number {
      return [...fakes.values()].reduce((sum, fake) => sum + fake.channelCalls(), 0);
    },
    setRows(list: readonly PlatformRecord[]) {
      rows = [...list];
    },
    setChannels(list: readonly ChannelEntry[]) {
      version += 1;
      spec = { version: `synthetic-${String(version)}`, channels: [...list] };
    },
    /** The object under test. */
    upstream(): HotRankUpstream {
      return createUnionHotRankUpstream(options);
    },
  };
}

export type Fixture = ReturnType<typeof fixture>;

export interface HotRankSetup {
  /** Wrap the wiring in cacheHotRankUpstream over this Redis. */
  readonly redis?: RedisNamespace;
  /** The use case's own whitelist reader; by default the wiring's. */
  readonly channels?: () => MaterialChannelsSpec;
}

/**
 * getHotRank over the wiring (optionally behind cacheHotRankUpstream with a memory Redis), with
 * the single card entry over synthetic quote and link stand-ins.
 */
export function hotRank(f: Fixture, setup: HotRankSetup = {}) {
  const viewer: Viewer = { appId: APP, userId: null, deviceId: 'synthetic-device' };
  const current = async () => viewer;
  let registered = 0;
  const entry = createCatalogCardEntry({
    clock: f.clock,
    viewerContext: { current },
    quoter: {
      quote: async (
        _item: UnionItem,
        _viewer: Viewer,
        context?: CardQuoteContext,
      ): Promise<RebateQuote> => ({
        // B1-05zc (D10-641): a pre-order quote is one amount (min = max), whatever the basis asked.
        rebateMinFen: 20n,
        rebateMaxFen: 20n,
        estNetPriceFen: null,
        rebateBasis: context?.rebateBasis ?? 'normal',
      }),
    },
    registrar: {
      register: async (input: RegisterLinkInput) => {
        void input;
        registered += 1;
        return { linkId: `00000000-0000-7000-8000-${String(registered).padStart(12, '0')}` };
      },
    },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'synthetic-item-ref' },
    logger: f.options.logger,
  });
  const wired = f.upstream();
  const upstream =
    setup.redis === undefined
      ? wired
      : cacheHotRankUpstream(wired, {
          redis: setup.redis,
          clock: f.clock,
          config: f.options.config,
        });
  const options: HotRankOptions = {
    clock: f.clock,
    viewerContext: { current },
    cards: entry,
    channels: setup.channels ?? f.options.channels,
    upstream,
    logger: f.options.logger,
  };
  return (query: Partial<HotRankQuery> = {}) =>
    getHotRank({ platform: 'taobao', ...query }, options);
}

export function pageRequest(
  overrides: Partial<Parameters<HotRankUpstream['page']>[0]> = {},
): Parameters<HotRankUpstream['page']>[0] {
  return {
    appId: APP,
    platform: 'taobao',
    channelId: TB_CHANNEL,
    categoryId: null,
    pageNo: 1,
    pageSize: PAGE_SIZE,
    ...overrides,
  };
}

/** The error an action ended with (a synchronous throw included); undefined when it resolved. */
export async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

/** `data` of a 50304 / 20001 failure, or undefined. */
export function dataOf(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
}

/** Everything a set of warnings carried, as text. */
export function warningText(warnings: readonly unknown[][]): string {
  return JSON.stringify(warnings, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
