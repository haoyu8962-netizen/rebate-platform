// B1-10q rule-test kit (claude-independent, SPEC_REF a36eb936): contracts/openapi.yaml
// adminListAgentSessions (GET /admin/v1/agent-traces/sessions) and adminGetAgentSession
// (GET /admin/v1/agent-traces/sessions/{session_id}), CT-24zzi, 编排 D10-1310 (D1 第一段).
// 08 BR-AI-19 (后台查看 trace 需要 agent-traces 权限，查看操作记审计), BR-AI-20 (owner: user_id or
// device_id; expired when last_active_at + 24 h ≤ now), BR-AI-22 (deleted user: free text cleared,
// rows kept, user_id → user_hash).
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation), PostgreSQL through @couli/db/testing as couli_app, Redis for the admin
// sessions and step-up tokens (../../payment/orders/kit.ts suite). Synthetic: the agent_* rows
// (written directly with INSERT, columns as in db/schema.sql and only those on main), the users,
// devices and admin accounts. No real user data. Missing pieces fail as assertions (an unregistered
// admin route does not answer 200 / 10403 / 20001).
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
import type { Suite } from '../../payment/orders/kit.ts';

export { suite } from '../../payment/orders/kit.ts';

/** 2026-11-12 12:00 +08:00. */
export const NOW = '2026-11-12T04:00:00.000Z';
export const LIST_PATH = '/admin/v1/agent-traces/sessions';
export const DETAIL_PATH = '/admin/v1/agent-traces/sessions/{session_id}';
/** specs/permissions.yaml (CT-24zzi): the read point of the trace console, no step-up. */
export const TRACE = 'agent.trace';
/** The report-handling point: it does not open traces. */
export const REPORT = 'agent.report';
/** Every pii.* point of specs/permissions.yaml. */
export const PII = ['pii.reveal_phone', 'pii.reveal_identity'] as const;
export const AUDIT_ACTION = 'agent_trace_view';

/** AdminAgentSessionListItem (additionalProperties false), sorted. */
export const ITEM_KEYS = [
  'badcase_count',
  'expired',
  'last_active_at',
  'report_count',
  'run_count',
  'session_id',
  'started_at',
  'user_id',
] as const;
/** AdminAgentSessionDetail, sorted. */
export const DETAIL_KEYS = [
  'cards',
  'expired',
  'last_active_at',
  'messages',
  'runs',
  'session_id',
  'started_at',
  'tool_calls',
  'user_id',
] as const;
/** AdminAgentTraceMessage, sorted. */
export const MESSAGE_KEYS = [
  'badcase',
  'card_ids',
  'feedback',
  'message_id',
  'report_note',
  'report_reason',
  'report_status',
  'reported_at',
  'role',
  'text',
] as const;
/** AdminAgentTraceRun, sorted. */
export const RUN_KEYS = [
  'accepted_at',
  'cost_mfen',
  'ended_at',
  'filter_hits',
  'finish_reason',
  'input_tokens',
  'intent',
  'latency_ms',
  'model',
  'model_snapshot',
  'output_tokens',
  'prompt_version',
  'run_id',
  'ttft_ms',
] as const;
/** AdminAgentTraceToolCall, sorted. */
export const TOOL_CALL_KEYS = ['args', 'latency_ms', 'name', 'run_id', 'seq', 'status'] as const;
/** AgentHistoryCard, sorted. */
export const CARD_KEYS = ['card_id', 'data', 'fallback_text', 'schema_version', 'type'] as const;

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Fixtures on the suite's database.

export interface Fixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
}

/** A fresh app id (28 characters). */
export function newAppId(): string {
  return `atr_${randomBytes(12).toString('hex')}`;
}

export function fixture(s: Suite, instant = NOW): Fixture {
  return { s, db: s.db(), clock: new FixedClock(instant), appId: newAppId() };
}

/** Another app on the same database and clock. */
export function otherApp(f: Fixture): Fixture {
  return { ...f, appId: newAppId() };
}

/** An instant `minutes` before the fixture's clock. */
export function ago(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * 60_000);
}

