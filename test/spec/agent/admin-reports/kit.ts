// B1-10t rule-test kit (claude-independent, SPEC_REF 62b5c993): contracts/openapi.yaml
// adminListAgentReports (GET /admin/v1/agent-traces/reports) and adminHandleAgentReport
// (POST /admin/v1/agent-traces/reports/{message_id}/handle), CT-24zzi, 编排 D10-1287 ⑤ / D10-1310
// (D1 第二段). 08 BR-ID-15 细则「举报的处理」(举报列表在后台「AI 助手记录」页，处理人查看对话、
// 标记已处理并填写处理说明，写审计；48 小时时限从举报提交起算，超时告警), BR-AI-19 (后台查看
// trace 需要权限点 agent.trace).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin
// sessions and step-up tokens (the suite of ../admin-traces/kit.ts). Synthetic: the agent_* rows,
// written directly with INSERT on the report columns agent_messages already has (reported,
// report_reason, reported_at, report_status, report_handler_id, report_handled_at, report_note,
// row_version) within the table's CHECKs, the users, devices and admin accounts. No real user data.
// Missing routes fail as assertions: the HTTP status is always checked before the body is parsed.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  REPORT,
  TRACE,
  ago,
  doneRun,
  insertMessage,
  insertRun,
  marker,
  plus,
  userMessage,
  type Fixture,
  type Session,
} from '../admin-traces/kit.ts';

export {
  PII,
  REPORT,
  TRACE,
  agentTables,
  auditCount,
  fixture,
  marker,
  otherApp,
  plus,
  plus8,
  seedMember,
  seedSession,
  suite,
  type Fixture,
  type Member,
  type Session,
} from '../admin-traces/kit.ts';

export const LIST_PATH = '/admin/v1/agent-traces/reports';
export const HANDLE_PATH = '/admin/v1/agent-traces/reports/{message_id}/handle';
/** The audit action of a handled report (B1-10s: target agent_messages:<message_id>). */
export const AUDIT_ACTION = 'agent_report_handle';
export const SECOND = 1000;
export const HOUR = 3_600_000;
/** BR-ID-15: a report is handled within 48 hours of its submission. */
export const DEADLINE_MS = 48 * HOUR;
/** 20902 of this resource (contracts/error-codes.yaml, CT-24zzi). */
export const CONFLICT = { resource: 'agent_report' } as const;

/** AdminAgentReport (additionalProperties false), sorted. */
export const REPORT_KEYS = [
  'deadline_at',
  'handled_at',
  'handler_id',
  'handler_name',
  'message_id',
  'overdue',
  'report_note',
  'report_reason',
  'report_status',
  'reported_at',
  'row_version',
  'session_id',
  'user_id',
] as const;

/** The agent_messages columns a successful handle writes (plus updated_at, not pinned). */
export const HANDLE_COLUMNS = [
  'report_status',
  'report_handler_id',
  'report_handled_at',
  'report_note',
  'row_version',
  'updated_at',
] as const;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Fixtures on the suite's database.

/** An instant `hours` before the fixture's clock (whole seconds, as NOW is). */
export function hoursAgo(f: Fixture, hours: number): Date {
  return ago(f, hours * 60);
}

