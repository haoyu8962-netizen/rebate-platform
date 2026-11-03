// B2-04zr: GET and POST /admin/v1/union-receipts and POST
// /admin/v1/union-receipts/{receipt_id}/reverse (adminListUnionReceipts, adminCreateUnionReceipt,
// adminReverseUnionReceipt; 08 BR-FUND-20 细则; 04 §11.1, §11.2). Only authorisation, the parameters
// and the call into application/admin-union-receipts.ts live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The AdminOperationGuard
// re-reads the account and checks the permission point: fund.cash_entry with the totp-tier
// X-Step-Up-Token for the writes (10003 data.tier=totp), fund.view without step-up for the list; a
// super admin holds every point. Inside the guard the writes run under platform idempotency (subject
// a:<admin_users.id>) and return the exact bytes to send, written raw here. Without the database,
// the event bus or the idempotency primitive the routes still register and every call fails closed
// (50001).
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
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  AdminUnionReceiptFieldsError,
  createAdminUnionReceipt,
  listAdminUnionReceipts,
  reverseAdminUnionReceipt,
  type AdminUnionReceiptDeps,
  type UnionReceiptListQuery,
  type UnionReceiptOperator,
} from '../../application/admin-union-receipts.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_UNION_RECEIPTS = Symbol('SETTLEMENT_ADMIN_UNION_RECEIPTS');

/** specs/permissions.yaml: fund.cash_entry, step-up tier totp (read by the guard). */
const WRITE = 'fund.cash_entry';
/** specs/permissions.yaml: fund.view, step-up null. */
const READ = 'fund.view';

export interface AdminUnionReceiptsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handlers write on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminUnionReceiptsRawReply {
  header(name: string, value: string): AdminUnionReceiptsRawReply;
  code(statusCode: number): AdminUnionReceiptsRawReply;
  type(contentType: string): AdminUnionReceiptsRawReply;
  send(payload: string): unknown;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

function idempotencyKey(request: AdminUnionReceiptsRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export class AdminUnionReceiptsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminUnionReceiptDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminUnionReceiptDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async list(
    request: AdminUnionReceiptsRequest,
    query: UnionReceiptListQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUnionReceiptPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminUnionReceiptPageResponse'> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('settlement: union receipts need the database');
      try {
        const data = await listAdminUnionReceipts(deps, actor.appId, query);
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminUnionReceiptFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) {
      throw new Error('settlement: admin guard returned without an answer');
    }
    return response;
  }

  create(
    request: AdminUnionReceiptsRequest,
    body: Schema<'AdminUnionReceiptCreateRequest'>,
    reply: AdminUnionReceiptsRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      createAdminUnionReceipt(deps, operator, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  reverse(
    request: AdminUnionReceiptsRequest,
    receiptId: string,
    body: Schema<'AdminUnionReceiptReverseRequest'>,
    reply: AdminUnionReceiptsRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      reverseAdminUnionReceipt(deps, operator, receiptId, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  async #write(
    request: AdminUnionReceiptsRequest,
    reply: AdminUnionReceiptsRawReply,
    write: (
      deps: AdminUnionReceiptDeps,
      operator: UnionReceiptOperator,
    ) => Promise<IdempotentResponse>,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: WRITE }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: union receipts need the database and idempotency');
      }
      sent = await write(deps, {
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
  const prototype = AdminUnionReceiptsController.prototype;
  Inject(AdminOperationGuard)(AdminUnionReceiptsController, undefined, 0);
  Inject(ADMIN_UNION_RECEIPTS)(AdminUnionReceiptsController, undefined, 1);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('union-receipts')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListUnionReceipts'))(prototype, 'list', list);

  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Res()(prototype, 'create', 2);
  Post('union-receipts')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateUnionReceipt'))(prototype, 'create', create);

  const reverse = Object.getOwnPropertyDescriptor(prototype, 'reverse')!;
  Req()(prototype, 'reverse', 0);
  Param('receipt_id')(prototype, 'reverse', 1);
  Body()(prototype, 'reverse', 2);
  Res()(prototype, 'reverse', 3);
  Post('union-receipts/:receipt_id/reverse')(prototype, 'reverse', reverse);
  HttpCode(200)(prototype, 'reverse', reverse);
  RouteSchema(contractRouteSchema('adminReverseUnionReceipt'))(prototype, 'reverse', reverse);

  Controller('admin/v1')(AdminUnionReceiptsController);
}
