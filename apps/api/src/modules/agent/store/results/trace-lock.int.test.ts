// B3-08y spec-test r2 S1 (BR-AI-22 × BR-AI-19): the trace writer's session lock, each write on its
// own. test/spec/agent/trace-retry/erased-write-first.int.test.ts stalls BOTH writes at once, so a
// writer that releases the session lock early in only ONE of recordCards / recordToolCalls could
// still pass it (the other write's lock keeps the purge waiting). Here a third connection holds an
// uncommitted conflicting row on ONE table only and only that write is made: the purge must wait
// for that write's transaction (FOR SHARE held until the insert commits) and then clear what it
// wrote. Real PG through the shared test-database fixture (apps/api integration config).
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAgentDataPurge, purgedCardText } from '../../deletion/index.ts';
import { createPgAgentTraceWriter, type ToolCallRecord } from './index.ts';

const APP = 'synthetic-b3-08y-lock-app';
const SECRET = '合成用户搜索词';
const AT = new Date('2026-12-01T00:00:00.000Z');
const ROLL_BACK = new Error('synthetic rollback of the blocking transaction');

let database: TestDatabase | undefined;
let pool: Kysely<DB> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);

afterAll(async () => {
  if (pool) await destroyDb(pool);
  if (database) await database.drop();
});

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** A member's session with one run (synthetic rows). */
async function memberRun(db: Kysely<DB>) {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const code = randomUUID().replaceAll('-', '').slice(0, 12);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method)
    VALUES (${userId}, ${APP}, '合成用户', 'synthetic-avatar', ${`i${code}`}, ${`a${code}`},
      'normal', 'phone')`.execute(db);
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${APP}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${AT})`.execute(db);
  await sql`INSERT INTO app.agent_sessions
    (id, app_id, user_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${APP}, ${userId}, ${deviceId}, ${AT}, ${AT})`.execute(db);
  await sql`INSERT INTO app.agent_runs
    (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
    VALUES (${runId}, ${APP}, ${sessionId}, ${AT}, ${[`["user","${userId}"]`]},
      'synthetic@1', ${AT})`.execute(db);
  return { userId, sessionId, runId };
}

function notice(cardId: string) {
  return {
    card_id: cardId,
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'k', actions: [], q: SECRET },
    fallback_text: `${SECRET} 兜底`,
  };
}

function toolCall(seq: number): ToolCallRecord {
  return {
    seq,
    name: 'search_products',
    args: { q: SECRET },
    result_digest: null,
    status: 'ok',
    latency_ms: null,
  };
}

async function lockWaiters(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await ready()) return;
    await pause(25);
  }
  throw new Error(`never happened: ${what}`);
}

/**
 * A third connection's uncommitted row on the conflict key of `table` only (card c1 of the session,
 * or tool call seq 1 of the run), held until released and then rolled back.
 */
function blockOne(
  db: Kysely<DB>,
  table: 'agent_cards' | 'agent_tool_calls',
  run: { readonly sessionId: string; readonly runId: string },
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted!: () => void;
  const ready = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const done = db
    .transaction()
    .execute(async (trx) => {
      if (table === 'agent_cards') {
        await sql`INSERT INTO app.agent_cards
            (id, app_id, session_id, run_id, card_id, type, data, link_id, schema_version,
             fallback_text)
          VALUES (${randomUUID()}, ${APP}, ${run.sessionId}, ${run.runId}, 'c1', 'notice',
            '{}'::jsonb, NULL, 1, '合成占位卡')`.execute(trx);
      } else {
        await sql`INSERT INTO app.agent_tool_calls
            (id, app_id, run_id, seq, name, args, result_digest, status, latency_ms)
          VALUES (${randomUUID()}, ${APP}, ${run.runId}, 1, 'search_products', NULL, NULL, 'ok',
            NULL)`.execute(trx);
      }
      inserted();
      await gate;
      throw ROLL_BACK;
    })
    .then(
      () => 'committed' as const,
      (error: unknown) => (error === ROLL_BACK ? ('rolled back' as const) : error),
    );
  return { ready, release, done };
}

async function expectSkeletonKept(db: Kysely<DB>, run: { sessionId: string; runId: string }) {
  const session = await sql<{ user_id: string | null; user_hash: string | null }>`SELECT
      user_id::text AS user_id, user_hash FROM app.agent_sessions
    WHERE id = ${run.sessionId}`.execute(db);
  expect(session.rows, 'the session row is kept').toHaveLength(1);
  expect(session.rows[0]?.user_id).toBeNull();
  expect(session.rows[0]?.user_hash).toMatch(/^[0-9a-f]{64}$/u);
  const runs = await sql<{ id: string }>`SELECT id::text AS id FROM app.agent_runs
    WHERE id = ${run.runId}`.execute(db);
  expect(runs.rows, 'the run row is kept').toHaveLength(1);
}

