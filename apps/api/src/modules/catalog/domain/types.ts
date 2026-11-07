// Catalog shapes (04 §3.2 platforms / product_refs / product_key_aliases / category_blocklist).
// The rule tests in test/spec/catalog/base/** observe them through catalog/index.ts.
import type { Platform } from '../../union/index.ts';

export interface ProductIdentity {
  readonly appId: string;
  readonly platform: Platform;
  readonly productKey: string | null;
}

export interface PlatformRecord {
  readonly code: string;
  readonly key_prefix: string | null;
  readonly key_stability: 'unverified' | 'stable_24h' | 'stable_7d' | 'unstable';
  readonly search_support: string;
  readonly convert_support: string;
  readonly order_sync_support: string;
  readonly stage: string;
}

/**
 * 调用方提供运行期开关；catalog 仍须读取 platforms 的能力标记。
 * searchEnabled 不能启用 search_support='none' 的平台；此时 parseEnabled=false
 * 表示两种能力均不可用，requirePlatform / registerProductRef 必须拒绝（30131）。
 */
export interface ProductCapabilities {
  readonly parseEnabled: boolean;
  readonly searchEnabled: boolean;
}

export type ProductRefSource = 'search' | 'detail' | 'parse' | 'pool';

export interface ProductRef extends ProductIdentity {
  readonly productKey: string;
  readonly rawItemId: string;
  readonly rawFetchedAt: string;
  /** The response receipt instant, captured with Clock before queuing the write. */
  readonly receivedAt: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly shopId: string | null;
  readonly shopType: string | null;
  readonly source: ProductRefSource;
}

/** A trusted, decoded item_ref or a server-read links row; wire verification is B1-05h. */
export interface RequestRawRef extends ProductIdentity {
  readonly productKey: string;
  readonly rawItemId: string;
  readonly fetchedAt: string;
  readonly source: 'item_ref' | 'link';
}

export type ReparseResult =
  | { readonly kind: 'found'; readonly ref: ProductRef }
  | { readonly kind: 'off_shelf' | 'ref_expired' | 'temporary_failure' };

export interface RawItemRequest extends ProductIdentity {
  readonly productKey: string;
  readonly requestRef: RequestRawRef | null;
  /** Server policy only. This module does not enable or derive fallback keys. */
  readonly fallbackEnabled: boolean;
  readonly capabilities: ProductCapabilities;
  readonly reparse: (identity: ProductIdentity) => Promise<ReparseResult>;
}

export interface RawItemResult {
  readonly rawItemId: string;
  readonly source: 'item_ref' | 'link' | 'product_refs' | 'reparse';
}

/**
 * B1-04zzx (D10-860 ①): categoryId null or '' is an item without a level-one category. Such an item
 * is not judged by category; only its platform's rows that carry a keyword apply, by literal title
 * substring.
 */
export interface CategoryCandidate {
  readonly platform: Platform;
  readonly categoryId: string | null;
  readonly title: string;
}

/** An active category_blocklist row of one app. */
export interface CategoryRule {
  readonly platform: string;
  readonly categoryId: string;
  readonly keyword: string | null;
}

export interface Catalog {
  listPlatforms(): Promise<readonly PlatformRecord[]>;
  requirePlatform(code: string, capabilities: ProductCapabilities): Promise<PlatformRecord>;
  resolveProductKey(key: string): Promise<string>;
  isSameProduct(left: ProductIdentity, right: ProductIdentity): Promise<boolean>;
  registerProductRef(ref: ProductRef, capabilities: ProductCapabilities): Promise<void>;
  readProductRef(identity: ProductIdentity): Promise<ProductRef | null>;
  takeRawItemId(request: RawItemRequest): Promise<RawItemResult>;
  filterCategories<T extends CategoryCandidate>(appId: string, items: readonly T[]): Promise<T[]>;
}

export interface CatalogWarning {
  readonly kind: 'alias_cycle' | 'alias_limit';
  readonly key: string;
}
