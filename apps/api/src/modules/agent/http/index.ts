// HTTP layer of /v1/agent/* (B3-03d after the 2026-10-08 redesign): createAgentSession,
// getCurrentAgentSession, sendAgentMessage (SSE) and cancelAgentRun of contracts/openapi.yaml,
// framework-neutral. The Nest / Fastify adapter and the mount on the stream entry are B3-03f. The
// rule tests in test/spec/agent/stream-http/** import this file by path: names, signatures and the
// semantics written here are the contract.
//
// The caller has passed BR-ID-01 ①–⑦ (signature, token, bans, …) before any method here runs.
// Every port is required unless marked optional; a port is never skipped or assumed to allow
// (consent, redactor and the run body have no permissive default).
//
// sendMessage(caller, sessionId, body, reply) — BR-AI-23, the first failure wins:
//   0. body is checked against the contract request body of sendAgentMessage (AgentMessageRequest:
//      types, client_msg_id format, unknown fields, missing fields): a failure is 20001 with
//      data.fields naming each offending field once (the rules of validationErrorEnvelope in
//      ../../platform/validation: missingProperty, additionalProperty, else the instancePath;
//      'body' when the body itself is not an object), before ① and before any port is called.
//   ① access.check → 30501; ② identity.check → 10001 / 10005; ③ consent.check → 10004 with
//   data.consent_type 'ai_third_party'; ④ sessions.owned(owner, sessionId) null or expired →
//   30504 without data (BR-AI-20); ⑤ text longer than settings.textMaxCodePoints Unicode code
//   points → 20001 data.fields ['text']. A refusal at 0–⑤ calls no later step: in particular no
//   redactor, no limits, no admission.
//   Then, in this order: three new ids from deps.ids() (runId, the user messageId, the
//   assistantMessageId; all distinct); redactor.redact(appId, text) once — the same result is
//   runUserText and messageText, the raw text never enters the admission request; limits =
//   deps.limits.current(appId) (the instance B3-03g's finalization uses too; a rejection → JSON
//   50401 and admit is not called); labels.current(caller) → promptVersion, modelSnapshot; then
//   admission.admit({sessionId, clientMsgId, runId, messageId, subject, reply: {assistantMessageId,
//   promptVersion, modelSnapshot, runUserText, messageText}}, limits). Quota subject: member
//   {userId} when the caller has a user id and a bound phone; otherwise guest {loggedIn: userId !==
//   null, deviceHash, ipKey} (BR-AI-15, BR-ID-03).
//   admit's answer:
//   - accepted → reply.stream(SSE headers), then runs.start({ticket, ownerKey, appId:
//     caller.appId, limits, meta: {message_id: assistantMessageId, prompt_version, model_label:
//     labels.modelLabel(appId, modelSnapshot), ai_label: labels.aiLabel(appId)}, sink},
//     body(input)); the RunManager writes every frame (meta first, one terminal frame last); after
//     start resolves, sink.end(). appId is the only field B3-03i added (RunStart.appId, for the
//     RunManager's per-run guard); every other field is as before.
//   - duplicate → reply.stream(SSE headers) and exactly two frames, ids 1 and 2 (04 §8.1): meta
//     {session_id, run_id: original.runId, message_id: original.assistantMessageId,
//     prompt_version: original.promptVersion, model_label: labels.modelLabel(appId,
//     original.modelSnapshot), ai_label: labels.aiLabel(appId), duplicate: true}; then for reply
//     final the stored terminal frame as it is (event and data unchanged), for reply running
//     error {code 30506, msg texts.errorMsg(30506), retryable true, fallback null, fallback_q
//     null}; then sink.end(). runs.start is not called.
//   - rejected 30506 → JSON 30506 without data; 42901 → JSON 42901 with header Retry-After =
//     retryAfterSeconds (decimal seconds); 30504 round_limit → JSON 30504 data {reason:
//     'round_limit'}; 30504 expired → JSON 30504 without data (as ④); 30502 → JSON 30502 data
//     {reset_at: resetAt, next}.
//   admit throws: AdmissionUnavailableError (either outcome) → JSON 50401; AdmissionHeldError →
//   JSON 50001; anything else → JSON 50001 (msg is texts.errorMsg(50001), nothing of the error).
//   A failure of the redactor or the labels port → JSON 50001, admit not called.
//   Streams: frames are written with the 04 §8.1 layout (`event:` / `id:` / `data:` lines). When
//   the client is gone (the sink's write throws, or onClose fired) nothing more is written by
//   this layer and sendMessage still resolves (never rejects, no unhandled rejection).
//
// JSON answers: reply.json(status of contracts/error-codes.yaml for the code, headers
//   {'content-type': 'application/json'} (+ 'retry-after' for 42901), ErrorEnvelope {code, msg:
//   texts.errorMsg(code), data?, trace_id: caller.traceId}). Success: 200 {code 0, msg '', data,
//   trace_id: caller.traceId}; times as RFC 3339 strings of the stored instants.
// SSE headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache'}.
// Owner (../store): user {appId, userId, deviceId} with a user id, else device {appId, deviceId};
//   owner key u:<user_id> | d:<device_id> (BR-AI-20).
//
// createSession(caller, reply): 0 is skipped (no body); ①–③; sessions.open(owner, ids()) → 200
//   AgentSessionResponse. currentSession(caller, reply): ①–③; sessions.current(owner) → 200
//   {session: … | null}. Neither calls admission.
// cancelRun(caller, runId, reply): ①–③; sessions.ownsRun(owner, runId) false → JSON 30505 (no
//   such run and not the caller's are never told apart; cancel not called); cancel({appId,
//   runId}): 'accepted' → 200 EmptyResponse (data {}), then signals?.requestCancel(runId,
//   ownerKey) best effort: not awaited before the answer, a rejection or a throw changes nothing;
//   'not_running' → JSON 30505, no signal; the cancel port rejects → JSON 50001, no signal.
//
// Rules for the implementation: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no NestJS, no process.env, time only from an injected Clock.
import type { Clock, RootLogger } from '../../platform/index.ts';
import { errorCodes } from '@couli/contracts-ts';
import type { Schema } from '@couli/contracts-ts';
import { AdmissionUnavailableError } from '../stream/admission/index.ts';
import type { Admission, AdmissionLimits, RedactedText } from '../stream/admission/index.ts';
import type { CancelQuery, QuotaLimitsSource } from '../stream/pg/index.ts';
import type { RunBody, RunManager, RunRegistry, RunSink, RunTexts } from '../stream/run/index.ts';
import { isUuid } from '../store/index.ts';
import type { AgentOwner, AgentSessionRow, AgentSessionStore } from '../store/index.ts';
import { encodeFrame } from '../stream/writer/index.ts';
import { invalidFields, messageValidator } from './message-schema.ts';
import { trackSink } from './sink.ts';

