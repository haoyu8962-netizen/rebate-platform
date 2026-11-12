// B3-08ze rule-test kit · listAgentSessionMessages over the real HTTP layer (GET
// /v1/agent/sessions/{id}/messages; 04 §6.5; BR-AI-19 细则「助手回复落库」, BR-AI-20, BR-AI-23 GET
// ①–④; D10-1347). B3-08zc pinned the framework-neutral read side (createAgentHistoryRuntime,
// test/spec/agent/session-history/**); this kit reaches the same answers through the real stream
// entry: bootstrap.createHttpApp('stream') (AppModule.forEntry, no listen, the job queue not
// started) over this test's PostgreSQL database, requests sent with Fastify inject, access tokens
// issued by the entry's own identity TOKEN_SERVICE, guests identified by X-Device-Id without a
// token. Precedents: test/spec/agent/stream-mount/mount.int.test.ts and
// test/spec/identity/deletion-guard-stream/kit.ts.
//
// Contract pinned by these tests:
// - The stream entry serves GET /v1/agent/sessions/{id}/messages (route schema from the contract;
//   query cursor / limit). 200: application/json AgentHistoryResponse of contracts/openapi.yaml
//   (code 0, msg '', data {items, next_cursor, expired}, trace_id = the request's well-formed
//   X-Trace-Id), items as B3-08zc's read side gives them; refusals: the JSON ErrorEnvelope with the
//   HTTP status of contracts/error-codes.yaml, the operation's 4XX schema, trace_id as above.
// - Owner (BR-AI-20): a guest owns only a session with user_id NULL and its device_id that never
//   had a user; a member's session detached by the account deletion cleanup (user_id NULL,
//   user_hash set, device_id kept) is no guest's — not readable, not current, not writable.
// Synthetic values only. Everything under test is built inside the tests (never in hooks).
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { historyResponseCheck, type HistoryData } from '../reply-persist/kit.ts';
import { httpStatusOf } from '../stream-http/kit.ts';
import { Logs, framesOf, type Frame, type Row } from '../stream-mount/kit.ts';

export type { Frame, HistoryData, Row };

/** When every test starts (the stream entry's clock). */
export const START = '2026-10-06T10:00:00+08:00';
/** BR-AI-20: a session expires 24 hours after its last accepted message. */
export const DAY_MS = 86_400_000;

export interface Injected {
  readonly statusCode: number;
  readonly headers: Record<string, unknown>;
  readonly body: string;
}

export interface StreamApp {
  init(): Promise<unknown>;
  close(): Promise<void>;
  get(token: unknown, options?: { strict: boolean }): unknown;
  inject(options: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    payload?: string;
  }): Promise<Injected>;
}

const src = (path: string): string =>
  new URL(`../../../../apps/api/src/${path}`, import.meta.url).href;

