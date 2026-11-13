// CT-13f / BR-ID-30 ③；任务书 §10（D10-1488 ①、D10-1500 (a)）。
// 直接测试既有 createWorkerMaintenance，不新增应用接口或配置；SQL 函数缺失先断言失败。
// 04:00 起每个 +08:00 日成功清理一次，先分区、再 DEFAULT、最后 dedup；三个调用必须逐个等完。
// 沿用维护模块的 SQL 结果别名 partition / partitions / deleted 与 pino table / partition / rows 字段。
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
} from 'kysely';
import { expect } from 'vitest';

import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { memoryLogger, settableClock } from '../maintenance/kit.ts';

export const NOW = '2026-10-08T20:00:00.000Z'; // 10-09 04:00 +08:00
export const CUTOFF = '2026-07-10T16:00:00.000Z'; // 07-11 00:00 +08:00
export const SIGNATURE = 'app.purge_expired_event_dedup(timestamp with time zone)';
export const STEPS = [
  'drop_expired_events_day_partitions',
  'purge_expired_events_default',
  'purge_expired_event_dedup',
] as const;
export const ENSURE = 'ensure_events_day_partition';
export type Step = (typeof STEPS)[number];

export async function requireFunction(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regprocedure(${SIGNATURE}) IS NOT NULL AS present
  `.execute(db);
  expect(result.rows, 'CT-13f 迁移须提供去重表清理函数').toEqual([{ present: true }]);
}

export async function purge(db: Kysely<DB>, now: string | null): Promise<bigint | undefined> {
  const result = await sql<{ deleted: bigint }>`
    SELECT app.purge_expired_event_dedup(${now}::timestamptz) AS deleted
  `.execute(db);
  return result.rows[0]?.deleted;
}

export async function seedDedup(db: Kysely<DB>, at: string, appId = 'couli'): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.event_dedup (app_id, event_type, event_id, created_at)
    VALUES (${appId}, 'synthetic-retention', ${id}::uuid, ${at}::timestamptz)
  `.execute(db);
  return id;
}

export async function dedupIds(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT event_id::text AS id FROM app.event_dedup ORDER BY event_id
  `.execute(db);
  return result.rows.map((row) => row.id);
}

export function workerAt(db: Kysely<DB>, instant = NOW) {
  const clock = settableClock(instant);
  const { logger, lines } = memoryLogger();
  return { maintenance: createWorkerMaintenance({ db, clock, logger }), clock, lines };
}

export function stepOf(query: CompiledQuery): Step | undefined {
  return STEPS.find((step) => query.sql.includes(`app.${step}(`));
}

export function cleanupQueries(queries: readonly CompiledQuery[]): CompiledQuery[] {
  return queries.filter((query) => stepOf(query) !== undefined);
}

export interface Control {
  role: string;
  fail: Step | typeof ENSURE | undefined;
  error: Error;
}

/** 不连库：真正的 Kysely 编译器，驱动只返回 SQL 函数契约形状，记录开始/完成以发现并行删除。 */
export async function fakeDb() {
  const queries: CompiledQuery[] = [];
  const trace: string[] = [];
  const control: Control = {
    role: 'couli_maint',
    fail: undefined,
    error: Object.assign(new Error('synthetic retention failure'), { code: '55P03' }),
  };
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    const text = query.sql;
    const step = stepOf(query);
    const operation = step ?? (text.includes(`app.${ENSURE}(`) ? ENSURE : undefined);
    if (operation !== undefined) {
      trace.push(`start:${operation}`);
      // 若调用方 Promise.all 并发，下一步的 start 会跑到当前 finish 之前。
      await Promise.resolve();
      await Promise.resolve();
      if (control.fail === operation) throw control.error;
      trace.push(`finish:${operation}`);
    }
    let rows: readonly unknown[] = [];
    if (text.includes('current_user')) rows = [{ role: control.role }];
    else if (operation === ENSURE) {
      rows = [{ partition: `events_p${String(query.parameters[0]).replaceAll('-', '')}` }];
    } else if (step === STEPS[0]) rows = [{ partitions: ['events_p20260709', 'events_p20260710'] }];
    else if (step === STEPS[1]) rows = [{ deleted: 2n }];
    else if (step === STEPS[2]) rows = [{ deleted: 3n }];
    else if (/ensure_(month|day)_partition/.test(text)) rows = [{ partition: 'other_partition' }];
    else if (/drop_expired_\w+_partitions/.test(text)) rows = [{ partitions: [] }];
    else if (text.includes('delete_expired_agent_traces')) {
      rows = [
        'agent_tool_calls',
        'agent_cards',
        'agent_result_deliveries',
        'agent_messages',
        'agent_result_sets',
        'agent_runs',
        'agent_clarify_asks',
        'agent_result_chains',
        'agent_sessions',
      ].map((table) => ({ table_name: table, deleted: 0n }));
    } else if (text.includes('delete_expired_')) rows = [{ deleted: 0n }];
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries, trace, control };
}
