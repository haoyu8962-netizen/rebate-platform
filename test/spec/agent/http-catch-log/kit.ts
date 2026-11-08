// B3-08v helpers (unit tier): fakes of every port of createAgentHttp with failure injection at each
// fallback catch of apps/api/src/modules/agent/http/index.ts, a reply that records JSON answers
// and SSE streams, and a logger that records every warn / error call. Built only inside tests.
//
// The catch sites (brief §9.1; line numbers of the trunk file):
//   create  (:263) createSession          — operation create_session
//   current (:278) currentSession         — operation current_session
//   cancel  (:300) cancelRun              — operation cancel_run
//   admit   (:377) sendMessage, admit()   — operation send_message (50401 / 50001 split)
//   outer   (:470) sendMessage, the rest  — operation send_message (JSON 50001 only before SSE)
// Expected values (codes, operation names) stay in the rule tests.
import { expect } from 'vitest';

import {
  createAgentHttp,
  type AgentCaller,
  type AgentHttp,
  type AgentHttpReply,
  type AgentStreamSink,
} from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  AgentOwner,
  AgentSessionRow,
  OwnedSession,
} from '../../../../apps/api/src/modules/agent/store/index.ts';
import type {
  AdmissionLimits,
  AdmissionRequest,
  AdmissionResult,
  RedactedText,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { CancelQuery } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import type {
  RunFinal,
  RunStart,
  RunTexts,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { errorCodes, liveCode } from '../../contracts/agent-http/kit.ts';

export type Row = Record<string, unknown>;

export const APP = 'couli';
export const START_MS = 1_791_252_000_000;

export const texts: RunTexts = {
  text: () => '超时提示（测试）',
  errorMsg: (code) => `错误提示-${code}`,
};

/** Synthetic user text: sent as the message text and carried inside the injected failures. */
export const USER_TEXT = '帮我查下订单 合成用户原文b308v 手机13800138000';
/**
 * A bearer-style credential string (synthetic, assembled from labels so that no credential-shaped
 * literal sits in the source) carried inside the injected failures.
 */
export const BEARER_LIKE = [
  'Bearer',
  ['eyJhbGciOiJIUzI1NiJ9', 'b308v-synthetic', 'sig-b308v'].join('.'),
].join(' ');
/** The failure detail: the error message of every injected failure. */
export const DETAIL = `port failed while handling "${USER_TEXT}" with ${BEARER_LIKE}`;

/** An Error whose name is `name` and whose message (and so stack) carries DETAIL. */
export function failure(name: string): Error {
  const error = new Error(DETAIL);
  error.name = name;
  return error;
}

// ---- ids and callers -------------------------------------------------------------------------

let idNo = 0;
/** A UUIDv7-shaped id, unique within the test run. */
export function newId(): string {
  idNo += 1;
  return `019a0000-0000-7000-8b30-${idNo.toString(16).padStart(12, '0')}`;
}

let traceNo = 0;
/** A logged-in caller with a bound phone (every identifying field set and distinct). */
export function member(): AgentCaller {
  traceNo += 1;
  const deviceId = newId();
  return {
    appId: APP,
    traceId: `trace_b3_08v_${traceNo}_${deviceId.slice(-6)}`,
    deviceId,
    deviceHash: `dh-b308v-${deviceId}`,
    ipKey: `ipk-b308v-${deviceId}`,
    userId: newId(),
    phoneBound: true,
  };
}

/** Identifiers of the caller and the message that must never appear in a log line. */
export function identifiersOf(caller: AgentCaller, clientMsgId?: string): string[] {
  const ids = [caller.traceId, caller.deviceId, caller.deviceHash, caller.ipKey];
  if (caller.userId !== null) ids.push(caller.userId);
  if (clientMsgId !== undefined) ids.push(clientMsgId);
  return ids;
}

let msgNo = 0;
export function messageBody(): { client_msg_id: string; text: string } {
  msgNo += 1;
  return { client_msg_id: `msgb308v${msgNo.toString(16).padStart(8, '0')}`, text: USER_TEXT };
}

// ---- logger ----------------------------------------------------------------------------------

export interface LogEntry {
  level: 'warn' | 'error';
  args: unknown[];
}

/** Records every warn / error call with its arguments as given. */
export class RecordingLogger {
  readonly entries: LogEntry[] = [];
  readonly logger = {
    warn: (...args: unknown[]) => void this.entries.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void this.entries.push({ level: 'error', args }),
  } as unknown as Pick<RootLogger, 'warn' | 'error'>;
  errors(): LogEntry[] {
    return this.entries.filter((e) => e.level === 'error');
  }
}

/**
 * The line as text: JSON with every Error found anywhere expanded to name, message and stack (a
 * logged Error object reaches pino's serializer, which writes its message and stack).
 */
export function serialize(entry: LogEntry): string {
  return JSON.stringify(entry.args, (_key, value: unknown) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
  });
}

/** Every string value (and object key) anywhere in the arguments, Errors expanded. */
export function stringsOf(entry: LogEntry): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      out.push(value.name, value.message, value.stack ?? '');
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      walk(inner);
    }
  };
  for (const arg of entry.args) walk(arg);
  return out;
}