export interface AgentCaller {
  readonly appId: string;
  readonly traceId: string;
  readonly deviceId: string;
  readonly deviceHash: string;
  /** Opaque IP counting key (never a plain IP). */
  readonly ipKey: string;
  /** From the access token; null for a guest. */
  readonly userId: string | null;
  readonly phoneBound: boolean;
}

/** ① agent.enabled / whitelist (BR-AI-12). */
export interface AgentAccessPort {
  check(caller: AgentCaller): Promise<null | { readonly code: 30501 }>;
}

/** ② identity requirements (BR-AI-11, BR-ID-03). */
export interface AgentIdentityPort {
  check(caller: AgentCaller): Promise<null | { readonly code: 10001 | 10005 }>;
}

/** ③ AI consent (BR-AI-13). */
export interface AgentConsentPort {
  check(caller: AgentCaller): Promise<null | { readonly code: 10004 }>;
}

/** BR-AI-19 redaction; the only producer of RedactedText here. */
export interface AgentRedactor {
  redact(appId: string, text: string): Promise<RedactedText>;
}

/** Labels of a run (B3-05 / model routing / texts). */
export interface AgentRunLabels {
  current(
    caller: AgentCaller,
  ): Promise<{ readonly promptVersion: string; readonly modelSnapshot: string | null }>;
  /** The display name of a model snapshot today (04 §8.1). */
  modelLabel(appId: string, modelSnapshot: string | null): Promise<string>;
  /** texts.ai_label (BR-TEXT-16). */
  aiLabel(appId: string): Promise<string>;
}

