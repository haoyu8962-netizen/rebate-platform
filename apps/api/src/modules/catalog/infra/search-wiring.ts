// B1-05j: server-side adapters of the search use case's ports — the union upstream over the
// governed adapters, the Redis session store, the signed cursor codec, and the non-cloud item_ref
// cipher used when no field keyring is configured.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { deriveProductKey, ProductKeyUnderivable } from '@couli/domain';
import {
  FIELD_CRYPTO_MESSAGES,
  FieldCryptoError,
  RedisUnavailableError,
  getMaterialChannels,
  type Clock,
  type FieldCrypto,
  type MaterialChannelsSpec,
  type RedisNamespace,
  type RootLogger,
} from '../../platform/index.ts';
import {
  createUnionChannelRanking,
  isRegisteredPlatform,
  type CallCtx,
  type Page,
  type Platform,
  type UnionItem,
} from '../../union/index.ts';
import { CatalogError } from '../domain/rules.ts';
import type { Catalog, ProductRef } from '../domain/types.ts';
import type { CatalogConfigReader, GovernedUnion } from '../ports.ts';
import { createSignedSearchCursorCodec, processSearchCursorKey } from './search-cursor.ts';
import {
  createAtomicSearchSessionStore,
  createRedisAtomicSessionStorage,
} from './search-session-atomic.ts';
import type {
  SearchCandidate,
  SearchCursorCodec,
  SearchSessionStore,
  SearchUpstream,
  SearchUpstreamPage,
  SearchUpstreamRequest,
} from '../search.ts';

/** Redis namespace of catalog search state; every key starts with the app_id (BR-PROD-07). */
export const SEARCH_REDIS_NAMESPACE = 'catalog-search';
/** Upstream page cursors live as long as a search session (BR-PROD-08 ②: 30 minutes). */
const CURSOR_LEDGER_TTL_SECONDS = 1800;
const JD_MODE = 'product_key.jd.mode';

/**
 * The wire cursor codec (B1-05g ②): HMAC-signed { search_session_id, page_no } (search-cursor.ts).
 * Without an explicit key it signs with the process-wide local / test key; CatalogModule passes the
 * keyring-derived deployment key whenever a field keyring is configured (always in staging / prod).
 */
export function createSearchCursorCodec(
  signingKey: Uint8Array = processSearchCursorKey(),
): SearchCursorCodec {
  return createSignedSearchCursorCodec(signingKey);
}

/**
 * Sessions in Redis under `<app_id>:session:<id>`; an unreadable value is no session. Every write
 * goes through the compare-and-swap storage (B1-05g ①): concurrent continuations of one session
 * on different instances merge their issued keys instead of overwriting each other.
 */
export function createRedisSearchSessionStore(redis: RedisNamespace): SearchSessionStore {
  return createAtomicSearchSessionStore(createRedisAtomicSessionStorage(redis));
}

/** Without a REDIS provider (isolated HTTP unit tests) sessions fail at call time. */
export const UNAVAILABLE_SEARCH_SESSIONS: SearchSessionStore = {
  read: () => Promise.reject(new Error('catalog: search sessions need Redis')),
  write: () => Promise.reject(new Error('catalog: search sessions need Redis')),
};

export interface UnionSearchUpstreamOptions {
  readonly union: GovernedUnion;
  readonly catalog: Pick<Catalog, 'listPlatforms'>;
  readonly config: CatalogConfigReader;
  readonly clock: Clock;
  /** Remembers the union cursor of page n+1; null walks from page 1 instead. */
  readonly ledger: RedisNamespace | null;
  /** The fallback's whitelist, read again before every fetch; default platform's getMaterialChannels. */
  readonly channels?: () => MaterialChannelsSpec;
  /** Takes the channel port's refusal warning; production passes one, without it none is logged. */
  readonly logger?: Pick<RootLogger, 'warn'>;
}

