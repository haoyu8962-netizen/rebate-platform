import { Controller, Get, HttpException, Inject, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { ROOT_LOGGER, contractRouteSchema, type RootLogger } from '../../../platform/index.ts';
import { UnionError } from '../../../union/index.ts';
import { CatalogSearchService } from '../../application/search-service.ts';
import { CatalogError } from '../../domain/rules.ts';
import type { SearchProductsQuery } from '../../search.ts';

type SearchProductsResponse = Schema<'SearchProductsResponse'>;

interface TracedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

/**
 * Fallback texts (`msg`); clients show their dictionary text error.<code>[.<reason>]
 * (contracts/texts.default.json, BR-TEXT-14).
 */
const MESSAGES = Object.freeze({
  20001: '填写内容有误，请检查',
  30131: '暂不支持这个链接或平台',
  50304: '搜索暂不可用，请稍后再试',
  search_disabled: '该平台暂不提供搜索，可以粘贴商品链接查返利',
});

/** Statuses of contracts/error-codes.yaml for the codes searchProducts can fail with. */
const STATUS: Readonly<Record<number, number>> = { 20001: 400, 30131: 422, 50304: 503 };

/** The query field a 20001 of the use case concerns (its messages name the parameter). */
function fieldsOf(message: string): string[] {
  if (message.includes('cursor')) return ['cursor'];
  if (message.includes('price_min_fen > price_max_fen')) return ['price_min_fen', 'price_max_fen'];
  for (const field of ['price_min_fen', 'price_max_fen', 'limit', 'q'] as const) {
    if (message.includes(field)) return [field];
  }
  return ['query'];
}

/**
 * The error envelope of a CatalogError, or 50304 { platform } for a UnionError the use case lets
 * through (a business rejection such as JD inner code 403: the contract answers any union failure
 * without usable cache with 50304). Undefined for any other failure (global filter, 50001).
 */
function errorResponse(
  error: unknown,
  query: SearchProductsQuery,
  traceId: string,
  logger: Pick<RootLogger, 'warn'>,
): HttpException | undefined {
  if (error instanceof UnionError) {
    // Only the event, platform and code: the message may carry the upstream payload.
    logger.warn(
      { event: 'search_union_rejected', platform: query.platform, union_code: error.code },
      'search: union failure answered as 50304',
    );
    return new HttpException(
      { code: 50304, msg: MESSAGES[50304], data: { platform: query.platform }, trace_id: traceId },
      STATUS[50304]!,
    );
  }
  if (!(error instanceof CatalogError)) return undefined;
  const status = STATUS[error.code];
  if (status === undefined) return undefined;
  let msg: string = MESSAGES[error.code as 20001 | 30131 | 50304];
  let data: Record<string, unknown> | undefined;
  if (error.code === 20001) {
    data = { fields: fieldsOf(error.message) };
  } else if (error.code === 50304) {
    // data.platform, plus data.reason=search_disabled for the switch; never the cause.
    data = { ...error.data };
    if (error.data?.['reason'] === 'search_disabled') msg = MESSAGES.search_disabled;
  }
  return new HttpException(
    { code: error.code, msg, ...(data === undefined ? {} : { data }), trace_id: traceId },
    status,
  );
}

/**
 * Contract operation `searchProducts` (BR-PROD-07/08/10, BR-PRICE-08/15): x-auth optional; the
 * viewer comes from the request-scoped ViewerContext (a guest until identity is wired). The route
 * schema has validated and coerced the query; the use case owns every business check.
 * Nest metadata is applied below without decorator syntax: rule tests import CatalogModule, and
 * their TypeScript project accepts erasable syntax only.
 */
export class SearchController {
  readonly #service: CatalogSearchService;
  readonly #logger: RootLogger;

  constructor(service: CatalogSearchService, logger: RootLogger) {
    this.#service = service;
    this.#logger = logger;
  }

  async search(
    request: TracedRequest,
    query: SearchProductsQuery,
  ): Promise<SearchProductsResponse> {
    try {
      const data = await this.#service.search(query);
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error: unknown) {
      throw errorResponse(error, query, request.id, this.#logger) ?? error;
    }
  }
}

Controller('v1')(SearchController);
Inject(CatalogSearchService)(SearchController, undefined, 0);
Inject(ROOT_LOGGER)(SearchController, undefined, 1);
const searchMethod = Object.getOwnPropertyDescriptor(SearchController.prototype, 'search')!;
Get('products/search')(SearchController.prototype, 'search', searchMethod);
RouteSchema(contractRouteSchema('searchProducts'))(
  SearchController.prototype,
  'search',
  searchMethod,
);
Req()(SearchController.prototype, 'search', 0);
Query()(SearchController.prototype, 'search', 1);
