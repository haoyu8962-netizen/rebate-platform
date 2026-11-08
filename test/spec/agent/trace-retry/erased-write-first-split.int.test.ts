// B3-08y · BR-AI-22 (注销后 Agent 数据处理, D10-175) × BR-AI-19: the write-first order, one write path
// at a time (D10-1071). ./erased-write-first.int.test.ts stalls both writes together, so one path's
// session lock can cover the other. The queue writes again only the failed half of a run, so each
// path runs alone in ordinary use: here a third connection holds an uncommitted row on ONE writer
// conflict key only — agent_tool_calls (app_id, run_id, seq) with only recordToolCalls called, or
// agent_cards (app_id, session_id, card_id) with only recordCards called — and the account deletion's
// purge (purgeAgentDataForUser) starts while that single write is stalled on its INSERT. Each path
// checks the session and inserts in one transaction holding the session row lock (FOR SHARE,
// exclusive with the purge's FOR NO KEY UPDATE) until the insert commits, so the purge waits for it
// and then clears what it wrote. A path that checks the session in its own short transaction and
// inserts separately lets the purge commit first and the plain text land afterwards under the
// detached session. Real PG; contract: ./kit.ts.
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

/** Which single write path is stalled. */
type Path = 'recordToolCalls' | 'recordCards';

/** Backends of this test database waiting for a lock. */
async function lockWaiters(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * A member's session and run; a third connection holds an uncommitted row on the conflict key of
 * `path` only; that single write is started and stalls; the purge starts and must keep waiting
 * (≥ 500 ms) while the write is stalled; then the blocker rolls back. Asserts no plain text is left
 * and the session / run skeleton is kept.
 */
async function stallOnePathThenPurge(path: Path): Promise<void> {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  const userId = member.userId;
  expect(userId, 'a member').toBeTypeOf('string');
  const sessionId = await sessionOf(pg.db, member);
  const runId = await insertRun(pg.db, sessionId);
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  const writer = createPgAgentTraceWriter({ db: pg.db, newId: uuid });

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
      if (path === 'recordCards') {
        await sql`INSERT INTO app.agent_cards
            (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version,
             fallback_text)
          VALUES (${uuid()}, ${member.appId}, ${sessionId}, ${runId}, 'c1', 'notice',
            ${JSON.stringify({ level: 'info', text_key: 'k', actions: [] })}::jsonb, NULL, 1,
            '合成占位卡')`.execute(trx);
      } else {
        await sql`INSERT INTO app.agent_tool_calls
            (id, app_id, run_id, seq, name, args, result_digest, status, latency_ms)
          VALUES (${uuid()}, ${member.appId}, ${runId}, 1, 'search_products', NULL, NULL, 'ok',
            NULL)`.execute(trx);
      }
      blockerInserted();
      await blockerGate;
      throw ROLL_BACK;
    })
    .then(
      () => 'committed' as const,
      (error: unknown) => (error === ROLL_BACK ? ('rolled back' as const) : error),
    );

  let writeSettled = false;
  let purgeSettled = false;
  let write: Promise<unknown> | undefined;
  let purge: Promise<{ sessions: number; messages: number }> | undefined;
  try {
    expect(await Promise.race([inserted, blocker]), 'the blocking row is in place').toBe(
      'inserted',
    );

    write =
      path === 'recordCards'
        ? writer.recordCards(member.appId, sessionId, runId, [notice('c1')])
        : writer.recordToolCalls(member.appId, runId, [toolCall(1)]);
    write.then(
      () => {
        writeSettled = true;
      },
      () => {
        writeSettled = true;
      },
    );
    await until(
      `the ${path} write waits on the blocking row (session checked, transaction open)`,
      async () => writeSettled || (await lockWaiters(pg.db)) >= 1,
    );
    expect(writeSettled, `the ${path} write is stalled on its INSERT`).toBe(false);

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
    expect(
      purgeSettled,
      `the purge waits for the session lock the stalled ${path} write holds`,
    ).toBe(false);
    expect(writeSettled, `the ${path} write is still stalled`).toBe(false);

    releaseBlocker();
    expect(await blocker, 'the blocking transaction rolled back').toBe('rolled back');
    const statuses = (await Promise.allSettled([write])).map((settled) => settled.status);
    expect(statuses, `the ${path} write completes`).toEqual(['fulfilled']);
    expect((await purge).sessions, 'the purge detached the session without error').toBe(1);

    const cardRows = await cardRowsOf(pg.db, 'session_id', sessionId);
    const toolRows = await toolCallRowsOf(pg.db, 'run_id', runId);
    if (path === 'recordCards') {
      expect(toolRows, 'no tool call was written').toEqual([]);
      expect(cardRows.length, 'at most the one card').toBeLessThanOrEqual(1);
      for (const row of cardRows) {
        expect(row.card_id).toBe('c1');
        expect(row.data, 'card data cleared').toEqual({});
        expect(row.fallback_text, 'card fallback_text is the placeholder').toBe(purgedCardText());
      }
    } else {
      expect(cardRows, 'no card was written').toEqual([]);
      expect(toolRows.length, 'at most the one tool call').toBeLessThanOrEqual(1);
      for (const row of toolRows) {
        expect(row.seq).toBe(1);
        expect(row.args, 'tool arguments cleared').toBeNull();
      }
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
    if (write !== undefined) await write.catch(() => undefined);
    if (purge !== undefined) await purge.catch(() => undefined);
  }
}

it('[AC-B3-08y#6][BR-AI-22][BR-AI-19] 写入先行·只卡工具调用：第三个连接只持有一条未提交、与 (app_id, run_id, seq) 冲突的 agent_tool_calls 行，只调 recordToolCalls；其查过会话后事务未结束时启动注销清理：清理一直等到写者提交（≥500ms 未结束），放行后 agent_tool_calls.args 为 NULL、库里无明文，清理不报错，会话与 run 行骨架都在', async () => {
  await stallOnePathThenPurge('recordToolCalls');
}, 120_000);

it('[AC-B3-08y#6][BR-AI-22][BR-AI-19] 写入先行·只卡卡片：第三个连接只持有一条未提交、与 (app_id, session_id, card_id) 冲突的 agent_cards 行，只调 recordCards；其查过会话后事务未结束时启动注销清理：清理一直等到写者提交（≥500ms 未结束），放行后 agent_cards.data 为 {}、fallback_text 为占位文本、库里无明文，清理不报错，会话与 run 行骨架都在', async () => {
  await stallOnePathThenPurge('recordCards');
}, 120_000);
