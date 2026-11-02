// B1-10n: POST / GET /admin/v1/rights-imports and GET /admin/v1/rights-imports/{import_id} (contract
// adminCreateRightsImport, adminListRightsImports, adminGetRightsImport). Mounted only by
// OrdersAdminModule on the admin entry; authorisation, the multipart body and the use cases are
// AdminRightsImportsHttp's. Without the database or the job queue the routes still register, and an
// authorised call fails closed (50001). The reads are no-store.
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
} from '../../../platform/index.ts';
import type { RightsImportDeps, RightsImportPageQuery } from '../../application/rights-imports.ts';
import {
  AdminRightsImportsHttp,
  type RightsImportReadRequest,
  type RightsImportRequest,
} from './rights-imports.http.ts';

/** Nest token of the use case dependencies (null in a process without database or queue). */
export const ADMIN_RIGHTS_IMPORTS = Symbol('ORDERS_ADMIN_RIGHTS_IMPORTS');

type ReadRequest = RightsImportReadRequest & CheckedRequest;

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminRightsImportsController {
  readonly #guard: AdminOperationGuard;
  readonly #http: AdminRightsImportsHttp | null;

  constructor(guard: AdminOperationGuard, imports: RightsImportDeps | null) {
    this.#guard = guard;
    this.#http = imports === null ? null : new AdminRightsImportsHttp({ guard, imports });
  }

  create(
    request: RightsImportRequest & CheckedRequest,
  ): Promise<Schema<'AdminRightsImportCreateResponse'>> {
    return this.#http === null ? this.unavailable(request, false) : this.#http.create(request);
  }

  list(
    request: ReadRequest,
    query: RightsImportPageQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminRightsImportPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    return this.#http === null ? this.unavailable(request, true) : this.#http.list(request, query);
  }

  detail(
    request: ReadRequest,
    importId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminRightsImportDetailResponse'>> {
    reply.header('Cache-Control', 'no-store');
    return this.#http === null
      ? this.unavailable(request, true)
      : this.#http.detail(request, importId);
  }

  /** The guard answers first: only an authorised call reaches the 50001. */
  private async unavailable(request: CheckedRequest, readOnly: boolean): Promise<never> {
    await this.#guard.run({ request, permission: 'order.claim', readOnly }, () => {
      throw new Error('orders: rights imports need the database and the job queue');
    });
    throw new Error('orders: admin guard returned without an answer');
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminRightsImportsController.prototype;
  Inject(AdminOperationGuard)(AdminRightsImportsController, undefined, 0);
  Inject(ADMIN_RIGHTS_IMPORTS)(AdminRightsImportsController, undefined, 1);
  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Post('')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateRightsImport'))(prototype, 'create', create);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListRightsImports'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('import_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get(':import_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetRightsImport'))(prototype, 'detail', detail);
  Controller('admin/v1/rights-imports')(AdminRightsImportsController);
}
