// B2-09l: POST /admin/v1/payout-batches and GET /admin/v1/payout-overview (adminCreatePayoutBatch,
// adminGetPayoutOverview; 08 BR-WDR-11, BR-WDR-12, BR-WDR-18; 04 §11.2). Only authorisation, the
// parameters and the call into application/ live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks the permission point (a super admin holds every point). The batch takes
// payout.execute with the totp-tier X-Step-Up-Token (10003 data.tier=totp) and runs under platform
// idempotency (subject a:<admin_users.id>), its exact bytes written raw here. The overview takes
// payout.execute or fund.view, read only. Without the database, the event bus, the queue or the
// idempotency primitive the routes still register and every call fails closed (50001).
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  createAdminPayoutBatch,
  type AdminPayoutBatchDeps,
} from '../../application/admin-payout-batch.ts';
import {
  getAdminPayoutOverview,
  type AdminPayoutOverviewDeps,
} from '../../application/admin-payout-overview.ts';

/** Nest tokens of the use case dependencies (null in a process without the database). */
export const ADMIN_PAYOUT_BATCH = Symbol('PAYOUT_ADMIN_PAYOUT_BATCH');
export const ADMIN_PAYOUT_OVERVIEW = Symbol('PAYOUT_ADMIN_PAYOUT_OVERVIEW');

/** specs/permissions.yaml: payout.execute, step-up tier totp (read by the guard). */
const EXECUTE = 'payout.execute';
/** The overview: either point suffices, read only and without step-up. */
const OVERVIEW = ['payout.execute', 'fund.view'] as const;

export interface AdminPayoutBatchRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handlers write on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminPayoutBatchRawReply {
  header(name: string, value: string): AdminPayoutBatchRawReply;
  code(statusCode: number): AdminPayoutBatchRawReply;
  type(contentType: string): AdminPayoutBatchRawReply;
  send(payload: string): unknown;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminPayoutBatchController {
  readonly #guard: AdminOperationGuard;
  readonly #batch: AdminPayoutBatchDeps | null;
  readonly #overview: AdminPayoutOverviewDeps | null;

  constructor(
    guard: AdminOperationGuard,
    batch: AdminPayoutBatchDeps | null,
    overview: AdminPayoutOverviewDeps | null,
  ) {
    this.#guard = guard;
    this.#batch = batch;
    this.#overview = overview;
  }

  async create(
    request: AdminPayoutBatchRequest,
    body: Schema<'AdminPayoutBatchCreateRequest'>,
    reply: AdminPayoutBatchRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: EXECUTE }, async (actor) => {
      const deps = this.#batch;
      if (deps === null) {
        throw new Error('payout: the batch needs the database, the queue and idempotency');
      }
      const key = request.headers['idempotency-key'];
      sent = await createAdminPayoutBatch(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        { body, key: typeof key === 'string' ? key : undefined, traceId: request.id },
      );
      // The guard reads the code and consumes the step-up token on 0; the bytes are sent below.
      return { statusCode: sent.status, body: JSON.parse(sent.body) as { code: number } };
    });
    if (sent === undefined) throw new Error('payout: admin guard returned without an answer');
    reply
      .header('Cache-Control', 'no-store')
      .code(sent.status)
      .type('application/json; charset=utf-8')
      .send(sent.body);
  }

  async overview(
    request: AdminPayoutBatchRequest,
    reply: HeaderReply,
  ): Promise<Schema<'AdminPayoutOverviewResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminPayoutOverviewResponse'> | undefined;
    await this.#guard.run({ request, permission: OVERVIEW, readOnly: true }, async (actor) => {
      const deps = this.#overview;
      if (deps === null) throw new Error('payout: the overview needs the database');
      response = {
        code: 0,
        msg: '',
        data: await getAdminPayoutOverview(deps, actor.appId),
        trace_id: request.id,
      };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('payout: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminPayoutBatchController.prototype;
  Inject(AdminOperationGuard)(AdminPayoutBatchController, undefined, 0);
  Inject(ADMIN_PAYOUT_BATCH)(AdminPayoutBatchController, undefined, 1);
  Inject(ADMIN_PAYOUT_OVERVIEW)(AdminPayoutBatchController, undefined, 2);

  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Res()(prototype, 'create', 2);
  Post('payout-batches')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreatePayoutBatch'))(prototype, 'create', create);

  const overview = Object.getOwnPropertyDescriptor(prototype, 'overview')!;
  Req()(prototype, 'overview', 0);
  Res({ passthrough: true })(prototype, 'overview', 1);
  Get('payout-overview')(prototype, 'overview', overview);
  RouteSchema(contractRouteSchema('adminGetPayoutOverview'))(prototype, 'overview', overview);

  Controller('admin/v1')(AdminPayoutBatchController);
}
