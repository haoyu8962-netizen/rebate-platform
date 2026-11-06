// B1-28h public hot-sales list use case, GET /v1/rank/hot (contract getHotRank, CT-22c; 规划/01
// F-PROD-13; BR-TEXT-13, BR-TEXT-17 细则「联盟物料频道」). Rule tests: test/spec/catalog/hot-rank/**.
import type { components, operations } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import { GovernanceError, type Clock, type MaterialChannelsSpec } from '../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  isPlatform,
  type Platform,
  type UnionItem,
} from '../union/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import { CatalogError } from './domain/rules.ts';
import type { ProductRef } from './domain/types.ts';
import type { ViewerContext } from './ports.ts';

export type HotRankQuery = operations['getHotRank']['parameters']['query'];
export type HotRankData = components['schemas']['HotRankData'];

/** One category the channel offers, as the union side reports it. */
export interface HotRankCategoryEntry {
  readonly categoryId: string;
  readonly name: string;
}

/** One channel position: the normalized union item, its ref and the union's sales field as is. */
export interface HotRankCandidate {
  readonly item: UnionItem;
  readonly ref: ProductRef;
  /** The union's sales field unchanged; null when the union gives none. */
  readonly salesText: string | null;
}

export interface HotRankCategoriesRequest {
  readonly appId: string;
  readonly platform: Platform;
  readonly channelId: string;
}

export interface HotRankPageRequest extends HotRankCategoriesRequest {
  /** null for the whole list. */
  readonly categoryId: string | null;
  /** From 1. */
  readonly pageNo: number;
  readonly pageSize: number;
}

/** One channel page, in the channel's own order. */
export interface HotRankUpstreamPage {
  readonly items: readonly HotRankCandidate[];
  readonly hasMore: boolean;
  /**
   * As long as `items`: each one's position in this channel page, from 0 and strictly increasing.
   * Only on a page that lost positions upstream; without it a position is the index in `items`.
   */
  readonly positions?: readonly number[];
  /** Only on an old copy answered during a union failure (BR-PROD-07, infra/hot-rank-cache.ts). */
  readonly stale?: true;
}

/** Union seam of the hot list: one whitelisted channel, never the product pool. */
export interface HotRankUpstream {
  categories(input: HotRankCategoriesRequest): Promise<readonly HotRankCategoryEntry[]>;
  page(input: HotRankPageRequest): Promise<HotRankUpstreamPage>;
}

export interface HotRankOptions {
  readonly clock: Clock;
  readonly viewerContext: ViewerContext;
  readonly cards: CatalogCardEntry;
  /** Read before every fetch (production: platform's getMaterialChannels). */
  readonly channels: () => MaterialChannelsSpec;
  /** The cached union side (infra/hot-rank-cache.ts in production). */
  readonly upstream: HotRankUpstream;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Highest page number a cursor may carry (08 未定，技术取值): 50 pages of 20 is the first 1000
 * positions of a channel; no next_cursor is issued beyond it and a larger page_no is 20001.
 */
export const HOT_RANK_MAX_PAGE_NO = 50;
/** Contract HotRankData.items maxItems; there is no limit parameter. */
export const HOT_RANK_PAGE_SIZE = 20;
/** F-PROD-13 ③: only sales / popularity lists rank; 「猜你喜欢」一类 channels are not a hot list. */
/** links.entry_source of hot list cards (opaque text, like 'search'). */
const RANK_ENTRY_SOURCE = 'rank';
const RANK_SORT_BASES: ReadonlySet<string> = new Set(['sales', 'popularity']);

type ChannelEntry = MaterialChannelsSpec['channels'][number];

/** Cursor claims; the wire value is the base64url JSON of exactly these four keys. */
interface HotRankCursor {
  readonly platform: Platform;
  readonly channel_id: string;
  readonly category_id: string | null;
  readonly page_no: number;
}

const CURSOR_KEYS = ['category_id', 'channel_id', 'page_no', 'platform'];
const CURSOR_WIRE = /^[A-Za-z0-9_-]{1,512}$/;

function invalid(message: string): never {
  throw new CatalogError(20001, `rank: ${message}`);
}

function encodeCursor(cursor: HotRankCursor): string {
  return Buffer.from(
    JSON.stringify({
      platform: cursor.platform,
      channel_id: cursor.channel_id,
      category_id: cursor.category_id,
      page_no: cursor.page_no,
    }),
    'utf8',
  ).toString('base64url');
}

/** A cursor is exactly { platform, channel_id, category_id, page_no }; anything else is 20001. */
function decodeCursor(value: string): HotRankCursor {
  if (!CURSOR_WIRE.test(value)) invalid('malformed cursor');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalid('malformed cursor');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    invalid('malformed cursor');
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) {
    invalid('malformed cursor');
  }
  const record = payload as Record<string, unknown>;
  const { platform, channel_id: channelId, category_id: categoryId, page_no: pageNo } = record;
  if (typeof platform !== 'string' || !isPlatform(platform)) invalid('malformed cursor');
  if (typeof channelId !== 'string' || channelId === '') invalid('malformed cursor');
  if (categoryId !== null && (typeof categoryId !== 'string' || categoryId === '')) {
    invalid('malformed cursor');
  }
  if (
    typeof pageNo !== 'number' ||
    !Number.isSafeInteger(pageNo) ||
    pageNo < 2 ||
    pageNo > HOT_RANK_MAX_PAGE_NO
  ) {
    invalid('malformed cursor');
  }
  return { platform, channel_id: channelId, category_id: categoryId, page_no: pageNo };
}