async function insertRow(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  const names = Object.keys(row);
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

/** An admin account that handles reports: id and display name (admin_users.display_name). */
export interface Handler {
  readonly id: string;
  readonly name: string | null;
}

/** An admin_users row of `appId` with a display name (it handled seeded reports). */
export async function seedHandler(f: Fixture, appId = f.appId): Promise<Handler> {
  const id = randomUUID();
  const name = marker('处理人');
  await f.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `rpt_handler_${id}`,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_bound_at: f.clock.now(),
      verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
      display_name: name,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return { id, name };
}

export interface Handling {
  readonly by: Handler;
  readonly at: Date;
  readonly note: string;
}

export interface ReportSeed {
  readonly reportedAt: Date;
  /** Absent: still pending. */
  readonly handled?: Handling;
  /** null: cleared after the user's data was deleted (BR-AI-22). Absent: a synthetic reason. */
  readonly reason?: string | null;
  /** agent_messages.row_version (default 1). */
  readonly rowVersion?: number;
}

/** One reported assistant reply, as written. */
export interface Report {
  readonly id: string;
  readonly session: Session;
  readonly reportedAt: Date;
  readonly reason: string | null;
  readonly handled: Handling | null;
  readonly rowVersion: number;
  /** The free texts of the turn that must never show in a report row or audit: reply, question, user_text. */
  readonly texts: readonly string[];
  /** The user message of the same turn (never reported). */
  readonly questionId: string;
}

/** A finished run with a user message and an assistant reply reported at `seed.reportedAt`. */
export async function seedReport(f: Fixture, session: Session, seed: ReportSeed): Promise<Report> {
  const acceptedAt = plus(seed.reportedAt, -10 * 60_000);
  const run = doneRun(acceptedAt);
  await insertRun(f, session, run);
  const question = userMessage(run.id, acceptedAt, marker('rpt-question'));
  await insertMessage(f, session, question);
  const id = randomUUID();
  const text = marker('rpt-answer');
  const reason = seed.reason === undefined ? marker('rpt-reason') : seed.reason;
  const handled = seed.handled ?? null;
  const rowVersion = seed.rowVersion ?? 1;
  await insertRow(f.db, 'agent_messages', {
    id,
    app_id: session.appId,
    session_id: session.id,
    run_id: run.id,
    client_msg_id: null,
    role: 'assistant',
    text,
    card_ids: [],
    feedback: null,
    feedback_at: null,
    reported: true,
    report_reason: reason,
    reported_at: seed.reportedAt,
    report_status: handled === null ? 'pending' : 'handled',
    report_handler_id: handled === null ? null : handled.by.id,
    report_handled_at: handled === null ? null : handled.at,
    report_note: handled === null ? null : handled.note,
    badcase: false,
    row_version: rowVersion,
    created_at: plus(acceptedAt, 2000),
    updated_at: handled === null ? seed.reportedAt : handled.at,
  });
  return {
    id,
    session,
    reportedAt: seed.reportedAt,
    reason,
    handled,
    rowVersion,
    texts: [text, question.text ?? '', run.userText ?? ''].filter((entry) => entry !== ''),
    questionId: question.id,
  };
}

/** A finished turn whose assistant reply was never reported. */
export interface Unreported {
  readonly replyId: string;
  readonly questionId: string;
  readonly texts: readonly string[];
}

export async function seedUnreported(f: Fixture, session: Session, at: Date): Promise<Unreported> {
  const run = doneRun(at);
  await insertRun(f, session, run);
  const question = userMessage(run.id, at, marker('rpt-plain-question'));
  await insertMessage(f, session, question);
  const replyId = randomUUID();
  const text = marker('rpt-plain-answer');
  await insertRow(f.db, 'agent_messages', {
    id: replyId,
    app_id: session.appId,
    session_id: session.id,
    run_id: run.id,
    client_msg_id: null,
    role: 'assistant',
    text,
    card_ids: [],
    feedback: 'up',
    feedback_at: plus(at, 30_000),
    reported: false,
    report_reason: null,
    reported_at: null,
    report_status: null,
    report_handler_id: null,
    report_handled_at: null,
    report_note: null,
    badcase: false,
    row_version: 0,
    created_at: plus(at, 2000),
    updated_at: plus(at, 30_000),
  });
  return {
    replyId,
    questionId: question.id,
    texts: [text, question.text ?? '', run.userText ?? ''].filter((entry) => entry !== ''),
  };
}

/** The report after it was handled by `by` at `at` with the stored (trimmed) `note`. */
export function afterHandle(r: Report, by: Handler, at: Date, note: string): Report {
  return { ...r, handled: { by, at, note }, rowVersion: r.rowVersion + 1 };
}

/** The AdminAgentReport row the report must be shown as at `now` (instants as epoch ms). */
export function reportItem(r: Report, now: Date): Row {
  const deadline = r.reportedAt.getTime() + DEADLINE_MS;
  const handled = r.handled;
  return {
    message_id: r.id,
    session_id: r.session.id,
    user_id: r.session.userId,
    reported_at: r.reportedAt.getTime(),
    report_reason: r.reason,
    report_status: handled === null ? 'pending' : 'handled',
    deadline_at: deadline,
    overdue: handled === null && now.getTime() >= deadline,
    handled_at: handled === null ? null : handled.at.getTime(),
    handler_id: handled === null ? null : handled.by.id,
    handler_name: handled === null ? null : handled.by.name,
    report_note: handled === null ? null : handled.note,
    row_version: r.rowVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Database views.

/** One agent_messages row as JSON (timestamps as PostgreSQL renders them in jsonb). */
export async function messageRow(db: Kysely<DB>, id: string): Promise<Row> {
  const { rows } = await sql<{ row: Row }>`SELECT to_jsonb(m) AS row
    FROM app.agent_messages AS m WHERE m.id = ${id}`.execute(db);
  expect(rows, `agent_messages ${id}`).toHaveLength(1);
  return { ...rows[0]!.row };
}

/** The row without the columns a handle writes. */
export function untouched(row: Row): Row {
  const out = { ...row };
  for (const column of HANDLE_COLUMNS) delete out[column];
  return out;
}

/** Every agent_* row of every app as JSON text, without the rows that mention one of `ids`. */
export function without(
  tables: Record<string, string[]>,
  ids: readonly string[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [table, rows] of Object.entries(tables))
    out[table] = rows.filter((row) => !ids.some((id) => row.includes(id)));
  return out;
}

export interface AuditRow {
  readonly admin_id: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly system_actor: string | null;
  readonly before: string | null;
  readonly after: string | null;
  /** The whole row as JSON text. */
  readonly row: string;
}

/** The app.audit_logs rows of `appId`, oldest first. */
export async function auditRows(db: Kysely<DB>, appId: string): Promise<AuditRow[]> {
  const { rows } = await sql<AuditRow>`SELECT admin_id::text AS admin_id, action, target,
      system_actor, before::text AS before, after::text AS after, to_jsonb(a)::text AS row
    FROM app.audit_logs AS a WHERE a.app_id = ${appId} ORDER BY a.id`.execute(db);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly statusCode: number;
  readonly body: string;
  readonly method: 'get' | 'post';
  /** The contract path template of the request. */
  readonly template: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
  /** admin_users.display_name. */
  readonly name: string | null;
}

export interface CallerOptions {
  readonly superAdmin?: boolean;
  readonly displayName?: string;
}

export interface ReportAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(permissions: readonly string[], options?: CallerOptions): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session. */
  stepUp(caller: AdminCaller, tier: 'totp' | 'sms'): Promise<string>;
  /** GET the report list with the query, as `viewer` unless given (null: no token). */
  list(
    query?: Record<string, string>,
    caller?: AdminCaller | null,
    headers?: Record<string, string>,
  ): Promise<AdminSent>;
  /** POST the handle of one report with this JSON body, as `handler` unless given (null: no token). */
  handle(
    messageId: string,
    body: unknown,
    caller?: AdminCaller | null,
    headers?: Record<string, string>,
  ): Promise<AdminSent>;
  /** An account with agent.trace only. */
  readonly viewer: AdminCaller;
  /** An account with agent.report only, with a display name. */
  readonly handler: AdminCaller;
}

interface InjectInput {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  remoteAddress: string;
  payload?: string;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: InjectInput): Promise<{ statusCode: number; body: string }>;
}

/** The handle request body. */
export function handleBody(note: string, expectedRowVersion: number): Row {
  return { note, expected_row_version: expectedRowVersion };
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withReportAdmin(
  f: Fixture,
  run: (h: ReportAdmin) => Promise<void>,
): Promise<void> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b1-10t-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b1_10t_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: ReportAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      const name = options.displayName ?? null;
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `rpt_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
          display_name: name,
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token, sessionId: claims.sessionId, name };
    };
    const stepUp: ReportAdmin['stepUp'] = async (who, tier) => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const viewer = await caller([TRACE], { displayName: marker('查看人') });
    const handler = await caller([REPORT], { displayName: marker('处理人') });
    const send = async (
      method: 'get' | 'post',
      url: string,
      template: string,
      actor: AdminCaller | null,
      extra: Record<string, string> | undefined,
      payload: string | undefined,
    ): Promise<AdminSent> => {
      const headers: Record<string, string> = {
        'x-trace-id': randomUUID(),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extra ?? {}),
      };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const response = await server.inject({
        method: method === 'get' ? 'GET' : 'POST',
        url,
        headers,
        remoteAddress: '127.0.0.1',
        ...(payload === undefined ? {} : { payload }),
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        method,
        template,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      caller,
      stepUp,
      viewer,
      handler,
      list(query, who, extra) {
        const text = new URLSearchParams(query ?? {}).toString();
        const url = text === '' ? LIST_PATH : `${LIST_PATH}?${text}`;
        return send('get', url, LIST_PATH, who === undefined ? viewer : who, extra, undefined);
      },
      handle(messageId, body, who, extra) {
        const url = `${LIST_PATH}/${encodeURIComponent(messageId)}/handle`;
        const actor = who === undefined ? handler : who;
        return send('post', url, HANDLE_PATH, actor, extra, JSON.stringify(body));
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract and the answers.

interface ContractOperation {
  readonly responses: Record<
    string,
    { readonly content?: Record<string, { readonly schema: JsonSchema }> }
  >;
}
type ContractPaths = Record<string, Record<string, ContractOperation>>;
let contractPromise: Promise<ContractPaths> | undefined;

/** The dereferenced paths of contracts/openapi.yaml. */
function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

/** HTTP status of each code (contracts/error-codes.yaml). */
const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
  20902: 409,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const operation = (await contractPaths())[sent.template]?.[sent.method];
  const schema = operation?.responses[status]?.content?.['application/json']?.schema;
  expect(schema, `${sent.method} ${sent.template} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status first, then code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, `${sent.template} ${sent.body}`).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

/** 10403 of an account without the permission point. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** 20001 with exactly these data.fields. */
export function invalid(sent: AdminSent, fields: readonly string[]): Promise<Envelope> {
  return answer(sent, 20001, { fields });
}

/** 20902 data.resource=agent_report. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, CONFLICT);
}

/** The envelope without trace_id, with the HTTP status (to compare two refusals). */
export function withoutTrace(sent: AdminSent): Row {
  const body: Row = { ...sent.json() };
  delete body['trace_id'];
  return { status: sent.statusCode, ...body };
}

function record(value: unknown): Row {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value), String(value)).toBe(
    true,
  );
  return { ...(value as Row) };
}

