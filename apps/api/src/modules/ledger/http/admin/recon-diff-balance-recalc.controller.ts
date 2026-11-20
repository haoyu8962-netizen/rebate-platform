// B2-02x: POST /admin/v1/recon-diffs/{recon_diff_id}/balance-recalc (recalcBalanceAdminReconDiff;
// 08 BR-FUND-19 细则「差异以分录为准修正」, BR-ID-34 短信档; 04 §11.2 fund.recon). Only
// authorisation, the parameters and the call into
// application/admin-recon-diff-balance-recalc-use-case.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the body, the path and the X-Step-Up-Token header
// before this runs; the AdminOperationGuard re-reads the account, checks fund.recon (10403) and the
// sms tier of operation fund.recon.balance_recalc (10003 data.tier=sms), and consumes the step-up
// token only after a 2xx answer with code 0, so a refusal (a committed refusal audit included)
// leaves it unspent. No Idempotency-Key. Without the database, the event bus or the recovery port
// (isolated HTTP unit tests) the route still registers and every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
  type HandlerResult,
} from '../../../platform/index.ts';
import {
  recalcBalanceAdminReconDiff,
  type BalanceRecalcDeps,
} from '../../application/admin-recon-diff-balance-recalc-use-case.ts';

/** Nest token of the use case dependencies (null in a process without database, bus or hook). */
export const RECON_DIFF_BALANCE_RECALC_DEPS = Symbol('LEDGER_RECON_DIFF_BALANCE_RECALC_DEPS');

/** specs/permissions.yaml: fund.recon; its operation fund.recon.balance_recalc is step-up sms. */
const PERMISSION = 'fund.recon';
const OPERATION = 'fund.recon.balance_recalc';

export interface AdminReconDiffBalanceRecalcRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
}

/** What the handler writes on the Fastify reply. */
export interface AdminReconDiffBalanceRecalcReply {
  code(statusCode: number): AdminReconDiffBalanceRecalcReply;
  type(contentType: string): AdminReconDiffBalanceRecalcReply;
  send(payload: string): unknown;
}

export class AdminReconDiffBalanceRecalcController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: BalanceRecalcDeps | null;

  constructor(guard: AdminOperationGuard, deps: BalanceRecalcDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async recalc(
    request: AdminReconDiffBalanceRecalcRequest,
    reconDiffId: string,
    body: Schema<'AdminReconDiffBalanceRecalcRequest'>,
    reply: AdminReconDiffBalanceRecalcReply,
  ): Promise<void> {
    let sent: HandlerResult | undefined;
    await this.#guard.run(
      { request, permission: PERMISSION, operation: OPERATION },
      async (actor) => {
        const deps = this.#deps;
        if (deps === null) {
          throw new Error(
            'ledger: recalculating a balance cache needs the database, event bus and recovery port',
          );
        }
        sent = await recalcBalanceAdminReconDiff(
          deps,
          {
            appId: actor.appId,
            adminId: actor.adminId,
            ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
          },
          reconDiffId,
          { body, traceId: request.id },
        );
        // The guard reads the code: only code 0 spends the sms-tier step-up token.
        return { statusCode: sent.status, body: sent.envelope };
      },
    );
    if (sent === undefined) throw new Error('ledger: admin guard returned without an answer');
    reply
      .code(sent.status)
      .type('application/json; charset=utf-8')
      .send(JSON.stringify(sent.envelope));
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminReconDiffBalanceRecalcController.prototype;
  Inject(AdminOperationGuard)(AdminReconDiffBalanceRecalcController, undefined, 0);
  Inject(RECON_DIFF_BALANCE_RECALC_DEPS)(AdminReconDiffBalanceRecalcController, undefined, 1);

  const recalc = Object.getOwnPropertyDescriptor(prototype, 'recalc')!;
  Req()(prototype, 'recalc', 0);
  Param('recon_diff_id')(prototype, 'recalc', 1);
  Body()(prototype, 'recalc', 2);
  Res()(prototype, 'recalc', 3);
  Post('recon-diffs/:recon_diff_id/balance-recalc')(prototype, 'recalc', recalc);
  HttpCode(200)(prototype, 'recalc', recalc);
  RouteSchema(contractRouteSchema('recalcBalanceAdminReconDiff'))(prototype, 'recalc', recalc);

  Controller('admin/v1')(AdminReconDiffBalanceRecalcController);
}
