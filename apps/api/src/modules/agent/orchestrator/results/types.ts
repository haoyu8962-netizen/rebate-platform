// B3-05g · BR-AI-05 / BR-AI-08 / BR-AI-24: result sets, references, refinement and relaxation.
import type { Platform } from '@couli/contracts-ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { MatchDeps } from '../../tools/match/index.ts';
import type { SearchBenefit, SearchSort } from '../../tools/search/schema.ts';
import type {
  AgentRunTexts,
  OrchestratorLimits,
  OrchestratorTools,
  QuotedScope,
} from '../core/ports.ts';
import type { IntentFallbackDeps } from '../core/intent-fallback.ts';
import type { ClarificationScope, ClarifySlot, IntentDeps } from '../intents/types.ts';

/** Server-owned conditions; chain_id is never accepted from model tool arguments. */
export type SearchConditions = {
  readonly q: string;
  readonly platforms?: readonly Platform[];
  readonly sort?: SearchSort;
  readonly price_min_fen?: number;
  readonly price_max_fen?: number;
  readonly spec?: string;
  readonly page?: number;
  /** B3-04k: kept so 换一批 / 再便宜点 / 换平台 continue with the same benefit and word filters. */
  readonly benefits?: readonly SearchBenefit[];
  readonly brand?: string;
  readonly category_hint?: string;
  readonly exclude_keywords?: readonly string[];
  readonly chain_id: string;
};

export type ChainStatus = 'searching' | 'awaiting_price' | 'has_products';

/** Server-owned current chain and its effective search conditions (or pending question). */
export interface SessionChain {
  readonly chainId: string;
  readonly status: ChainStatus;
  readonly conditions: SearchConditions | null;
}

/** Only actual delivery receipts populate this server-only snapshot. */
export interface DeliveredProduct {
  readonly card_id: string;
  readonly product_key: string;
  readonly platform: Platform;
  readonly final_price_fen: number;
  readonly card: UnnumberedCard;
}

export interface ResultSetInput {
  readonly id: string;
  readonly appId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly conditions: SearchConditions;
}

export interface StoredResultSet extends ResultSetInput {
  readonly delivered: readonly DeliveredProduct[];
}

export interface ResultSetStore {
  /** Persist conditions separately from delivered cards/prices, under product_list.result_set_id. */
  save(value: ResultSetInput): Promise<void>;
  /** Trusted delivery hook, not a model tool. PG/core receipt wiring belongs to later tasks. */
  recordDelivered(resultSetId: string, items: readonly DeliveredProduct[]): Promise<void>;
  latestWithProducts(appId: string, sessionId: string): Promise<StoredResultSet | null>;
  /** Earlier rounds remain addressable; all lookup dimensions come from server context. */
  findDelivered(appId: string, sessionId: string, cardId: string): Promise<DeliveredProduct | null>;
  takeOnce(scope: ClarificationScope, slot: ClarifySlot): Promise<boolean>;
  /** Last append for this app/session, or null; never falls back to delivered result sets. */
  currentChain?(appId: string, sessionId: string): Promise<SessionChain | null>;
  /** Append only. Reject has_products with null conditions or a mismatching chain_id. */
  appendChain?(appId: string, sessionId: string, chain: SessionChain): Promise<void>;
}

/**
 * B3-03p · BR-AI-05: a store that also keeps the product of a written rebate_quote card
 * (DeliveryReceiptPort.recordQuoted): findDelivered finds it by card_id in the same app and
 * session; latestWithProducts never returns it (「第 N 个」 keeps the latest product_list).
 */
export interface QuotedReceiptStore {
  recordQuoted(scope: QuotedScope, items: readonly DeliveredProduct[]): Promise<void>;
}

/** B3-03r · BR-AI-05: a batch's chain, waiting for a delivery receipt of one of its lists. */
export interface PendingBatch {
  readonly appId: string;
  readonly sessionId: string;
  /** has_products, with the conditions that produced the batch. */
  readonly chain: SessionChain;
  /** The batch's product_list result_set_ids (already saved). */
  readonly resultSetIds: readonly string[];
}

/**
 * B3-03r · BR-AI-05: the receipt store's pending table (createKeywordResults). The batch's chain
 * becomes the session's current chain on the first delivery receipt (at least one product) of
 * one of its lists; a batch never confirmed never switches it.
 */
export interface PendingChains {
  defer(batch: PendingBatch): void;
}

export interface ResultsDeps {
  readonly store: ResultSetStore;
  /**
   * B3-03r: when wired (the production assembly, over the same store as the core's receipts), a
   * search's has_products chain waits for its first written product_list instead of being set
   * as soon as the search returns. Absent: the chain is set at once, as before (B3-05g / B3-05k).
   */
  readonly chains?: PendingChains;
  /** toolDisplay, when wired, gives server-built calls (refinement, 第 N 个) the same
   * tool.status frames as the core's model calls. */
  readonly texts: IntentDeps['texts'] & { readonly toolDisplay?: AgentRunTexts['toolDisplay'] };
  readonly limits: OrchestratorLimits;
  readonly match?: MatchDeps;
}

/** tools is the decorated port, sharing store with clarification and refinement. */
export interface ResultsContinuationDeps extends ResultsDeps {
  readonly tools: OrchestratorTools;
  /** B3-05o: configuration and clock of the intent fallback (core/intent-fallback.ts). Absent,
   * an intent without its tool call gets nothing from this port (as before). */
  readonly fallback?: Pick<IntentFallbackDeps, 'config' | 'clock'>;
}
