// B2-12c: GET /admin/v1/adjustments, GET /admin/v1/adjustments/{adjust_id} and POST
// /admin/v1/adjustments (adminListAdjustments, adminGetAdjustment, adminCreateAdjustment; 08
// BR-FUND-24; 04 §11.1, §11.2). Only authorisation, the parameters and the call into
// application/admin-adjustment.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry; the route schema runs first
// (D10-590 ⑥). Reads: any one of fund.adjust or fund.view, read only (no step-up, no audit).
// The submission: fund.adjust with the sms-tier X-Step-Up-Token (the guard; super admins too),
// then the use case under platform idempotency returns the exact bytes to send. A refusal of the
// permission point (10403) writes one audit record adjustment_denied outside any business
// transaction (BR-FUND-24 例（无权限）) and is then thrown on unchanged; a failing audit write
// never turns the refusal into an allowed operation. Without the database the routes still
// register and every call fails closed (50001).
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
  adminPrincipal,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  ADJUSTMENT_DENIED_ACTION,
  AdminAdjustmentFieldsError,
  createAdminAdjustment,
  createInputOf,
  getAdminAdjustment,
  listAdminAdjustments,
  listQueryOf,
  type AdminAdjustmentCreateDeps,
  type AdminAdjustmentReadDeps,
} from '../../application/admin-adjustment.ts';

/** Nest token of the read dependencies (null in a process without database). */
export const ADJUSTMENT_READ_DEPS = Symbol('LEDGER_ADJUSTMENT_READ_DEPS');
/** Nest token of the submission dependencies (null without database, bus or idempotency). */
export const ADJUSTMENT_CREATE_DEPS = Symbol('LEDGER_ADJUSTMENT_CREATE_DEPS');

/** specs/permissions.yaml: fund.adjust (step-up sms) files; fund.view only reads. */
const ADJUST = 'fund.adjust';
const READ = ['fund.adjust', 'fund.view'] as const;

export interface AdminAdjustmentsRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** What the submission writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminAdjustmentsRawReply {
  code(statusCode: number): AdminAdjustmentsRawReply;
  type(contentType: string): AdminAdjustmentsRawReply;
  send(payload: string): unknown;
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

export interface AdminAdjustmentListRawQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly reason_code?: string;
  readonly status?: string;
  readonly user_id?: string;
}

function header(request: AdminAdjustmentsRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function ipOf(request: AdminAdjustmentsRequest): string | null {
  return typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null;
}

/** The 10403 the guard throws for a missing permission point. */
function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof HttpException)) return false;
  const body = error.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === 10403;
}

/** The ids of the request, for the denied audit record (no personal data, no note). */
function deniedTarget(body: unknown): Record<string, string> {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of ['user_id', 'reverses_adjust_id', 'direction', 'reason_code']) {
    if (typeof raw[name] === 'string') out[name] = raw[name] as string;
  }
  if (typeof raw['amount_fen'] === 'number') out['amount_fen'] = String(raw['amount_fen']);
  return out;
}

export class AdminAdjustmentsController {
  readonly #guard: AdminOperationGuard;
  readonly #read: AdminAdjustmentReadDeps | null;
  readonly #create: AdminAdjustmentCreateDeps | null;

  constructor(
    guard: AdminOperationGuard,
    read: AdminAdjustmentReadDeps | null,
    create: AdminAdjustmentCreateDeps | null,
  ) {
    this.#guard = guard;
    this.#read = read;
    this.#create = create;
  }

  list(
    request: AdminAdjustmentsRequest,
    query: AdminAdjustmentListRawQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAdjustmentPageResponse'>> {
    return this.#reading(request, reply, (deps, appId) =>
      listAdminAdjustments(deps, listQueryOf(appId, query ?? {})),
    );
  }

  detail(
    request: AdminAdjustmentsRequest,
    adjustId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAdjustmentDetailResponse'>> {
    return this.#reading(request, reply, (deps, appId) =>
      getAdminAdjustment(deps, { appId, adjustId }),
    );
  }

  async create(
    request: AdminAdjustmentsRequest,
    body: Schema<'AdminAdjustmentCreateRequest'>,
    reply: AdminAdjustmentsRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    try {
      await this.#guard.run({ request, permission: ADJUST }, async (actor) => {
        const deps = this.#create;
        if (deps === null) {
          throw new Error('ledger: adjustments need the database, event bus and idempotency');
        }
        sent = await createAdminAdjustment(deps, {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: ipOf(request),
          body: createInputOf(body),
          rawBody: body,
          key: header(request, 'idempotency-key'),
          traceId: request.id,
        });
        // The guard reads the code (it consumes the sms step-up token on success only).
        return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
      });
    } catch (error: unknown) {
      if (isPermissionDenied(error)) await this.#auditDenied(request, body);
      throw error;
    }
    if (sent === undefined) throw new Error('ledger: admin guard returned without an answer');
    reply.code(sent.status).type('application/json; charset=utf-8').send(sent.body);
  }

  /** BR-FUND-24 例（无权限）: one adjustment_denied record; its failure never allows anything. */
  async #auditDenied(request: AdminAdjustmentsRequest, body: unknown): Promise<void> {
    const deps = this.#create;
    const principal = adminPrincipal(request);
    if (deps === null || principal === undefined) return;
    try {
      await deps.auditOn(deps.db).append({
        appId: principal.appId,
        actor: principal.adminId,
        action: ADJUSTMENT_DENIED_ACTION,
        target: null,
        before: null,
        after: { permission: ADJUST, ...deniedTarget(body) },
        ip: ipOf(request),
      });
    } catch {
      // The refusal stands whatever happens to its audit record (the 10403 is rethrown).
    }
  }

  async #reading<T>(
    request: AdminAdjustmentsRequest,
    reply: HeaderReply,
    read: (deps: AdminAdjustmentReadDeps, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#read;
      if (deps === null) throw new Error('ledger: admin adjustment reads need the database');
      try {
        response = { code: 0, msg: '', data: await read(deps, actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminAdjustmentFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) throw new Error('ledger: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminAdjustmentsController.prototype;
  Inject(AdminOperationGuard)(AdminAdjustmentsController, undefined, 0);
  Inject(ADJUSTMENT_READ_DEPS)(AdminAdjustmentsController, undefined, 1);
  Inject(ADJUSTMENT_CREATE_DEPS)(AdminAdjustmentsController, undefined, 2);

  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('adjustments')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListAdjustments'))(prototype, 'list', list);

  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('adjust_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('adjustments/:adjust_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetAdjustment'))(prototype, 'detail', detail);

  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Res()(prototype, 'create', 2);
  Post('adjustments')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreateAdjustment'))(prototype, 'create', create);

  Controller('admin/v1')(AdminAdjustmentsController);
}
