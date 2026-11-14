// B1-10t: GET /admin/v1/agent-traces/reports (adminListAgentReports), CT-24zzi, 编排 D10-1287 ⑤ /
// D10-1310; BR-ID-15 细则「举报的处理」. Mounted only by AgentAdminModule on the admin entry. The
// admin request check has verified the admin_token and the route schema the parameters before this
// runs; the operation guard re-reads the account and checks the permission point agent.trace, read
// only (no step-up; an X-Step-Up-Token header is ignored). The list writes no audit record. The
// answer is no-store. Only authorisation, the parameters and the call into the use case live here.
// Without the database the route still registers and every call fails closed (50001). The
// handling (adminHandleAgentReport) is admin's route (编排 D10-1539).
import { Controller, Get, HttpException, Inject, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
} from '../../../platform/index.ts';
import {
  AdminReportFieldsError,
  type AdminReportQuery,
  type AdminReportService,
} from '../../application/admin-reports.ts';
import type { AdminAgentTracesRequest } from './agent-traces.controller.ts';

/** Nest token of the report list use case (null in a process without the database). */
export const ADMIN_AGENT_REPORTS = Symbol('AGENT_ADMIN_REPORTS');

/** specs/permissions.yaml (CT-24zzi): agent.trace, step-up null. */
const TRACE = 'agent.trace';

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  readonly code: 0;
  readonly msg: string;
  readonly data: T;
  readonly trace_id: string;
}

export class AdminAgentReportsController {
  readonly #guard: AdminOperationGuard;
  readonly #reports: AdminReportService | null;

  constructor(guard: AdminOperationGuard, reports: AdminReportService | null) {
    this.#guard = guard;
    this.#reports = reports;
  }

  list(
    request: AdminAgentTracesRequest,
    query: AdminReportQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAgentReportPageResponse'>> {
    return this.#run(request, reply, (reports, actor) => reports.list(actor.appId, query));
  }

  async #run<T>(
    request: AdminAgentTracesRequest,
    reply: HeaderReply,
    business: (reports: AdminReportService, actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: TRACE, readOnly: true }, async (actor) => {
      const reports = this.#reports;
      if (reports === null) throw new Error('agent: the admin report console needs the database');
      try {
        response = { code: 0, msg: '', data: await business(reports, actor), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) {
      throw new Error('agent: admin guard returned without an answer');
    }
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AdminReportFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  return error;
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminAgentReportsController.prototype;
  Inject(AdminOperationGuard)(AdminAgentReportsController, undefined, 0);
  Inject(ADMIN_AGENT_REPORTS)(AdminAgentReportsController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('agent-traces/reports')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListAgentReports'))(prototype, 'list', list);
  Controller('admin/v1')(AdminAgentReportsController);
}
