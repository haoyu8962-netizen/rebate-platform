// B3-04b · search_products (BR-AI-08 / BR-AI-09 / BR-AI-11, with BR-AI-04 / BR-AI-05 /
// BR-AI-18 / BR-PROD-10) and the keyword fallback search of the degraded path. The pipeline is in
// pipeline.ts, the Agent card contract in card.ts, the model-facing schema in schema.ts.
import { wrapUntrusted } from '../../guard/index.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../../orchestrator/index.ts';
import type { PlatformSearchResult } from '../../model-gateway/degraded/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';
import type { AgentProductCard } from './card.ts';
import type { SearchProductsDeps } from './types.ts';
import {
  runSearch,
  enabledPlatforms,
  upstreamKeyword,
  type Platform,
  type SearchRequest,
} from './pipeline.ts';
import {
  defaultPageSize,
  maxExcludeKeywordLength,
  maxExcludeKeywords,
  maxHintLength,
  maxSearchPage,
  maxSpecLength,
  searchBenefits,
  searchProductsDefinition,
  type SearchBenefit,
  type SearchSort,
} from './schema.ts';

export type { AgentProductCard } from './card.ts';

export type { AgentSearchCandidate, SearchProductsDeps } from './types.ts';

/** Tool result for an inverted price range; the registry's rejected form only carries
 * invalid_args, so this is an ok outcome with no card that B3-05g keys on. */
export function priceRangeInvalidView(): { readonly error: 'price_range_invalid' } {
  return { error: 'price_range_invalid' };
}

function prohibitedKey(): string {
  return 'agent.refuse.prohibited';
}

function productListKey(): string {
  return 'agent.product_list';
}

async function fallbackText(deps: SearchProductsDeps, appId: string, key: string) {
  if (deps.texts === undefined) return key;
  try {
    const text = await deps.texts(appId, key);
    return text === '' ? key : text;
  } catch {
    return key;
  }
}

const CLOSED_BENEFIT = 'closed_benefit';

/**
 * B3-04k · BR-AI-17: whether a search_products trace is the closed taolijin answer (tlj_none and
 * maybe tlj_taobao_only), which the results decorator returns exactly as built.
 */
export function isTaolijinClosed(trace: unknown): boolean {
  return (
    typeof trace === 'object' &&
    trace !== null &&
    (trace as Readonly<Record<string, unknown>>)[CLOSED_BENEFIT] === 'taolijin'
  );
}

/** BR-AI-17 / BR-TEXT-15 判定 6: no taolijin activity (default “暂无淘礼金活动”). */
function tljNoneKey(): string {
  return 'agent.notice.tlj_none';
}

/** BR-AI-17: the user named a non-taobao platform with taolijin (“淘礼金仅支持淘宝”). */
function tljTaobaoOnlyKey(): string {
  return 'agent.notice.tlj_taobao_only';
}

async function prohibitedNotice(deps: SearchProductsDeps, appId: string): Promise<UnnumberedCard> {
  return notice(deps, appId, prohibitedKey());
}

async function notice(
  deps: SearchProductsDeps,
  appId: string,
  key: string,
): Promise<UnnumberedCard> {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: key, actions: [] },
    fallback_text: await fallbackText(deps, appId, key),
  };
}

/** One unnumbered product_list; its items carry no card_id (RunManager numbers them). */
async function productList(
  deps: SearchProductsDeps,
  appId: string,
  cards: readonly AgentProductCard[],
): Promise<UnnumberedCard> {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: deps.newResultSetId(), items: [...cards], layout: 'list' },
    fallback_text: await fallbackText(deps, appId, productListKey()),
  };
}

async function outcomeCards(
  deps: SearchProductsDeps,
  appId: string,
  prohibited: boolean,
  cards: readonly AgentProductCard[],
): Promise<UnnumberedCard[]> {
  if (prohibited) return [await prohibitedNotice(deps, appId)];
  return cards.length === 0 ? [] : [await productList(deps, appId, cards)];
}

function linkTrace(cards: readonly AgentProductCard[]) {
  return {
    link_registrations: cards.map((card) => ({
      link_id: card.link_id,
      product_key: card.product_key,
      ok: true,
    })),
  };
}

/**
 * B3-04e: the spec and page this call actually used, for the orchestrator (B3-05g relaxes by
 * dropping spec and pages "换一批"). Never part of modelView. ToolTraceFragment has no field for
 * it yet; B3-05g adds it to the port type, until then it rides along as an extra trace member.
 */