/** The real stream entry over `db` (no listen, the job queue not started; the test owns the pool). */
export async function streamApp(db: Kysely<DB>, clock: FixedClock): Promise<StreamApp> {
  const boot = (await import(src('bootstrap.ts'))) as {
    createHttpApp(entry: string, overrides: object): Promise<StreamApp>;
  };
  const { loadConfig } = (await import(src('modules/platform/index.ts'))) as {
    loadConfig(env: Record<string, string>): unknown;
  };
  const app = await boot.createHttpApp('stream', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger: new Logs().logger,
    dbHandles: { db, dbRead: null, close: async () => undefined },
    startQueue: false,
  });
  try {
    await app.init();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

/** A live access token of `caller` (a member), issued by the stream entry's own token service. */
export async function accessToken(
  app: StreamApp,
  db: Kysely<DB>,
  clock: FixedClock,
  caller: AgentCaller,
): Promise<string> {
  expect(caller.userId, 'a member').not.toBeNull();
  const { TOKEN_SERVICE } = (await import(src('modules/identity/application/tokens.ts'))) as {
    TOKEN_SERVICE: symbol;
  };
  const identity = (await import(
    src('modules/identity/application/sessions.ts')
  )) as typeof import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  type Tokens = Parameters<typeof identity.createSession>[2]['tokens'];
  let tokens: Tokens | undefined;
  try {
    tokens = app.get(TOKEN_SERVICE, { strict: false }) as Tokens;
  } catch {
    // Unwired: the stream entry runs identity's token check, so it holds its token service.
  }
  expect(tokens, "the stream entry provides identity's TOKEN_SERVICE").toBeDefined();
  const session = await db
    .transaction()
    .execute((trx) =>
      identity.createSession(
        trx,
        { uid: caller.userId!, app_id: caller.appId, device_id: caller.deviceId, scp: 'full' },
        { clock, tokens: tokens! },
      ),
    );
  return session.access_token;
}

/** A well-formed X-Trace-Id (a UUID; the platform keeps a 32 / 36-character UUID or hex value as sent). */
export function newTraceId(): string {
  return randomUUID();
}

/** One request of a client: the response and the trace id it was sent with. */
export interface Sent {
  readonly response: Injected;
  readonly traceId: string;
}

export type Client = (method: string, url: string, body?: unknown) => Promise<Sent>;

function clientOf(app: StreamApp, base: Record<string, string>): Client {
  return async (method, url, body) => {
    const traceId = newTraceId();
    const headers = { ...base, 'x-trace-id': traceId };
    const response = await app.inject({
      method,
      url,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { response, traceId };
  };
}

function clientHeaders(caller: AgentCaller): Record<string, string> {
  return {
    'x-app-id': caller.appId,
    'x-platform': 'ios',
    'x-channel': 'appstore',
    'x-app-version': '2.0.0',
    'x-device-id': caller.deviceId,
  };
}

/** A member's requests: the contract's client headers and a bearer access token of the caller. */
export async function memberClient(
  app: StreamApp,
  db: Kysely<DB>,
  clock: FixedClock,
  caller: AgentCaller,
): Promise<Client> {
  const token = await accessToken(app, db, clock, caller);
  return clientOf(app, { ...clientHeaders(caller), authorization: `Bearer ${token}` });
}

/** A guest's requests: no token, the device identity of the caller's devices row. */
export function guestClient(app: StreamApp, caller: AgentCaller): Client {
  return clientOf(app, clientHeaders(caller));
}

export function historyUrl(sessionId: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  const path = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/messages`;
  return search === '' ? path : `${path}?${search}`;
}

export function headerOf(response: Injected, name: string): string {
  const value = response.headers[name.toLowerCase()];
  return value === undefined ? '' : String(value);
}

/** The JSON body of a response (application/json asserted first). */
export function json(response: Injected): Row {
  expect(headerOf(response, 'content-type'), response.body).toMatch(/^application\/json/u);
  return JSON.parse(response.body) as Row;
}

/** createAgentSession through HTTP; returns the new session id. */
export async function createSession(call: Client): Promise<string> {
  const { response } = await call('POST', '/v1/agent/sessions');
  expect(response.statusCode, response.body).toBe(200);
  const body = json(response);
  expect(body['code'], response.body).toBe(0);
  const id = (body['data'] as Row)['session_id'];
  expect(id, 'session id').toBeTypeOf('string');
  return id as string;
}

/** sendAgentMessage through HTTP: accepted (SSE ending with a terminal frame); its frames. */
export async function sendTurn(call: Client, sessionId: string, text: string): Promise<Frame[]> {
  const { response } = await call('POST', `/v1/agent/sessions/${sessionId}/messages`, {
    client_msg_id: randomUUID(),
    text,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(headerOf(response, 'content-type'), response.body).toMatch(/^text\/event-stream/u);
  const frames = framesOf([response.body]);
  expect(frames[0]?.event, 'meta first').toBe('meta');
  expect(['done', 'error'], 'a terminal frame last').toContain(frames[frames.length - 1]?.event);
  return frames;
}

/**
 * One 200 answer of the history route: application/json, code 0, msg '', trace_id = the request's
 * X-Trace-Id, the body passes the contract's AgentHistoryResponse; returns data.
 */
export async function expectHistoryOk(sent: Sent): Promise<HistoryData> {
  const { response, traceId } = sent;
  expect(response.statusCode, response.body).toBe(200);
  const body = json(response);
  expect(body['code'], response.body).toBe(0);
  expect(body['msg']).toBe('');
  expect(body['trace_id']).toBe(traceId);
  (await historyResponseCheck(200))(body);
  return body['data'] as HistoryData;
}

/**
 * One refusal of the history route: the status of contracts/error-codes.yaml for `code`,
 * application/json ErrorEnvelope passing the operation's schema for that status, a non-empty msg,
 * trace_id = the request's X-Trace-Id, data exactly as given (absent when undefined).
 */
export async function expectHistoryRefused(sent: Sent, code: number, data?: Row): Promise<Row> {
  const { response, traceId } = sent;
  const body = json(response);
  expect(body['code'], response.body).toBe(code);
  expect(response.statusCode, `HTTP status of ${String(code)}`).toBe(httpStatusOf(code));
  expect(body['msg']).toBeTypeOf('string');
  expect(String(body['msg'])).not.toBe('');
  expect(body['trace_id']).toBe(traceId);
  if (data === undefined) expect(body).not.toHaveProperty('data');
  else expect(body['data']).toEqual(data);
  (await historyResponseCheck(response.statusCode))(body);
  return body;
}

/** A fresh stream-entry clock at START. */
export function startClock(): FixedClock {
  return new FixedClock(START);
}

/** Moves the entry's clock past the agent.* switch cache (kept for less than 1 000 ms). */
export function pastSwitchCache(clock: FixedClock): void {
  clock.advanceMs(1_000);
}
