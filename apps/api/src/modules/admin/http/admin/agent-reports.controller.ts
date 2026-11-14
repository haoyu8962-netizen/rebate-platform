// B1-10t: POST /admin/v1/agent-traces/reports/{message_id}/handle (adminHandleAgentReport),
// CT-24zzi, 编排 D10-1287 ⑤ / D10-1310 / D10-1539; BR-ID-15 细则「举报的处理」. Mounted only by
// AdminAgentReportsModule (../../admin.module.ts) on the admin entry. The admin request check has
// verified the admin_token and the route schema the parameters and the body before this runs; the
// operation guard re-reads the account and checks the permission point agent.report, whose step-up
// tier is null (specs/permissions.yaml). A successful handling writes one agent_report_handle
// record in its own transaction (../../application/agent-report-handle.ts). No Idempotency-Key
// (04 §6.6): the row_version compare-and-set makes a repeat a 20902. The answer is no-store. Only
// authorisation, the parameters and the call into the use case live here. Without the database
// the route still registers and every call fails closed (50001). The report list
// (adminListAgentReports) is agent's route.
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AgentReportConflictError,
  AgentReportFieldsError,
  type AgentReportHandler,
} from '../../application/agent-report-handle.ts';

/** Nest token of the report handling use case (null in a process without the database). */
export const ADMIN_AGENT_REPORT_HANDLE = Symbol('ADMIN_AGENT_REPORT_HANDLE');

/** specs/permissions.yaml (CT-24zzi): agent.report, step-up null. */
const REPORT = 'agent.report';

type HandleBody = Schema<'AdminAgentReportHandleRequest'>;
type HandleResponse = Schema<'AdminAgentReportResponse'>;

export interface AdminAgentReportRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

export class AdminAgentReportHandleController {
  readonly #guard: AdminOperationGuard;
  readonly #handler: AgentReportHandler | null;

  constructor(guard: AdminOperationGuard, handler: AgentReportHandler | null) {
    this.#guard = guard;
    this.#handler = handler;
  }

  async handle(
    request: AdminAgentReportRequest,
    messageId: string,
    body: HandleBody,
    reply: HeaderReply,
  ): Promise<HandleResponse> {
    reply.header('Cache-Control', 'no-store');
    let response: HandleResponse | undefined;
    await this.#guard.run({ request, permission: REPORT, readOnly: false }, async (actor) => {
      const handler = this.#handler;
      if (handler === null) throw new Error('admin: the agent report handling needs the database');
      try {
        const data = await handler.handle({
          appId: actor.appId,
          adminId: actor.adminId,
          messageId,
          note: body.note,
          expectedRowVersion: body.expected_row_version,
          ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
        });
        response = { code: 0, msg: '', data, trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        throw refusal(error, request.id);
      }
    });
    if (response === undefined) {
      throw new Error('admin: admin guard returned without an answer');
    }
    return response;
  }
}

function refusal(error: unknown, traceId: string): unknown {
  if (error instanceof AgentReportFieldsError) {
    const refused = fieldsErrorEnvelope(error.fields, traceId);
    return new HttpException(refused.body, refused.statusCode);
  }
  if (error instanceof AgentReportConflictError) {
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

// Plain decorator calls (no parameter decorators), as agent's admin controllers.
{
  const prototype = AdminAgentReportHandleController.prototype;
  Inject(AdminOperationGuard)(AdminAgentReportHandleController, undefined, 0);
  Inject(ADMIN_AGENT_REPORT_HANDLE)(AdminAgentReportHandleController, undefined, 1);
  const handle = Object.getOwnPropertyDescriptor(prototype, 'handle')!;
  Req()(prototype, 'handle', 0);
  Param('message_id')(prototype, 'handle', 1);
  Body()(prototype, 'handle', 2);
  Res({ passthrough: true })(prototype, 'handle', 3);
  Post('agent-traces/reports/:message_id/handle')(prototype, 'handle', handle);
  HttpCode(200)(prototype, 'handle', handle);
  RouteSchema(contractRouteSchema('adminHandleAgentReport'))(prototype, 'handle', handle);
  Controller('admin/v1')(AdminAgentReportHandleController);
}
