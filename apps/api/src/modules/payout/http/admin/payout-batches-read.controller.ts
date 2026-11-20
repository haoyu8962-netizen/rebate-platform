// B2-07g: GET /admin/v1/payout-batches and GET /admin/v1/payout-batches/{batch_id}
// (listAdminPayoutBatches, getAdminPayoutBatch, CT-24zzo; 08 BR-WDR-12, BR-WDR-14, BR-WDR-17; 04
// §11.1, §11.2). Only authorisation, the parameters and the call into application/ live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the query and the path before this runs. The
// AdminOperationGuard re-reads the account and checks the permission point: any one of
// payout.execute or fund.view, read only (no step-up); a super admin holds every point. Refusals
// of the reads (20001 data.fields) are thrown as error envelopes for the global filter; an unknown
// batch, one of another app and a batch_id that is no uuid answer alike (data.fields=[batch_id]).
// Answers are no-store; reading writes no audit record. Without the database the routes still
// register and every call fails closed (50001).
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminPayoutBatchFieldsError,
  getAdminPayoutBatch,
  listAdminPayoutBatches,
  type AdminPayoutBatchesReadDeps,
} from '../../application/admin-payout-batches-read.ts';

/** Nest token of the read dependencies (null in a process without the database). */
export const ADMIN_PAYOUT_BATCH_READS = Symbol('PAYOUT_ADMIN_PAYOUT_BATCH_READS');

/** specs/permissions.yaml: payout.execute, fund.view; either one suffices, read only. */
const READ = ['payout.execute', 'fund.view'] as const;

/** Contract AdminPage / AdminPageSize defaults. */
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/** The query of listAdminPayoutBatches after the route schema (integers and boolean coerced). */
export interface AdminPayoutBatchListParams {
  readonly page?: number;
  readonly page_size?: number;
  readonly kind?: Schema<'AdminPayoutBatchKind'>;
  readonly held?: boolean;
  readonly created_from?: string;
  readonly created_to?: string;
}

export interface AdminPayoutBatchesReadRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

export class AdminPayoutBatchesReadController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminPayoutBatchesReadDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminPayoutBatchesReadDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  list(
    request: AdminPayoutBatchesReadRequest,
    query: AdminPayoutBatchListParams,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayoutBatchPageResponse'>> {
    return this.#read(request, reply, (deps, appId) =>
      listAdminPayoutBatches(deps, appId, {
        page: query.page ?? DEFAULT_PAGE,
        pageSize: query.page_size ?? DEFAULT_PAGE_SIZE,
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.held === undefined ? {} : { held: query.held }),
        ...(query.created_from === undefined ? {} : { createdFrom: query.created_from }),
        ...(query.created_to === undefined ? {} : { createdTo: query.created_to }),
      }),
    );
  }

  detail(
    request: AdminPayoutBatchesReadRequest,
    batchId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayoutBatchDetailResponse'>> {
    return this.#read(request, reply, async (deps, appId) => {
      const batch = await getAdminPayoutBatch(deps, appId, batchId);
      if (batch === null) throw new AdminPayoutBatchFieldsError(['batch_id']);
      return batch;
    });
  }

  async #read<T>(
    request: AdminPayoutBatchesReadRequest,
    reply: HeaderReply,
    read: (deps: AdminPayoutBatchesReadDeps, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('payout: admin payout batch reads need the database');
      try {
        const data = await read(deps, actor.appId);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminPayoutBatchFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('payout: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminPayoutBatchesReadController.prototype;
  Inject(AdminOperationGuard)(AdminPayoutBatchesReadController, undefined, 0);
  Inject(ADMIN_PAYOUT_BATCH_READS)(AdminPayoutBatchesReadController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('payout-batches')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('listAdminPayoutBatches'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('batch_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('payout-batches/:batch_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('getAdminPayoutBatch'))(prototype, 'detail', detail);

  Controller('admin/v1')(AdminPayoutBatchesReadController);
}
