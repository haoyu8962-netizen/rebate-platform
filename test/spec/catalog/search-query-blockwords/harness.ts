// B1-04zzzza (FU-SEARCH-QUERY-BLOCKWORDS, D10-860 ⑥ / D10-1064 口径 A) rule-test support.
// The frozen search kit (test/spec/catalog/search/kit.ts) is reused read-only; the use case, the
// card entry and the session rules are the real ones. The prohibited query port is the optional
// `queryBlockwords` option of searchProducts, here wired to catalog's own matcher
// (domain/query-blockwords.ts), as CatalogModule wires it in production.
// The oracle for the matching rule is the Agent's own matcher over its own list (BR-AI-18 input
// check: NFKC, lower case, every whitespace removed, substring; a hit right after 「非」 does not
// count); both lists are pinned to specs/agent-input-keywords.yaml by rule tests.
// All values are synthetic.
import { readFileSync } from 'node:fs';
import {
  createKeywordMatcher,
  inputKeywordLists,
  normalizeForKeywords,
} from '../../../../apps/api/src/modules/agent/preprocess/input/keywords.ts';
import { isProhibitedQuery } from '../../../../apps/api/src/modules/catalog/domain/query-blockwords.ts';
import {
  searchProducts,
  type SearchProductsData,
  type SearchProductsOptions,
  type SearchProductsQuery,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import type { Platform } from '../../../../apps/api/src/modules/union/index.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import { QUERY, candidate, fixture, observed } from '../search/kit.ts';

export { observed };

/** The one log event of a refused query (口径 A: event and platform only). */
export const EVENT = 'search_query_prohibited';

/** 口径 A: the exact data body of a refused query, same shape as the contract's. */
export const EMPTY: SearchProductsData = {
  items: [],
  next_cursor: null,
  has_more: false,
  fallback_items: [],
};

/** The prohibited group of specs/agent-input-keywords.yaml, as written there. */
export function specProhibited(): string[] {
  const file = new URL('../../../../specs/agent-input-keywords.yaml', import.meta.url);
  const spec = parseYamlLite(readFileSync(file, 'utf8')) as { readonly prohibited?: unknown };
  const list = spec.prohibited;
  return Array.isArray(list) ? list.map((word) => String(word)) : [];
}

const agentMatcher = createKeywordMatcher(inputKeywordLists());

/** The Agent's judgement of the same text in the prohibited group (the reference rule). */
export function agentProhibits(text: string): boolean {
  return agentMatcher.hits('prohibited', normalizeForKeywords(text));
}

export { normalizeForKeywords };

/**
 * The frozen search fixture with the prohibited query port wired in. Page 1 holds two deliverable
 * cards of `platform` and the fallback feed one item (on a selectable synthetic channel when
 * `feedChannels` of the category kit is installed), so a query that reached the union would show
 * in the response.
 */
export function setup(platform: Platform = 'taobao') {
  const f = fixture();
  const options: SearchProductsOptions = {
    ...f.options,
    queryBlockwords: { isProhibited: (query: string) => isProhibitedQuery(query) },
  };
  f.pages.set(1, {
    items: [candidate('main-a', 1000n, 0n, platform), candidate('main-b', 1000n, 0n, platform)],
    hasMore: false,
  });
  f.materialFeed.mockResolvedValue({
    items: [candidate('feed-a', 1000n, 0n, platform)],
    hasMore: false,
  });
  const run = (query: Partial<SearchProductsQuery> = {}): Promise<SearchProductsData> =>
    searchProducts({ ...QUERY, ...query }, options);
  return {
    ...f,
    options,
    run,
    /** The request's outcome without throwing: { kind: 'returned' | 'rejected', … }. */
    attempt(query: Partial<SearchProductsQuery> = {}) {
      return observed(() => run(query));
    },
  };
}

export type Setup = ReturnType<typeof setup>;

/** Every observable side effect of the search past the switch, as call counts. */
export function sideEffects(f: Setup) {
  return {
    search: f.search.mock.calls.length,
    materialFeed: f.materialFeed.mock.calls.length,
    getActivePid: f.getActivePid.mock.calls.length,
    sessionRead: f.sessions.read.mock.calls.length,
    sessionWrite: f.sessions.write.mock.calls.length,
    assemble: f.assemble.mock.calls.length,
    register: f.register.mock.calls.length,
    resolveProductKey: f.resolveProductKey.mock.calls.length,
  };
}

/** No side effect past the switch at all. */
export const NONE: ReturnType<typeof sideEffects> = {
  search: 0,
  materialFeed: 0,
  getActivePid: 0,
  sessionRead: 0,
  sessionWrite: 0,
  assemble: 0,
  register: 0,
  resolveProductKey: 0,
};

interface WarnRecorder {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

/** The warn calls whose first argument carries `event`. */
export function warnsOf(warn: WarnRecorder, event: string): (readonly unknown[])[] {
  return warn.mock.calls.filter((call) => {
    const fields = call[0];
    return (
      typeof fields === 'object' &&
      fields !== null &&
      (fields as Record<string, unknown>)['event'] === event
    );
  });
}

/** Full width form of the printable ASCII characters of `text` (U+FF01..U+FF5E). */
export function fullWidth(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char;
    })
    .join('');
}

/** U+3000 IDEOGRAPHIC SPACE, built from its code point (no raw special space in the source). */
export const IDEO_SPACE = String.fromCodePoint(0x3000);
/** U+00A0 NO-BREAK SPACE, built from its code point (no raw special space in the source). */
export const NB_SPACE = String.fromCodePoint(0xa0);

/** Whitespace the Agent's normalisation removes. */
export const SPACES: readonly string[] = [' ', '\t', '\n', IDEO_SPACE, NB_SPACE, '\r\n'];
