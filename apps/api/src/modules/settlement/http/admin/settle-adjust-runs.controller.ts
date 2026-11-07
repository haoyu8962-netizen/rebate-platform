// B2-09zb: POST /admin/v1/settle-adjust-runs (adminRunSettleAdjust, CT-24zv; D10-769 / D10-770):
// finance's manual trigger of the positive-difference candidate run. Only authorisation, the
// parameters and the call into adjust/admin-run.ts live here.
//
// Mounted only by SettlementAdminModule.forAdmin on the admin entry. The admin request check has
// verified the admin_token and the route schema the body and the headers before this runs; the
// AdminOperationGuard re-reads the account and checks the permission point fund.settle_adjust (a
// super admin holds every point) and the step-up tier totp. The use case returns the exact bytes
// to send (the stored first answer on a replay), so the reply is written raw here; the token is
// consumed only on code 0. Without the database, the idempotency primitive or the job queue
// (isolated HTTP unit tests) the route still registers and every call fails closed (50001).
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  runAdminSettleAdjust,
  type AdminSettleAdjustRunAnswer,
  type AdminSettleAdjustRunDeps,
} from '../../adjust/admin-run.ts';

/** Nest token of the use case dependencies (null without database, idempotency or queue). */
export const ADMIN_SETTLE_ADJUST_RUNS = Symbol('SETTLEMENT_ADMIN_SETTLE_ADJUST_RUNS');

/** specs/permissions.yaml: fund.settle_adjust, step-up tier totp. */
const PERMISSION = 'fund.settle_adjust';

export interface AdminSettleAdjustRunRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the use case's exact bytes). */
export interface AdminSettleAdjustRunRawReply {
  header(name: string, value: string): AdminSettleAdjustRunRawReply;
  code(statusCode: number): AdminSettleAdjustRunRawReply;
  type(contentType: string): AdminSettleAdjustRunRawReply;
  send(payload: string): unknown;
}

function header(request: AdminSettleAdjustRunRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export class AdminSettleAdjustRunsController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminSettleAdjustRunDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminSettleAdjustRunDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async run(
    request: AdminSettleAdjustRunRequest,
    body: Schema<'AdminSettleAdjustRunRequest'>,
    reply: AdminSettleAdjustRunRawReply,
  ): Promise<void> {
    let sent: AdminSettleAdjustRunAnswer | undefined;
    await this.#guard.run({ request, permission: PERMISSION }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) {
        throw new Error('settlement: the settle adjust run needs the database, idempotency, queue');
      }
      sent = await runAdminSettleAdjust(
        deps,
        {
          appId: actor.appId,
          adminId: actor.adminId,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        },
        { body, key: header(request, 'idempotency-key'), traceId: request.id },
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
  const prototype = AdminSettleAdjustRunsController.prototype;
  Inject(AdminOperationGuard)(AdminSettleAdjustRunsController, undefined, 0);
  Inject(ADMIN_SETTLE_ADJUST_RUNS)(AdminSettleAdjustRunsController, undefined, 1);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'run')!;
  Req()(prototype, 'run', 0);
  Body()(prototype, 'run', 1);
  Res()(prototype, 'run', 2);
  Post('settle-adjust-runs')(prototype, 'run', descriptor);
  HttpCode(200)(prototype, 'run', descriptor);
  RouteSchema(contractRouteSchema('adminRunSettleAdjust'))(prototype, 'run', descriptor);
  Controller('admin/v1')(AdminSettleAdjustRunsController);
}
