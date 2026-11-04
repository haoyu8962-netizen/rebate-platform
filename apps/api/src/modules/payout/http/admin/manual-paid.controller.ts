// B2-09m: POST /admin/v1/withdrawals/batch-manual-paid (adminBatchManualPaid; 08 BR-WDR-16; 04 §11.2
// payout.manual_entry, step-up tier totp). Only authorisation, the parameters and the call into
// application/admin-manual-paid.ts live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks payout.manual_entry (a super admin holds every point) and the totp-tier
// X-Step-Up-Token (10003 data.tier=totp); inside the guard the use case runs under platform
// idempotency (subject a:<admin_users.id>) and returns the exact bytes to send, written raw here.
// Without the database, the event bus or the idempotency primitive the route still registers and
// every call fails closed (50001).
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
  batchManualPaidAdminWithdrawals,
  type AdminManualPaidDeps,
} from '../../application/admin-manual-paid.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_MANUAL_PAID = Symbol('PAYOUT_ADMIN_MANUAL_PAID');

/** specs/permissions.yaml: payout.manual_entry, step-up tier totp (read by the guard). */
const PERMISSION = 'payout.manual_entry';

export interface AdminManualPaidRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminManualPaidRawReply {
  header(name: string, value: string): AdminManualPaidRawReply;
  code(statusCode: number): AdminManualPaidRawReply;
  type(contentType: string): AdminManualPaidRawReply;
  send(payload: string): unknown;
}

export class AdminManualPaidController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminManualPaidDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminManualPaidDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async batch(
    request: AdminManualPaidRequest,
    body: Schema<'AdminWithdrawalBatchManualPaidRequest'>,
    reply: AdminManualPaidRawReply,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('payout: the offline payment entry needs the database and idempotency');
      }
      const key = request.headers['idempotency-key'];
      sent = await batchManualPaidAdminWithdrawals(
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
  const prototype = AdminManualPaidController.prototype;
  Inject(AdminOperationGuard)(AdminManualPaidController, undefined, 0);
  Inject(ADMIN_MANUAL_PAID)(AdminManualPaidController, undefined, 1);

  const batch = Object.getOwnPropertyDescriptor(prototype, 'batch')!;
  Req()(prototype, 'batch', 0);
  Body()(prototype, 'batch', 1);
  Res()(prototype, 'batch', 2);
  Post('withdrawals/batch-manual-paid')(prototype, 'batch', batch);
  HttpCode(200)(prototype, 'batch', batch);
  RouteSchema(contractRouteSchema('adminBatchManualPaid'))(prototype, 'batch', batch);

  Controller('admin/v1')(AdminManualPaidController);
}
