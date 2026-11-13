// B1-10t: GET /admin/v1/agent-traces/reports (adminListAgentReports) and
// POST /admin/v1/agent-traces/reports/{message_id}/handle (adminHandleAgentReport), CT-24zzi,
// 编排 D10-1287 ⑤ / D10-1310; BR-ID-15 细则「举报的处理」. Mounted only by AgentAdminModule on the
// admin entry. The admin request check has verified the admin_token and the route schema the
// parameters and the body before this runs; the operation guard re-reads the account and checks
// the permission point: the list agent.trace, read only (no step-up; an X-Step-Up-Token header is
// ignored); the handling agent.report, whose step-up tier is null (specs/permissions.yaml). The
// list writes no audit record; a successful handling writes one agent_report_handle record in its
// own transaction (application/admin-reports.ts). No Idempotency-Key (04 §6.6): the row_version
// compare-and-set makes a repeat a 20902. The answer is no-store. Only authorisation, the
// parameters and the calls into the use cases live here. Without the database (or the audit
// writer) the routes still register and every call fails closed (50001).
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
} from '../../../platform/index.ts';
import {
  AdminReportConflictError,
  AdminReportFieldsError,
  type AdminReportQuery,
  type AdminReportService,
} from '../../application/admin-reports.ts';
import type { AdminAgentTracesRequest } from './agent-traces.controller.ts';

/** Nest token of the report use cases (null in a process without the database). */
export const ADMIN_AGENT_REPORTS = Symbol('AGENT_ADMIN_REPORTS');

/** specs/permissions.yaml (CT-24zzi): agent.trace and agent.report, step-up null. */
const TRACE = 'agent.trace';
const REPORT = 'agent.report';

type HandleBody = Schema<'AdminAgentReportHandleRequest'>;

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
    return this.#run(request, reply, TRACE, true, (reports, actor) =>
      reports.list(actor.appId, query),
    );
  }

  handle(
    request: AdminAgentTracesRequest,
    messageId: string,
    body: HandleBody,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAgentReportResponse'>> {
    return this.#run(request, reply, REPORT, false, (reports, actor) =>
      reports.handle({
        appId: actor.appId,
        adminId: actor.adminId,
        messageId,
        note: body.note,
        expectedRowVersion: body.expected_row_version,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      }),
    );
  }

  async #run<T>(
    request: AdminAgentTracesRequest,
    reply: HeaderReply,
    permission: string,
    readOnly: boolean,
    business: (reports: AdminReportService, actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission, readOnly }, async (actor) => {
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
  if (error instanceof AdminReportConflictError) {
    return new HttpException(
      {
        code: 20902,
        msg: '状态已变化，请刷新后重试',
        data: { resource: 'agent_report' },
        trace_id: traceId,
      },
      409,
    );
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
  const handle = Object.getOwnPropertyDescriptor(prototype, 'handle')!;
  Req()(prototype, 'handle', 0);
  Param('message_id')(prototype, 'handle', 1);
  Body()(prototype, 'handle', 2);
  Res({ passthrough: true })(prototype, 'handle', 3);
  Post('agent-traces/reports/:message_id/handle')(prototype, 'handle', handle);
  HttpCode(200)(prototype, 'handle', handle);
  RouteSchema(contractRouteSchema('adminHandleAgentReport'))(prototype, 'handle', handle);
  Controller('admin/v1')(AdminAgentReportsController);
}
