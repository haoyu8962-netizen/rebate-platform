// B2-04zzl: POST /admin/v1/recon-diffs/{recon_diff_id}/blacklist-clawback
// (blacklistClawbackAdminReconDiff; 08 BR-ATTR-26, BR-FUND-01 R8). Only authorisation, the parameters
// and the call into application/blacklist-clawback.ts live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The route mounts the contract's
// path and header schemas only: the contract's order is permission → step-up → body, so the body is
// validated here, inside the guard. The AdminOperationGuard re-reads the account, checks
// order.blacklist_clawback (a super admin holds every point) and the totp-tier X-Step-Up-Token
// (10003 data.tier=totp); inside the guard the use case runs under platform idempotency (subject a:<admin_users.id>) and returns the exact bytes to send, written raw
// here. Without the database, the event bus, the field cipher or the idempotency primitive the
// route still registers and every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  fieldsErrorEnvelope,
  type CheckedRequest,
  type IdempotentResponse,
} from '../../../platform/index.ts';
import {
  confirmBlacklistClawback,
  type BlacklistClawbackDeps,
} from '../../application/blacklist-clawback.ts';
import { createContractBodyValidator, withoutBody } from './settle-adjustments.validation.ts';

/** Nest token of the use case dependencies (null in a process without the database). */
export const ADMIN_BLACKLIST_CLAWBACK = Symbol('SETTLEMENT_ADMIN_BLACKLIST_CLAWBACK');

/** specs/permissions.yaml: order.blacklist_clawback, step-up tier totp (read by the guard). */
const PERMISSION = 'order.blacklist_clawback';
const OPERATION = 'blacklistClawbackAdminReconDiff';

export interface AdminBlacklistClawbackRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminBlacklistClawbackRawReply {
  header(name: string, value: string): AdminBlacklistClawbackRawReply;
  code(statusCode: number): AdminBlacklistClawbackRawReply;
  type(contentType: string): AdminBlacklistClawbackRawReply;
  send(payload: string): unknown;
}

function header(request: AdminBlacklistClawbackRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminBlacklistClawbackController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: BlacklistClawbackDeps | null;
  readonly #validateBody = createContractBodyValidator(OPERATION);

  constructor(guard: AdminOperationGuard, deps: BlacklistClawbackDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async confirm(
    request: AdminBlacklistClawbackRequest,
    reconDiffId: string,
    body: unknown,
    reply: AdminBlacklistClawbackRawReply,
  ): Promise<void> {
    let sent: Pick<IdempotentResponse, 'status' | 'body'> | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: the blacklist clawback needs the database and idempotency');
      }
      // The contract's order: permission → step-up (the guard) → body.
      const fields = this.#validateBody(body);
      if (fields !== null) {
        const refused = fieldsErrorEnvelope(fields, request.id);
        sent = { status: refused.statusCode, body: JSON.stringify(refused.body) };
        return { statusCode: sent.status, body: refused.body };
      }
      sent = await confirmBlacklistClawback(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        reconDiffId,
        {
          body: body as Schema<'AdminReconDiffBlacklistClawbackRequest'>,
          key: header(request, 'idempotency-key'),
          traceId: request.id,
        },
      );
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
  const prototype = AdminBlacklistClawbackController.prototype;
  Inject(AdminOperationGuard)(AdminBlacklistClawbackController, undefined, 0);
  Inject(ADMIN_BLACKLIST_CLAWBACK)(AdminBlacklistClawbackController, undefined, 1);

  const confirm = Object.getOwnPropertyDescriptor(prototype, 'confirm')!;
  Req()(prototype, 'confirm', 0);
  Param('recon_diff_id')(prototype, 'confirm', 1);
  Body()(prototype, 'confirm', 2);
  Res()(prototype, 'confirm', 3);
  Post('recon-diffs/:recon_diff_id/blacklist-clawback')(prototype, 'confirm', confirm);
  HttpCode(200)(prototype, 'confirm', confirm);
  RouteSchema(withoutBody(OPERATION))(prototype, 'confirm', confirm);

  Controller('admin/v1')(AdminBlacklistClawbackController);
}
