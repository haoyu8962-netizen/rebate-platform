// B3-05g / B3-05k: chain access and helpers shared by the search decorator, clarification and refinement.
import { randomUUID } from 'node:crypto';
import { platform as PLATFORM_CODES } from '@couli/contracts-ts';
import type { Platform } from '@couli/contracts-ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import { maxPriceFen, searchBenefits, searchSorts } from '../../tools/search/schema.ts';
import type { SearchBenefit, SearchSort } from '../../tools/search/schema.ts';
import { qShort } from '../core/intent-fallback.ts';
import type { OrchestratorToolCall, ToolOutcome } from '../core/ports.ts';
import type { ClarifySlot, IntentDeps } from '../intents/types.ts';
import { createMemoryResultSetStore } from './store.ts';
import type { ResultSetStore, SearchConditions, SessionChain } from './types.ts';
export type { SessionChain } from './types.ts';

/** Text keys (contracts/texts.default.json; clarify options and the platform notice are new keys
 * for the dictionary owner, B3-13). */
export const resultKeys = {
  priceUnrecognized: 'agent.notice.price_unrecognized',
  platformUnrecognized: 'agent.notice.platform_unrecognized',
  ordinalDefault: 'agent.notice.ordinal_default',
  relaxedSpec: 'agent.notice.relaxed_spec',
  relaxedPrice: 'agent.notice.relaxed_price',
  noResult: 'agent.notice.no_result',
  noCheaper: 'agent.notice.no_cheaper',
  /** A server-built call failed (no model turn follows): the error notices of the same failures
   * elsewhere — 50302 search unavailable without a model answer, 50303 price not confirmed. */
  searchFailed: 'error.50302',
  quoteFailed: 'error.50303',
  noResultSuggestion: (n: number) => `agent.suggest.no_result.${n}`,
  clarifyOption: (slot: ClarifySlot, n: number) => `agent.suggest.clarify.${slot}.${n}`,
} as const;

/** How a server-built call (refinement, clarification answer) asks the decorator to behave.
 * Carried on the call object under a symbol, so model arguments can never forge it. */
export interface ServerCall {
  /** B3-05o 'keyword': the intent fallback's search (BR-AI-14 细则 ⑥: no clarify, no relaxation). */
  readonly kind: 'cheaper' | 'refine' | 'keyword';
  readonly chainId: string;
}

export const SERVER_CALL = Symbol('B3-05g server call');

export type InternalToolCall = OrchestratorToolCall & { readonly [SERVER_CALL]?: ServerCall };

/** Chains of a five-method store (no chain port yet), bound to that store object's identity:
 * every decorator and continuation sharing the store sees the same chain. */
const fallbackChains = new WeakMap<ResultSetStore, Required<ResultSetStore>>();

export type ChainPort = Pick<Required<ResultSetStore>, 'currentChain' | 'appendChain'>;

export function chainPort(store: ResultSetStore): ChainPort {
  const { currentChain: read, appendChain: append } = store;
  if (read !== undefined && append !== undefined) {
    return {
      currentChain: (appId, sessionId) => read.call(store, appId, sessionId),
      appendChain: (appId, sessionId, chain) => append.call(store, appId, sessionId, chain),
    };
  }
  let memory = fallbackChains.get(store);
  if (memory === undefined) {
    memory = createMemoryResultSetStore();
    fallbackChains.set(store, memory);
  }
  return memory;
}

export function newChainId(): string {
  return randomUUID();
}

/** The chain in use: the store's latest appended chain of the session, else (nothing appended
 * yet, e.g. sessions from before the chain port) the latest result set that actually delivered
 * products. Never a model-supplied id. */
export async function currentChain(
  store: ResultSetStore,
  appId: string,
  sessionId: string,
): Promise<SessionChain | null> {
  const own = await chainPort(store).currentChain(appId, sessionId);
  if (own !== null) return own;
  const latest = await store.latestWithProducts(appId, sessionId);
  return latest === null
    ? null
    : {
        chainId: latest.conditions.chain_id,
        conditions: latest.conditions,
        status: 'has_products',
      };
}

/** Append one chain row; it becomes the session's current chain. */
export function setChain(
  store: ResultSetStore,
  appId: string,
  sessionId: string,
  chain: SessionChain,
): Promise<void> {
  return chainPort(store).appendChain(appId, sessionId, chain);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORM_CODES as readonly string[]).includes(value);
}

function isSort(value: unknown): value is SearchSort {
  return typeof value === 'string' && (searchSorts() as readonly string[]).includes(value);
}

function isBenefit(value: unknown): value is SearchBenefit {
  return typeof value === 'string' && (searchBenefits() as readonly string[]).includes(value);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** B3-04k: a non-empty array whose every element passes `item` (the registry checked the rest). */
function listOf<T>(value: unknown, item: (v: unknown) => v is T): value is readonly T[] {
  return Array.isArray(value) && value.length > 0 && value.every(item);
}

/** B3-04k · BR-AI-17: conditions of a taolijin request; every continuation of such a chain stays
 * on the taolijin branch (the closed notice), never a product_list. */
export function asksTaolijin(conditions: SearchConditions | null | undefined): boolean {
  return conditions?.benefits?.includes('taolijin') === true;
}

/** BR-AI-08: an integer number of fen, 0 < value ≤ 10,000,000. */
export function validPrice(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maxPriceFen()
  );
}

/** BR-AI-08 / BR-PRICE-15: a given bound out of range, or min > max. */
export function priceInvalid(args: Readonly<Record<string, unknown>>): boolean {
  const min = args['price_min_fen'];
  const max = args['price_max_fen'];
  if (min !== undefined && !validPrice(min)) return true;
  if (max !== undefined && !validPrice(max)) return true;
  return validPrice(min) && validPrice(max) && min > max;
}

