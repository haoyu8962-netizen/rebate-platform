// B2-09i: POST /admin/v1/payout-watermarks (adminCreatePayoutWatermark; 08 BR-WDR-18; 04 §11.2
// fund.cash_entry, step-up tier totp). Only authorisation, the parameters and the call into
// application/admin-payout-watermarks.ts live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks fund.cash_entry (a super admin holds every point) and the totp-tier
// X-Step-Up-Token (10003 data.tier=totp); inside the guard the use case runs under platform
// idempotency (subject a:<admin_users.id>) and returns the exact bytes to send, written raw here.
// Without the database or the idempotency primitive the route still registers and every call fails
// closed (50001).
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  createAdminPayoutWatermark,
  type AdminPayoutWatermarkDeps,
} from '../../application/admin-payout-watermarks.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_PAYOUT_WATERMARKS = Symbol('PAYOUT_ADMIN_PAYOUT_WATERMARKS');

/** specs/permissions.yaml: fund.cash_entry, step-up tier totp (read by the guard). */
const PERMISSION = 'fund.cash_entry';

export interface AdminPayoutWatermarksRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminPayoutWatermarksRawReply {
  header(name: string, value: string): AdminPayoutWatermarksRawReply;
  code(statusCode: number): AdminPayoutWatermarksRawReply;
  type(contentType: string): AdminPayoutWatermarksRawReply;
  send(payload: string): unknown;
}

export class AdminPayoutWatermarksController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminPayoutWatermarkDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminPayoutWatermarkDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async create(
    request: AdminPayoutWatermarksRequest,
    body: Schema<'AdminPayoutWatermarkCreateRequest'>,
    reply: AdminPayoutWatermarksRawReply,
  ): Promise<void> {
    const key = request.headers['idempotency-key'];
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('payout: entering a watermark needs the database and idempotency');
      }
      sent = await createAdminPayoutWatermark(
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
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminPayoutWatermarksController.prototype;
  Inject(AdminOperationGuard)(AdminPayoutWatermarksController, undefined, 0);
  Inject(ADMIN_PAYOUT_WATERMARKS)(AdminPayoutWatermarksController, undefined, 1);

  const create = Object.getOwnPropertyDescriptor(prototype, 'create')!;
  Req()(prototype, 'create', 0);
  Body()(prototype, 'create', 1);
  Res()(prototype, 'create', 2);
  Post('payout-watermarks')(prototype, 'create', create);
  HttpCode(200)(prototype, 'create', create);
  RouteSchema(contractRouteSchema('adminCreatePayoutWatermark'))(prototype, 'create', create);

  Controller('admin/v1')(AdminPayoutWatermarksController);
}