// ---- ports -----------------------------------------------------------------------------------

/** A port call that fails: an Error, or any other thrown value. */
export type Fault = unknown;

/** A gate (①, ②, ③) that lets the caller pass unless `fail` is set. */
export class Gate {
  fail: Fault | undefined = undefined;
  check(): Promise<null> {
    if (this.fail !== undefined) return Promise.reject(this.fail);
    return Promise.resolve(null);
  }
}

export class FakeSessions {
  readonly fail: { open?: Fault; current?: Fault; owned?: Fault; ownsRun?: Fault } = {};
  /** Session ids owned by the caller (any owner here: one caller per rig). */
  readonly mine = new Set<string>();
  readonly runs = new Set<string>();
  open(_owner: AgentOwner, id: string): Promise<AgentSessionRow> {
    if (this.fail.open !== undefined) return Promise.reject(this.fail.open);
    const at = new Date(START_MS);
    return Promise.resolve({ id, startedAt: at, lastActiveAt: at });
  }
  current(): Promise<AgentSessionRow | null> {
    if (this.fail.current !== undefined) return Promise.reject(this.fail.current);
    const at = new Date(START_MS);
    const first = [...this.mine][0];
    return Promise.resolve(
      first === undefined ? null : { id: first, startedAt: at, lastActiveAt: at },
    );
  }
  owned(_owner: AgentOwner, sessionId: string): Promise<OwnedSession | null> {
    if (this.fail.owned !== undefined) return Promise.reject(this.fail.owned);
    if (!this.mine.has(sessionId)) return Promise.resolve(null);
    const at = new Date(START_MS - 60_000);
    return Promise.resolve({
      session: { id: sessionId, startedAt: at, lastActiveAt: at },
      expired: false,
    });
  }
  ownsRun(_owner: AgentOwner, runId: string): Promise<boolean> {
    if (this.fail.ownsRun !== undefined) return Promise.reject(this.fail.ownsRun);
    return Promise.resolve(this.runs.has(runId));
  }
}

const LIMITS: AdmissionLimits = {
  memberDaily: 7,
  guestDaily: 2,
  guestIpDaily: 9,
  perMinute: 4,
  maxRounds: 11,
};

export class FakeAdmission {
  fail: Fault | undefined = undefined;
  answer: ((req: AdmissionRequest) => AdmissionResult) | null = null;
  readonly admits: AdmissionRequest[] = [];
  admit(req: AdmissionRequest): Promise<AdmissionResult> {
    this.admits.push(req);
    if (this.fail !== undefined) return Promise.reject(this.fail);
    if (this.answer !== null) return Promise.resolve(this.answer(req));
    return Promise.resolve({
      kind: 'accepted',
      ticket: {
        runId: req.runId,
        messageId: req.messageId,
        sessionId: req.sessionId,
        subject: req.subject,
        dayKey: '2026-11-08',
        acceptedAtMs: START_MS,
        lockExpiresAtMs: START_MS + 50_000,
      },
      quotaLeft: 5,
    });
  }
}

export class FakeLabels {
  readonly fail: { current?: Fault; modelLabel?: Fault; aiLabel?: Fault } = {};
  current(): Promise<{ promptVersion: string; modelSnapshot: string | null }> {
    if (this.fail.current !== undefined) return Promise.reject(this.fail.current);
    return Promise.resolve({ promptVersion: 'agent-prompt@b308v', modelSnapshot: 'snap-b308v' });
  }
  modelLabel(): Promise<string> {
    if (this.fail.modelLabel !== undefined) return Promise.reject(this.fail.modelLabel);
    return Promise.resolve('模型展示名（测试）');
  }
  aiLabel(): Promise<string> {
    if (this.fail.aiLabel !== undefined) return Promise.reject(this.fail.aiLabel);
    return Promise.resolve('内容由 AI 生成（测试）');
  }
}