/** Conditions to remember for a search_products argument object; null without a usable q. */
export function conditionsOf(
  args: Readonly<Record<string, unknown>>,
  chainId: string,
): SearchConditions | null {
  const q = args['q'];
  if (typeof q !== 'string') return null;
  const platforms = args['platforms'];
  const sort = args['sort'];
  const min = args['price_min_fen'];
  const max = args['price_max_fen'];
  const spec = args['spec'];
  const page = args['page'];
  const benefits = args['benefits'];
  const brand = args['brand'];
  const categoryHint = args['category_hint'];
  const exclude = args['exclude_keywords'];
  return {
    q,
    ...(Array.isArray(platforms) && platforms.every(isPlatform)
      ? { platforms: [...platforms] }
      : {}),
    ...(isSort(sort) ? { sort } : {}),
    ...(validPrice(min) ? { price_min_fen: min } : {}),
    ...(validPrice(max) ? { price_max_fen: max } : {}),
    ...(typeof spec === 'string' ? { spec } : {}),
    ...(Number.isSafeInteger(page) ? { page: page as number } : {}),
    // B3-04k: the 04 §8.5 conditions travel with the chain like the others (BR-AI-05 / BR-AI-17).
    ...(listOf(benefits, isBenefit) ? { benefits: [...new Set(benefits)] } : {}),
    ...(nonEmptyText(brand) ? { brand } : {}),
    ...(nonEmptyText(categoryHint) ? { category_hint: categoryHint } : {}),
    ...(listOf(exclude, nonEmptyText) ? { exclude_keywords: [...exclude] } : {}),
    chain_id: chainId,
  };
}

/** Tool arguments rebuilt from stored conditions; chain_id stays on the server. */
export function argsOf(conditions: SearchConditions): Record<string, unknown> {
  const { chain_id, ...rest } = conditions;
  void chain_id;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) args[key] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return args;
}

export function without(
  args: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) if (!keys.includes(key)) next[key] = value;
  return next;
}

export async function noticeCard(
  texts: IntentDeps['texts'],
  appId: string,
  key: string,
  level: 'info' | 'warn' = 'info',
): Promise<UnnumberedCard> {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level, text_key: key, actions: [] },
    fallback_text: await texts.text(appId, key),
  };
}

export async function suggestionItems(
  texts: IntentDeps['texts'],
  appId: string,
  keys: readonly string[],
): Promise<{ readonly text: string; readonly send_text: string }[]> {
  const items: { readonly text: string; readonly send_text: string }[] = [];
  for (const key of keys) {
    const text = await texts.text(appId, key);
    items.push({ text, send_text: text });
  }
  return items;
}

/**
 * BR-AI-08 / BR-TEXT-22: agent.suggest.no_result.1–3 for the search term `q`. {q_short} in the
 * second one is the first 8 code points of q (B3-05o); without a search term (null, empty or
 * blank) the second one is left out. text = send_text.
 */
export async function noResultSuggestions(
  texts: IntentDeps['texts'],
  appId: string,
  q: string | null,
): Promise<{ readonly text: string; readonly send_text: string }[]> {
  const term = q === null || q.trim() === '' ? null : qShort(q);
  const items: { readonly text: string; readonly send_text: string }[] = [];
  for (const n of [1, 2, 3]) {
    if (n === 2 && term === null) continue;
    const raw = await texts.text(appId, resultKeys.noResultSuggestion(n));
    const text = term === null ? raw : raw.replaceAll('{q_short}', term);
    items.push({ text, send_text: text });
  }
  return items;
}

/** BR-AI-05: the model learns which server notices went out by name only, never a number. */
export function withServerNotices(view: unknown, notices: readonly string[]): unknown {
  if (notices.length === 0) return view;
  const base = isRecord(view) ? view : { items: [] };
  return { ...base, server_notices: [...notices] };
}

export function productLists(cards: readonly UnnumberedCard[]): readonly UnnumberedCard[] {
  return cards.filter((card) => card.type === 'product_list');
}

export function listItems(card: UnnumberedCard): readonly unknown[] {
  const items = card.data['items'];
  return Array.isArray(items) ? items : [];
}

/** "No result" means an ok outcome without any product in a product_list. */
export function hasProducts(outcome: Extract<ToolOutcome, { kind: 'ok' }>): boolean {
  return productLists(outcome.cards).some((card) => listItems(card).length > 0);
}

/** Read effective handler metadata, never assume ToolTraceFragment has search_params. */
export function readSearchParams(trace: unknown): { spec: string | null; page: number } | null {
  if (!isRecord(trace)) return null;
  const params = trace['search_params'];
  if (!isRecord(params) || !Object.hasOwn(params, 'spec')) return null;
  const spec = params['spec'];
  const page = params['page'];
  if (spec !== null && typeof spec !== 'string') return null;
  if (typeof page !== 'number' || !Number.isSafeInteger(page)) return null;
  return { spec, page };
}

type SuggestionItem = { readonly text: string; readonly send_text: string };

/** BR-AI-08 / BR-AI-01: the three quick options of one clarify slot, from the text port. Without
 * an app (the intent port's call) the empty app id asks the text port for its default copy. */
export async function clarifyOptions(
  texts: IntentDeps['texts'],
  slot: ClarifySlot,
  appId?: string,
): Promise<readonly [SuggestionItem, SuggestionItem, SuggestionItem]> {
  const [a, b, c] = await suggestionItems(
    texts,
    appId ?? '',
    [1, 2, 3].map((n) => resultKeys.clarifyOption(slot, n)),
  );
  if (a === undefined || b === undefined || c === undefined) throw new Error('clarify options');
  return [a, b, c];
}
