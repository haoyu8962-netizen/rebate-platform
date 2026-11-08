// B3-08y · BR-AI-22 (注销后 Agent 数据处理, D10-175) × BR-AI-19: the write-first order of the
// writer's session lock. ./erased.int.test.ts holds the purge first and then writes; here the
// write comes first: the writer (agent/store/results createPgAgentTraceWriter) has checked the
// session (still a member's) and its transaction is still open — its INSERT … ON CONFLICT waits on
// a third connection's uncommitted conflicting agent_cards / agent_tool_calls rows — when the
// account deletion's purge (purgeAgentDataForUser) starts. The session check and the insert are one
// transaction holding the session row lock (FOR SHARE, exclusive with the purge's FOR NO KEY
// UPDATE) until the insert commits, so the purge waits for the write and then clears what it wrote.
// A check that releases its lock before the insert lets the purge commit first and the plain card
// data / tool arguments land afterwards under the detached session. Real PG; contract: ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createAgentDataPurge,
  purgedCardText,
} from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import { createPgAgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { insertRun, sessionOf } from '../stream-assembly-orders/kit.ts';
import { newMember, openAgent, until, usePgEach } from '../stream-mount/kit.ts';
import { cardRowsOf, pause, toolCallRowsOf } from '../trace-persist/kit.ts';
import { SECRET, notice, toolCall } from './kit.ts';
import { HASH_KEY, uuid } from './runtime-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const AT = new FixedClock('2026-12-01T00:00:00.000Z').now();

/** Thrown inside the blocking transaction to roll it back. */
const ROLL_BACK = new Error('synthetic rollback of the blocking transaction');

/** Backends of this test database waiting for a lock. */
async function lockWaiters(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

it('[AC-B3-08y#6][BR-AI-22][BR-AI-19] 写入先行：写者已查过会话（仍属会员）、其事务未结束（INSERT 等第三个连接未提交的冲突行）时启动注销清理：清理等写者提交后才动手，最终该会话的 agent_cards.data 为 {}、fallback_text 为占位文本、agent_tool_calls.args 为 NULL，库里无明文；清理不报错，会话与 run 行骨架都在', async () => {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  const userId = member.userId;
  expect(userId, 'a member').toBeTypeOf('string');
  const sessionId = await sessionOf(pg.db, member);
  const runId = await insertRun(pg.db, sessionId);
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  const writer = createPgAgentTraceWriter({ db: pg.db, newId: uuid });

  // A third connection: uncommitted rows on the writer's conflict keys (card c1 of the session,
  // tool call seq 1 of the run), held until released, then rolled back.
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  let blockerInserted!: () => void;
  const inserted = new Promise<'inserted'>((resolve) => {
    blockerInserted = () => resolve('inserted');
  });
  const blocker = pg.db
    .transaction()
    .execute(async (trx) => {
      await sql`INSERT INTO app.agent_cards
          (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version,
           fallback_text)
        VALUES (${uuid()}, ${member.appId}, ${sessionId}, ${runId}, 'c1', 'notice',
          ${JSON.stringify({ level: 'info', text_key: 'k', actions: [] })}::jsonb, NULL, 1,
          '合成占位卡')`.execute(trx);
      await sql`INSERT INTO app.agent_tool_calls
          (id, app_id, run_id, seq, name, args, result_digest, status, latency_ms)
        VALUES (${uuid()}, ${member.appId}, ${runId}, 1, 'search_products', NULL, NULL, 'ok',
          NULL)`.execute(trx);
      blockerInserted();
      await blockerGate;
      throw ROLL_BACK;
    })
    .then(
      () => 'committed' as const,
      (error: unknown) => (error === ROLL_BACK ? ('rolled back' as const) : error),
    );

  let writesSettled = 0;
  let purgeSettled = false;
  let writes: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let purge: Promise<{ sessions: number; messages: number }> | undefined;
  try {
    expect(await Promise.race([inserted, blocker]), 'the blocking rows are in place').toBe(
      'inserted',
    );

    const cards = writer.recordCards(member.appId, sessionId, runId, [notice('c1')]);
    const calls = writer.recordToolCalls(member.appId, runId, [toolCall(1)]);
    const mark = () => {
      writesSettled += 1;
    };
    cards.then(mark, mark);
    calls.then(mark, mark);
    writes = Promise.allSettled([cards, calls]);
    await until(
      'both writes wait on the blocking rows (session checked, transaction open)',
      async () => writesSettled > 0 || (await lockWaiters(pg.db)) >= 2,
    );
    expect(writesSettled, 'the writes are stalled on their INSERT').toBe(0);

    purge = pg.db
      .transaction()
      .execute((trx) =>
        port.purgeAgentDataForUser(trx, { appId: member.appId, userId: userId ?? '', at: AT }),
      );
    purge.then(
      () => {
        purgeSettled = true;
      },
      () => {
        purgeSettled = true;
      },
    );
    await pause(500);
    expect(purgeSettled, 'the purge waits for the session lock the stalled writer holds').toBe(
      false,
    );
    expect(writesSettled, 'the writes are still stalled').toBe(0);

    releaseBlocker();
    expect(await blocker, 'the blocking transaction rolled back').toBe('rolled back');
    const statuses = (await writes).map((outcome) => outcome.status);
    expect(statuses, 'the writes complete').toEqual(['fulfilled', 'fulfilled']);
    expect((await purge).sessions, 'the purge detached the session without error').toBe(1);

    const cardRows = await cardRowsOf(pg.db, 'session_id', sessionId);
    const toolRows = await toolCallRowsOf(pg.db, 'run_id', runId);
    for (const row of cardRows) {
      expect(row.card_id).toBe('c1');
      expect(row.data, 'card data cleared').toEqual({});
      expect(row.fallback_text, 'card fallback_text is the placeholder').toBe(purgedCardText());
    }
    for (const row of toolRows) {
      expect(row.seq).toBe(1);
      expect(row.args, 'tool arguments cleared').toBeNull();
    }
    expect(JSON.stringify([cardRows, toolRows])).not.toContain(SECRET);

    const session = await sql<{ user_id: string | null; user_hash: string | null }>`SELECT
        user_id::text AS user_id, user_hash
      FROM app.agent_sessions WHERE id = ${sessionId}`.execute(pg.db);
    expect(session.rows, 'the session row is kept').toHaveLength(1);
    expect(session.rows[0]?.user_id).toBeNull();
    expect(session.rows[0]?.user_hash).toMatch(/^[0-9a-f]{64}$/u);
    const run = await sql<{ user_text: string | null }>`SELECT user_text FROM app.agent_runs
      WHERE id = ${runId}`.execute(pg.db);
    expect(run.rows, 'the run row is kept').toEqual([{ user_text: null }]);
  } finally {
    releaseBlocker();
    await blocker;
    if (writes !== undefined) await writes;
    if (purge !== undefined) await purge.catch(() => undefined);
  }
}, 120_000);
