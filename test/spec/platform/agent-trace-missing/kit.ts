// B3-08z rule-test kit — Agent trace 缺失告警（FU-AGENT-TRACE-RETRY 单 2；BR-AI-19、BR-AI-22；编排
// D10-1060、D10-1087、03:19 (a)）。本文件头是契约；名字与签名同 apps/api/src/modules/agent/store/
// trace-missing/index.ts 的文件头。
//
// 端口（agent 提供，entry.ts 注入 platform 的 createAgentTraceMissingCollector；platform 不 import agent）：
//   createPgAgentTraceMissingPort({ db }).countMissing(now: Date)
//     → Promise<readonly { app_id: string; runs: number }[]>
// 口径（「已出卡」以 agent_runs.card_delivered 为准：stream 在下发卡片时置 true、只增不减，04 §3.2）：
//   一个 run 计入，当且仅当
//   ① 已结束超过 24 小时：ended_at 非空且 ended_at < now − 24h（恰 24h 不计，多 1 毫秒计；没结束的不计）；
//   ② 已出卡：card_delivered = true（没出卡的不计）；
//   ③ 没有卡片行：app.agent_cards 里没有该 app_id + run_id 的行（同一会话别的 run 的卡片不算它的）；
//   ④ 会话没有脱离用户（BR-AI-22）：user_id IS NULL 且 user_hash 非空的会话不计——注销清理后卡片行骨架
//      还在（data '{}'）不误报，注销后 trace 写入被跳过（B3-08y）也不误报；游客会话（两者都空）与会员
//      会话照计。
//   结束原因不参与判断：end_reason / finish_reason / final_event 是 stop、cancelled（用户收卡后取消）、
//   disconnected、timeout、server_error 等任一正常可达的结束，都按 ①–④ 判定（夹具见 ENDINGS）。
//   结果按 app_id 分组，每个有计入 run 的 app_id 恰一个元素，runs 为 JS number（≥ 1）；没有计入的 app_id
//   不出现（不给 0）；顺序不限。now 只来自调用方（注入的 Clock），不读库的 now()。
//   只读：只有 SELECT（app.agent_runs、app.agent_cards、app.agent_sessions），不加行锁，能在 READ ONLY
//   事务里跑；读失败时原样拒绝（不给空结果、不编 0）。
// 接线：worker 入口把真实端口经 createAgentTraceMissingCollector 交给 registry，/metrics 在 scrape 时经
// worker 自己的库读，正常渲染该 gauge（gauge、只带 app_id 标签）；端口读失败时整次 render 拒绝（冻结语义，
// B3-08za）；api / stream / admin / payout 没有该指标、不做该读。告警规则（表达式 / for / severity /
// summary）由 B3-08za 钉住，本目录不重复。
//
// 夹具：数据库时钟比注入时钟 NOW 早好几年；库内时间全按 NOW 平移写死。测试库来自 int 测试（@couli/db/testing
// 只在 *.int.test.ts 里用）；Prometheus 文本读取与只读连接串取自 B1-01zzh 的 kit（只读引用，不改）。
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { insertUser } from '../fund-metrics/kit.ts';
import { samples } from '../metrics/kit.ts';

// ---- the metric --------------------------------------------------------------------------------

export const METRIC = 'couli_agent_trace_missing_runs';
export const LABEL = 'app_id';

/** Whether the text mentions the metric at all (a sample, HELP or TYPE line). */
export function mentionsMetric(text: string): boolean {
  return new RegExp(`(^|[\\s{])${METRIC}([\\s{]|$)`, 'm').test(text);
}

/** The gauge as { app_id: value }; every series carries exactly the label app_id, once each. */
export function missingGauge(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === METRIC)) {
    expect(Object.keys(sample.labels), `${METRIC} labels`).toEqual([LABEL]);
    const appId = sample.labels[LABEL]!;
    expect(Object.hasOwn(out, appId), `${METRIC}{${LABEL}="${appId}"} twice`).toBe(false);
    out[appId] = sample.value;
  }
  return out;
}

// ---- the port's result -------------------------------------------------------------------------

export interface PortRow {
  readonly app_id: string;
  readonly runs: number;
}

/**
 * The port's result as { app_id: runs }: every element has app_id (a string) and runs (a JS number
 * ≥ 1), and each app_id appears once.
 */
export function byApp(rows: readonly PortRow[]): Record<string, number> {
  expect(Array.isArray(rows), 'the port resolves an array').toBe(true);
  const out: Record<string, number> = {};
  for (const row of rows) {
    expect(typeof row.app_id, 'app_id is a string').toBe('string');
    expect(typeof row.runs, `runs of ${row.app_id} is a JS number`).toBe('number');
    expect(
      row.runs,
      `runs of ${row.app_id} (an app without counted runs is absent)`,
    ).toBeGreaterThanOrEqual(1);
    expect(Object.hasOwn(out, row.app_id), `${row.app_id} appears twice`).toBe(false);
    out[row.app_id] = row.runs;
  }
  return out;
}