function searchTrace(cards: readonly AgentProductCard[], request: SearchRequest) {
  return {
    ...linkTrace(cards),
    search_params: { spec: request.spec ?? null, page: request.page },
  };
}

/**
 * BR-AI-17 (D7): taolijin is closed in the first version and no pool exists, so whatever
 * tlj.enabled reads, a taolijin request never searches the union (the taobao-only platform
 * override has nothing to search), delivers no product card and no coupon substitute: only the
 * tlj_none notice, plus tlj_taobao_only when the user named a platform other than taobao.
 * TODO(规划/11 §2.3): 淘礼金池查询 — blocked on 淘礼金后续接入（BR-AI-17 D7）
 */
async function taolijinOutcome(
  deps: SearchProductsDeps,
  appId: string,
  request: SearchRequest,
): Promise<ToolOutcome> {
  const keys = [tljNoneKey()];
  if (request.platforms !== undefined && request.platforms.some((p) => p !== 'taobao')) {
    keys.push(tljTaobaoOnlyKey());
  }
  const cards: UnnumberedCard[] = [];
  for (const key of keys) cards.push(await notice(deps, appId, key));
  // Nothing was searched with a spec, so the orchestrator has no spec step to relax. Built apart
  // so the extra members pass ToolTraceFragment (see searchTrace). closed_benefit tells the
  // results decorator this is a final answer, like a refusal: no relaxation, retry, no_result
  // notice or suggestion is added (B3-04k r2); it is trace only, never in modelView.
  const trace = {
    link_registrations: [],
    search_params: { spec: null, page: request.page },
    [CLOSED_BENEFIT]: 'taolijin',
  };
  return {
    kind: 'ok',
    // BR-AI-05: the model learns the notices by name only, as the orchestrator's server notices.
    modelView: {
      items: [],
      server_notices: keys.map((key) => key.slice(key.lastIndexOf('.') + 1)),
    },
    cards,
    trace,
  };
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' && [...value].length <= max ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Arguments already passed the registry's schema; read defensively all the same. */
function requestFromArgs(args: Readonly<Record<string, unknown>>): SearchRequest {
  const sort = args['sort'];
  const platforms = args['platforms'];
  const limit = optionalInt(args['limit']);
  const page = optionalInt(args['page']);
  const spec = args['spec'];
  const benefits = stringList(args['benefits'])?.filter((b): b is SearchBenefit =>
    searchBenefits().includes(b as SearchBenefit),
  );
  const brand = boundedText(args['brand'], maxHintLength());
  const categoryHint = boundedText(args['category_hint'], maxHintLength());
  const excludeKeywords = stringList(args['exclude_keywords'])
    ?.map((word) => boundedText(word, maxExcludeKeywordLength()))
    .filter((word): word is string => word !== undefined)
    .slice(0, maxExcludeKeywords());
  return {
    q: typeof args['q'] === 'string' ? args['q'] : '',
    ...(Array.isArray(platforms)
      ? { platforms: platforms.filter((p): p is string => typeof p === 'string') }
      : {}),
    sort:
      sort === 'rebate_desc' || sort === 'final_price_asc' || sort === 'sales_desc'
        ? (sort satisfies SearchSort)
        : 'relevance',
    ...(optionalInt(args['price_min_fen']) === undefined
      ? {}
      : { priceMinFen: optionalInt(args['price_min_fen'])! }),
    ...(optionalInt(args['price_max_fen']) === undefined
      ? {}
      : { priceMaxFen: optionalInt(args['price_max_fen'])! }),
    pageSize:
      limit !== undefined && limit >= 1 && limit <= defaultPageSize() ? limit : defaultPageSize(),
    page: page !== undefined && page >= 1 && page <= maxSearchPage() ? page : 1,
    // Counted in code points, as the registry's JSON Schema maxLength does (a supplementary
    // character is one, not two UTF-16 units).
    ...(typeof spec === 'string' && spec !== '' && [...spec].length <= maxSpecLength()
      ? { spec }
      : {}),
    ...(benefits === undefined || benefits.length === 0
      ? {}
      : { benefits: [...new Set(benefits)] }),
    ...(brand === undefined ? {} : { brand }),
    ...(categoryHint === undefined ? {} : { categoryHint }),
    ...(excludeKeywords === undefined || excludeKeywords.length === 0 ? {} : { excludeKeywords }),
  };
}

/**
 * BR-AI-05: the model sees only the card reference, the escaped and wrapped title, the platform
 * and the server-made benefit tags; no price, rebate, link or reference.
 */
function modelItems(
  deps: SearchProductsDeps,
  products: readonly AgentProductCard[],
  outcomeCards: readonly UnnumberedCard[],
  ctx: ToolCallContext,
) {
  // B3-05i ruling: the reference index addresses the final outcome.cards array, not products.
  // Every delivered product lives in the one product_list card, so it references that card's
  // position; a product dropped before delivery never appears here and takes no reference.
  const listIndex = outcomeCards.findIndex((card) => card.type === 'product_list');
  if (listIndex < 0) return [];
  return products.map((card) => ({
    card_id: deps.cardReference(ctx, listIndex),
    title: card.title === null ? null : wrapUntrusted(card.title),
    platform: card.platform,
    benefit_tags: [...card.benefit_tags],
  }));
}

export function createSearchProductsHandler(deps: SearchProductsDeps): ToolHandler {
  return {
    name: 'search_products',
    audience: 'all',
    definition: searchProductsDefinition(deps.platforms),
    async run(args, ctx): Promise<ToolOutcome> {
      const request = requestFromArgs(args);
      // BR-AI-08: min > max never searches nor registers. The clarify (three quick price
      // options) and the drop-after-one-ask notice belong to the orchestrator (B3-05g), which
      // recognizes this modelView; the tool itself never asks.
      if (
        request.priceMinFen !== undefined &&
        request.priceMaxFen !== undefined &&
        request.priceMinFen > request.priceMaxFen
      ) {
        return { kind: 'ok', modelView: priceRangeInvalidView(), cards: [] };
      }
      if (request.benefits?.includes('taolijin') === true) {
        // BR-AI-18 still first: a prohibited query is refused, not answered with a tlj notice.
        if (await deps.prohibited(ctx.appId, upstreamKeyword(request))) {
          return {
            kind: 'ok',
            modelView: { items: [], refused: 'prohibited' },
            cards: [await prohibitedNotice(deps, ctx.appId)],
            trace: { link_registrations: [] },
          };
        }
        return taolijinOutcome(deps, ctx.appId, request);
      }
      const run = await runSearch(deps, request, ctx);
      // Every searched platform failed (upstream, assembly or registration): a tool failure,
      // never an empty result; the registry shows the model only the generic error.
      if (run.allFailed) return { kind: 'failed', modelView: { error: 'tool_failed' } };
      const cards = await outcomeCards(deps, ctx.appId, run.prohibited, run.cards);
      const items = modelItems(deps, run.cards, cards, ctx);
      // Built apart so the extra search_params member passes ToolTraceFragment (see searchTrace).
      const trace = searchTrace(run.cards, request);
      return {
        kind: 'ok',
        modelView: run.prohibited ? { items, refused: 'prohibited' } : { items },
        cards,
        trace,
      };
    },
  };
}

/** Server context of the degraded path, built like the registry's call context. */
function callContext(ctx: ToolContext): ToolCallContext {
  const { appId, userId, deviceId, phoneBound } = ctx.subject;
  return {
    appId,
    userId,
    deviceId,
    phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    ...(ctx.context === undefined ? {} : { context: ctx.context }),
    placeholders: ctx.placeholders,
  };
}

/**
 * B3-05c's keyword fallback: same switches, filters and deferred registration as search_products,
 * relevance only, no price condition. Every planned platform gets one result (a platform switched
 * off since planning, unknown or failing is ok=false) for resolveDegradedOutcome.
 */
export function createKeywordSearch(
  deps: SearchProductsDeps,
): Pick<OrchestratorTools, 'enabledSearchPlatforms' | 'searchKeyword'> {
  return {
    async enabledSearchPlatforms(appId) {
      return enabledPlatforms(deps, appId);
    },

    async searchKeyword(plan, toolCtx) {
      const ctx = callContext(toolCtx);
      const run = await runSearch(
        deps,
        {
          q: plan.q,
          platforms: plan.platforms,
          sort: 'relevance',
          pageSize: defaultPageSize(),
          page: 1,
        },
        ctx,
      );
      const results: PlatformSearchResult[] = plan.platforms.map((platform) => {
        if (run.prohibited) return { platform, ok: true, items: [] };
        if (run.status.get(platform as Platform) !== 'ok') return { platform, ok: false };
        return { platform, ok: true, items: run.cards.filter((c) => c.platform === platform) };
      });
      return {
        results,
        cards: await outcomeCards(deps, ctx.appId, run.prohibited, run.cards),
        trace: linkTrace(run.cards),
      };
    },
  };
}
