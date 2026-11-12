// B3-05p ① · BR-AI-01 细则「意图兜底与不空回复」: 服务端代调的工具调用「照常留痕（标明由服务端发起）」;
// BR-AI-19: the run's tool calls go to app.agent_tool_calls asynchronously. On the production stream
// entry ([AC-B3-08g]'s ordersFixture → createProductionStreamAssembly → createAgentStreamRuntime,
// real PG; ../trace-persist/kit.ts productionRig with a scripted model), one run in which the model
// calls search_products and then gives only the intent object handoff, so the server calls
// handoff_to_human itself: the run's two rows carry initiator 'model' (seq 1) and 'server' (seq 2),
// written through the runtime's own trace path (stream/mount/trace.ts → createPgAgentTraceWriter).
// The test first asserts the column (information_schema), so before migration 0139 it fails on that
// assertion. Synthetic values only.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD } from '../core-reply-templates/kit.ts';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  finishOf,
  productionRig,
  runIdOf,
  toolCallsOnce,
} from '../trace-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ASK = '帮我找合成保温杯，找不到就帮我转人工';

async function expectInitiatorColumn(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ column_name: string }>`SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'agent_tool_calls'
      AND column_name = 'initiator'`.execute(db);
  expect(result.rows, 'app.agent_tool_calls.initiator exists').toHaveLength(1);
}

it('[AC-B3-05p#6][BR-AI-01][BR-AI-19] 生产流装配·模型路径：模型调 search_products、再只给 handoff 意图由服务端代调 handoff_to_human，agent_tool_calls 两行的 initiator 依次为 model、server', async () => {
  await expectInitiatorColumn(pg.db);
  const x = await productionRig(pg.db, {
    scripts: {
      [ASK]: [
        { text: LEAD, calls: [{ name: 'search_products', args: { q: KEYWORD } }] },
        { text: JSON.stringify({ agent_intent: 'handoff' }) },
      ],
    },
  });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toContain('handoff');
    const runId = runIdOf(frames);

    const calls = await toolCallsOnce(pg.db, runId, 2);
    expect(calls.map((call) => [call.seq, call.name, call.status])).toEqual([
      [1, 'search_products', 'ok'],
      [2, 'handoff_to_human', 'ok'],
    ]);
    const stored = await sql<{ seq: number; initiator: string }>`SELECT seq, initiator
      FROM app.agent_tool_calls WHERE run_id = ${runId} ORDER BY seq`.execute(pg.db);
    expect(stored.rows.map((row) => [Number(row.seq), row.initiator])).toEqual([
      [1, 'model'],
      [2, 'server'],
    ]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