/**
 * BR-TEXT-17 细则「取数时再查一次」: the platform's first selectable sales / popularity channel of the
 * whitelist as it is now. Entries of the platform that are listed but unusable are alerted, since
 * a channel turned off after a configuration was saved must not be fetched silently.
 */
function channelOf(
  platform: Platform,
  spec: MaterialChannelsSpec,
  logger: Pick<Logger, 'warn'>,
): ChannelEntry {
  const own = spec.channels.filter((entry) => entry.platform === platform);
  const usable = own.find((entry) => entry.selectable && RANK_SORT_BASES.has(entry.sort_basis));
  if (usable !== undefined) return usable;
  for (const entry of own) {
    logger.warn(
      {
        event: 'rank_channel_unusable',
        platform,
        channel_id: entry.channel_id,
        selectable: entry.selectable,
        sort_basis: entry.sort_basis,
        whitelist_version: spec.version,
      },
      'rank: whitelisted channel not usable for the hot list, not fetched',
    );
  }
  if (own.length === 0) {
    logger.warn(
      { event: 'rank_channel_missing', platform, whitelist_version: spec.version },
      'rank: no whitelisted channel for the platform',
    );
  }
  throw new CatalogError(50304, 'rank: no compliant channel', {
    platform,
    reason: 'rank_unavailable',
  });
}

/**
 * Union dependency failures map to 50304 without reason (retry later), never the product pool:
 * governance timeout / breaker / quota, UnionError upstream_unavailable / rate_limited and any
 * unknown throw. Business refusals (invalid_policy, other UnionError codes, demo or catalog
 * errors) keep their identity.
 */
function isUnionOutage(error: unknown): boolean {
  if (error instanceof GovernanceError) return error.code !== 'invalid_policy';
  if (error instanceof UnionError) {
    return error.code === 'upstream_unavailable' || error.code === 'rate_limited';
  }
  if (error instanceof DemoUnionError || error instanceof CatalogError) return false;
  return true;
}

/** Flat diagnostic fields of a swallowed error (no stack, no object dump). */
function errorFields(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      error_name: error.name,
      error_message: error.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { error_code: String(code) } : {}),
    };
  }
  return { error_name: typeof error, error_message: String(error) };
}

/**
 * Appends the cards of one channel page to `items` until it holds HOT_RANK_PAGE_SIZE, in channel
 * order, each ranked by its own channel position (`positions` when the upstream dropped some).
 * Positions the card entry skips or that come out as no_rebate for the current viewer (BR-PRICE-08)
 * leave their rank unused. Returns how many no_rebate cards were left out.
 */
async function collect(
  page: HotRankUpstreamPage,
  pageNo: number,
  items: HotRankData['items'],
  options: HotRankOptions,
): Promise<number> {
  const first = (pageNo - 1) * HOT_RANK_PAGE_SIZE;
  let filtered = 0;
  for (const [index, entry] of page.items.slice(0, HOT_RANK_PAGE_SIZE).entries()) {
    if (items.length >= HOT_RANK_PAGE_SIZE) break;
    const result = await options.cards.assemble({
      item: entry.item,
      ref: entry.ref,
      entrySource: RANK_ENTRY_SOURCE,
      stale: page.stale === true,
      scene: 'retrieval',
    });
    if (result.kind !== 'card') continue;
    if (result.card.rebate_basis === 'no_rebate') {
      filtered += 1;
      continue;
    }
    const position = page.positions?.[index] ?? index;
    items.push({
      rank: first + position + 1,
      sales_text: entry.salesText,
      product_card: result.card,
    });
  }
  return filtered;
}

