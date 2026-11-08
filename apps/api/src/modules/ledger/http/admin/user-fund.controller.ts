// B2-02u: GET /admin/v1/users/{user_id}/fund-summary and GET /admin/v1/ledger
// (adminGetUserFundSummary, adminListLedgerEntries; 08 BR-FUND-13, 15, 16, 18; D10-1057). Only
// authorisation, the parameters and the call into application/admin-ledger-read.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry; the route schema runs first. The
// AdminOperationGuard re-reads the account and checks either permission point fund.view or
// user.lookup, read only (no step-up, no audit); a super admin holds every point. Both points get
// the same answer. Answers are no-store. Without the database the routes still register and every
// call fails closed (50001).
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminLedgerReadFieldsError,
  adminLedgerQueryOf,
  getAdminUserFundSummary,
  listAdminLedgerEntries,
  type AdminLedgerReadDeps,
} from '../../application/admin-ledger-read.ts';

/** Nest token of the read dependencies (null in a process without the database). */
export const ADMIN_LEDGER_READ_DEPS = Symbol('LEDGER_ADMIN_LEDGER_READ_DEPS');

/** specs/permissions.yaml: fund.view or user.lookup, step-up null for both. */
const READ = ['fund.view', 'user.lookup'] as const;

export interface AdminUserFundRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  code: 0;
  msg: string;
  data: T;
  trace_id: string;
}

export interface AdminLedgerRawQuery {
  readonly user_id?: string;
  readonly ledger_type?: string;
  readonly sub_type?: string;
  readonly sub_account?: string;
  readonly accounting_date_from?: string;
  readonly accounting_date_to?: string;
  readonly ref?: string;
  readonly page?: number;
  readonly page_size?: number;
}

export class AdminUserFundController {
  readonly #guard: AdminOperationGuard;
  readonly #deps: AdminLedgerReadDeps | null;

  constructor(guard: AdminOperationGuard, deps: AdminLedgerReadDeps | null) {
    this.#guard = guard;
    this.#deps = deps;
  }

  summary(
    request: AdminUserFundRequest,
    userId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminUserFundSummaryResponse'>> {
    return this.#reading(request, reply, (deps, appId) =>
      getAdminUserFundSummary(deps, { appId, userId }),
    );
  }

  ledger(
    request: AdminUserFundRequest,
    query: AdminLedgerRawQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminLedgerEntryPageResponse'>> {
    return this.#reading(request, reply, (deps, appId) =>
      listAdminLedgerEntries(deps, adminLedgerQueryOf(appId, query ?? {})),
    );
  }

  async #reading<T>(
    request: AdminUserFundRequest,
    reply: HeaderReply,
    read: (deps: AdminLedgerReadDeps, appId: string) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: READ, readOnly: true }, async (actor) => {
      const deps = this.#deps;
      if (deps === null) throw new Error('ledger: the admin user fund reads need the database');
      try {
        response = { code: 0, msg: '', data: await read(deps, actor.appId), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminLedgerReadFieldsError) {
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
  const prototype = AdminUserFundController.prototype;
  Inject(AdminOperationGuard)(AdminUserFundController, undefined, 0);
  Inject(ADMIN_LEDGER_READ_DEPS)(AdminUserFundController, undefined, 1);

  const summary = Object.getOwnPropertyDescriptor(prototype, 'summary')!;
  Req()(prototype, 'summary', 0);
  Param('user_id')(prototype, 'summary', 1);
  Res({ passthrough: true })(prototype, 'summary', 2);
  Get('users/:user_id/fund-summary')(prototype, 'summary', summary);
  RouteSchema(contractRouteSchema('adminGetUserFundSummary'))(prototype, 'summary', summary);

  const ledger = Object.getOwnPropertyDescriptor(prototype, 'ledger')!;
  Req()(prototype, 'ledger', 0);
  Query()(prototype, 'ledger', 1);
  Res({ passthrough: true })(prototype, 'ledger', 2);
  Get('ledger')(prototype, 'ledger', ledger);
  RouteSchema(contractRouteSchema('adminListLedgerEntries'))(prototype, 'ledger', ledger);

  Controller('admin/v1')(AdminUserFundController);
}
