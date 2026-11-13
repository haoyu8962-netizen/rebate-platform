// B3-08zh (BR-AI-22 细则「立即删除的做法」, review r1 S2 ①; BR-AI-19 细则「助手回复落库」, BR-AI-05):
// the result writers of createPgResultSetStore against a session the deletion purge detached, also
// while that purge is committing, and findDelivered's committed-reply rule. Real PG through the
// shared test-database fixture (apps/api integration config). Synthetic values only.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAgentDataPurge } from '../../deletion/index.ts';
import type { DeliveredProduct } from '../../orchestrator/results/types.ts';
import { createPgResultSetStore } from './index.ts';

const APP = 'synthetic-b3-08zh-detached-app';
const SECRET = '合成用户搜索词';
const AT = new Date('2026-12-01T00:00:00.000Z');
const HASH_KEY = 'synthetic-b3-08zh-hash-key';

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

/** A session with one run: a member's (user row) or a guest's (device only). */
async function seedRun(db: Kysely<DB>, member: boolean) {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const code = randomUUID().replaceAll('-', '').slice(0, 12);
  if (member) {
    await sql`INSERT INTO app.users
      (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method)
      VALUES (${userId}, ${APP}, '合成用户', 'synthetic-avatar', ${`i${code}`}, ${`a${code}`},
        'normal', 'phone')`.execute(db);
  }
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${APP}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${AT})`.execute(db);
  await sql`INSERT INTO app.agent_sessions
    (id, app_id, user_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${APP}, ${member ? userId : null}, ${deviceId}, ${AT}, ${AT})`.execute(
    db,
  );
  const subject = member ? `["user","${userId}"]` : `["device","${deviceId}"]`;
  await sql`INSERT INTO app.agent_runs
    (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
    VALUES (${runId}, ${APP}, ${sessionId}, ${AT}, ${[subject]}, 'synthetic@1', ${AT})`.execute(db);
  return { userId, sessionId, runId };
}

function product(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: `jd:synthetic-${cardId}`,
    platform: 'jd',
    final_price_fen: 1990,
    card: {
      type: 'notice',
      schema_version: 1,
      data: { text_key: `synthetic.${cardId}`, q: SECRET },
      fallback_text: '合成卡片',
    },
  };
}

async function purge(db: Kysely<DB>, userId: string) {
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  return db
    .transaction()
    .execute((trx) => port.purgeAgentDataForUser(trx, { appId: APP, userId, at: AT }));
}

async function rowsOf(db: Kysely<DB>, run: { sessionId: string; runId: string }) {
  const sets = await sql`SELECT id FROM app.agent_result_sets
    WHERE app_id = ${APP} AND run_id = ${run.runId}`.execute(db);
  const deliveries = await sql`SELECT card_id FROM app.agent_result_deliveries
    WHERE app_id = ${APP} AND session_id = ${run.sessionId}`.execute(db);
  const chains = await sql`SELECT seq FROM app.agent_result_chains
    WHERE app_id = ${APP} AND session_id = ${run.sessionId}`.execute(db);
  return { sets: sets.rows.length, deliveries: deliveries.rows.length, chains: chains.rows.length };
}

async function writeAll(
  db: Kysely<DB>,
  run: { sessionId: string; runId: string },
  setId: string,
): Promise<void> {
  const store = createPgResultSetStore({ db });
  await store.save({
    id: setId,
    appId: APP,
    sessionId: run.sessionId,
    runId: run.runId,
    conditions: { q: SECRET, chain_id: 'synthetic-chain' },
  });
  await store.recordDelivered(setId, [product('c2')]);
  await store.recordQuoted({ appId: APP, sessionId: run.sessionId, runId: run.runId }, [
    product('c4'),
  ]);
  await store.appendChain(APP, run.sessionId, {
    chainId: 'synthetic-chain',
    status: 'has_products',
    conditions: { q: SECRET, chain_id: 'synthetic-chain' },
  });
}

it('[AC-B3-08zh#2][BR-AI-22] 会话已被注销清理脱离用户：save / recordDelivered / recordQuoted / appendChain 都不写；游客会话照常写', async () => {
  const db = pool!;
  const member = await seedRun(db, true);
  expect((await purge(db, member.userId)).sessions).toBe(1);
  await writeAll(db, member, randomUUID());
  expect(await rowsOf(db, member)).toEqual({ sets: 0, deliveries: 0, chains: 0 });

  const guest = await seedRun(db, false);
  await writeAll(db, guest, randomUUID());
  expect(await rowsOf(db, guest)).toEqual({ sets: 2, deliveries: 2, chains: 1 });
}, 120_000);

it('[AC-B3-08zh#2][BR-AI-22] 清理事务持有会话锁未提交时写结果集：写入等到清理提交，然后什么都不写（不是查完再插留下搜索词）', async () => {
  const db = pool!;
  const run = await seedRun(db, true);
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const purging = db.transaction().execute(async (trx) => {
    const out = await port.purgeAgentDataForUser(trx, { appId: APP, userId: run.userId, at: AT });
    locked();
    await gate;
    return out;
  });
  let settled = false;
  let writing: Promise<void> | undefined;
  try {
    await holding;
    writing = writeAll(db, run, randomUUID());
    const mark = (): void => {
      settled = true;
    };
    writing.then(mark, mark);
    await pause(500);
    expect(settled, 'the write waits for the purge holding the session lock').toBe(false);
  } finally {
    release();
  }
  expect((await purging).sessions).toBe(1);
  await writing;
  expect(await rowsOf(db, run)).toEqual({ sets: 0, deliveries: 0, chains: 0 });
}, 120_000);

it('[AC-B3-08zh#3][BR-AI-19][BR-AI-05] findDelivered：run 未结束（本轮）可解析；已结束且回复已提交可解析；已结束但回复未提交（终态回滚后由别的请求收尾）不解析', async () => {
  const db = pool!;
  const store = createPgResultSetStore({ db });
  const run = await seedRun(db, false);
  const setId = randomUUID();
  await store.save({
    id: setId,
    appId: APP,
    sessionId: run.sessionId,
    runId: run.runId,
    conditions: { q: '合成', chain_id: 'synthetic-chain' },
  });
  await store.recordDelivered(setId, [product('c2')]);
  await sql`INSERT INTO app.agent_messages (id, app_id, session_id, run_id, role, text)
    VALUES (${randomUUID()}, ${APP}, ${run.sessionId}, ${run.runId}, 'assistant', NULL)`.execute(
    db,
  );
  expect(await store.findDelivered(APP, run.sessionId, 'c2'), 'the run still going').toEqual(
    product('c2'),
  );
  await sql`UPDATE app.agent_runs SET end_reason = 'server_error', settle_result = 'counted',
    settled_at = ${AT},
    final_event = '{"type":"done","data":{"finish_reason":"error","quota_left":1}}'::jsonb,
    ended_at = ${AT}, finish_reason = 'error'
    WHERE app_id = ${APP} AND id = ${run.runId}`.execute(db);
  expect(await store.findDelivered(APP, run.sessionId, 'c2'), 'ended without its reply').toBeNull();

  const other = await seedRun(db, false);
  const otherSet = randomUUID();
  await store.save({
    id: otherSet,
    appId: APP,
    sessionId: other.sessionId,
    runId: other.runId,
    conditions: { q: '合成', chain_id: 'synthetic-chain' },
  });
  await store.recordDelivered(otherSet, [product('c3')]);
  await sql`INSERT INTO app.agent_messages (id, app_id, session_id, run_id, role, text)
    VALUES (${randomUUID()}, ${APP}, ${other.sessionId}, ${other.runId}, 'assistant', '')`.execute(
    db,
  );
  await sql`UPDATE app.agent_runs SET end_reason = 'stop', settle_result = 'counted',
    settled_at = ${AT},
    final_event = '{"type":"done","data":{"finish_reason":"stop","quota_left":1}}'::jsonb,
    ended_at = ${AT}, finish_reason = 'stop'
    WHERE app_id = ${APP} AND id = ${other.runId}`.execute(db);
  expect(await store.findDelivered(APP, other.sessionId, 'c3'), 'reply committed').toEqual(
    product('c3'),
  );
}, 120_000);
