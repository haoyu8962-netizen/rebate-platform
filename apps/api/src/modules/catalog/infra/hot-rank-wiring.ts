// B1-28j: the union side of the hot-sales list (HotRankUpstream) in the server's wiring, over the
// union's material-channel ranking port (createUnionChannelRanking, B1-22p). Channel check, order,
// sales field and cache rules stay those of B1-28h.
// Rule tests: test/spec/catalog/hot-rank-upstream/**.
import { randomUUID } from 'node:crypto';
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import type { Clock, MaterialChannelsSpec, RootLogger } from '../../platform/index.ts';
import {
  createUnionChannelRanking,
  isRegisteredPlatform,
  type Platform,
  type UnionItem,
} from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import type { Catalog, ProductRef } from '../domain/types.ts';
import type {
  HotRankCandidate,
  HotRankCategoriesRequest,
  HotRankUpstream,
  HotRankUpstreamPage,
} from '../hot-rank.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';

const JD_MODE = 'product_key.jd.mode';

export interface UnionHotRankUpstreamOptions {
  readonly union: GovernedUnion;
  /** key_prefix of the platform, as search-wiring reads it. */
  readonly catalog: Pick<Catalog, 'listPlatforms'>;
  /** JD item / sku mode (product_key.jd.mode), as search-wiring reads it. */
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
  /** Production: platform's getMaterialChannels; read again before every fetch. */
  readonly channels: () => MaterialChannelsSpec;
  readonly logger: Pick<RootLogger, 'warn'>;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** BR-PROD-05 raw_item_id, as search-wiring derives it. */
function rawItemIdOf(item: UnionItem, jdMode: 'item' | 'sku'): string | undefined {
  switch (item.platform) {
    case 'taobao':
      return nonEmpty(item.item_id);
    case 'jd':
      return jdMode === 'sku' ? nonEmpty(item.skuId) : nonEmpty(item.itemId);
    case 'pdd':
      return nonEmpty(item.goods_sign) ?? nonEmpty(item.goods_id);
    default:
      return undefined;
  }
}

/**
 * The hot list over union's channel ranking port: the governed adapter of a registered platform
 * (none otherwise: the port answers upstream_unavailable, 50304 without reason), called with the
 * caller's app and purpose `online`. Before every fetch the whitelist is read here as well: a
 * (platform, channel_id) not listed or not selectable is 50304 rank_unavailable with one warning
 * and no union call, so the port's "no data" never passes for the channel's empty list.
 * Positions keep the channel's order; one without a product key or of another platform is dropped
 * and the page then carries `positions`, so the rest keep their channel rank (D10-422 ②).
 * The B1-28h cache (infra/hot-rank-cache.ts) wraps this upstream.
 */
export function createUnionHotRankUpstream(options: UnionHotRankUpstreamOptions): HotRankUpstream {
  const { union, catalog, config, clock, channels, logger } = options;

  const ranking = createUnionChannelRanking({
    adapterFor: (platform) =>
      isRegisteredPlatform(platform) ? union.adapter(platform) : undefined,
    channels,
    callCtx: ({ appId }) => ({ appId, requestId: randomUUID(), purpose: 'online' }),
    logger,
  });

  /** BR-TEXT-17 细则「取数时再查一次」: same refusal as B1-28h's use case (50304 rank_unavailable). */
  function ensureSelectable(input: HotRankCategoriesRequest, operation: string): void {
    const spec = channels();
    const listed = spec.channels.find(
      (entry) => entry.platform === input.platform && entry.channel_id === input.channelId,
    );
    if (listed !== undefined && listed.selectable === true) return;
    logger.warn(
      {
        event: 'rank_channel_refused',
        operation,
        platform: input.platform,
        channel_id: input.channelId,
        reason: listed === undefined ? 'not_listed' : 'not_selectable',
        whitelist_version: spec.version,
      },
      'rank: channel not selectable in the whitelist at fetch time, not fetched',
    );
    throw new CatalogError(50304, 'rank: no compliant channel', {
      platform: input.platform,
      reason: 'rank_unavailable',
    });
  }

  async function toCandidates(
    appId: string,
    platform: Platform,
    entries: readonly { readonly item: UnionItem; readonly salesText: string | null }[],
  ): Promise<Pick<HotRankUpstreamPage, 'items' | 'positions'>> {
    const row = (await catalog.listPlatforms()).find((entry) => entry.code === platform);
    const jdEntry = platform === 'jd' ? await config.configValue(appId, JD_MODE) : null;
    // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
    const jdMode = (jdEntry === null ? 'item' : String(jdEntry.value)) as 'item' | 'sku';
    const receivedAt = clock.now().toISOString();
    const out: HotRankCandidate[] = [];
    const positions: number[] = [];
    for (const [position, { item, salesText }] of entries.entries()) {
      if (item.platform !== platform) continue;
      let productKey: string;
      try {
        productKey = deriveProductKey(
          {
            platform,
            keyPrefix: row?.key_prefix ?? null,
            ...(platform === 'jd' ? { jdMode } : {}),
          },
          item,
        );
      } catch (error: unknown) {
        if (error instanceof ProductKeyUnderivable) continue;
        throw error;
      }
      const rawItemId = rawItemIdOf(item, jdMode);
      if (rawItemId === undefined) continue;
      const ref: ProductRef = {
        appId,
        platform,
        productKey,
        rawItemId,
        rawFetchedAt: item.quoted_at,
        receivedAt,
        canonicalUrl: null,
        title: item.title,
        // B1-05zm (S17-c1): the union's shop id of the item, null when it gave none.
        shopId: nonEmpty(item.shop_ref) ?? null,
        shopType: null,
        source: 'search',
      };
      out.push({ item, ref, salesText });
      positions.push(position);
    }
    // No item left means no rank to express, so an emptied page has no `positions` either.
    return out.length > 0 && out.length < entries.length
      ? { items: out, positions }
      : { items: out };
  }

  return {
    async categories(input) {
      ensureSelectable(input, 'channelCategories');
      return await ranking.categories(input);
    },
    async page(input) {
      ensureSelectable(input, 'channelRanking');
      const page = await ranking.page(input);
      // Entries past pageSize are not this page's: their positions would overlap the next page.
      const entries = page.items.slice(0, input.pageSize);
      return {
        ...(await toCandidates(input.appId, input.platform, entries)),
        hasMore: page.hasMore,
      };
    },
  };
}
