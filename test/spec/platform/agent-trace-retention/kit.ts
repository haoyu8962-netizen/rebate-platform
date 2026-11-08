// B3-08s — BR-ID-30 ① Agent trace 到期清理（FU-AGENT-TRACE-PURGE；BR-AI-19、BR-AI-22；编排 D10-454、
// D10-971、D10-999）。本文件头是契约（写法照 test/spec/platform/retention/kit.ts），不新增 TS 导出，也不用骨架：
// 规则测试按名字调 SQL 函数、经 createWorkerMaintenance / createPartitionMaintenance 跑维护轮次。
//
// SQL 函数（迁移文件名不属于契约），只有一个重载：
//   app.delete_expired_agent_traces(p_now timestamptz, p_days integer, p_batch_size integer)
//     RETURNS TABLE (table_name text, deleted bigint)
// - 九张表（AGENT_TABLES，不含 agent_rule_chunks）按各自的 created_at 硬删（DELETE，不是置空）：created_at 严格
//   小于截断点才删，恰等于截断点的保留。截断点 = p_now 的 +08:00 日历日 − p_days 个日历天，再取该日 00:00
//   （+08:00）；不看会话时区。例（08 细则）：2026-10-01 创建的 run 在 2027-04-10 03:00 那轮删（截断点
//   2026-10-02 00:00），2027-04-09 那轮不删。
// - 一次调用按 AGENT_TABLES 的固定顺序（先子后父）每张表各删一批：每表最多 p_batch_size 行，从 created_at 最旧
//   的开始，覆盖所有 app_id；被别的事务锁住的行（含写入方插子行时外键加在父行上的 KEY SHARE）跳过（SKIP
//   LOCKED），不等锁、不报错，留给后面的调用。父表（agent_sessions、agent_runs、agent_result_sets）的行只在九张表
//   里已没有引用它的子行时才删：子行还没到期或被锁住，父行就留着，不报 23503、不算失败，等子行删了再删。同一次
//   调用里先删的子行对后面的父表可见，所以批量够大时一棵全部到期的树一次调用删光。
// - 返回恰好九行，顺序同 AGENT_TABLES，deleted 为本次删除行数；什么都没删时九行都是 0（不是空集）。
// - 入参：任一为 NULL → 22004；p_now 非有限、p_batch_size 不在 1..10000、p_days 不在 [184, 36500] → 22023，什么都
//   不删。184 写死在函数里（08「后台不得设为小于 184 天」），配置之后的第二道关；36500 是防溢出的技术上限。
// - SECURITY DEFINER，属主 couli_migrator，proconfig 含 search_path=pg_catalog, pg_temp 与 lock_timeout=5s；撤销
//   PUBLIC EXECUTE，只授 couli_maint（ACL 恰为两项）；不给任何业务角色（couli_app、couli_maint、couli_payout、
//   couli_readonly）新增九张表的 DELETE / TRUNCATE。正文引用九张表，不引用 agent_rule_chunks、links、devices、
//   users、config_items 与账务、订单、审计、提现类表。
// - 九张表各有一个只含 created_at 一列的普通索引（无谓词、无表达式），每批不必全表扫。
//
// 运行（maintenance 第 M 节；createPartitionMaintenance 的 dayPartitions=true 路径，含 createWorkerMaintenance；
// 未开时不清）：
// - 门：now 在 +08:00 的时刻 ≥ 03:00:00.000 才跑（固定偏移），用同一个 now（时钟每轮只读一次）。03:00–04:00 只跑
//   本节，第 K、L 节仍等 04:00；04:00 起本节照跑。同一天之后的轮次再调，幂等。
// - 配置每轮只读一次、不缓存，经 app.read_retention_settings('couli')（它另返回 agent.trace.retention_days 这一键），
//   04:00 起与第 K 节共用那一次读取：
//   - retention.purge.enabled 恰为 false：本节不跑；其他值或缺行照跑。
//   - agent.trace.retention_days：不小于 184 的整数按它（高于 36500 按 36500，不回落）；缺行、不是整数或小于 184
//     回落 190，照常清，不记失败。
//   - 读失败：本节不跑；整轮只记第 K 节那一行 retention_purge_failed { table: 'config_items', sqlstate }，
//     failed += 1（03:00–04:00 也是这一行），本节不另记。
// - 循环调函数，批量 1000，每次一条语句（不开显式事务，单连接池够用），直到九个计数全为 0 或本轮调满 100 次；积压
//   留到下一轮。
// - 日志只经 options.logger，字段正好如下（只有表名与删除行数，没有用户编号、设备、文本）：
//     agent_trace_purged        info   { table, rows }  本表本轮删了行（rows 是 number，九张表各一行，只记 > 0 的）
//     agent_trace_purge_backlog warn   { table, rows }  调满 100 次且本表最后一次仍 > 0（替代上一行）
//     agent_trace_purge_failed  error  { sqlstate }     一次调用失败：先按上两行记失败前已删的行，再记这一行；
//                                                      failed += 1，本轮不再调；其余维护（第 K、L 节、DEFAULT
//                                                      检查）照做
//   没有删除、也没有失败时不写任何行。报告形状不变，删除行不进 dropped、ensured 与 partition_maintenance_done
//   的计数。
import { randomBytes, randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { memoryLogger, reduceLine, settableClock } from '../maintenance/kit.ts';
import type { World } from '../retention/kit.ts';

export const FUNCTION_NAME = 'delete_expired_agent_traces';

export const SIGNATURE = 'app.delete_expired_agent_traces(timestamptz,integer,integer)';

export const DAYS_KEY = 'agent.trace.retention_days';

export const SWITCH_KEY = 'retention.purge.enabled';

/** 函数删除与返回的顺序：先子后父。 */
export const AGENT_TABLES = [
  'agent_tool_calls',
  'agent_cards',
  'agent_result_deliveries',
  'agent_messages',
  'agent_result_sets',
  'agent_runs',
  'agent_clarify_asks',
  'agent_result_chains',
  'agent_sessions',
] as const;

export type AgentTable = (typeof AGENT_TABLES)[number];

/** 每张表在九张表里的外键目标（照 db/schema.sql 手写）。 */
export const PARENTS: Readonly<Record<AgentTable, readonly AgentTable[]>> = {
  agent_tool_calls: ['agent_runs'],
  agent_cards: ['agent_runs'],
  agent_result_deliveries: ['agent_result_sets', 'agent_runs'],
  agent_messages: ['agent_runs', 'agent_sessions'],
  agent_result_sets: ['agent_runs'],
  agent_runs: ['agent_sessions'],
  agent_clarify_asks: ['agent_sessions'],
  agent_result_chains: ['agent_sessions'],
  agent_sessions: [],
};

/** 本表的全部祖先（父、父的父……），按 AGENT_TABLES 的顺序。 */
export function ancestors(table: AgentTable): AgentTable[] {
  const found = new Set<AgentTable>();
  const visit = (each: AgentTable): void => {
    for (const parent of PARENTS[each]) {
      if (!found.has(parent)) {
        found.add(parent);
        visit(parent);
      }
    }
  };
  visit(table);
  return AGENT_TABLES.filter((each) => found.has(each));
}

export const DAY_MS = 86_400_000;

/** ISO 时刻平移 `ms` 毫秒，格式与 agentTimes() 相同。 */
export function shift(instant: string, ms: number): string {
  return new Date(new Date(instant).getTime() + ms).toISOString();
}

/** 2027-04-10 03:00:00.000 +08:00：门内第一刻（08 细则的例子那一轮）。 */
export const NOW = '2027-04-09T19:00:00.000Z';

/** 2027-04-10 02:59:59.999 +08:00：同一日、门外最后一刻。 */
export const BEFORE_GATE = '2027-04-09T18:59:59.999Z';

/** 2027-04-10 03:30 +08:00：门内、第 K 节的 04:00 之前。 */
export const HALF_PAST_THREE = '2027-04-09T19:30:00.000Z';

/** 2027-04-10 04:00:00.000 +08:00：第 K 节的门。截断点与 NOW 相同。 */
export const AT_FOUR = '2027-04-09T20:00:00.000Z';

/** 2027-04-09 03:00 +08:00：前一天那一轮，190 天的截断点是 2026-10-01 00:00（+08:00）。 */
export const PREVIOUS_DAY = '2027-04-08T19:00:00.000Z';

/** 2027-04-11 03:00 +08:00：后一天那一轮，190 天的截断点是 2026-10-03 00:00（+08:00）。 */
export const NEXT_DAY = '2027-04-10T19:00:00.000Z';

/** NOW 的截断点：2026-10-08、2026-10-02、2026-09-22 的 00:00（+08:00）。 */
export const CUTOFF = {
  184: '2026-10-07T16:00:00.000Z',
  190: '2026-10-01T16:00:00.000Z',
  200: '2026-09-21T16:00:00.000Z',
} as const;

/** PREVIOUS_DAY、NEXT_DAY 的 190 天截断点。 */
export const PREVIOUS_CUTOFF = '2026-09-30T16:00:00.000Z';
export const NEXT_CUTOFF = '2026-10-02T16:00:00.000Z';

/** 比 login_logs 在 NOW / AT_FOUR 的 180 天截断点（2026-10-12 00:00 +08:00）早得多。 */
export const LOGIN_EXPIRED = '2026-09-01T00:00:00.000Z';

export interface PurgeRow {
  readonly table_name: string;
  readonly deleted: bigint;
}

/** 缺迁移时先在这里以断言失败，不去执行不存在的 SQL 函数。 */
export async function requireFunction(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ found: string | null }>`
    SELECT to_regprocedure(${SIGNATURE})::text AS found
  `.execute(db);
  expect(result.rows[0]?.found ?? null, SIGNATURE).not.toBeNull();
}