/** The sorted keys of an object of a response. */
export function keysOf(value: unknown): string[] {
  return Object.keys(record(value)).sort();
}

function instant(value: unknown): unknown {
  return typeof value === 'string' ? Date.parse(value) : value;
}

/** A report row with its date-time strings turned into epoch milliseconds. */
export function normalizeReport(value: unknown): Row {
  const out = record(value);
  for (const key of ['reported_at', 'deadline_at', 'handled_at']) out[key] = instant(out[key]);
  return out;
}

export interface ReportPage {
  readonly items: Row[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list (data exactly items / page / page_size / total, rows exactly REPORT_KEYS). */
export async function page(sent: AdminSent): Promise<ReportPage> {
  const body = await answer(sent, 0);
  expect(keysOf(body.data), sent.body).toEqual(['items', 'page', 'page_size', 'total']);
  const data = body.data as Row;
  expect(Array.isArray(data['items']), sent.body).toBe(true);
  const items = data['items'] as unknown[];
  for (const item of items) expect(keysOf(item), sent.body).toEqual([...REPORT_KEYS]);
  return {
    items: items.map(normalizeReport),
    page: data['page'] as number,
    page_size: data['page_size'] as number,
    total: data['total'] as number,
  };
}

/** The message ids of a successful list, in order. */
export async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['message_id']);
}

/** The report row of a successful handle (exactly REPORT_KEYS), normalized. */
export async function reportOf(sent: AdminSent): Promise<Row> {
  const body = await answer(sent, 0);
  expect(keysOf(body.data), sent.body).toEqual([...REPORT_KEYS]);
  return normalizeReport(body.data);
}

/** The response body text contains none of the values. */
export function leaksNone(sent: AdminSent, values: readonly string[]): void {
  for (const value of values) expect(sent.body.includes(value), `leaks ${value}`).toBe(false);
}
