// /admin/v1/product-pools* (B1-05q, CT-07d; contract adminListProductPools, adminCreateProductPool,
// adminSearchPoolCandidates, adminGetProductPool, adminUpdateProductPool, adminListPoolItems,
// adminAddPoolItem, adminUpdatePoolItem, adminRemovePoolItem). 04 §11.2 content.pool, step-up 「–」:
// the four reads pass `readOnly: true`. The contract's route schema has validated the query and
// the body (20001) before a handler runs; each handler runs inside platform's AdminOperationGuard,
// so nothing is read before the permission passes; the app and admin are the guard's actor, never
// request fields. Served by the admin entry only (CatalogAdminModule).
//
// Nest's decorators are applied as plain calls below (not decorator syntax), as in
// content's articles.controller.ts.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  PoolAdmin,
  PoolConflictError,
  PoolFieldsError,
  PoolNotFoundError,
  type PoolAdminActor,
  type PoolItemListQuery,
  type PoolListQuery,
} from '../../application/pool-admin.ts';
import type { PoolCandidateQuery } from '../../application/pool-candidates.ts';
import { PoolCategoryBlockedError } from '../../application/pool-category.ts';
import { PoolManyProductsError } from '../../application/pool-source.ts';
import { CatalogError } from '../../domain/rules.ts';

export interface PoolAdminRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** Client address as resolved by platform's trusted-proxy setting (audit only). */
  readonly ip?: string;
}

type Envelope<T> = { code: 0; msg: string; data: T; trace_id: string };

const PERMISSION = 'content.pool';

/** Statuses of contracts/error-codes.yaml and fallback texts; clients show their dictionary. */
const REFUSALS: Readonly<Record<number, { readonly status: number; readonly msg: string }>> = {
  20001: { status: 400, msg: '参数校验失败' },
  30131: { status: 422, msg: '暂时无法识别这个商品，试试用商品名搜索' },
  30132: { status: 422, msg: '未识别到商品，请检查链接或口令' },
  30141: { status: 422, msg: '商品已下架' },
  30143: { status: 422, msg: '商品信息已失效，请重新搜索' },
  30147: { status: 422, msg: '该商品所在类目已被禁售，不能加入商品池' },
  50304: { status: 503, msg: '搜索暂不可用，请稍后再试' },
  50401: { status: 504, msg: '网络繁忙，请稍后再试' },
};

export class AdminProductPoolsController {
  readonly #guard: AdminOperationGuard;
  readonly #pools: PoolAdmin;

  constructor(guard: AdminOperationGuard, pools: PoolAdmin) {
    this.#guard = guard;
    this.#pools = pools;
  }

  /** adminListProductPools. */
  list(
    request: PoolAdminRequest,
    query: PoolListQuery,
  ): Promise<Envelope<Schema<'AdminProductPoolList'>>> {
    return this.#run(request, true, (actor) => this.#pools.listPools(actor.appId, query ?? {}));
  }

  /** adminCreateProductPool. */
  create(
    request: PoolAdminRequest,
    body: Schema<'AdminProductPoolCreateRequest'>,
  ): Promise<Envelope<Schema<'AdminProductPool'>>> {
    return this.#run(request, false, (actor) =>
      this.#pools.createPool(writerOf(actor, request), body),
    );
  }

  /** adminSearchPoolCandidates. */
  candidates(
    request: PoolAdminRequest,
    query: PoolCandidateQuery,
  ): Promise<Envelope<Schema<'AdminPoolCandidateList'>>> {
    return this.#run(request, true, (actor) => this.#pools.searchCandidates(actor, query));
  }

  /** adminGetProductPool. */
  detail(request: PoolAdminRequest, poolId: string): Promise<Envelope<Schema<'AdminProductPool'>>> {
    return this.#run(request, true, (actor) => this.#pools.getPool(actor.appId, poolId));
  }

  /** adminUpdateProductPool. */
  update(
    request: PoolAdminRequest,
    poolId: string,
    body: Schema<'AdminProductPoolUpdateRequest'>,
  ): Promise<Envelope<Schema<'AdminProductPool'>>> {
    return this.#run(request, false, (actor) =>
      this.#pools.updatePool(writerOf(actor, request), poolId, body),
    );
  }

  /** adminListPoolItems. */
  items(
    request: PoolAdminRequest,
    poolId: string,
    query: PoolItemListQuery,
  ): Promise<Envelope<Schema<'AdminPoolItemList'>>> {
    return this.#run(request, true, (actor) =>
      this.#pools.listItems(actor.appId, poolId, query ?? {}),
    );
  }

  /** adminAddPoolItem. */
  addItem(
    request: PoolAdminRequest,
    poolId: string,
    body: Schema<'AdminPoolItemAddRequest'>,
  ): Promise<Envelope<Schema<'AdminPoolItem'>>> {
    return this.#run(request, false, (actor) =>
      this.#pools.addItem(writerOf(actor, request), poolId, body),
    );
  }

  /** adminUpdatePoolItem. */
  updateItem(
    request: PoolAdminRequest,
    poolId: string,
    productKey: string,
    body: Schema<'AdminPoolItemUpdateRequest'>,
  ): Promise<Envelope<Schema<'AdminPoolItem'>>> {
    return this.#run(request, false, (actor) =>
      this.#pools.updateItem(writerOf(actor, request), poolId, productKey, body),
    );
  }

  /** adminRemovePoolItem. */
  removeItem(
    request: PoolAdminRequest,
    poolId: string,
    productKey: string,
  ): Promise<Envelope<Schema<'AdminPoolItem'>>> {
    return this.#run(request, false, (actor) =>
      this.#pools.removeItem(writerOf(actor, request), poolId, productKey),
    );
  }

  async #run<T>(
    request: PoolAdminRequest,
    readOnly: boolean,
    work: (actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    let response: Envelope<T> | undefined;
    await this.#guard.run(
      readOnly
        ? { request, permission: PERMISSION, readOnly: true }
        : { request, permission: PERMISSION },
      async (actor) => {
        try {
          const data = await work(actor);
          response = { code: 0, msg: '', data, trace_id: request.id };
          return { statusCode: 200, body: response };
        } catch (error) {
          throw refusal(error, request.id);
        }
      },
    );
    if (response === undefined) throw new Error('catalog: admin guard returned without the call');
    return response;
  }
}