const NO_WARNINGS: Pick<RootLogger, 'warn'> = { warn: () => undefined };

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** BR-PROD-05 raw_item_id: the platform's own identifier used later for detail and convert. */
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
 * The union side of search (BR-PROD-07): the governed adapter of the platform, called with the
 * caller's app and purpose `online` (the governance wrapper adds signal, base URL and headers).
 * Union pages are cursor based; the cursor of page n+1 is remembered per (app, platform, query)
 * in Redis for a session's lifetime, and a missing one is re-derived by walking from page 1.
 * The union search query carries only the keyword today: sort, coupon and price lower bound are
 * filtered on our side (BR-PRICE-15) until the adapters accept them.
 * TODO(规划/11 §4.5): 向联盟透传 sort / has_coupon / price_min_fen 与查询专用推广位 — blocked on 真实适配器的检索参数（CAP-*-03）
 * The BR-PROD-07 page cache wraps this upstream (infra/product-cache.ts cacheSearchUpstream).
 * The no-result fallback reads the selected whitelisted channel through union's ranking port
 * (B1-22p), never the general material feed (BR-TEXT-17 细则「联盟物料频道」): a channel gone from the
 * whitelist at fetch time is an empty page, an adapter without the channel method an outage.
 */
export function createUnionSearchUpstream(options: UnionSearchUpstreamOptions): SearchUpstream {
  const {
    union,
    catalog,
    config,
    clock,
    ledger,
    channels = getMaterialChannels,
    logger = NO_WARNINGS,
  } = options;

  function adapterOf(platform: Platform) {
    if (!isRegisteredPlatform(platform)) {
      throw new CatalogError(30131, `search: no union adapter for ${platform}`);
    }
    return union.adapter(platform);
  }

  function context(appId: string): CallCtx {
    return { appId, requestId: randomUUID(), purpose: 'online' };
  }

  const ranking = createUnionChannelRanking({
    adapterFor: (platform) =>
      isRegisteredPlatform(platform) ? union.adapter(platform) : undefined,
    channels,
    callCtx: ({ appId }) => context(appId),
    logger,
  });

  async function toCandidates(
    appId: string,
    platform: Platform,
    items: readonly UnionItem[],
  ): Promise<SearchCandidate[]> {
    const row = (await catalog.listPlatforms()).find((entry) => entry.code === platform);
    const jdEntry = platform === 'jd' ? await config.configValue(appId, JD_MODE) : null;
    // Absent means item (BR-PROD-03); any other value fails closed in deriveProductKey.
    const jdMode = (jdEntry === null ? 'item' : String(jdEntry.value)) as 'item' | 'sku';
    const receivedAt = clock.now().toISOString();
    const out: SearchCandidate[] = [];
    for (const item of items) {
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
      out.push({ item, ref });
    }
    return out;
  }

  function ledgerKey(input: SearchUpstreamRequest, pageNo: number): string {
    const query = createHash('sha256')
      .update(
        JSON.stringify([
          input.keyword,
          input.sort,
          input.hasCoupon ?? false,
          input.priceMinFen ?? null,
          input.pageSize,
        ]),
        'utf8',
      )
      .digest('hex');
    return `${input.appId}:cursor:${input.platform}:${query}:${String(pageNo)}`;
  }

  /**
   * One union page; `saved` is false when its continuation cursor could not be remembered because
   * Redis was unavailable (02 §14: the union answer is still used; D6-8: no next cursor then).
   */
  async function fetchPage(
    input: SearchUpstreamRequest,
    pageNo: number,
    cursor: string | undefined,
  ): Promise<{ readonly page: Page<UnionItem>; readonly saved: boolean }> {
    const page = await adapterOf(input.platform).searchItems(
      { keyword: input.keyword, ...(cursor === undefined ? {} : { cursor }) },
      context(input.appId),
    );
    if (ledger !== null && page.nextCursor !== null) {
      try {
        await ledger.set(ledgerKey(input, pageNo + 1), page.nextCursor, CURSOR_LEDGER_TTL_SECONDS);
      } catch (error: unknown) {
        if (!(error instanceof RedisUnavailableError)) throw error;
        return { page, saved: false };
      }
    }
    return { page, saved: true };
  }

  /** A remembered cursor, or null when none is remembered or Redis is unavailable (walk). */
  async function rememberedCursor(input: SearchUpstreamRequest): Promise<string | null> {
    if (ledger === null) return null;
    try {
      return await ledger.get(ledgerKey(input, input.pageNo));
    } catch (error: unknown) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      return null;
    }
  }

  async function cursorOf(input: SearchUpstreamRequest): Promise<string | null | undefined> {
    if (input.pageNo === 1) return undefined;
    const remembered = await rememberedCursor(input);
    if (remembered !== null) return remembered;
    // Walk from page 1 to recover the cursor; null means the upstream has no such page.
    let cursor: string | undefined;
    for (let pageNo = 1; pageNo < input.pageNo; pageNo++) {
      const { page } = await fetchPage(input, pageNo, cursor);
      if (page.nextCursor === null) return null;
      cursor = page.nextCursor;
    }
    return cursor;
  }

  return {
    async search(input) {
      const cursor = await cursorOf(input);
      if (cursor === null) return { items: [], hasMore: false };
      const { page, saved } = await fetchPage(input, input.pageNo, cursor);
      return {
        items: await toCandidates(input.appId, input.platform, page.items),
        hasMore: page.nextCursor !== null,
        ...(saved ? {} : { cursorUnsaved: true }),
      };
    },
    async materialFeed(input): Promise<SearchUpstreamPage> {
      const page = await ranking.page({
        appId: input.appId,
        platform: input.platform,
        channelId: input.channelId,
        categoryId: null,
        pageNo: 1,
        pageSize: input.limit,
      });
      const candidates = await toCandidates(
        input.appId,
        input.platform,
        page.items.map((entry) => entry.item),
      );
      return { items: candidates.slice(0, input.limit), hasMore: page.hasMore };
    },
  };
}