export async function purge(
  db: Kysely<DB>,
  now: string | null,
  days: number | null,
  size: number | null,
): Promise<PurgeRow[]> {
  const result = await sql<PurgeRow>`
    SELECT table_name, deleted
    FROM app.delete_expired_agent_traces(${now}::timestamptz, ${days}::integer, ${size}::integer)
  `.execute(db);
  return result.rows.map((row) => ({ table_name: row.table_name, deleted: row.deleted }));
}

/** 函数应返回的九行。 */
export function counts(deleted: (table: AgentTable) => number): PurgeRow[] {
  return AGENT_TABLES.map((table) => ({ table_name: table, deleted: BigInt(deleted(table)) }));
}

export function everyTable(deleted: number): PurgeRow[] {
  return counts(() => deleted);
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

/**
 * plain：普通对话；erased：注销后已清空自由文本、用户编号换成哈希的行（BR-AI-22）；reported：被举报、
 * 点踩成 badcase 的助手消息。
 */
export type Shape = 'plain' | 'erased' | 'reported';

export interface TraceOptions {
  readonly appId?: string;
  readonly shape?: Shape;
  /** 个别表的 created_at，覆盖 `at`。 */
  readonly times?: Partial<Record<AgentTable, string>>;
  /** agent_cards.link_id。 */
  readonly linkId?: string;
}

export interface Trace {
  readonly appId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly messageId: string;
}

export const CHAIN_ID = 'synthetic-chain';

/**
 * 一棵 trace：设备、会话、run 各一，九张表各一行（消息一条），created_at 默认都取 `at`（couli_app 写）。
 */
export async function seedTrace(
  app: Kysely<DB>,
  at: string,
  options: TraceOptions = {},
): Promise<Trace> {
  const appId = options.appId ?? 'couli';
  const shape = options.shape ?? 'plain';
  const erased = shape === 'erased';
  const time = (table: AgentTable): string => options.times?.[table] ?? at;
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const messageId = randomUUID();
  const resultSetId = randomUUID();

  await sql`
    INSERT INTO app.devices
      (id, app_id, user_id, install_secret_cipher, device_hash, id_source, platform, app_version,
       last_seen_at)
    VALUES (${deviceId}, ${appId}, NULL, ${Buffer.from('synthetic-secret')}, ${hex64()}, 'idfv',
      'ios', 'synthetic@1', ${time('agent_sessions')}::timestamptz)
  `.execute(app);
  const s = time('agent_sessions');
  await sql`
    INSERT INTO app.agent_sessions
      (id, app_id, user_id, device_id, started_at, last_active_at, user_hash, created_at, updated_at)
    VALUES (${sessionId}, ${appId}, NULL, ${deviceId}, ${s}::timestamptz, ${s}::timestamptz,
      ${erased ? hex64() : null}::text, ${s}::timestamptz, ${s}::timestamptz)
  `.execute(app);
  const r = time('agent_runs');
  const subject = erased
    ? JSON.stringify(['member', hex64()])
    : JSON.stringify(['device', 'synthetic-device']);
  await sql`
    INSERT INTO app.agent_runs
      (id, app_id, session_id, accepted_at, prompt_version, quota_subjects, user_text, created_at,
       updated_at)
    VALUES (${runId}, ${appId}, ${sessionId}, ${r}::timestamptz, 'synthetic@1', ${[subject]}::text[],
      ${erased ? null : 'synthetic private question'}::text, ${r}::timestamptz, ${r}::timestamptz)
  `.execute(app);
  const m = time('agent_messages');
  if (shape === 'reported') {
    await sql`
      INSERT INTO app.agent_messages
        (id, app_id, session_id, run_id, client_msg_id, role, text, feedback, feedback_at, badcase,
         reported, reported_at, report_status, report_reason, created_at, updated_at)
      VALUES (${messageId}, ${appId}, ${sessionId}, ${runId}, NULL, 'assistant',
        'synthetic private answer', 'down', ${m}::timestamptz, true, true, ${m}::timestamptz,
        'pending', 'synthetic private report', ${m}::timestamptz, ${m}::timestamptz)
    `.execute(app);
  } else {
    await sql`
      INSERT INTO app.agent_messages
        (id, app_id, session_id, run_id, client_msg_id, role, text, created_at, updated_at)
      VALUES (${messageId}, ${appId}, ${sessionId}, ${runId}, 'synthetic-client', 'user',
        ${erased ? null : 'synthetic private question'}::text, ${m}::timestamptz, ${m}::timestamptz)
    `.execute(app);
  }
  await sql`
    INSERT INTO app.agent_tool_calls
      (id, app_id, run_id, seq, name, args, result_digest, status, latency_ms, created_at)
    VALUES (${randomUUID()}, ${appId}, ${runId}, 1, 'synthetic_search',
      ${erased ? null : '{"q":"synthetic private query"}'}::jsonb, 'synthetic digest', 'ok', 1,
      ${time('agent_tool_calls')}::timestamptz)
  `.execute(app);
  await sql`
    INSERT INTO app.agent_cards
      (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version, fallback_text,
       created_at)
    VALUES (${randomUUID()}, ${appId}, ${sessionId}, ${runId}, 'c1', 'notice',
      ${erased ? '{}' : '{"text":"synthetic private card"}'}::jsonb, ${options.linkId ?? null}::uuid,
      1, ${erased ? '内容已删除' : 'synthetic private fallback'},
      ${time('agent_cards')}::timestamptz)
  `.execute(app);
  await sql`
    INSERT INTO app.agent_result_sets (id, app_id, run_id, conditions, created_at)
    VALUES (${resultSetId}, ${appId}, ${runId},
      ${erased ? '{}' : '{"q":"synthetic private query"}'}::jsonb,
      ${time('agent_result_sets')}::timestamptz)
  `.execute(app);
  await sql`
    INSERT INTO app.agent_result_deliveries
      (app_id, session_id, run_id, result_set_id, position, card_id, product_key, platform,
       final_price_fen, card, created_at)
    VALUES (${appId}, ${sessionId}, ${runId}, ${resultSetId}, 1, 'c1', 'jd:synthetic-product', 'jd',
      100, ${erased ? '{}' : '{"title":"synthetic private card"}'}::jsonb,
      ${time('agent_result_deliveries')}::timestamptz)
  `.execute(app);
  const conditions = erased
    ? JSON.stringify({ chain_id: CHAIN_ID })
    : JSON.stringify({ chain_id: CHAIN_ID, q: 'synthetic private query' });
  await sql`
    INSERT INTO app.agent_result_chains
      (app_id, session_id, seq, chain_id, status, conditions, created_at)
    VALUES (${appId}, ${sessionId}, 1, ${CHAIN_ID}, 'has_products', ${conditions}::jsonb,
      ${time('agent_result_chains')}::timestamptz)
  `.execute(app);
  await sql`
    INSERT INTO app.agent_clarify_asks (app_id, session_id, chain_id, slot, created_at)
    VALUES (${appId}, ${sessionId}, ${CHAIN_ID}, 'price', ${time('agent_clarify_asks')}::timestamptz)
  `.execute(app);
  return { appId, deviceId, sessionId, runId, messageId };
}

/** 本表现存行的 created_at，从旧到新（couli_app 读）。 */
export async function agentTimes(db: Kysely<DB>, table: AgentTable): Promise<string[]> {
  const result = await sql<{ at: string }>`
    SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM ${sql.table(`app.${table}`)}
    ORDER BY created_at
  `.execute(db);
  return result.rows.map((row) => row.at);
}

/** 九张表各自现存行的 created_at 应为 rows(table)（从旧到新）。 */
export async function expectAgentLeft(
  db: Kysely<DB>,
  rows: (table: AgentTable) => readonly string[],
): Promise<void> {
  for (const table of AGENT_TABLES) {
    expect(await agentTimes(db, table), table).toEqual([...rows(table)].sort());
  }
}

/** 每张表一行一棵树的时刻里，created_at 不早于截断点的那些（从旧到新）。 */
export function keptOf(times: readonly string[], cutoff: string): string[] {
  return times.filter((at) => at >= cutoff).sort();
}

/** worker 的维护实例，时钟可调，日志原文收进 lines；maint 只有一条连接。 */
export function workerAt(
  world: Pick<World, 'maint'>,
  instant: string,
): {
  readonly maintenance: ReturnType<typeof createWorkerMaintenance>;
  readonly clock: ReturnType<typeof settableClock>;
  readonly lines: string[];
} {
  const clock = settableClock(instant);
  const { logger, lines } = memoryLogger();
  const maintenance = createWorkerMaintenance({ db: world.maint, logger, clock });
  return { maintenance, clock, lines };
}

/** 本节写的日志行（reduceLine 之后）；不是一行 JSON 的原文也留着，让断言失败。 */
export function agentLines(lines: readonly string[]): (Record<string, unknown> | string)[] {
  return lines
    .map(reduceLine)
    .filter(
      (record) => typeof record === 'string' || String(record['msg']).startsWith('agent_trace_'),
    );
}

/** 本节与第 K 节（retention_*）写的日志行。 */
export function cleanupLines(lines: readonly string[]): (Record<string, unknown> | string)[] {
  return lines
    .map(reduceLine)
    .filter(
      (record) =>
        typeof record === 'string' ||
        String(record['msg']).startsWith('agent_trace_') ||
        String(record['msg']).startsWith('retention_'),
    );
}

/** UUID、32 位以上十六进制（设备、用户哈希）、夹具文本与 IP。 */
export const PERSONAL = /[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{32}|synthetic|192\.0\.2\./;
