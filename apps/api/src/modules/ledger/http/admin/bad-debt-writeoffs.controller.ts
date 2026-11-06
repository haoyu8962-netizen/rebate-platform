// B2-12f: GET /admin/v1/bad-debt-writeoffs and POST /admin/v1/bad-debt-writeoffs/{id}/approve
// (adminListBadDebtWriteoffs, adminApproveBadDebtWriteoff; 08 BR-FUND-12; 04 §11.1, §11.2). Only
// authorisation, the parameters and the call into application/bad-debt-writeoff.ts live here.
//
// Mounted only by LedgerBadDebtWriteoffModule.forAdmin on the admin entry; the route schema runs
// first. The list: any one of fund.writeoff or fund.view, read only (no step-up, no audit). The
// approval: fund.writeoff with the sms-tier X-Step-Up-Token (the guard; super admins too), then the
// use case under platform idempotency returns the exact bytes to send (the stored first answer on
// a replay). Without the database, the bus or idempotency the routes still register and every
// call fails closed (50001).
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
  AdminBadDebtWriteoffFieldsError,
  approveAdminBadDebtWriteoff,
  listAdminBadDebtWriteoffs,
  listQueryOf,
  type AdminBadDebtWriteoffApproveDeps,
  type AdminBadDebtWriteoffReadDeps,
} from '../../application/bad-debt-writeoff.ts';

/** Nest token of the read dependencies (null in a process without database). */
export const BAD_DEBT_WRITEOFF_READ_DEPS = Symbol('LEDGER_BAD_DEBT_WRITEOFF_READ_DEPS');
/** Nest token of the approval dependencies (null without database, bus or idempotency). */
export const BAD_DEBT_WRITEOFF_APPROVE_DEPS = Symbol('LEDGER_BAD_DEBT_WRITEOFF_APPROVE_DEPS');

/** specs/permissions.yaml: fund.writeoff (step-up sms) approves; fund.view only reads. */
const WRITEOFF = 'fund.writeoff';
const READ = ['fund.writeoff', 'fund.view'] as const;

export interface AdminBadDebtWriteoffsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** What the approval writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminBadDebtWriteoffsRawReply {
  code(statusCode: number): AdminBadDebtWriteoffsRawReply;
  type(contentType: string): AdminBadDebtWriteoffsRawReply;
  send(payload: string): unknown;
}

export interface AdminBadDebtWriteoffListRawQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly status?: string;
  readonly user_id?: string;
}

function header(request: AdminBadDebtWriteoffsRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminBadDebtWriteoffsController {
  readonly #guard: AdminOperationGuard;
  readonly #read: AdminBadDebtWriteoffReadDeps | null;
  readonly #approve: AdminBadDebtWriteoffApproveDeps | null;

  constructor(
    guard: AdminOperationGuard,
    read: AdminBadDebtWriteoffReadDeps | null,
    approve: AdminBadDebtWriteoffApproveDeps | null,
  ) {
    this.#guard = guard;
    this.#read = read;
    this.#approve = approve;
  }

  async list(
    request: AdminBadDebtWriteoffsRequest,
    query: AdminBadDebtWriteoffListRawQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminBadDebtWriteoffPageResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminBadDebtWriteoffPageResponse'> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#read;
      if (deps === null) throw new Error('ledger: bad debt write-off reads need the database');
      try {
        const data = await listAdminBadDebtWriteoffs(deps, listQueryOf(actor.appId, query ?? {}));
        response = {
          code: 0,
          msg: '',
          data: data as Schema<'AdminBadDebtWriteoffPage'>,
          trace_id: request.id,
        };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminBadDebtWriteoffFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('ledger: admin guard returned without an answer');
    return response;
  }

  async approve(
    request: AdminBadDebtWriteoffsRequest,
    id: string,
    body: Schema<'AdminEmptyActionRequest'>,
    reply: AdminBadDebtWriteoffsRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: WRITEOFF }, async (actor) => {
      const deps = this.#approve;
      if (deps === null) {
        throw new Error('ledger: write-off approval needs the database, event bus and idempotency');
      }
      sent = await approveAdminBadDebtWriteoff(deps, {
        appId: actor.appId,
        adminId: actor.adminId,
        candidateId: id,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        rawBody: body,
        key: header(request, 'idempotency-key'),
        traceId: request.id,
      });
      // The guard reads the code (it consumes the sms step-up token on success only).
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('ledger: admin guard returned without an answer');
    reply.code(sent.status).type('application/json; charset=utf-8').send(sent.body);
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminBadDebtWriteoffsController.prototype;
  Inject(AdminOperationGuard)(AdminBadDebtWriteoffsController, undefined, 0);
  Inject(BAD_DEBT_WRITEOFF_READ_DEPS)(AdminBadDebtWriteoffsController, undefined, 1);
  Inject(BAD_DEBT_WRITEOFF_APPROVE_DEPS)(AdminBadDebtWriteoffsController, undefined, 2);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('bad-debt-writeoffs')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListBadDebtWriteoffs'))(prototype, 'list', list);

  const approve = Object.getOwnPropertyDescriptor(prototype, 'approve')!;
  Req()(prototype, 'approve', 0);
  Param('id')(prototype, 'approve', 1);
  Body()(prototype, 'approve', 2);
  Res()(prototype, 'approve', 3);
  Post('bad-debt-writeoffs/:id/approve')(prototype, 'approve', approve);
  HttpCode(200)(prototype, 'approve', approve);
  RouteSchema(contractRouteSchema('adminApproveBadDebtWriteoff'))(prototype, 'approve', approve);

  Controller('admin/v1')(AdminBadDebtWriteoffsController);
}