/**
 * One page of the hot-sales list of a platform: a selectable whitelisted channel checked before
 * every fetch (none → 50304 rank_unavailable), its categories, items in channel order with rank
 * counted from 1 across pages, sales_text passed through, cards registering a link and quote
 * snapshot only; a union failure without a usable cache is 50304 without reason; a category not
 * offered or a malformed / foreign cursor is 20001.
 *
 * Order: whitelist (50304 rank_unavailable) → cursor (20001) → viewer → categories → category
 * (20001) → channel page → one card per position through the single card entry. A position the
 * card entry skips (price anomaly), the upstream dropped (D10-422 ②, `positions`) or that is
 * no_rebate for the viewer (BR-PRICE-08) leaves its rank number unused: ranks are the channel's own
 * positions, never renumbered. Only a page that lost a no_rebate card is refilled, once, from the
 * next channel page (its items ranked by their own positions); the cursor then points past it.
 */
export async function getHotRank(
  query: HotRankQuery,
  options: HotRankOptions,
): Promise<HotRankData> {
  const { platform } = query;
  const { logger, upstream } = options;
  const channel = channelOf(platform, options.channels(), logger);
  const channelId = channel.channel_id;
  const category = query.category ?? null;

  let pageNo = 1;
  if (query.cursor !== undefined) {
    const claims = decodeCursor(query.cursor);
    // A cursor of another platform, another channel (the whitelist changed) or another category
    // is foreign: the client starts the list again.
    if (
      claims.platform !== platform ||
      claims.channel_id !== channelId ||
      claims.category_id !== category
    ) {
      invalid('foreign cursor');
    }
    pageNo = claims.page_no;
  }

  const { appId } = await options.viewerContext.current();
  const fromUnion = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error: unknown) {
      if (!isUnionOutage(error)) throw error;
      logger.warn(
        {
          event: 'rank_union_unavailable',
          platform,
          channel_id: channelId,
          step,
          ...errorFields(error),
        },
        'rank: union hot list unavailable',
      );
      throw new CatalogError(
        50304,
        'rank: union hot list unavailable',
        { platform },
        { cause: error },
      );
    }
  };

  const categories = await fromUnion('categories', () =>
    upstream.categories({ appId, platform, channelId }),
  );
  if (category !== null && !categories.some((entry) => entry.categoryId === category)) {
    invalid('category not offered by the channel');
  }
  const page = await fromUnion('page', () =>
    upstream.page({
      appId,
      platform,
      channelId,
      categoryId: category,
      pageNo,
      pageSize: HOT_RANK_PAGE_SIZE,
    }),
  );

  const items: HotRankData['items'] = [];
  const filtered = await collect(page, pageNo, items, options);

  // BR-PRICE-08: a page that lost a no_rebate card is refilled once from the next channel page;
  // a page short only because of upstream gaps or price anomalies is not. The cursor counts
  // upstream pages, never filtered offsets.
  let lastPageNo = pageNo;
  let lastPage = page;
  if (filtered > 0 && page.hasMore && pageNo < HOT_RANK_MAX_PAGE_NO) {
    const refillNo = pageNo + 1;
    lastPage = await fromUnion('page', () =>
      upstream.page({
        appId,
        platform,
        channelId,
        categoryId: category,
        pageNo: refillNo,
        pageSize: HOT_RANK_PAGE_SIZE,
      }),
    );
    lastPageNo = refillNo;
    await collect(lastPage, refillNo, items, options);
  }

  const more = lastPage.hasMore && lastPageNo < HOT_RANK_MAX_PAGE_NO;
  return {
    channel: channelId,
    categories: categories.map((entry) => ({ category_id: entry.categoryId, name: entry.name })),
    items,
    notice_key: 'rank.notice',
    next_cursor: more
      ? encodeCursor({
          platform,
          channel_id: channelId,
          category_id: category,
          page_no: lastPageNo + 1,
        })
      : null,
  };
}
