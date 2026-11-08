// B1-06zg: contract operation openProductShop (POST /v1/products/{product_key}/shop/open): x-auth
// login, x-signed, x-idempotent, version gate — all applied by the platform from the contract
// before this controller runs. The body has no scene, no no_rebate and no identity field
// (BR-ATTR-05 / BR-ATTR-08 / BR-ID-18 进店例外); identity comes from the server-side CallerContext
// inside the use case. Use-case refusals keep their code and HTTP status.
import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema } from '../../../platform/index.ts';
import { ShopOpenService, type ShopOpenInput } from '../../application/shop-open.ts';

type ShopOpenResponse = Schema<'ShopOpenResponse'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
export interface ShopOpenHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: { readonly product_key: string };
  readonly body: Schema<'ShopOpenRequest'>;
}

function header(request: ShopOpenHttpRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * Nest's decorators are applied as plain calls below (not decorator syntax), as the open's
 * controller: linking's index is reachable from the test project.
 */
export class ShopOpenController {
  readonly #shops: ShopOpenService;

  constructor(shops: ShopOpenService) {
    this.#shops = shops;
  }

  async open(request: ShopOpenHttpRequest): Promise<ShopOpenResponse> {
    const body = request.body;
    const result = await this.#shops.open({
      productKey: request.params.product_key,
      body: {
        platform: body.platform,
        ...(body.item_ref === undefined ? {} : { item_ref: body.item_ref }),
        installed: body.installed ?? 'unknown',
      },
      idempotencyKey: header(request, 'idempotency-key'),
      // The caller's X-Trace-Id (schema-checked) when given, else the id genReqId assigned.
      traceId: header(request, 'x-trace-id') || request.id,
      client: header(request, 'x-platform') as ShopOpenInput['client'],
    });
    if (result.status === 200 && result.envelope.code === 0) {
      return result.envelope as unknown as ShopOpenResponse;
    }
    throw new HttpException(result.envelope, result.status);
  }
}

{
  const prototype = ShopOpenController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'open')!;
  Inject(ShopOpenService)(ShopOpenController, undefined, 0);
  Req()(prototype, 'open', 0);
  Post('products/:product_key/shop/open')(prototype, 'open', descriptor);
  HttpCode(200)(prototype, 'open', descriptor);
  RouteSchema(contractRouteSchema('openProductShop'))(prototype, 'open', descriptor);
  Controller('v1')(ShopOpenController);
}
