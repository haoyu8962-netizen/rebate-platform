// B2-09k: POST /admin/v1/withdrawals/batch-approve and POST /admin/v1/withdrawals/{withdrawal_id}/
// reject (adminBatchApproveWithdrawals, adminRejectWithdrawal; 08 BR-WDR-10; 04 §11.2
// withdraw.review, step-up tier totp). Only authorisation, the parameters and the call into
// application/admin-withdrawal-review.ts live here.
//
// Mounted only by PayoutAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks withdraw.review (a super admin holds every point) and the totp-tier
// X-Step-Up-Token (10003 data.tier=totp); inside the guard the use case runs under platform
// idempotency (subject a:<admin_users.id>) and returns the exact bytes to send, written raw here.
// Without the database, the event bus or the idempotency primitive the routes still register and
// every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  batchApproveAdminWithdrawals,
  rejectAdminWithdrawal,
  type AdminWithdrawalReviewDeps,
  type WithdrawalReviewOperator,
} from '../../application/admin-withdrawal-review.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_WITHDRAWAL_REVIEW = Symbol('PAYOUT_ADMIN_WITHDRAWAL_REVIEW');

/** specs/permissions.yaml: withdraw.review, step-up tier totp (read by the guard). */
const PERMISSION = 'withdraw.review';

export interface AdminWithdrawalReviewRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handlers write on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminWithdrawalReviewRawReply {
  header(name: string, value: string): AdminWithdrawalReviewRawReply;
  code(statusCode: number): AdminWithdrawalReviewRawReply;
  type(contentType: string): AdminWithdrawalReviewRawReply;
  send(payload: string): unknown;
}

function idempotencyKey(request: AdminWithdrawalReviewRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export class AdminWithdrawalReviewController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminWithdrawalReviewDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminWithdrawalReviewDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  batchApprove(
    request: AdminWithdrawalReviewRequest,
    body: Schema<'AdminWithdrawalBatchApproveRequest'>,
    reply: AdminWithdrawalReviewRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      batchApproveAdminWithdrawals(deps, operator, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  reject(
    request: AdminWithdrawalReviewRequest,
    withdrawalId: string,
    body: Schema<'AdminWithdrawalRejectRequest'>,
    reply: AdminWithdrawalReviewRawReply,
  ): Promise<void> {
    return this.#write(request, reply, (deps, operator) =>
      rejectAdminWithdrawal(deps, operator, withdrawalId, {
        body,
        key: idempotencyKey(request),
        traceId: request.id,
      }),
    );
  }

  async #write(
    request: AdminWithdrawalReviewRequest,
    reply: AdminWithdrawalReviewRawReply,
    write: (
      deps: AdminWithdrawalReviewDeps,
      operator: WithdrawalReviewOperator,
    ) => Promise<IdempotentResponse>,
  ): Promise<void> {
    let sent: IdempotentResponse | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('payout: the withdrawal review needs the database and idempotency');
      }
      sent = await write(deps, {
        appId: actor.appId,
        adminId: actor.adminId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      });
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
  const prototype = AdminWithdrawalReviewController.prototype;
  Inject(AdminOperationGuard)(AdminWithdrawalReviewController, undefined, 0);
  Inject(ADMIN_WITHDRAWAL_REVIEW)(AdminWithdrawalReviewController, undefined, 1);

  const batchApprove = Object.getOwnPropertyDescriptor(prototype, 'batchApprove')!;
  Req()(prototype, 'batchApprove', 0);
  Body()(prototype, 'batchApprove', 1);
  Res()(prototype, 'batchApprove', 2);
  Post('withdrawals/batch-approve')(prototype, 'batchApprove', batchApprove);
  HttpCode(200)(prototype, 'batchApprove', batchApprove);
  RouteSchema(contractRouteSchema('adminBatchApproveWithdrawals'))(
    prototype,
    'batchApprove',
    batchApprove,
  );

  const reject = Object.getOwnPropertyDescriptor(prototype, 'reject')!;
  Req()(prototype, 'reject', 0);
  Param('withdrawal_id')(prototype, 'reject', 1);
  Body()(prototype, 'reject', 2);
  Res()(prototype, 'reject', 3);
  Post('withdrawals/:withdrawal_id/reject')(prototype, 'reject', reject);
  HttpCode(200)(prototype, 'reject', reject);
  RouteSchema(contractRouteSchema('adminRejectWithdrawal'))(prototype, 'reject', reject);

  Controller('admin/v1')(AdminWithdrawalReviewController);
}