export interface AgentHttpSettings {
  /** BR-AI-23 ⑤. */
  readonly textMaxCodePoints: number;
}

export interface AgentMessageBody {
  readonly client_msg_id: string;
  readonly text: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface RunBodyInput {
  readonly caller: AgentCaller;
  readonly sessionId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  /** The text as sent. */
  readonly text: string;
  readonly redactedText: RedactedText;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly limits: AdmissionLimits;
}

export interface AgentStreamSink extends RunSink {
  end(): void;
}

export interface AgentHttpReply {
  json(status: number, headers: Readonly<Record<string, string>>, body: unknown): void;
  stream(headers: Readonly<Record<string, string>>): AgentStreamSink;
}

export interface AgentHttpDeps {
  readonly access: AgentAccessPort;
  readonly identity: AgentIdentityPort;
  readonly consent: AgentConsentPort;
  readonly sessions: AgentSessionStore;
  /** B3-03g PgRunPorts.admission (only admit is used here). */
  readonly admission: Pick<Admission, 'admit'>;
  /** The RunManager (B3-03b) wired on B3-03g's registry and admission. */
  readonly runs: Pick<RunManager, 'start'>;
  /** B3-03g PgRunPorts.cancel. */
  readonly cancel: (query: CancelQuery) => Promise<'accepted' | 'not_running'>;
  /** Redis fast path for the cancel signal; may be absent or failing. */
  readonly signals?: Pick<RunRegistry, 'requestCancel'>;
  /** The same QuotaLimitsSource instance given to createPgRunPorts. */
  readonly limits: QuotaLimitsSource;
  readonly body: (input: RunBodyInput) => RunBody;
  readonly redactor: AgentRedactor;
  readonly labels: AgentRunLabels;
  readonly settings: AgentHttpSettings;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  /** New UUIDv7 ids (sessions, runs, messages). */
  readonly ids: () => string;
  readonly clock: Clock;
  readonly logger?: Pick<RootLogger, 'error' | 'warn'>;
}

export interface AgentHttp {
  createSession(caller: AgentCaller, reply: AgentHttpReply): Promise<void>;
  currentSession(caller: AgentCaller, reply: AgentHttpReply): Promise<void>;
  sendMessage(
    caller: AgentCaller,
    sessionId: string,
    body: unknown,
    reply: AgentHttpReply,
  ): Promise<void>;
  cancelRun(caller: AgentCaller, runId: string, reply: AgentHttpReply): Promise<void>;
}

/** BR-AI-23 ⑤: 500 Unicode code points. */
export function agentHttpDefaults(): AgentHttpSettings {
  return { textMaxCodePoints: 500 };
}

/** The operation named in an agent_http_failed line (B3-08v). */
type AgentHttpOperation = 'create_session' | 'current_session' | 'cancel_run' | 'send_message';

export function createAgentHttp(deps: AgentHttpDeps): AgentHttp {
  if (
    !Number.isSafeInteger(deps.settings.textMaxCodePoints) ||
    deps.settings.textMaxCodePoints < 1
  ) {
    throw new RangeError('Invalid agent text limit');
  }
  /**
   * B3-08v: one error line per fallback catch (the answer itself is unchanged). Only the operation,
   * the catch site and the error's name: an error message, the user's text, tokens and trace or
   * device identifiers never go into the line. A logger that throws cannot change the answer.
   */
  function failed(op: AgentHttpOperation, stage: string, error: unknown): void {
    try {
      deps.logger?.error(
        { op, stage, error_name: error instanceof Error ? error.name : 'unknown' },
        'agent_http_failed',
      );
    } catch {
      /* Logging must never turn into a different answer. */
    }
  }
  // Reuse the validator compiled at module load; instance creation performs no contract I/O.
  const validate = messageValidator();
  function refuse(
    caller: AgentCaller,
    reply: AgentHttpReply,
    code: keyof typeof errorCodes,
    data?: Schema<'ErrorEnvelope'>['data'],
    headers: Readonly<Record<string, string>> = {},
  ): void {
    const body: Schema<'ErrorEnvelope'> = {
      code,
      msg: deps.texts.errorMsg(code),
      trace_id: caller.traceId,
      ...(data === undefined ? {} : { data }),
    };
    reply.json(errorCodes[code].http, { 'content-type': 'application/json', ...headers }, body);
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

  return {
    async createSession(caller, reply) {
      try {
        if (!(await allowed(caller, reply))) return;
        const row = await deps.sessions.open(ownerOf(caller), deps.ids());
        const body: Schema<'AgentSessionResponse'> = {
          code: 0,
          msg: '',
          data: sessionData(row),
          trace_id: caller.traceId,
        };
        reply.json(200, JSON_HEADERS, body);
      } catch (error) {
        failed('create_session', 'create', error);
        refuse(caller, reply, 50001);
      }
    },
    async currentSession(caller, reply) {
      try {
        if (!(await allowed(caller, reply))) return;
        const row = await deps.sessions.current(ownerOf(caller));
        const body: Schema<'AgentCurrentSessionResponse'> = {
          code: 0,
          msg: '',
          data: { session: row ? sessionData(row) : null },
          trace_id: caller.traceId,
        };
        reply.json(200, JSON_HEADERS, body);
      } catch (error) {
        failed('current_session', 'current', error);
        refuse(caller, reply, 50001);
      }
    },
    async cancelRun(caller, runId, reply) {
      try {
        if (!(await allowed(caller, reply))) return;
        if (!isUuid(runId) || !(await deps.sessions.ownsRun(ownerOf(caller), runId))) {
          refuse(caller, reply, 30505);
          return;
        }
        if ((await deps.cancel({ appId: caller.appId, runId })) !== 'accepted') {
          refuse(caller, reply, 30505);
          return;
        }
        const body: Schema<'EmptyResponse'> = {
          code: 0,
          msg: '',
          data: {},
          trace_id: caller.traceId,
        };
        reply.json(200, JSON_HEADERS, body);
      } catch (error) {
        failed('cancel_run', 'cancel', error);
        refuse(caller, reply, 50001);
        return;
      }
      // The committed PG cancellation is authoritative; this signal is only a fast path.
      try {
        void deps.signals?.requestCancel(runId, ownerKeyOf(caller)).catch(() => undefined);
      } catch {
        /* A synchronously failed signal cannot change the successful answer. */
      }
    },
    async sendMessage(caller, sessionId, input, reply) {
      let streaming = false;
      let sink: AgentStreamSink | undefined;
      try {
        if (!validate(input)) {
          refuse(caller, reply, 20001, { fields: invalidFields(validate.errors ?? []) });
          return;
        }
        const body = input as AgentMessageBody;
        if (!(await allowed(caller, reply))) return;
        const owned = isUuid(sessionId)
          ? await deps.sessions.owned(ownerOf(caller), sessionId)
          : null;
        if (!owned || owned.expired) {
          refuse(caller, reply, 30504);
          return;
        }
        if ([...body.text].length > deps.settings.textMaxCodePoints) {
          refuse(caller, reply, 20001, { fields: ['text'] });
          return;
        }
        const runId = deps.ids();
        const messageId = deps.ids();
        const assistantMessageId = deps.ids();
        if (new Set([runId, messageId, assistantMessageId]).size !== 3) {
          throw new Error('Agent id generator returned duplicate ids');
        }
        const redactedText = await deps.redactor.redact(caller.appId, body.text);
        let limits: AdmissionLimits;
        try {
          limits = await deps.limits.current(caller.appId);
        } catch (error) {
          failed('send_message', 'limits', error);
          refuse(caller, reply, 50401);
          return;
        }
        const labels = await deps.labels.current(caller);
        // Resolve display labels before acceptance too: a label outage must not charge a turn.
        const modelLabel = await deps.labels.modelLabel(caller.appId, labels.modelSnapshot);
        const aiLabel = await deps.labels.aiLabel(caller.appId);
        let result;
        try {
          result = await deps.admission.admit(
            {
              sessionId,
              clientMsgId: body.client_msg_id,
              runId,
              messageId,
              subject:
                caller.userId !== null && caller.phoneBound
                  ? { tier: 'member', userId: caller.userId }
                  : {
                      tier: 'guest',
                      loggedIn: caller.userId !== null,
                      deviceHash: caller.deviceHash,
                      ipKey: caller.ipKey,
                    },
              reply: {
                assistantMessageId,
                promptVersion: labels.promptVersion,
                modelSnapshot: labels.modelSnapshot,
                runUserText: redactedText,
                messageText: redactedText,
              },
            },
            limits,
          );
        } catch (error) {
          failed('send_message', 'admit', error);
          refuse(caller, reply, error instanceof AdmissionUnavailableError ? 50401 : 50001);
          return;
        }
        if (result.kind === 'rejected') {
          switch (result.code) {
            case 42901:
              refuse(caller, reply, result.code, undefined, {
                'retry-after': String(result.retryAfterSeconds),
              });
              break;
            case 30504:
              refuse(
                caller,
                reply,
                result.code,
                result.reason === 'round_limit' ? { reason: 'round_limit' } : undefined,
              );
              break;
            case 30502:
              refuse(caller, reply, result.code, { reset_at: result.resetAt, next: result.next });
              break;
            case 30506:
              refuse(caller, reply, result.code);
              break;
          }
          return;
        }
        if (result.kind === 'duplicate') {
          const original = result.original;
          const originalLabel = await deps.labels.modelLabel(caller.appId, original.modelSnapshot);
          streaming = true;
          sink = trackSink(reply.stream(SSE_HEADERS));
          sink.write(
            encodeFrame({
              event: 'meta',
              id: 1,
              data: {
                session_id: sessionId,
                run_id: original.runId,
                message_id: original.assistantMessageId,
                prompt_version: original.promptVersion,
                model_label: originalLabel,
                ai_label: aiLabel,
                duplicate: true,
              },
            }),
          );
          const terminal =
            result.reply.kind === 'final'
              ? result.reply.frame
              : {
                  event: 'error' as const,
                  data: {
                    code: 30506,
                    msg: deps.texts.errorMsg(30506),
                    retryable: true,
                    fallback: null,
                    fallback_q: null,
                  },
                };
          sink.write(encodeFrame({ event: terminal.event, data: { ...terminal.data }, id: 2 }));
          return;
        }
        streaming = true;
        sink = trackSink(reply.stream(SSE_HEADERS));
        const runInput: RunBodyInput = {
          caller,
          sessionId,
          runId,
          userMessageId: messageId,
          assistantMessageId,
          text: body.text,
          redactedText,
          limits,
          ...(body.context === undefined ? {} : { context: body.context }),
        };
        await deps.runs.start(
          {
            ticket: result.ticket,
            ownerKey: ownerKeyOf(caller),
            appId: caller.appId,
            limits,
            meta: {
              message_id: assistantMessageId,
              prompt_version: labels.promptVersion,
              model_label: modelLabel,
              ai_label: aiLabel,
            },
            sink,
          },
          async (ctx) => deps.body(runInput)(ctx),
        );
      } catch (error) {
        failed('send_message', streaming ? 'stream' : 'prepare', error);
        // Once SSE starts, never send JSON or invent an unpersisted terminal frame.
        if (!streaming) refuse(caller, reply, 50001);
      } finally {
        sink?.end();
      }
    },
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } as const;

function ownerOf(caller: AgentCaller): AgentOwner {
  return caller.userId === null
    ? { kind: 'device', appId: caller.appId, deviceId: caller.deviceId }
    : { kind: 'user', appId: caller.appId, deviceId: caller.deviceId, userId: caller.userId };
}

function ownerKeyOf(caller: AgentCaller): string {
  return caller.userId === null ? `d:${caller.deviceId}` : `u:${caller.userId}`;
}

function sessionData(row: AgentSessionRow): Schema<'AgentSession'> {
  return {
    session_id: row.id,
    started_at: row.startedAt.toISOString(),
    last_active_at: row.lastActiveAt.toISOString(),
  };
}