/** `at` plus `ms` milliseconds. */
export function plus(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** The instant as ISO 8601 with +08:00 (whole seconds). */
export function plus8(at: Date): string {
  const shifted = new Date(at.getTime() + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/** A synthetic marker, unique per call, so a leak of a seeded text is visible. */
export function marker(label: string): string {
  return `${label}-${randomBytes(5).toString('hex')}`;
}

type Row = Record<string, unknown>;

async function insert(db: Kysely<DB>, table: string, row: Row): Promise<void> {
  const names = Object.keys(row);
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

export interface Member {
  readonly id: string;
  readonly appId: string;
  /** Synthetic personal data of the account that must never show. */
  readonly phone: string;
  readonly phoneHmac: string;
}

/** A synthetic users row (status normal) with a phone digest, in `appId`. */
export async function seedMember(f: Fixture, appId = f.appId): Promise<Member> {
  const id = randomUUID();
  const phone = `1980000${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0')}`;
  const phoneHmac = hex64();
  const at = ago(f, 60 * 24 * 30);
  await insert(f.db, 'users', {
    id,
    app_id: appId,
    phone_cipher: Buffer.from(`synthetic-cipher:${phone}`),
    phone_hmac: phoneHmac,
    nickname: marker('atr-nick'),
    avatar: 'synthetic',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'sms',
    status: 'normal',
    created_at: at,
    updated_at: at,
  });
  return { id, appId, phone, phoneHmac };
}

/** A synthetic devices row in `appId`. */
export async function seedDevice(f: Fixture, appId = f.appId): Promise<string> {
  const id = randomUUID();
  await insert(f.db, 'devices', {
    id,
    app_id: appId,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    device_hash: hex64(),
    id_source: 'idfv',
    platform: 'ios',
    app_version: 'synthetic@1',
    last_seen_at: ago(f, 60 * 24),
  });
  return id;
}

/** An admin_users row of `appId` that handled reports (agent_messages.report_handler_id). */
export async function seedHandler(f: Fixture, appId = f.appId): Promise<string> {
  const id = randomUUID();
  await f.db
    .insertInto('admin_users')
    .values({
      id,
      app_id: appId,
      login_name: `atr_handler_${id}`,
      password_hash: 'unused-test-login',
      is_super: false,
      status: 'active',
      password_must_change: false,
      totp_bound_at: f.clock.now(),
      verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .execute();
  return id;
}

export interface SessionSeed {
  readonly appId?: string;
  /** The signed-in owner; null / absent: a guest session. */
  readonly userId?: string | null;
  readonly startedAt?: Date;
  readonly lastActiveAt?: Date;
  readonly expiredAt?: Date | null;
  /** BR-AI-22: set (and user_id null) once the owner's account deletion completed. */
  readonly userHash?: string | null;
}

/** A seeded agent_sessions row, as written. */
export interface Session {
  readonly id: string;
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly expiredAt: Date | null;
  readonly userHash: string | null;
}

export async function seedSession(f: Fixture, seed: SessionSeed = {}): Promise<Session> {
  const appId = seed.appId ?? f.appId;
  const startedAt = seed.startedAt ?? ago(f, 60);
  const session: Session = {
    id: randomUUID(),
    appId,
    userId: seed.userId ?? null,
    deviceId: await seedDevice(f, appId),
    startedAt,
    lastActiveAt: seed.lastActiveAt ?? startedAt,
    expiredAt: seed.expiredAt ?? null,
    userHash: seed.userHash ?? null,
  };
  await insert(f.db, 'agent_sessions', {
    id: session.id,
    app_id: appId,
    user_id: session.userId,
    device_id: session.deviceId,
    started_at: session.startedAt,
    last_active_at: session.lastActiveAt,
    expired_at: session.expiredAt,
    user_hash: session.userHash,
    card_seq: 3,
    created_at: session.startedAt,
    updated_at: session.lastActiveAt,
  });
  return session;
}

/** One agent_runs row as written (the columns the trace shows, plus user_text). */
export interface RunRow {
  readonly id: string;
  readonly acceptedAt: Date;
  readonly intent: string | null;
  readonly model: string | null;
  readonly modelSnapshot: string | null;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMfen: number | null;
  readonly ttftMs: number | null;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly filterHits: readonly string[];
  /** null while the run is going. */
  readonly endedAt: Date | null;
  readonly userText: string | null;
}

export async function insertRun(f: Fixture, session: Session, run: RunRow): Promise<void> {
  const ended = run.endedAt !== null;
  await insert(f.db, 'agent_runs', {
    id: run.id,
    app_id: session.appId,
    session_id: session.id,
    user_text: run.userText,
    intent: run.intent,
    model: run.model,
    model_snapshot: run.modelSnapshot,
    prompt_version: run.promptVersion,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    cost_mfen: run.costMfen,
    ttft_ms: run.ttftMs,
    latency_ms: run.latencyMs,
    finish_reason: run.finishReason,
    final_event: ended
      ? JSON.stringify({ type: 'done', data: { finish_reason: run.finishReason, quota_left: 3 } })
      : null,
    ended_at: run.endedAt,
    output_filtered: run.filterHits.length > 0,
    filter_hits: [...run.filterHits],
    accepted_at: run.acceptedAt,
    quota_subjects: [JSON.stringify(['device', 'synthetic-device-hash'])],
    end_reason: ended ? run.finishReason : null,
    settle_result: ended ? 'counted' : null,
    settled_at: run.endedAt,
    created_at: run.acceptedAt,
    updated_at: run.endedAt ?? run.acceptedAt,
  });
}

/** A finished run with a model (finish_reason stop). */
export function doneRun(acceptedAt: Date, overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: randomUUID(),
    acceptedAt,
    intent: 'search',
    model: 'qwen-plus',
    modelSnapshot: 'qwen-plus-2026-09-01',
    promptVersion: 'p-2026-11-01',
    inputTokens: 900,
    outputTokens: 120,
    costMfen: 3100,
    ttftMs: 600,
    latencyMs: 2000,
    finishReason: 'stop',
    filterHits: [],
    endedAt: plus(acceptedAt, 2000),
    userText: marker('atr-user-text'),
    ...overrides,
  };
}

/** One agent_messages row as written. */
export interface MessageRow {
  readonly id: string;
  readonly runId: string;
  readonly role: 'user' | 'assistant';
  readonly createdAt: Date;
  readonly text: string | null;
  readonly cardIds: readonly string[];
  readonly feedback: 'up' | 'down' | null;
  readonly badcase: boolean;
  readonly reportedAt: Date | null;
  readonly reportReason: string | null;
  readonly reportStatus: 'pending' | 'handled' | null;
  readonly reportNote: string | null;
  readonly handlerId: string | null;
  readonly handledAt: Date | null;
}

export async function insertMessage(
  f: Fixture,
  session: Session,
  message: MessageRow,
): Promise<void> {
  await insert(f.db, 'agent_messages', {
    id: message.id,
    app_id: session.appId,
    session_id: session.id,
    run_id: message.runId,
    client_msg_id: message.role === 'user' ? `cm-${message.id}` : null,
    role: message.role,
    text: message.text,
    card_ids: [...message.cardIds],
    feedback: message.feedback,
    feedback_at: message.feedback === null ? null : plus(message.createdAt, 30_000),
    reported: message.reportStatus !== null,
    report_reason: message.reportReason,
    reported_at: message.reportedAt,
    report_status: message.reportStatus,
    report_handler_id: message.handlerId,
    report_handled_at: message.handledAt,
    report_note: message.reportNote,
    badcase: message.badcase,
    created_at: message.createdAt,
    updated_at: message.handledAt ?? message.reportedAt ?? message.createdAt,
  });
}

export function userMessage(runId: string, createdAt: Date, text: string | null): MessageRow {
  return {
    id: randomUUID(),
    runId,
    role: 'user',
    createdAt,
    text,
    cardIds: [],
    feedback: null,
    badcase: false,
    reportedAt: null,
    reportReason: null,
    reportStatus: null,
    reportNote: null,
    handlerId: null,
    handledAt: null,
  };
}

export function reply(
  runId: string,
  createdAt: Date,
  text: string | null,
  overrides: Partial<MessageRow> = {},
): MessageRow {
  return { ...userMessage(runId, createdAt, text), role: 'assistant', ...overrides };
}

/** One agent_tool_calls row as written. */
export interface ToolCallRow {
  readonly runId: string;
  readonly seq: number;
  readonly name: string;
  readonly args: Record<string, unknown> | null;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly createdAt: Date;
}

export async function insertToolCall(
  f: Fixture,
  session: Session,
  call: ToolCallRow,
): Promise<void> {
  await insert(f.db, 'agent_tool_calls', {
    id: randomUUID(),
    app_id: session.appId,
    run_id: call.runId,
    seq: call.seq,
    name: call.name,
    args: call.args === null ? null : JSON.stringify(call.args),
    result_digest: 'synthetic-result-digest',
    status: call.status,
    latency_ms: call.latencyMs,
    created_at: call.createdAt,
  });
}

/** One agent_cards row as written. */
export interface CardRow {
  readonly runId: string;
  readonly cardId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: Record<string, unknown>;
  readonly fallbackText: string;
  readonly createdAt: Date;
}

export async function insertCard(f: Fixture, session: Session, card: CardRow): Promise<void> {
  await insert(f.db, 'agent_cards', {
    id: randomUUID(),
    app_id: session.appId,
    session_id: session.id,
    run_id: card.runId,
    card_id: card.cardId,
    type: card.type,
    data: JSON.stringify(card.data),
    link_id: null,
    schema_version: card.schemaVersion,
    fallback_text: card.fallbackText,
    created_at: card.createdAt,
  });
}

export interface TurnReply {
  readonly feedback?: 'up' | 'down' | null;
  readonly badcase?: boolean;
  readonly report?: 'pending' | 'handled' | null;
}

/** One finished run with its user message and (unless null) an assistant reply with these marks. */
export interface Turn {
  readonly runId: string;
  /** The message texts and the run's user_text written. */
  readonly texts: readonly string[];
}

export async function seedTurn(
  f: Fixture,
  session: Session,
  at: Date,
  outcome: TurnReply | null,
): Promise<Turn> {
  const run = doneRun(at);
  await insertRun(f, session, run);
  const question = marker('atr-question');
  await insertMessage(f, session, userMessage(run.id, at, question));
  const texts = [question, run.userText ?? ''].filter(Boolean);
  if (outcome === null) return { runId: run.id, texts };
  const text = marker('atr-answer');
  const feedback = outcome.feedback ?? null;
  const report = outcome.report ?? null;
  const reason = report === null ? null : marker('atr-reason');
  const note = report === 'handled' ? marker('atr-note') : null;
  const repliedAt = plus(at, 2000);
  await insertMessage(
    f,
    session,
    reply(run.id, repliedAt, text, {
      feedback,
      badcase: outcome.badcase ?? feedback === 'down',
      reportStatus: report,
      reportedAt: report === null ? null : plus(repliedAt, 60_000),
      reportReason: reason,
      reportNote: note,
      handlerId: report === 'handled' ? await seedHandler(f, session.appId) : null,
      handledAt: report === 'handled' ? plus(repliedAt, 120_000) : null,
    }),
  );
  return { runId: run.id, texts: [...texts, text, reason ?? '', note ?? ''].filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// A whole conversation with its expected detail.

export interface Conversation {
  readonly session: Session;
  /** The expected adminGetAgentSession data (instants as epoch milliseconds). */
  readonly detail: Record<string, unknown>;
  /** Values that must never appear in any response: device id, app id, user_text, user_hash, phone. */
  readonly hidden: readonly string[];
  /** The free texts written (message texts, tool arguments, card texts, report texts). */
  readonly texts: readonly string[];
  readonly runIds: readonly string[];
  readonly messageIds: readonly string[];
}

export interface ConversationOptions {
  readonly appId?: string;
  /** The signed-in owner (absent: a guest session). */
  readonly member?: Member;
  /** BR-AI-22: the owner's deletion completed — texts cleared, user_id → user_hash, rows kept. */
  readonly erased?: boolean;
  readonly startedAt?: Date;
}

/**
 * One session (last active 20 minutes after it started) with three runs accepted in this order:
 * r1 a model run with an earnings card and a notice card, its reply voted down (badcase) and
 * reported (pending); r2 a run without any model (fallback) with a product card, its reply voted
 * up and reported (handled); r3 still going, no reply yet. Four tool calls, inserted out of order.
 */
export async function seedConversation(
  f: Fixture,
  options: ConversationOptions = {},
): Promise<Conversation> {
  const appId = options.appId ?? f.appId;
  const erased = options.erased === true;
  const T = options.startedAt ?? ago(f, 120);
  const handlerId = await seedHandler(f, appId);
  const userHash = erased ? hex64() : null;
  const session = await seedSession(f, {
    appId,
    userId: erased ? null : (options.member?.id ?? null),
    startedAt: T,
    lastActiveAt: plus(T, 20 * 60_000),
    userHash,
  });
  const tag = randomBytes(4).toString('hex');
  const free = (text: string): string | null => (erased ? null : `${text}（${tag}）`);
  // Run ids ascend in the order the runs were accepted.
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  const [id1, id2, id3] = [ids[0]!, ids[1]!, ids[2]!];
  const r1: RunRow = {
    id: id1,
    acceptedAt: plus(T, 60_000),
    intent: 'earnings_query',
    model: 'qwen-plus',
    modelSnapshot: 'qwen-plus-2026-09-01',
    promptVersion: 'p-2026-11-01',
    inputTokens: 1200,
    outputTokens: 300,
    costMfen: 4500,
    ttftMs: 800,
    latencyMs: 3200,
    finishReason: 'stop',
    filterHits: ['amount', 'url'],
    endedAt: plus(T, 60_000 + 3200),
    userText: erased ? null : `原话一 13812345678 ${tag}`,
  };
  const r2: RunRow = {
    id: id2,
    acceptedAt: plus(T, 10 * 60_000),
    intent: 'search',
    model: null,
    modelSnapshot: null,
    promptVersion: 'p-2026-11-01',
    inputTokens: null,
    outputTokens: null,
    costMfen: null,
    ttftMs: null,
    latencyMs: 150,
    finishReason: 'fallback',
    filterHits: [],
    endedAt: plus(T, 10 * 60_000 + 150),
    userText: erased ? null : `原话二 ${tag}`,
  };
  const r3: RunRow = {
    id: id3,
    acceptedAt: plus(T, 20 * 60_000),
    intent: null,
    model: 'qwen-max',
    modelSnapshot: 'qwen-max-2026-10-01',
    promptVersion: 'p-2026-11-02',
    inputTokens: null,
    outputTokens: null,
    costMfen: null,
    ttftMs: null,
    latencyMs: null,
    finishReason: null,
    filterHits: [],
    endedAt: null,
    userText: erased ? null : `原话三 ${tag}`,
  };
  for (const run of [r3, r1, r2]) await insertRun(f, session, run);

  const u1 = userMessage(r1.id, r1.acceptedAt, free('我现在有多少收益'));
  const a1 = reply(r1.id, plus(r1.acceptedAt, 3200), free('这是你当时的收益概况，以钱包页为准。'), {
    cardIds: ['c1', 'c2'],
    feedback: 'down',
    badcase: true,
    reportedAt: plus(T, 5 * 60_000),
    reportReason: free('回答内容与事实不符'),
    reportStatus: 'pending',
  });
  const u2 = userMessage(r2.id, r2.acceptedAt, free('帮我找 138****5678 推荐的手机壳'));
  const a2 = reply(r2.id, plus(r2.acceptedAt, 150), free('先看看这些商品。'), {
    cardIds: ['c3'],
    feedback: 'up',
    reportedAt: plus(T, 11 * 60_000),
    reportReason: free('推荐的商品不对'),
    reportStatus: 'handled',
    reportNote: `已核对，推荐口径已修正（${tag}）`,
    handlerId,
    handledAt: plus(T, 12 * 60_000),
  });
  const u3 = userMessage(r3.id, r3.acceptedAt, free('订单 2310****7890 什么时候到账'));
  const messages = [u1, a1, u2, a2, u3];
  for (const message of [a2, u3, u1, a1, u2]) await insertMessage(f, session, message);

  const toolAt = plus(T, 21 * 60_000);
  const calls: ToolCallRow[] = [
    {
      runId: r1.id,
      seq: 1,
      name: 'get_my_earnings',
      args: erased ? null : {},
      status: 'ok',
      latencyMs: 120,
      createdAt: toolAt,
    },
    {
      runId: r2.id,
      seq: 1,
      name: 'search_products',
      args: erased ? null : { q: `手机壳 ${tag}`, contact: '138****5678', platforms: ['jd'] },
      status: 'ok',
      latencyMs: 300,
      createdAt: toolAt,
    },
    {
      runId: r2.id,
      seq: 2,
      name: 'get_rebate_quote',
      args: null,
      status: 'rejected',
      latencyMs: null,
      createdAt: toolAt,
    },
    {
      runId: r3.id,
      seq: 1,
      name: 'search_rules',
      args: erased ? null : { q: `到账时间 ${tag}` },
      status: 'ok',
      latencyMs: 80,
      createdAt: toolAt,
    },
  ];
  for (const index of [3, 2, 0, 1]) await insertToolCall(f, session, calls[index]!);

  const deleted = '内容已删除';
  const cards: CardRow[] = [
    {
      runId: r1.id,
      cardId: 'c1',
      type: 'earnings_summary',
      schemaVersion: 1,
      data: erased
        ? {}
        : {
            as_of: '2026-11-12T09:55:02+08:00',
            actions: [{ route: 'Wallet', text_key: 'agent.earnings.open_wallet' }],
          },
      fallbackText: erased ? deleted : `收益以钱包页显示为准（${tag}）`,
      createdAt: plus(r1.acceptedAt, 2000),
    },
    {
      runId: r1.id,
      cardId: 'c2',
      type: 'notice',
      schemaVersion: 1,
      data: erased ? {} : { level: 'info', text: `收益数据有延迟（${tag}）` },
      fallbackText: erased ? deleted : `收益数据有延迟（${tag}）`,
      createdAt: plus(r1.acceptedAt, 2500),
    },
    {
      runId: r2.id,
      cardId: 'c3',
      type: 'product_list',
      schemaVersion: 2,
      data: erased ? {} : { items: [{ title: `手机壳 ${tag}`, final_price_fen: 1990 }] },
      fallbackText: erased ? deleted : `为你找到 1 件商品（${tag}）`,
      createdAt: plus(r2.acceptedAt, 100),
    },
  ];
  for (const index of [2, 0, 1]) await insertCard(f, session, cards[index]!);

  const texts = [
    ...messages.flatMap((m) => [m.text, m.reportReason, m.reportNote]),
    `手机壳 ${tag}`,
    `到账时间 ${tag}`,
    ...cards.map((card) => card.fallbackText),
  ].filter((text): text is string => text !== null && text !== '' && text !== deleted);
  const hidden = [
    session.deviceId,
    appId,
    ...[r1, r2, r3].flatMap((run) => (run.userText === null ? [] : [run.userText])),
    ...(userHash === null ? [] : [userHash]),
    ...(options.member === undefined ? [] : [options.member.phone, options.member.phoneHmac]),
  ];
  return {
    session,
    detail: {
      ...sessionHeader(session, false),
      messages: messages.map(messageView),
      runs: [r1, r2, r3].map(runView),
      tool_calls: calls.map(toolCallView),
      cards: cards.map(cardView),
    },
    hidden,
    texts,
    runIds: [r1.id, r2.id, r3.id],
    messageIds: messages.map((m) => m.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Expected shapes (instants as epoch milliseconds).

function ms(at: Date | null): number | null {
  return at === null ? null : at.getTime();
}

/** The session header of the detail (the list item without the counts). */
export function sessionHeader(session: Session, expired: boolean): Record<string, unknown> {
  return {
    session_id: session.id,
    user_id: session.userId,
    started_at: session.startedAt.getTime(),
    last_active_at: session.lastActiveAt.getTime(),
    expired,
  };
}

export interface Counts {
  readonly expired: boolean;
  readonly run_count: number;
  readonly badcase_count: number;
  readonly report_count: number;
}

/** The AdminAgentSessionListItem the session must be shown as. */
export function sessionItem(session: Session, counts: Counts): Record<string, unknown> {
  return {
    ...sessionHeader(session, counts.expired),
    run_count: counts.run_count,
    badcase_count: counts.badcase_count,
    report_count: counts.report_count,
  };
}

export function messageView(m: MessageRow): Record<string, unknown> {
  return {
    message_id: m.id,
    role: m.role,
    text: m.text,
    card_ids: [...m.cardIds],
    feedback: m.feedback,
    badcase: m.badcase,
    reported_at: ms(m.reportedAt),
    report_reason: m.reportReason,
    report_status: m.reportStatus,
    report_note: m.reportNote,
  };
}

export function runView(run: RunRow): Record<string, unknown> {
  return {
    run_id: run.id,
    intent: run.intent,
    model: run.model,
    model_snapshot: run.modelSnapshot,
    prompt_version: run.promptVersion,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    cost_mfen: run.costMfen,
    ttft_ms: run.ttftMs,
    latency_ms: run.latencyMs,
    finish_reason: run.finishReason,
    filter_hits: [...run.filterHits],
    accepted_at: run.acceptedAt.getTime(),
    ended_at: ms(run.endedAt),
  };
}

export function toolCallView(call: ToolCallRow): Record<string, unknown> {
  return {
    run_id: call.runId,
    seq: call.seq,
    name: call.name,
    args: call.args,
    status: call.status,
    latency_ms: call.latencyMs,
  };
}

export function cardView(card: CardRow): Record<string, unknown> {
  return {
    card_id: card.cardId,
    type: card.type,
    schema_version: card.schemaVersion,
    data: card.data,
    fallback_text: card.fallbackText,
  };
}

function record(value: unknown): Record<string, unknown> {
  expect(typeof value === 'object' && value !== null && !Array.isArray(value), String(value)).toBe(
    true,
  );
  return { ...(value as Record<string, unknown>) };
}

function array(value: unknown, name: string): unknown[] {
  expect(Array.isArray(value), `${name} is an array`).toBe(true);
  return value as unknown[];
}

function instant(value: unknown): unknown {
  return typeof value === 'string' ? Date.parse(value) : value;
}

/** The sorted keys of an object of a response. */
export function keysOf(value: unknown): string[] {
  return Object.keys(record(value)).sort();
}

/** A list item with its date-time strings turned into epoch milliseconds. */
export function normalizeItem(item: unknown): Record<string, unknown> {
  const out = record(item);
  for (const key of ['started_at', 'last_active_at']) if (key in out) out[key] = instant(out[key]);
  return out;
}

/** The detail data with every date-time string turned into epoch milliseconds. */
export function normalizeDetail(data: unknown): Record<string, unknown> {
  const out = normalizeItem(data);
  out['messages'] = array(out['messages'], 'messages').map((entry) => {
    const m = record(entry);
    m['reported_at'] = instant(m['reported_at']);
    return m;
  });
  out['runs'] = array(out['runs'], 'runs').map((entry) => {
    const run = record(entry);
    run['accepted_at'] = instant(run['accepted_at']);
    run['ended_at'] = instant(run['ended_at']);
    return run;
  });
  out['tool_calls'] = array(out['tool_calls'], 'tool_calls').map(record);
  out['cards'] = array(out['cards'], 'cards').map(record);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Database views.

export const AGENT_TABLES = [
  'agent_sessions',
  'agent_runs',
  'agent_messages',
  'agent_tool_calls',
  'agent_cards',
] as const;

/** Every row of the five agent tables of every app, as JSON text (reads must leave them as they were). */
export async function agentTables(db: Kysely<DB>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of AGENT_TABLES) {
    const { rows } = await sql<{ row: string }>`SELECT to_jsonb(t)::text AS row
      FROM ${sql.table(`app.${table}`)} AS t ORDER BY 1`.execute(db);
    out[table] = rows.map((entry) => entry.row);
  }
  return out;
}

/** The number of app.audit_logs rows of every app. */
export async function auditCount(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ n: string }>`SELECT count(*)::text AS n FROM app.audit_logs`.execute(
    db,
  );
  return Number(rows[0]?.n ?? '0');
}

export interface AuditRow {
  readonly admin_id: string | null;
  readonly action: string;
  readonly target: string | null;
  readonly system_actor: string | null;
  /** The whole row as JSON text. */
  readonly row: string;
}

/** The app.audit_logs rows of `appId`, oldest first. */
export async function auditRows(db: Kysely<DB>, appId: string): Promise<AuditRow[]> {
  const { rows } = await sql<AuditRow>`SELECT admin_id::text AS admin_id, action, target,
      system_actor, to_jsonb(a)::text AS row
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
  /** The contract path template of the request. */
  readonly template: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
  readonly sessionId: string;
}

export interface TraceAdmin {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session. */
  stepUp(caller: AdminCaller, tier: 'totp' | 'sms'): Promise<string>;
  /** GET the session list with the query, as `viewer` unless given (null: no token). */
  list(
    query?: Record<string, string>,
    caller?: AdminCaller | null,
    headers?: Record<string, string>,
  ): Promise<AdminSent>;
  /** GET one session, as `viewer` unless given (null: no token). */
  detail(
    sessionId: string,
    caller?: AdminCaller | null,
    headers?: Record<string, string>,
  ): Promise<AdminSent>;
  /** An account with agent.trace only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withTraceAdmin(
  f: Fixture,
  run: (h: TraceAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b1-10q-'));
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
        JWT_KEY_ID: 'b1_10q_test',
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
    const caller: TraceAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `atr_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          verify_phone_cipher: Buffer.from('synthetic-verify-phone-cipher'),
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
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: TraceAdmin['stepUp'] = async (who, tier) => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const viewer = await caller([TRACE]);
    const send = async (
      url: string,
      template: string,
      who: AdminCaller | null | undefined,
      extra: Record<string, string> | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? viewer : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID(), ...(extra ?? {}) };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const response = await server.inject({
        method: 'GET',
        url,
        headers,
        remoteAddress: '127.0.0.1',
      });
      return {
        statusCode: response.statusCode,
        body: response.body,
        template,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    await run({
      caller,
      stepUp,
      viewer,
      list(query, who, extra) {
        const text = new URLSearchParams(query ?? {}).toString();
        return send(text === '' ? LIST_PATH : `${LIST_PATH}?${text}`, LIST_PATH, who, extra);
      },
      detail(sessionId, who, extra) {
        return send(`${LIST_PATH}/${encodeURIComponent(sessionId)}`, DETAIL_PATH, who, extra);
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
// The contract.

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

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to the operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[sent.template]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${sent.template} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
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

/** The envelope without trace_id, with the HTTP status (to compare two refusals). */
export function withoutTrace(sent: AdminSent): Record<string, unknown> {
  const body: Record<string, unknown> = { ...sent.json() };
  delete body['trace_id'];
  return { status: sent.statusCode, ...body };
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response (data exactly items / page / page_size / total). */
export async function page(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(keysOf(data), sent.body).toEqual(['items', 'page', 'page_size', 'total']);
  const items = array((data as Record<string, unknown>)['items'], 'items');
  for (const item of items) expect(keysOf(item), sent.body).toEqual([...ITEM_KEYS]);
  return { ...(data as Page), items: items.map(normalizeItem) };
}

/** The session ids of a successful list response, in order. */
export async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['session_id']);
}

/** The data of a successful detail response, normalized, after checking every key set. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const body = await answer(sent, 0);
  expect(keysOf(body.data), sent.body).toEqual([...DETAIL_KEYS]);
  const data = normalizeDetail(body.data);
  const sets: [string, readonly string[]][] = [
    ['messages', MESSAGE_KEYS],
    ['runs', RUN_KEYS],
    ['tool_calls', TOOL_CALL_KEYS],
    ['cards', CARD_KEYS],
  ];
  for (const [name, keys] of sets)
    for (const entry of array(data[name], name)) expect(keysOf(entry), name).toEqual([...keys]);
  return data;
}

/** The response body text contains none of the values. */
export function leaksNone(sent: AdminSent, values: readonly string[]): void {
  for (const value of values) expect(sent.body.includes(value), `leaks ${value}`).toBe(false);
}
