import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { contractRouteSchema, type ContractOperationId } from '../../../platform/index.ts';
import type { AgentCaller, AgentHttpReply } from '../../http/index.ts';
import { AGENT_CALLER, type AgentCallerResolver, type AgentStreamRequest } from './caller.ts';
import { agentHttpReply, type StreamReply } from './reply.ts';
import type { AgentStreamRuntime } from './index.ts';
import { agentDefaultTexts } from './texts.ts';

/** The Fastify request of the agent routes; GET history also reads its query string. */
type AgentRouteRequest = AgentStreamRequest & { readonly query?: unknown };

/** Called only by forStream; api/worker never register these routes or resolve their schemas. */
export function agentStreamController(runtimeToken: symbol): typeof AgentStreamController {
  const prototype = AgentStreamController.prototype;
  Inject(runtimeToken)(AgentStreamController, undefined, 0);
  Inject(AGENT_CALLER)(AgentStreamController, undefined, 1);
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

  constructor(runtime: AgentStreamRuntime | null, caller: AgentCallerResolver | null) {
    this.#runtime = runtime;
    this.#caller = caller;
  }

  create(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.createSession(caller, response),
    );
  }

  current(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.currentSession(caller, response),
    );
  }

  message(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.sendMessage(caller, request.params.id ?? '', request.body, response),
    );
  }

  history(request: AgentRouteRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.history.listMessages(caller, request.params.id ?? '', request.query, response),
    );
  }

  cancel(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.http.cancelRun(caller, request.params.run_id ?? '', response),
    );
  }

  feedback(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.messages.setFeedback(caller, request.params.message_id ?? '', request.body, response),
    );
  }

  report(request: AgentStreamRequest, reply: StreamReply): Promise<void> {
    return this.#handle(request, reply, (runtime, caller, response) =>
      runtime.messages.report(caller, request.params.message_id ?? '', request.body, response),
    );
  }

  async #handle(
    request: AgentStreamRequest,
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
    await operation(this.#runtime, caller, response);
  }
}
