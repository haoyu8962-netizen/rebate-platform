// B1-10q: GET /admin/v1/agent-traces/sessions (adminListAgentSessions) and
// GET /admin/v1/agent-traces/sessions/{session_id} (adminGetAgentSession), CT-24zzi, 编排 D10-1310.
// Mounted only by AgentAdminModule on the admin entry. The admin request check has verified the
// admin_token and the route schema the parameters before this runs; the operation guard re-reads
// the account and checks the permission point agent.trace, read only (no step-up; an
// X-Step-Up-Token header is ignored). The list writes no audit record; each successful detail read
// writes one agent_trace_view record (application/admin-traces.ts). The answer is no-store. Only
// authorisation, the parameters and the calls into the use cases live here. Without the database
// (or the audit port) the routes still register and every call fails closed (50001).
import { Controller, Get, HttpException, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  AdminOperationGuard,
  contractRouteSchema,
  fieldsErrorEnvelope,
  type AdminActor,
  type CheckedRequest,
} from '../../../platform/index.ts';
import {
  AdminTraceFieldsError,
  type AdminTraceReaders,
  type AdminTraceSessionQuery,
} from '../../application/admin-traces.ts';

/** Nest token of the trace readers (null in a process without the database). */
export const ADMIN_AGENT_TRACES_READERS = Symbol('AGENT_ADMIN_TRACES_READERS');

/** specs/permissions.yaml (CT-24zzi): agent.trace, step-up null. */
const TRACE = 'agent.trace';

export interface AdminAgentTracesRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
}

interface HeaderReply {
  header(name: string, value: string): unknown;
}

interface Envelope<T> {
  readonly code: 0;
  readonly msg: string;
  readonly data: T;
  readonly trace_id: string;
}

export class AdminAgentTracesController {
  readonly #guard: AdminOperationGuard;
  readonly #readers: AdminTraceReaders | null;

  constructor(guard: AdminOperationGuard, readers: AdminTraceReaders | null) {
    this.#guard = guard;
    this.#readers = readers;
  }

  list(
    request: AdminAgentTracesRequest,
    query: AdminTraceSessionQuery,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAgentSessionPageResponse'>> {
    return this.#run(request, reply, (readers, actor) => readers.list(actor.appId, query));
  }

  detail(
    request: AdminAgentTracesRequest,
    sessionId: string,
    reply: HeaderReply,
  ): Promise<Schema<'AdminAgentSessionDetailResponse'>> {
    return this.#run(request, reply, (readers, actor) =>
      readers.detail({
        appId: actor.appId,
        adminId: actor.adminId,
        sessionId,
        ip: typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : null,
      }),
    );
  }

  async #run<T>(
    request: AdminAgentTracesRequest,
    reply: HeaderReply,
    read: (readers: AdminTraceReaders, actor: AdminActor) => Promise<T>,
  ): Promise<Envelope<T>> {
    reply.header('Cache-Control', 'no-store');
    let response: Envelope<T> | undefined;
    await this.#guard.run({ request, permission: TRACE, readOnly: true }, async (actor) => {
      const readers = this.#readers;
      if (readers === null) throw new Error('agent: the admin trace console needs the database');
      try {
        response = { code: 0, msg: '', data: await read(readers, actor), trace_id: request.id };
        return { statusCode: 200, body: response };
      } catch (error: unknown) {
        if (error instanceof AdminTraceFieldsError) {
          const refused = fieldsErrorEnvelope(error.fields, request.id);
          throw new HttpException(refused.body, refused.statusCode);
        }
        throw error;
      }
    });
    if (response === undefined) {
      throw new Error('agent: admin guard returned without an answer');
    }
    return response;
  }
}

// Plain decorator calls, as the other admin controllers (no parameter decorators).
{
  const prototype = AdminAgentTracesController.prototype;
  Inject(AdminOperationGuard)(AdminAgentTracesController, undefined, 0);
  Inject(ADMIN_AGENT_TRACES_READERS)(AdminAgentTracesController, undefined, 1);
  const list = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Req()(prototype, 'list', 0);
  Query()(prototype, 'list', 1);
  Res({ passthrough: true })(prototype, 'list', 2);
  Get('agent-traces/sessions')(prototype, 'list', list);
  RouteSchema(contractRouteSchema('adminListAgentSessions'))(prototype, 'list', list);
  const detail = Object.getOwnPropertyDescriptor(prototype, 'detail')!;
  Req()(prototype, 'detail', 0);
  Param('session_id')(prototype, 'detail', 1);
  Res({ passthrough: true })(prototype, 'detail', 2);
  Get('agent-traces/sessions/:session_id')(prototype, 'detail', detail);
  RouteSchema(contractRouteSchema('adminGetAgentSession'))(prototype, 'detail', detail);
  Controller('admin/v1')(AdminAgentTracesController);
}
