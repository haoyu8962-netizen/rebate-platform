// B3-08zf · setAgentMessageFeedback (POST /v1/agent/messages/{message_id}/feedback) and
// reportAgentMessage (POST /v1/agent/messages/{message_id}/report) of contracts/openapi.yaml
// (BR-AI-19, BR-AI-20, BR-ID-15 ④), framework-neutral like ./index.ts; mounted on the stream entry
// by ../stream/mount/controller.ts with the same caller resolver as the other agent routes.
//
// setFeedback(caller, messageId, body, reply) / report(caller, messageId, body, reply):
//   0. body is the operation's request body (AgentFeedbackRequest {feedback: up | down};
//      AgentReportRequest {reason: 1–200 characters}; no other field): otherwise 20001 with
//      data.fields (the route schema already refuses these before the handler; checked again here
//      so the layer never writes a malformed value);
//   ① access.check → 30501; ② identity.check → 10001 / 10005; ③ consent.check → 10004 with
//   data.consent_type 'ai_third_party' (BR-AI-23 ①–③, the first failure answers);
//   ④ the store's write (../store/feedback) answers false — the message is missing, not in a session
//   of the caller (owner as in ./index.ts ownerOf: user_id with an access token, else the device),
//   a user message, or the id is not a UUID → 30504 without data, never told apart (BR-AI-20).
//   Otherwise 200 EmptyResponse. The time written is deps.clock.now(), read once per request.
//   An unexpected failure is 50001 and one error line agent_http_failed (op, stage, error_name).
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from an injected Clock.
import { errorCodes } from '@couli/contracts-ts';
import type { Schema } from '@couli/contracts-ts';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RunTexts } from '../stream/run/index.ts';
import type { AgentFeedbackValue, AgentMessageFeedbackStore } from '../store/feedback/index.ts';
import { ownerOf } from './index.ts';
import type {
  AgentAccessPort,
  AgentCaller,
  AgentConsentPort,
  AgentHttpReply,
  AgentIdentityPort,
} from './index.ts';

export interface AgentMessageFeedbackDeps {
  readonly access: AgentAccessPort;
  readonly identity: AgentIdentityPort;
  readonly consent: AgentConsentPort;
  readonly store: AgentMessageFeedbackStore;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  readonly clock: Clock;
  readonly logger?: Pick<RootLogger, 'error' | 'warn'>;
}

export interface AgentMessageFeedbackHttp {
  setFeedback(
    caller: AgentCaller,
    messageId: string,
    body: unknown,
    reply: AgentHttpReply,
  ): Promise<void>;
  report(
    caller: AgentCaller,
    messageId: string,
    body: unknown,
    reply: AgentHttpReply,
  ): Promise<void>;
}

/** contracts/openapi.yaml AgentReportRequest.reason: 1–200 characters (Unicode code points). */
const REASON_MAX = 200;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; fields: string[] };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One field `name` and nothing else; the fields named in a 20001 as the route schema names them. */
function single<T>(body: unknown, name: string, accept: (value: unknown) => value is T): Parsed<T> {
  if (!isRecord(body)) return { ok: false, fields: ['body'] };
  const fields = Object.keys(body).filter((key) => key !== name);
  if (!Object.hasOwn(body, name) || !accept(body[name])) fields.unshift(name);
  return fields.length > 0 ? { ok: false, fields } : { ok: true, value: body[name] as T };
}

export function parseFeedbackBody(body: unknown): Parsed<AgentFeedbackValue> {
  return single(body, 'feedback', (value): value is AgentFeedbackValue => {
    return value === 'up' || value === 'down';
  });
}

export function parseReportBody(body: unknown): Parsed<string> {
  return single(body, 'reason', (value): value is string => {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    return length >= 1 && length <= REASON_MAX;
  });
}

type Operation = 'set_feedback' | 'report_message';

export function createAgentMessageFeedbackHttp(
  deps: AgentMessageFeedbackDeps,
): AgentMessageFeedbackHttp {
  function refuse(
    caller: AgentCaller,
    reply: AgentHttpReply,
    code: keyof typeof errorCodes,
    data?: Schema<'ErrorEnvelope'>['data'],
  ): void {
    const body: Schema<'ErrorEnvelope'> = {
      code,
      msg: deps.texts.errorMsg(code),
      trace_id: caller.traceId,
      ...(data === undefined ? {} : { data }),
    };
    reply.json(errorCodes[code].http, JSON_HEADERS, body);
  }

  function failed(op: Operation, error: unknown): void {
    try {
      deps.logger?.error(
        { op, stage: 'write', error_name: error instanceof Error ? error.name : 'unknown' },
        'agent_http_failed',
      );
    } catch {
      /* Logging must never turn into a different answer. */
    }
  }

  async function allowed(caller: AgentCaller, reply: AgentHttpReply): Promise<boolean> {
    const access = await deps.access.check(caller);
    if (access) {
      refuse(caller, reply, access.code);
      return false;
    }
    const identity = await deps.identity.check(caller);
    if (identity) {
      refuse(caller, reply, identity.code);
      return false;
    }
    const consent = await deps.consent.check(caller);
    if (consent) {
      refuse(caller, reply, consent.code, { consent_type: 'ai_third_party' });
      return false;
    }
    return true;
  }

  async function run<T>(
    op: Operation,
    caller: AgentCaller,
    body: unknown,
    reply: AgentHttpReply,
    parse: (body: unknown) => Parsed<T>,
    write: (value: T, at: Date) => Promise<boolean>,
  ): Promise<void> {
    try {
      const parsed = parse(body);
      if (!parsed.ok) {
        refuse(caller, reply, 20001, { fields: parsed.fields });
        return;
      }
      if (!(await allowed(caller, reply))) return;
      if (!(await write(parsed.value, deps.clock.now()))) {
        refuse(caller, reply, 30504);
        return;
      }
      const ok: Schema<'EmptyResponse'> = { code: 0, msg: '', data: {}, trace_id: caller.traceId };
      reply.json(200, JSON_HEADERS, ok);
    } catch (error) {
      failed(op, error);
      refuse(caller, reply, 50001);
    }
  }

  return {
    setFeedback(caller, messageId, body, reply) {
      return run('set_feedback', caller, body, reply, parseFeedbackBody, (value, at) =>
        deps.store.feedback(ownerOf(caller), messageId, value, at),
      );
    },
    report(caller, messageId, body, reply) {
      return run('report_message', caller, body, reply, parseReportBody, (reason, at) =>
        deps.store.report(ownerOf(caller), messageId, reason, at),
      );
    },
  };
}