/** FieldCrypto context names are 1..200 printable ASCII characters (platform/crypto). */
const CONTEXT = /^[\x21-\x7e]{1,200}$/;

function cryptoFail(code: 'malformed_ciphertext' | 'decrypt_failed' | 'invalid_context'): never {
  throw new FieldCryptoError(code, FIELD_CRYPTO_MESSAGES[code]);
}

/**
 * item_ref cipher for local / test processes started without a field keyring (no FIELD_CRYPTO):
 * AES-256-GCM under a random per-process key, context as additional data. Tokens stop verifying
 * after a restart, which only drops the raw-ID shortcut (BR-PROD-11 falls back to the product
 * key). Staging and prod always have a keyring (platform/config/keyring.ts) and never use this.
 */
export function createProcessItemRefCipher(): Pick<FieldCrypto, 'encrypt' | 'decrypt'> {
  const key = randomBytes(32);
  return {
    encrypt(plaintext: string, context: string): string {
      if (!CONTEXT.test(context)) cryptoFail('invalid_context');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `p1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
    },
    decrypt(ciphertext: string, context: string): string {
      if (!CONTEXT.test(context)) cryptoFail('invalid_context');
      const match =
        typeof ciphertext === 'string' ? /^p1\.([A-Za-z0-9_-]+)$/.exec(ciphertext) : null;
      if (match === null) cryptoFail('malformed_ciphertext');
      const bytes = Buffer.from(match[1]!, 'base64url');
      if (bytes.length < 12 + 1 + 16) cryptoFail('malformed_ciphertext');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        return Buffer.concat([
          decipher.update(bytes.subarray(12, bytes.length - 16)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return cryptoFail('decrypt_failed');
      }
    },
  };
}