/** The guard's verified actor; the request contributes only its address for the audit row. */
function writerOf(actor: AdminActor, request: PoolAdminRequest): PoolAdminActor {
  return {
    appId: actor.appId,
    adminId: actor.adminId,
    ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
  };
}

function fieldsRefusal(fields: readonly string[], traceId: string): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException(refused.body, refused.statusCode);
}

/** The contract's refusals; anything else rethrown (50001). */
export function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof PoolFieldsError) return fieldsRefusal(error.fields, traceId);
  if (error instanceof PoolManyProductsError) return fieldsRefusal(['link_text'], traceId);
  if (error instanceof PoolConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'product_pool' },
        trace_id: traceId,
      },
      409,
    );
  }
  if (error instanceof PoolNotFoundError) {
    return new HttpException({ code: 30701, msg: '内容不存在', trace_id: traceId }, 404);
  }
  if (error instanceof PoolCategoryBlockedError) {
    // CT-26zf: 30147 carries no data.
    const blocked = REFUSALS[30147]!;
    return new HttpException({ code: 30147, msg: blocked.msg, trace_id: traceId }, blocked.status);
  }
  if (error instanceof CatalogError) {
    // searchProducts' only 20001 on this route: q and platform passed the route schema.
    if (error.code === 20001) return fieldsRefusal(['cursor'], traceId);
    const known = REFUSALS[error.code];
    if (known === undefined) return error;
    return new HttpException(
      {
        code: error.code,
        msg: known.msg,
        ...(error.code === 50304 ? { data: { ...error.data } } : {}),
        trace_id: traceId,
      },
      known.status,
    );
  }
  return error;
}

{
  const prototype = AdminProductPoolsController.prototype;
  const ITEM = ':pool_id/items/:product_key';
  const routes = [
    ['list', 'Get', '', 'adminListProductPools', ['query']],
    ['create', 'Post', '', 'adminCreateProductPool', ['body']],
    ['candidates', 'Get', 'candidates', 'adminSearchPoolCandidates', ['query']],
    ['detail', 'Get', ':pool_id', 'adminGetProductPool', ['pool_id']],
    ['update', 'Patch', ':pool_id', 'adminUpdateProductPool', ['pool_id', 'body']],
    ['items', 'Get', ':pool_id/items', 'adminListPoolItems', ['pool_id', 'query']],
    ['addItem', 'Post', ':pool_id/items', 'adminAddPoolItem', ['pool_id', 'body']],
    ['updateItem', 'Patch', ITEM, 'adminUpdatePoolItem', ['pool_id', 'product_key', 'body']],
    ['removeItem', 'Delete', ITEM, 'adminRemovePoolItem', ['pool_id', 'product_key']],
  ] as const;
  const verbs = { Get, Post, Patch, Delete };
  Inject(AdminOperationGuard)(AdminProductPoolsController, undefined, 0);
  Inject(PoolAdmin)(AdminProductPoolsController, undefined, 1);
  for (const [name, method, path, operationId, args] of routes) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
    Req()(prototype, name, 0);
    args.forEach((arg, index) => {
      if (arg === 'query') Query()(prototype, name, index + 1);
      else if (arg === 'body') Body()(prototype, name, index + 1);
      else Param(arg)(prototype, name, index + 1);
    });
    verbs[method](path)(prototype, name, descriptor);
    if (method === 'Post') HttpCode(200)(prototype, name, descriptor);
    RouteSchema(contractRouteSchema(operationId))(prototype, name, descriptor);
  }
  Controller('admin/v1/product-pools')(AdminProductPoolsController);
}