// ---- time --------------------------------------------------------------------------------------

/** The injected clock's instant. The database's own now() is years earlier on purpose. */
export const NOW = '2031-04-05T06:07:08.000Z';
export const NOW_MS = Date.parse(NOW);

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** An ISO instant shifted by milliseconds. */
export function shift(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** NOW − 24 h: a run that ended exactly here is not counted yet. */
export const EDGE = shift(NOW, -DAY_MS);

/** Ended 25 hours before NOW: past the edge. */
export const OLD_END = shift(NOW, -25 * HOUR_MS);

/** Ended 23 hours before NOW: within the 24 hours. */
export const RECENT_END = shift(NOW, -23 * HOUR_MS);

/** A clock standing at one instant. */
export function clockAt(instant: string): { now(): Date } {
  return { now: () => new Date(instant) };
}

// ---- database fixtures -------------------------------------------------------------------------

function hex64(): string {
  return randomBytes(32).toString('hex');
}

export async function insertDevice(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.devices
      (id, app_id, user_id, install_secret_cipher, device_hash, id_source, platform, app_version,
       last_seen_at)
    VALUES (${id}, ${appId}, NULL, ${Buffer.from('synthetic-install-secret')}, ${hex64()}, 'idfv',
      'ios', 'synthetic@1', ${shift(NOW, -30 * DAY_MS)}::timestamptz)
  `.execute(db);
  return id;
}

/**
 * guest: user_id and user_hash both NULL; member: user_id set (a users row is created when no
 * userId is given); erased: user_id NULL with user_hash set, as the deletion purge leaves it.
 */
export type SessionKind = 'guest' | 'member' | 'erased';

export interface Session {
  readonly appId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly userId: string | null;
}

export async function insertSession(
  db: Kysely<DB>,
  appId: string,
  kind: SessionKind,
  userId?: string,
): Promise<Session> {
  const deviceId = await insertDevice(db, appId);
  const owner = kind === 'member' ? (userId ?? (await insertUser(db, appId))) : null;
  const sessionId = randomUUID();
  const started = shift(NOW, -10 * DAY_MS);
  await sql`
    INSERT INTO app.agent_sessions
      (id, app_id, user_id, device_id, started_at, last_active_at, user_hash, created_at,
       updated_at)
    VALUES (${sessionId}, ${appId}, ${owner}::uuid, ${deviceId}, ${started}::timestamptz,
      ${started}::timestamptz, ${kind === 'erased' ? hex64() : null}::text, ${started}::timestamptz,
      ${started}::timestamptz)
  `.execute(db);
  return { appId, sessionId, deviceId, userId: owner };
}

/**
 * How an ended run ended, as the stream writes it (stream/pg/ending.ts defaultDraft and
 * decideEnding, stream/pg/finalize.ts): end_reason, finish_reason, final_event, and whether a
 * cancellation was requested first.
 */
export interface Ending {
  readonly endReason: string;
  readonly finishReason: string;
  readonly finalEvent: string;
  readonly cancelRequested: boolean;
}

/** Endings a run can normally reach after a card went out; `stop` is the default. */
export const ENDINGS = {
  stop: {
    endReason: 'stop',
    finishReason: 'stop',
    finalEvent: '{"type":"done","data":{}}',
    cancelRequested: false,
  },
  cancelled: {
    endReason: 'cancelled',
    finishReason: 'cancelled',
    finalEvent: '{"type":"done","data":{"finish_reason":"cancelled"}}',
    cancelRequested: true,
  },
  disconnected: {
    endReason: 'disconnected',
    finishReason: 'cancelled',
    finalEvent: '{"type":"done","data":{"finish_reason":"cancelled"}}',
    cancelRequested: false,
  },
  timeout: {
    endReason: 'timeout',
    finishReason: 'timeout',
    finalEvent: '{"type":"done","data":{"finish_reason":"timeout"}}',
    cancelRequested: false,
  },
  server_error: {
    endReason: 'server_error',
    finishReason: 'error',
    finalEvent:
      '{"type":"error","data":{"code":50001,"msg":"synthetic","retryable":true,"fallback":null}}',
    cancelRequested: false,
  },
} as const satisfies Record<string, Ending>;

export interface RunOptions {
  /** ended_at; null for a run that never ended (no final frame, not settled). */
  readonly endedAt: string | null;
  /** agent_runs.card_delivered. */
  readonly cardDelivered: boolean;
  /** accepted_at; 30 seconds before endedAt by default (10 days before NOW for an unended run). */
  readonly acceptedAt?: string;
  /** How an ended run ended; ENDINGS.stop by default, ignored for a run that never ended. */
  readonly ending?: Ending;
}

/** One run of the session; its quota subject is the session's member or device. */
export async function insertRun(
  db: Kysely<DB>,
  session: Session,
  options: RunOptions,
): Promise<string> {
  const runId = randomUUID();
  const ended = options.endedAt;
  const accepted =
    options.acceptedAt ??
    (ended === null ? shift(NOW, -10 * DAY_MS) : shift(ended, -30 * SECOND_MS));
  const subject =
    session.userId === null
      ? JSON.stringify(['device', session.deviceId])
      : JSON.stringify(['member', session.userId]);
  const ending: Ending | null = ended === null ? null : (options.ending ?? ENDINGS.stop);
  // A requested cancellation lies between acceptance and the end (agent_runs_cancel_order_check).
  const cancelAt =
    ended !== null && ending?.cancelRequested === true ? shift(ended, -SECOND_MS) : null;
  await sql`
    INSERT INTO app.agent_runs
      (id, app_id, session_id, user_text, intent, prompt_version, accepted_at, deadline_at,
       quota_subjects, finish_reason, final_event, ended_at, end_reason, card_delivered,
       settle_result, settled_at, cancel_requested_at, created_at, updated_at)
    VALUES (${runId}, ${session.appId}, ${session.sessionId},
      ${session.userId === null ? null : 'synthetic private question'}::text, 'search', 'synthetic@1',
      ${accepted}::timestamptz, ${accepted}::timestamptz, ${[subject]}::text[],
      ${ending?.finishReason ?? null}::text, ${ending?.finalEvent ?? null}::jsonb,
      ${ended}::timestamptz, ${ending?.endReason ?? null}::text, ${options.cardDelivered}::boolean,
      ${ended === null ? null : 'counted'}::text, ${ended}::timestamptz,
      ${cancelAt}::timestamptz, ${accepted}::timestamptz, ${accepted}::timestamptz)
  `.execute(db);
  return runId;
}

/**
 * One card row of the run (card_id unique within the session). `purged` writes it as the deletion
 * purge leaves it: data '{}' and the placeholder fallback text.
 */
export async function insertCard(
  db: Kysely<DB>,
  session: Session,
  runId: string,
  cardId: string,
  purged = false,
): Promise<void> {
  await sql`
    INSERT INTO app.agent_cards
      (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version, fallback_text,
       created_at)
    VALUES (${randomUUID()}, ${session.appId}, ${session.sessionId}, ${runId}, ${cardId}, 'notice',
      ${purged ? '{}' : '{"level":"info","text":"synthetic card"}'}::jsonb, NULL, 1,
      ${purged ? '内容已删除' : 'synthetic fallback'}, ${NOW}::timestamptz)
  `.execute(db);
}

/**
 * A run in a fresh session of `kind` with `cards` card rows (c1 … cN).
 */
export async function seedRun(
  db: Kysely<DB>,
  appId: string,
  options: RunOptions & { readonly kind?: SessionKind; readonly cards?: number },
): Promise<{ session: Session; runId: string }> {
  const session = await insertSession(db, appId, options.kind ?? 'guest');
  const runId = await insertRun(db, session, options);
  for (let n = 1; n <= (options.cards ?? 0); n += 1) {
    await insertCard(db, session, runId, `c${String(n)}`, options.kind === 'erased');
  }
  return { session, runId };
}

/** Every row of the three tables the port reads. */
export async function tableSnapshot(db: Kysely<DB>): Promise<unknown[]> {
  const runs = await sql`SELECT to_jsonb(r) AS row FROM app.agent_runs r ORDER BY id`.execute(db);
  const cards = await sql`SELECT to_jsonb(c) AS row FROM app.agent_cards c ORDER BY id`.execute(db);
  const sessions =
    await sql`SELECT to_jsonb(s) AS row FROM app.agent_sessions s ORDER BY id`.execute(db);
  return [...runs.rows, ...cards.rows, ...sessions.rows];
}

/** Card rows of one run, as (data, fallback_text). */
export async function cardsOf(
  db: Kysely<DB>,
  runId: string,
): Promise<{ data: unknown; fallback_text: string }[]> {
  const result = await sql<{ data: unknown; fallback_text: string }>`
    SELECT data, fallback_text FROM app.agent_cards WHERE run_id = ${runId} ORDER BY card_id
  `.execute(db);
  return result.rows;
}

// ---- compile-only checks -----------------------------------------------------------------------

/** The three tables the port may read. */
export const PORT_TABLES = ['agent_runs', 'agent_cards', 'agent_sessions'] as const;

/** Tables a query names with the app schema (quoted or not). */
export function appTables(query: string): string[] {
  return [...query.matchAll(/(?<![\w"])"?app"?\s*\.\s*"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]!);
}

/** Row locks: a read-only port takes none. */
export const ROW_LOCK = /\bfor\s+(?:no\s+key\s+)?(?:update|share|key\s+share)\b/i;
