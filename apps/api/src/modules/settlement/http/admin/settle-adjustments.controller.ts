// B2-09zc (CT-24zv; D10-769, D10-770): the 补差批次 console — GET /admin/v1/settle-adjustments
// (fund.settle_adjust or fund.view, read only, no step-up, no audit), POST
// /admin/v1/settle-adjust-batches/{batch_id}/approve and /reject (fund.settle_adjust, step-up totp,
// Idempotency-Key). Only authorisation, the parameters and the call into adjust/approve.ts live
// here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema (query, path, body, headers) before this runs; the
// AdminOperationGuard re-reads the account and checks the permission point (a super admin holds
// every point) and, for the writes, the step-up tier. The writes return the exact bytes to send
// (the stored first answer on a replay), so the reply is written raw; the token is consumed only on
// code 0. Without the database or the idempotency primitive (isolated HTTP unit tests) the routes
// still register and every call fails closed (50001).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  approveSettleAdjustBatch,
  listSettleAdjustments,
  rejectSettleAdjustBatch,
  type SettleAdjustAnswer,
  type SettleAdjustDecisionDeps,
  type SettleAdjustOperator,
} from '../../adjust/approve.ts';
import {
  createSettleAdjustBodyValidators,
  withoutBody,
  type BodyValidator,
} from './settle-adjustments.validation.ts';

/** A canonical UUID (the contract's Id is a UUIDv7 string; anything else names no batch). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nest token of the use case dependencies (null without database or idempotency). */
export const ADMIN_SETTLE_ADJUSTMENTS = Symbol('SETTLEMENT_ADMIN_SETTLE_ADJUSTMENTS');

/** specs/permissions.yaml: fund.settle_adjust (step-up totp) for the writes. */
const WRITE = 'fund.settle_adjust';
/** The list: either point (both read without step-up). */
const READ = ['fund.settle_adjust', 'fund.view'] as const;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export interface AdminSettleAdjustmentsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface AdminSettleAdjustmentsListQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: Schema<'AdminSettleAdjustmentStatus'>;
  readonly batch_id?: string;
}

/** What the write handlers send on the Fastify reply (the use case's exact bytes). */
export interface AdminSettleAdjustmentsRawReply {
  header(name: string, value: string): AdminSettleAdjustmentsRawReply;
  code(statusCode: number): AdminSettleAdjustmentsRawReply;
  type(contentType: string): AdminSettleAdjustmentsRawReply;
  send(payload: string): unknown;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

function header(request: AdminSettleAdjustmentsRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminSettleAdjustmentsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: SettleAdjustDecisionDeps | null;
  readonly #bodies = createSettleAdjustBodyValidators();

  constructor(guard: AdminOperationGuard, deps: SettleAdjustDecisionDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async list(
    request: AdminSettleAdjustmentsRequest,
    query: AdminSettleAdjustmentsListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminSettleAdjustmentPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminSettleAdjustmentPageResponse'> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null)
        throw new Error('settlement: the settle adjustment list needs the database');
      if (query.batch_id !== undefined && !UUID.test(query.batch_id)) {
        const refused = fieldsErrorEnvelope(['batch_id'], request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      const data = await listSettleAdjustments(deps, actor.appId, {
        page: query.page ?? DEFAULT_PAGE,
        pageSize: query.page_size ?? DEFAULT_PAGE_SIZE,
        status: query.status,
        batchId: query.batch_id,
      });
      response = { code: 0, msg: '', data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined)
      throw new Error('settlement: admin guard returned without an answer');
    return response;
  }

  approve(
    request: AdminSettleAdjustmentsRequest,
    batchId: string,
    body: Schema<'AdminEmptyActionRequest'>,
    reply: AdminSettleAdjustmentsRawReply,
  ): Promise<void> {
    return this.#write(request, reply, body, this.#bodies.approve, batchId, (deps, operator) =>
      approveSettleAdjustBatch(deps, operator, {
        batchId,
        body,
        key: header(request, 'idempotency-key'),
        traceId: request.id,
      }),
    );
  }

  reject(
    request: AdminSettleAdjustmentsRequest,
    batchId: string,
    body: Schema<'AdminAdjustmentRejectRequest'>,
    reply: AdminSettleAdjustmentsRawReply,
  ): Promise<void> {
    return this.#write(request, reply, body, this.#bodies.reject, batchId, (deps, operator) =>
      rejectSettleAdjustBatch(deps, operator, {
        batchId,
        body,
        key: header(request, 'idempotency-key'),
        traceId: request.id,
      }),
    );
  }

  async #write(
    request: AdminSettleAdjustmentsRequest,
    reply: AdminSettleAdjustmentsRawReply,
    body: unknown,
    validate: BodyValidator,
    batchId: string,
    work: (
      deps: SettleAdjustDecisionDeps,
      operator: SettleAdjustOperator,
    ) => Promise<SettleAdjustAnswer>,
  ): Promise<void> {
    let sent: SettleAdjustAnswer | undefined;
    await this.#guard.run({ request, permission: WRITE }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: settle adjust decisions need the database and idempotency');
      }
      // The contract's order: permission → step-up (the guard) → body → batch_id.
      const fields = validate(body) ?? (UUID.test(batchId) ? null : ['batch_id']);
      if (fields !== null) {
        const refused = fieldsErrorEnvelope(fields, request.id);
        sent = { status: refused.statusCode, body: JSON.stringify(refused.body) };
        return { statusCode: sent.status, body: refused.body };
      }
      sent = await work(deps, {
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      });
      // The guard reads the code and consumes the step-up token on 0; the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('settlement: admin guard returned without an answer');
    reply
      .header('Cache-Control', 'no-store')
      .code(sent.status)
      .type('application/json; charset=utf-8')
      .send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminSettleAdjustmentsController.prototype;
  Inject(AdminOperationGuard)(AdminSettleAdjustmentsController, undefined, 0);
  Inject(ADMIN_SETTLE_ADJUSTMENTS)(AdminSettleAdjustmentsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('settle-adjustments')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListSettleAdjustments'))(prototype, 'list', list);

  const write = (
    method: 'approve' | 'reject',
    path: string,
    operationId: 'adminApproveSettleAdjustBatch' | 'adminRejectSettleAdjustBatch',
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    Req()(prototype, method, 0);
    Param('batch_id')(prototype, method, 1);
    Body()(prototype, method, 2);
    Res()(prototype, method, 3);
    Post(path)(prototype, method, descriptor);
    HttpCode(200)(prototype, method, descriptor);
    RouteSchema(withoutBody(operationId))(prototype, method, descriptor);
  };
  write('approve', 'settle-adjust-batches/:batch_id/approve', 'adminApproveSettleAdjustBatch');
  write('reject', 'settle-adjust-batches/:batch_id/reject', 'adminRejectSettleAdjustBatch');

  Controller('admin/v1')(AdminSettleAdjustmentsController);
}