/** The RunManager stand-in: writes a frame and resolves, or rejects (after the stream opened). */
export class FakeRuns {
  fail: Fault | undefined = undefined;
  readonly starts: RunStart[] = [];
  start(start: RunStart): Promise<RunFinal> {
    this.starts.push(start);
    if (this.fail !== undefined) return Promise.reject(this.fail);
    start.sink.write('event: done\nid: 2\ndata: {}\n\n');
    return Promise.resolve({ terminal: null, ending: 'stop', cardsDelivered: 0 });
  }
}

export class FakeCancel {
  fail: Fault | undefined = undefined;
  answer: 'accepted' | 'not_running' = 'accepted';
  readonly calls: CancelQuery[] = [];
  cancel(query: CancelQuery): Promise<'accepted' | 'not_running'> {
    this.calls.push(query);
    if (this.fail !== undefined) return Promise.reject(this.fail);
    return Promise.resolve(this.answer);
  }
}

export class FakeSignals {
  mode: 'ok' | 'reject' = 'ok';
  readonly calls: string[] = [];
  requestCancel(runId: string): Promise<'ok' | 'not_found'> {
    this.calls.push(runId);
    if (this.mode === 'reject') return Promise.reject(failure('SyntheticSignalFailure'));
    return Promise.resolve('ok');
  }
}

export class FakeRedactor {
  fail: Fault | undefined = undefined;
  redact(_appId: string, text: string): Promise<RedactedText> {
    if (this.fail !== undefined) return Promise.reject(this.fail);
    return Promise.resolve(`[r]${text.replace(/[0-9]/g, '*')}` as RedactedText);
  }
}

// ---- reply -----------------------------------------------------------------------------------

export interface JsonCall {
  status: number;
  headers: Record<string, string>;
  body: Row;
}

/** Records JSON answers and SSE streams. */
export class FakeReply implements AgentHttpReply {
  readonly jsons: JsonCall[] = [];
  readonly streams: Record<string, string>[] = [];
  readonly chunks: string[] = [];
  ended = 0;
  json(status: number, headers: Readonly<Record<string, string>>, body: unknown): void {
    this.jsons.push(structuredClone({ status, headers: { ...headers }, body: body as Row }));
  }
  stream(headers: Readonly<Record<string, string>>): AgentStreamSink {
    this.streams.push({ ...headers });
    return {
      write: (chunk: string) => void this.chunks.push(chunk),
      onClose: () => undefined,
      end: () => {
        this.ended += 1;
      },
    };
  }
  /** What the client received, for comparing two runs of the same request. */
  record(): Row {
    return {
      jsons: this.jsons.map((j) => ({ ...j, body: { ...j.body, trace_id: '<trace>' } })),
      streams: this.streams,
      chunks: this.chunks,
      ended: this.ended,
    };
  }
}

// ---- the rig ---------------------------------------------------------------------------------

export interface Rig {
  http: AgentHttp;
  caller: AgentCaller;
  access: Gate;
  identity: Gate;
  consent: Gate;
  sessions: FakeSessions;
  admission: FakeAdmission;
  runs: FakeRuns;
  cancel: FakeCancel;
  signals: FakeSignals;
  redactor: FakeRedactor;
  labels: FakeLabels;
  /** Present unless the rig was built with `logger: false`. */
  log: RecordingLogger | null;
  /** A session of the caller and a run in it. */
  sessionId: string;
  runId: string;
}

