import { Controller, Get, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type ContractOperationId } from '../../../platform/index.ts';
import type { AgentCaller, AgentHttpReply } from '../../http/index.ts';
import { AGENT_CALLER, type AgentCallerResolver, type AgentStreamRequest } from './caller.ts';
import { agentHttpReply, type StreamReply } from './reply.ts';
import type { AgentStreamRuntime } from './index.ts';
import {
  agentPrivacyCheckToken,
  type AgentPrivacyCheck,
  type AgentPrivacyRequest,
} from './privacy.ts';
import { agentDefaultTexts } from './texts.ts';

/**
 * The Fastify request of the agent routes (B3-08zi: with the method and matched route ⑦ reads);
 * GET history also reads its query string.
 */
type AgentMountRequest = AgentStreamRequest & Pick<AgentPrivacyRequest, 'method' | 'routeOptions'>;
type AgentRouteRequest = AgentMountRequest & { readonly query?: unknown };

/** Called only by forStream; api/worker never register these routes or resolve their schemas. */
export function agentStreamController(runtimeToken: symbol): typeof AgentStreamController {
  const prototype = AgentStreamController.prototype;
  Inject(runtimeToken)(AgentStreamController, undefined, 0);
  Inject(AGENT_CALLER)(AgentStreamController, undefined, 1);
  // B3-08zi: BR-ID-01 ⑦ for /v1/agent/ (identity's check, provided by app.module on stream).
  Inject(agentPrivacyCheckToken())(AgentStreamController, undefined, 2);
  Optional()(AgentStreamController, undefined, 2);
  for (const [method, path, operation, decorator] of [
    ['create', 'sessions', 'createAgentSession', Post],
    ['current', 'sessions/current', 'getCurrentAgentSession', Get],
    ['message', 'sessions/:id/messages', 'sendAgentMessage', Post],
    // B3-08ze: the history read side (B3-08zc's createAgentHistoryRuntime), same caller resolver.
    ['history', 'sessions/:id/messages', 'listAgentSessionMessages', Get],
    ['cancel', 'runs/:run_id/cancel', 'cancelAgentRun', Post],
    // B3-08zf: 👍/👎 and reports on a reply (runtime.messages), same caller resolver.
    ['feedback', 'messages/:message_id/feedback', 'setAgentMessageFeedback', Post],
    ['report', 'messages/:message_id/report', 'reportAgentMessage', Post],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
    Req()(prototype, method, 0);
    Res()(prototype, method, 1);
    decorator(path)(prototype, method, descriptor);
    // The orchestrator's authorized mechanical contract-codegen commit adds these IDs.
    // Keep the runtime check: a missing generated schema must refuse startup, never skip validation.
    RouteSchema(contractRouteSchema(operation as ContractOperationId))(
      prototype,
      method,
      descriptor,
    );
  }
  Controller('v1/agent')(AgentStreamController);
  return AgentStreamController;
}

class AgentStreamController {
  readonly #runtime: AgentStreamRuntime | null;
  readonly #caller: AgentCallerResolver | null;
  readonly #privacy: AgentPrivacyCheck | null;

  constructor(
    runtime: AgentStreamRuntime | null,
    caller: AgentCallerResolver | null,
    privacy?: AgentPrivacyCheck | null,
  ) {
    this.#runtime = runtime;
    this.#caller = caller;
    this.#privacy = privacy ?? null;
  }

  create(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.createSession(caller, response),
    );
  }

  current(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.currentSession(caller, response),
    );
  }

  message(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.sendMessage(caller, request.params.id ?? '', request.body, response),
    );
  }

  history(request: AgentRouteRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.history.listMessages(caller, request.params.id ?? '', request.query, response),
    );
  }

  cancel(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.cancelRun(caller, request.params.run_id ?? '', response),
    );
  }

  feedback(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.messages.setFeedback(caller, request.params.message_id ?? '', request.body, response),
    );
  }

  report(request: AgentMountRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.messages.report(caller, request.params.message_id ?? '', request.body, response),
    );
  }

  async #handle(
    request: AgentMountRequest,
    reply: StreamReply,
    operation: (
      runtime: AgentStreamRuntime,
      caller: AgentCaller,
      response: AgentHttpReply,
    ) => Promise<void>,
  ): Promise<void> {
    const response = agentHttpReply(reply, request.id);
    let caller: AgentCaller;
    try {
      if (this.#runtime === null || this.#caller === null) throw new Error('Agent unavailable');
      caller = await this.#caller(request);
    } catch {
      const body: Schema<'ErrorEnvelope'> = {
        code: 50001,
        msg: agentDefaultTexts().errorMsg(50001),
        trace_id: request.id,
      };
      response.json(500, { 'content-type': 'application/json' }, body);
      return;
    }
    // BR-ID-01 ⑦ (B3-08zi): after the caller, before the runtime (BR-AI-23 ①); a refusal rejects
    // and the global error filter writes its envelope (10004 privacy / 50001).
    // ⑦ 放 agent 入口而不进 beforeRateLimit 清单，前提是 stream 入口不限流（noRateLimits）；若 stream 接了限流，⑦ 须移进清单并改 [AC-B1-15m#1]（D10-2509 / D10-2510）
    if (this.#privacy !== null) {
      await this.#privacy.canActivate({ switchToHttp: () => ({ getRequest: () => request }) });
    }
    await operation(this.#runtime, caller, response);
  }
}