/**
 * Starts the purge while `write` is stalled on the blocker; asserts the purge waits at least 500 ms
 * (the writer holds the session lock until its insert commits), then releases the blocker.
 */
async function purgeWhileStalled(
  db: Kysely<DB>,
  run: { readonly userId: string; readonly sessionId: string; readonly runId: string },
  table: 'agent_cards' | 'agent_tool_calls',
  write: () => Promise<void>,
) {
  const port = createAgentDataPurge({ userHashKey: 'synthetic-b3-08y-lock-hash-key' });
  const blocker = blockOne(db, table, run);
  let writeSettled = false;
  let purgeSettled = false;
  let written: Promise<PromiseSettledResult<void>> | undefined;
  let purge: Promise<{ sessions: number; messages: number }> | undefined;
  try {
    await blocker.ready;
    const pending = write();
    const mark = (): void => {
      writeSettled = true;
    };
    pending.then(mark, mark);
    written = Promise.allSettled([pending]).then((all) => all[0]!);
    await until(
      'the write waits on the blocking row (session checked, transaction open)',
      async () => writeSettled || (await lockWaiters(db)) >= 1,
    );
    expect(writeSettled, 'the write is stalled on its INSERT').toBe(false);

    purge = db
      .transaction()
      .execute((trx) =>
        port.purgeAgentDataForUser(trx, { appId: APP, userId: run.userId, at: AT }),
      );
    const markPurge = (): void => {
      purgeSettled = true;
    };
    purge.then(markPurge, markPurge);
    await pause(500);
    expect(purgeSettled, 'the purge waits for the session lock the stalled write holds').toBe(
      false,
    );
    expect(writeSettled, 'the write is still stalled').toBe(false);

    blocker.release();
    expect(await blocker.done, 'the blocking transaction rolled back').toBe('rolled back');
    expect((await written).status, 'the write completes').toBe('fulfilled');
    expect((await purge).sessions, 'the purge detached the session without error').toBe(1);
  } finally {
    blocker.release();
    await blocker.done;
    if (written !== undefined) await written;
    if (purge !== undefined) await purge.catch(() => undefined);
  }
}

it('[AC-B3-08y#6][BR-AI-22] B3-08y spec-test r2 S1 ①：只卡 agent_tool_calls 的冲突键、只调 recordToolCalls：注销清理一直等到写者事务提交（≥500ms），放行后 args 为 NULL、库里无明文，会话与 run 骨架保留', async () => {
  const db = pool!;
  const run = await memberRun(db);
  const writer = createPgAgentTraceWriter({ db, newId: randomUUID });
  await purgeWhileStalled(db, run, 'agent_tool_calls', () =>
    writer.recordToolCalls(APP, run.runId, [toolCall(1)]),
  );
  const rows = await sql<{ seq: number; args: unknown }>`SELECT seq, args
    FROM app.agent_tool_calls WHERE run_id = ${run.runId}`.execute(db);
  expect(rows.rows.map((row) => row.seq)).toEqual([1]);
  expect(rows.rows[0]?.args, 'tool arguments cleared').toBeNull();
  expect(JSON.stringify(rows.rows)).not.toContain(SECRET);
  await expectSkeletonKept(db, run);
}, 120_000);

it('[AC-B3-08y#6][BR-AI-22] B3-08y spec-test r2 S1 ②：只卡 agent_cards 的冲突键、只调 recordCards：注销清理一直等到写者事务提交（≥500ms），放行后 data 为 {}、fallback_text 为占位文本、库里无明文，会话与 run 骨架保留', async () => {
  const db = pool!;
  const run = await memberRun(db);
  const writer = createPgAgentTraceWriter({ db, newId: randomUUID });
  await purgeWhileStalled(db, run, 'agent_cards', () =>
    writer.recordCards(APP, run.sessionId, run.runId, [notice('c1')]),
  );
  const rows = await sql<{ card_id: string; data: unknown; fallback_text: string }>`SELECT
      card_id, data, fallback_text FROM app.agent_cards
    WHERE session_id = ${run.sessionId}`.execute(db);
  expect(rows.rows.map((row) => row.card_id)).toEqual(['c1']);
  expect(rows.rows[0]?.data, 'card data cleared').toEqual({});
  expect(rows.rows[0]?.fallback_text, 'the placeholder').toBe(purgedCardText());
  expect(JSON.stringify(rows.rows)).not.toContain(SECRET);
  await expectSkeletonKept(db, run);
}, 120_000);
