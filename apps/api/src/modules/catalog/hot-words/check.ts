// B1-05m (规划/01 F-PROD-03; contracts getSearchHotWords, SearchHotWordsData, RouteTarget;
// BR-ATTR-29 ①; D10-419 (a)): the save checks of search.hot_words and search.keyword_routes,
// pure. A value fits only when every item does (no partial save); the caller turns a refusal into
// 20001 with the config item route's fields. Route names and params come from contracts/routes.json
// (route-table.ts), never from a copied list; union domains from the platform link pattern table
// (category union_host), and only while external_page.union_host_block is on. The read returns the
// stored lists as configured, so they also keep SearchHotWordsData's limits.
import { getLinkPatterns, type LinkPatternsSpec } from '../../platform/index.ts';
import { isUnionHost, normalisedHttpsHost } from '../../content/index.ts';
import { isProhibitedQuery } from '../domain/query-blockwords.ts';
import { routeTable } from './route-table.ts';

/** What the keyword route check reads besides the value. */
export interface SearchConfigCheckContext {
  /** external_page.union_host_block (default on: only a stored false turns it off). */
  readonly unionHostBlock: boolean;
  readonly linkPatterns: LinkPatternsSpec;
}

export const SEARCH_HOT_WORDS_KEY = 'search.hot_words';
export const SEARCH_KEYWORD_ROUTES_KEY = 'search.keyword_routes';
const UNION_HOST_BLOCK = 'external_page.union_host_block';

/** SearchHotWordsData: maxItems of hot_words / keyword_routes; text and keyword 1–20 characters. */
const MAX_HOT_WORDS = 10;
const MAX_KEYWORD_ROUTES = 50;
const MAX_WORD_LENGTH = 20;

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every own key is one of `allowed` and every `required` key is present. */
function hasKeys(value: Plain, allowed: readonly string[], required: readonly string[]): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

/** A string of 1–20 characters (JSON Schema counts code points) that is not blank. */
function isWord(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= 1 && length <= MAX_WORD_LENGTH && value.trim() !== '';
}

/** Whether `value` may be saved as search.hot_words: a list of `{text}`, text not blank. */
export function searchHotWordsFit(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_HOT_WORDS &&
    value.every(
      (item) => isPlainObject(item) && hasKeys(item, ['text'], ['text']) && isWord(item['text']),
    )
  );
}

/** BR-ATTR-29 ①: an ExternalPage url on a union domain is refused while the switch is on. */
function externalUrlFits(url: unknown, context: SearchConfigCheckContext): boolean {
  if (typeof url !== 'string') return false;
  // Parsed by URL (user info refused), never by cutting the string.
  const host = normalisedHttpsHost(url);
  if (host === null) return false;
  return !(context.unionHostBlock && isUnionHost(host, context.linkPatterns));
}

function targetFits(target: unknown, context: SearchConfigCheckContext): boolean {
  if (!isPlainObject(target) || !hasKeys(target, ['route', 'params'], ['route'])) return false;
  const route = target['route'];
  const params = target['params'];
  if (typeof route !== 'string') return false;
  if (Object.hasOwn(target, 'params') && !isPlainObject(params)) return false;
  const given = isPlainObject(params) ? params : undefined;
  if (!routeTable().fits(route, given)) return false;
  return route !== 'ExternalPage' || externalUrlFits(given?.['url'], context);
}

/**
 * Whether `value` may be saved as search.keyword_routes: a list of `{keyword, target}`, keyword
 * not empty, target a RouteTarget of contracts/routes.json with params as that route defines them;
 * an ExternalPage url on a union domain is refused while the switch is on.
 */
export function searchKeywordRoutesFit(value: unknown, context: SearchConfigCheckContext): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_KEYWORD_ROUTES &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        hasKeys(item, ['keyword', 'target'], ['keyword', 'target']) &&
        isWord(item['keyword']) &&
        targetFits(item['target'], context),
    )
  );
}

/**
 * B1-04zzzzb (D10-1064 / D10-1070; 01 F-PROD-08, agent's default until 08 writes it): whether a
 * value that already fits holds a prohibited word in `field`. Only saving is refused here: the
 * read path keeps using the *Fit functions, so a stored value is never blanked by this rule.
 */
function holdsProhibitedWord(value: unknown, field: 'text' | 'keyword'): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        isPlainObject(item) && typeof item[field] === 'string' && isProhibitedQuery(item[field]),
    )
  );
}

/**
 * The configuration center's save check of the two keys (content ConfigItemAdminChecks.save,
 * wired by app.module): `keys` the rows it reads (the switch included, no row = on),
 * `refusals(stored, written)` the written search keys whose values do not fit. A write that sets
 * neither search key is never refused here.
 */
export function searchConfigSaveCheck(linkPatterns: () => LinkPatternsSpec = getLinkPatterns): {
  readonly keys: readonly string[];
  refusals(stored: ReadonlyMap<string, unknown>, written: ReadonlyMap<string, unknown>): string[];
} {
  return {
    keys: [SEARCH_HOT_WORDS_KEY, SEARCH_KEYWORD_ROUTES_KEY, UNION_HOST_BLOCK],
    refusals(stored, written) {
      const refused: string[] = [];
      if (
        written.has(SEARCH_HOT_WORDS_KEY) &&
        (!searchHotWordsFit(written.get(SEARCH_HOT_WORDS_KEY)) ||
          holdsProhibitedWord(written.get(SEARCH_HOT_WORDS_KEY), 'text'))
      ) {
        refused.push(SEARCH_HOT_WORDS_KEY);
      }
      if (written.has(SEARCH_KEYWORD_ROUTES_KEY)) {
        const block = written.has(UNION_HOST_BLOCK)
          ? written.get(UNION_HOST_BLOCK)
          : stored.get(UNION_HOST_BLOCK);
        const context = { unionHostBlock: block !== false, linkPatterns: linkPatterns() };
        if (
          !searchKeywordRoutesFit(written.get(SEARCH_KEYWORD_ROUTES_KEY), context) ||
          holdsProhibitedWord(written.get(SEARCH_KEYWORD_ROUTES_KEY), 'keyword')
        ) {
          refused.push(SEARCH_KEYWORD_ROUTES_KEY);
        }
      }
      return refused;
    },
  };
}