export function rig(options: { logger?: boolean } = {}): Rig {
  const log = options.logger === false ? null : new RecordingLogger();
  const r: Omit<Rig, 'http'> = {
    caller: member(),
    access: new Gate(),
    identity: new Gate(),
    consent: new Gate(),
    sessions: new FakeSessions(),
    admission: new FakeAdmission(),
    runs: new FakeRuns(),
    cancel: new FakeCancel(),
    signals: new FakeSignals(),
    redactor: new FakeRedactor(),
    labels: new FakeLabels(),
    log,
    sessionId: newId(),
    runId: newId(),
  };
  r.sessions.mine.add(r.sessionId);
  r.sessions.runs.add(r.runId);
  const http = createAgentHttp({
    access: r.access,
    identity: r.identity,
    consent: r.consent,
    sessions: r.sessions,
    admission: r.admission,
    runs: r.runs,
    cancel: (query) => r.cancel.cancel(query),
    signals: r.signals,
    limits: { current: () => Promise.resolve({ ...LIMITS }) },
    body: () => () => Promise.resolve({ kind: 'done', finishReason: 'stop' }),
    redactor: r.redactor,
    labels: r.labels,
    settings: { textMaxCodePoints: 500 },
    texts,
    ids: newId,
    clock: { now: () => new Date(START_MS) },
    ...(log === null ? {} : { logger: log.logger }),
  });
  return { ...r, http };
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---- operations ------------------------------------------------------------------------------

export type Operation = 'create_session' | 'current_session' | 'cancel_run' | 'send_message';

function start(r: Rig, op: Operation, reply: FakeReply, body: Row): Promise<void> {
  if (op === 'create_session') return r.http.createSession(r.caller, reply);
  if (op === 'current_session') return r.http.currentSession(r.caller, reply);
  if (op === 'cancel_run') return r.http.cancelRun(r.caller, r.runId, reply);
  return r.http.sendMessage(r.caller, r.sessionId, body, reply);
}

/** Runs one request of `op` on the rig; resolves when the handler settles (and asserts it does). */
export async function call(
  r: Rig,
  op: Operation,
  body?: { client_msg_id: string; text: string },
): Promise<FakeReply> {
  const reply = new FakeReply();
  const done = start(r, op, reply, body ?? messageBody());
  const outcome = await Promise.race([
    done.then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    flush().then(() => 'pending' as const),
  ]);
  expect(outcome, `${op} settles and never rejects`).toBe('resolved');
  await flush();
  return reply;
}

// ---- answers ---------------------------------------------------------------------------------

export function httpStatusOf(code: number): number {
  const status = liveCode(errorCodes(), code)['http'];
  expect(status, `error-codes.yaml ${code}.http`).toBeTypeOf('number');
  return status as number;
}

/** Exactly one JSON error answer as the trunk gives it (no stream, no data). */
export function expectJsonError(reply: FakeReply, caller: AgentCaller, code: number): void {
  expect(reply.streams, 'no SSE stream for a JSON answer').toEqual([]);
  expect(reply.jsons, 'exactly one JSON answer').toHaveLength(1);
  const answer = reply.jsons[0]!;
  expect(answer.status).toBe(httpStatusOf(code));
  expect(answer.headers).toStrictEqual({ 'content-type': 'application/json' });
  expect(answer.body).toStrictEqual({
    code,
    msg: texts.errorMsg(code),
    trace_id: caller.traceId,
  });
}

/** SSE had started: one stream with the SSE headers, no JSON at all, the sink ended once. */
export function expectStreamWithoutJson(reply: FakeReply): void {
  expect(reply.jsons, 'no JSON once SSE started').toEqual([]);
  expect(reply.streams).toStrictEqual([
    { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  ]);
  expect(reply.ended).toBe(1);
}

/** One 200 JSON answer. */
export function expectOk(reply: FakeReply, caller: AgentCaller): Row {
  expect(reply.streams).toEqual([]);
  expect(reply.jsons).toHaveLength(1);
  const answer = reply.jsons[0]!;
  expect(answer.status).toBe(200);
  expect(answer.body['code']).toBe(0);
  expect(answer.body['trace_id']).toBe(caller.traceId);
  return answer.body;
}

/**
 * The single log line of one failure: exactly one entry, at error level; among its strings the
 * operation name and the error name (or 'unknown'); nothing of the failure detail, the user text,
 * the bearer-style string or the caller's / message's identifiers, and no Error object.
 */
export function expectOneErrorLine(
  log: RecordingLogger,
  options: { op: Operation; errorName: string; forbidden: readonly string[] },
): LogEntry {
  expect(
    log.entries.map((e) => e.level),
    'exactly one log line, at error level',
  ).toStrictEqual(['error']);
  const entry = log.entries[0]!;
  const strings = stringsOf(entry);
  expect(strings, 'the operation name is in the line').toContain(options.op);
  expect(strings, 'the error name is in the line').toContain(options.errorName);
  const text = serialize(entry);
  for (const piece of [DETAIL, USER_TEXT, BEARER_LIKE, ...options.forbidden]) {
    expect(text, 'the line carries none of the failure detail or identifiers').not.toContain(piece);
  }
  expect(text).not.toContain('13800138000');
  expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  expect(
    entry.args.some((a) => a instanceof Error),
    'no Error object handed to the logger',
  ).toBe(false);
  return entry;
}
