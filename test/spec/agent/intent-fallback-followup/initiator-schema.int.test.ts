// B3-05p ① (D10-1378, migration 0139 per D10-1380) · BR-AI-01 细则「意图兜底与不空回复」: a
// server-initiated tool call is traced「标明由服务端发起」; BR-AI-19: tool calls are stored in
// app.agent_tool_calls. After the migrations app.agent_tool_calls has
//   initiator text NOT NULL DEFAULT 'model', CHECK (initiator IN ('model', 'server')),
// and agent/store/results createPgAgentTraceWriter stores the initiator of each record that
// stream/mount/trace.ts toolCallRecords built from the run trace.
// Every test first asserts that the column is there (information_schema), so before the migration
// the test fails on that assertion, not on a database error. Real PG as the business role
// (store-results kit); synthetic values only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type { OrchestratorTrace } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { createPgAgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { toolCallRecords } from '../../../../apps/api/src/modules/agent/stream/mount/trace.ts';
import { APP, databaseKit, type Scope } from '../store-results/kit.ts';

const h = databaseKit(createTestDatabase);

interface ColumnRow {
  readonly data_type: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
}

async function initiatorColumn(db: Kysely<DB>): Promise<ColumnRow | undefined> {
  const result = await sql<ColumnRow>`SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'agent_tool_calls'
      AND column_name = 'initiator'`.execute(db);
  return result.rows[0];
}

/** The column the migration adds; an assertion failure when it is missing. */
async function expectInitiatorColumn(db: Kysely<DB>): Promise<void> {
  expect(await initiatorColumn(db), 'app.agent_tool_calls.initiator exists').toBeDefined();
}

/** One agent_tool_calls row of `scope`'s run, written as the business role, initiator left to
 * the column default. */
function insertDefault(scope: Scope, seq: number) {
  return sql`INSERT INTO app.agent_tool_calls (id, app_id, run_id, seq, name, args, status)
    VALUES (${randomUUID()}, ${scope.appId}, ${scope.runId}, ${seq}, 'search_products', NULL,
      'ok')`.execute(h.db());
}

/** The same row with an explicit initiator (NULL included). */
function insertWith(scope: Scope, seq: number, initiator: string | null) {
  return sql`INSERT INTO app.agent_tool_calls
      (id, app_id, run_id, seq, name, args, status, initiator)
    VALUES (${randomUUID()}, ${scope.appId}, ${scope.runId}, ${seq}, 'search_products', NULL,
      'ok', ${initiator})`.execute(h.db());
}

async function initiatorsOf(runId: string): Promise<unknown[][]> {
  const result = await sql<{ seq: number; name: string; initiator: string }>`SELECT seq, name,
      initiator
    FROM app.agent_tool_calls WHERE run_id = ${runId} ORDER BY seq`.execute(h.db());
  return result.rows.map((row) => [Number(row.seq), row.name, row.initiator]);
}

it('[AC-B3-05p#3][BR-AI-19] 迁移后 app.agent_tool_calls 有 initiator 列：text、NOT NULL、默认 model', async () => {
  const column = await initiatorColumn(h.db());
  expect(column, 'app.agent_tool_calls.initiator exists').toBeDefined();
  expect(column).toEqual({
    data_type: 'text',
    is_nullable: 'NO',
    column_default: "'model'::text",
  });
});

it('[AC-B3-05p#4][BR-AI-19] 不写 initiator 时落 model；只收 model / server，别的值与 NULL 被约束拒绝', async () => {
  await expectInitiatorColumn(h.db());
  const scope = await h.scope();
  await insertDefault(scope, 1);
  await insertWith(scope, 2, 'model');
  await insertWith(scope, 3, 'server');
  const rejected: readonly (readonly [number, string])[] = [
    [4, 'user'],
    [5, 'Server'],
    [6, ''],
  ];
  for (const [seq, value] of rejected) {
    await expect(
      insertWith(scope, seq, value),
      `initiator ${JSON.stringify(value)}`,
    ).rejects.toMatchObject({ code: '23514' });
  }
  await expect(insertWith(scope, 7, null), 'initiator NULL').rejects.toMatchObject({
    code: '23502',
  });
  expect(await initiatorsOf(scope.runId)).toEqual([
    [1, 'search_products', 'model'],
    [2, 'search_products', 'model'],
    [3, 'search_products', 'server'],
  ]);
});

it('[AC-B3-05p#5][BR-AI-01][BR-AI-19] 写库器经 toolCallRecords 落库：模型调用记 model、服务端代调记 server，重复写入仍各一行', async () => {
  await expectInitiatorColumn(h.db());
  const scope = await h.scope();
  const traced: OrchestratorTrace['tool_calls'] = [
    { name: 'search_products', args: { q: '合成保温杯' }, status: 'ok' },
    { name: 'handoff_to_human', args: {}, status: 'ok', initiator: 'server' },
    {
      name: 'list_my_orders',
      args: { date_from: '2026-10-13' },
      status: 'failed',
      initiator: 'server',
    },
  ];
  const writer = createPgAgentTraceWriter({ db: h.db(), newId: randomUUID });
  await writer.recordToolCalls(APP, scope.runId, toolCallRecords(traced));
  await writer.recordToolCalls(APP, scope.runId, toolCallRecords(traced));
  expect(await initiatorsOf(scope.runId)).toEqual([
    [1, 'search_products', 'model'],
    [2, 'handoff_to_human', 'server'],
    [3, 'list_my_orders', 'server'],
  ]);
});
