// B1-29b: GET /v1/products/{product_key}/price-trend (contract getProductPriceTrend, CT-22a).
// Rule tests: test/spec/catalog/price-trend-route/**.
import { Controller, Get, HttpException, Inject, Param, Query, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { ProductKeyInvalid, splitProductKey } from '@couli/domain';
import { fenToJsonNumber } from '@couli/money';
import { contractRouteSchema } from '../../../platform/index.ts';
import type { Catalog } from '../../domain/types.ts';
import { getPriceTrend } from '../../price-trend/read.ts';
import type { PriceTrendOptions } from '../../price-trend/types.ts';

type ProductPriceTrendResponse = Schema<'ProductPriceTrendResponse'>;

/** Nest injection token of the price trend ports (built once per process by CatalogModule). */
export const PRICE_TREND = Symbol('CATALOG_PRICE_TREND');

/** What the route reads: the platform dictionary and B1-29a's read options (store, clock, config). */
export interface PriceTrendPorts {
  readonly catalog: Pick<Catalog, 'listPlatforms'>;
  readonly options: PriceTrendOptions;
}

interface PriceTrendRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** X-App-Id, required and validated by the route schema. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** Query of the contract operation (the route schema rejects any other field). */
interface PriceTrendQueryParams {
  readonly platform: string;
}

/** 20001 naming product_key (BR-TEXT-14 fallback text; same wording as the detail route). */
function invalidProductKey(traceId: string): HttpException {
  return new HttpException(
    {
      code: 20001,
      msg: '填写内容有误，请检查',
      data: { fields: ['product_key'] },
      trace_id: traceId,
    },
    400,
  );
}

/**
 * Contract operation `getProductPriceTrend` (x-auth none; BR-WATCH-05, BR-PROD-03, BR-TEXT-11).
 * The route schema has validated the path, the query `platform` (enum) and the headers. The key
 * must parse against the platform dictionary (same check as the detail route) and belong to the
 * queried platform, else 20001 with fields [product_key]. The read scope is the request's app
 * (X-App-Id), the query platform and the path key; no user identifier is read, so a guest and a
 * member get the same answer. Amounts go out through fenToJsonNumber (above 2^53 throws → 50001
 * by the global filter). Separate from the detail route: the detail never calls this.
 * Nest metadata is applied below without decorator syntax (same as ProductController).
 */
export class PriceTrendController {
  readonly #ports: PriceTrendPorts;

  constructor(ports: PriceTrendPorts) {
    this.#ports = ports;
  }

  async get(
    request: PriceTrendRequest,
    productKey: string,
    query: PriceTrendQueryParams,
  ): Promise<ProductPriceTrendResponse> {
    const appId = request.headers['x-app-id'];
    if (typeof appId !== 'string' || appId === '') {
      throw new Error('catalog: price trend request carries no app scope');
    }
    const rows = await this.#ports.catalog.listPlatforms();
    try {
      // BR-PROD-02 format → registered prefix → prefix of the queried platform.
      splitProductKey(
        productKey,
        rows.map((row) => ({
          platform: row.code,
          keyPrefix: row.key_prefix,
          parseEnabled: true,
          searchEnabled: true,
        })),
        query.platform,
      );
    } catch (error: unknown) {
      if (error instanceof ProductKeyInvalid) throw invalidProductKey(request.id);
      throw error;
    }

    const trend = await getPriceTrend(this.#ports.options, {
      appId,
      platform: query.platform,
      productKey,
    });
    return {
      code: 0,
      msg: '',
      data: {
        status: trend.status,
        points: trend.points.map((point) => ({
          date: point.date,
          final_price_fen: fenToJsonNumber(point.final_price_fen),
        })),
        start_date: trend.start_date,
        window_days: trend.window_days,
        source_key: trend.source_key,
        // B1-29c (CT-22e): null exactly when no_data; same int64 serialization as the points.
        mode_price_fen:
          trend.mode_price_fen === null ? null : fenToJsonNumber(trend.mode_price_fen),
      },
      trace_id: request.id,
    };
  }
}

Controller('v1')(PriceTrendController);
Inject(PRICE_TREND)(PriceTrendController, undefined, 0);
const getMethod = Object.getOwnPropertyDescriptor(PriceTrendController.prototype, 'get')!;
Get('products/:product_key/price-trend')(PriceTrendController.prototype, 'get', getMethod);
RouteSchema(contractRouteSchema('getProductPriceTrend'))(
  PriceTrendController.prototype,
  'get',
  getMethod,
);
Req()(PriceTrendController.prototype, 'get', 0);
Param('product_key')(PriceTrendController.prototype, 'get', 1);
Query()(PriceTrendController.prototype, 'get', 2);
