// B2-04zs: GET /admin/v1/fund-ledger (adminGetFundLedger; 08 BR-FUND-20, BR-WDR-18; 04 §11.1). Only
// authorisation and the call into application/admin-fund-ledger.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account and checks the permission point fund.view, read only (no step-up); a super admin holds
// every point. Answers are no-store; reading writes no audit record. Without the database the route
// still registers and every call fails closed (50001).
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  getAdminFundLedger,
  type AdminFundLedgerDeps,
} from '../../application/admin-fund-ledger.ts';

/** Nest token of the read dependencies (null in a process without the database). */
export const ADMIN_FUND_LEDGER = Symbol('LEDGER_ADMIN_FUND_LEDGER');

/** specs/permissions.yaml: fund.view, step-up null. */
const READ = 'fund.view';

export interface AdminFundLedgerRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminFundLedgerController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminFundLedgerDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminFundLedgerDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  async get(
    request: AdminFundLedgerRequest,
    reply: HeaderReply,
  ): Promise<Schema<'AdminFundLedgerResponse'>> {
    reply.header('Cache-Control', 'no-store');
    let response: Schema<'AdminFundLedgerResponse'> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('ledger: the fund ledger overview needs the database');
      const data = await getAdminFundLedger(deps, actor.appId);
      response = { code: 0, msg: '', data, trace_id: request.id };
      return { statusCode: 200, body: response };
    });
    if (response === undefined) throw new Error('ledger: admin guard returned without an answer');
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators in source).
{
  const prototype = AdminFundLedgerController.prototype;
  Inject(AdminOperationGuard)(AdminFundLedgerController, undefined, 0);
  Inject(ADMIN_FUND_LEDGER)(AdminFundLedgerController, undefined, 1);

  const get = Object.getOwnPropertyDescriptor(prototype, 'get')!;
  Req()(prototype, 'get', 0);
  Res({ passthrough: true })(prototype, 'get', 1);
  Get('fund-ledger')(prototype, 'get', get);
  RouteSchema(contractRouteSchema('adminGetFundLedger'))(prototype, 'get', get);

  Controller('admin/v1')(AdminFundLedgerController);
}
