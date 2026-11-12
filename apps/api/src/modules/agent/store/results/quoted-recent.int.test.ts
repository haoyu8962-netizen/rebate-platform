// B3-05p · BR-AI-18 细则「比较与适用性的提示」(「或最近对话里的报价卡」): the PG store's quotedRecently
// — the session's latest `turns` runs (agent_runs, accepted_at desc), the asking run excluded, same
// app and session only; the same semantics as the memory store (orchestrator/results/store.ts).
// Real PG through the shared test-database fixture (apps/api integration config); synthetic rows.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DeliveredProduct } from '../../orchestrator/results/types.ts';
import { createPgResultSetStore } from './index.ts';

const APP = 'synthetic-b3-05p-quotes-app';
let database: TestDatabase | undefined;
let pool: Kysely<DB> | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);

afterAll(async () => {
  if (pool) await destroyDb(pool);
  if (database) await database.drop();
});

/** A guest session with `runs` runs accepted one minute apart (oldest first). */
async function seedSession(
  db: Kysely<DB>,
  runs: number,
  appId = APP,
): Promise<{ sessionId: string; runIds: string[] }> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const start = Date.parse('2026-11-01T00:00:00Z');
  const at = new Date(start);
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${appId}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${at})`.execute(db);
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${appId}, ${deviceId}, ${at}, ${at})`.execute(db);
  const runIds: string[] = [];
  for (let i = 0; i < runs; i += 1) {
    const runId = randomUUID();
    const accepted = new Date(start + i * 60_000);
    await sql`INSERT INTO app.agent_runs
      (id, app_id, session_id, accepted_at, quota_subjects, prompt_version, deadline_at)
      VALUES (${runId}, ${appId}, ${sessionId}, ${accepted}, ${['["device","synthetic-device"]']},
        'synthetic@1', ${accepted})`.execute(db);
    runIds.push(runId);
  }
  return { sessionId, runIds };
}

function quote(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: `tb:synthetic-${cardId}`,
    platform: 'taobao',
    final_price_fen: 1000,
    card: { type: 'rebate_quote', schema_version: 1, data: {}, fallback_text: '合成报价卡' },
  };
}

it('[B3-05p][BR-AI-18] 本会话最近 turns 轮内的报价卡算，更早的不算；正在问的这一轮与 turns=0 不算', async () => {
  const db = pool!;
  const store = createPgResultSetStore({ db });
  // run 0 quoted; runs 1–3 stored nothing; run 4 is the run asking.
  const { sessionId, runIds } = await seedSession(db, 5);
  await store.recordQuoted({ appId: APP, sessionId, runId: runIds[0]! }, [quote('c1')]);
  const asking = { appId: APP, sessionId, runId: runIds[4]! };
  expect(await store.quotedRecently(asking, 4)).toBe(true);
  expect(await store.quotedRecently(asking, 3)).toBe(false);
  expect(await store.quotedRecently(asking, 0)).toBe(false);
  // The asking run's own quote is not the recent conversation.
  const quoting = { appId: APP, sessionId, runId: runIds[0]! };
  expect(await store.quotedRecently(quoting, 8)).toBe(false);
  // Still outside 「第 N 个」.
  expect(await store.latestWithProducts(APP, sessionId)).toBeNull();
});

it('[B3-05p][BR-AI-18] 别的会话、别的应用的报价卡不算；非 UUID 会话直接为 false', async () => {
  const db = pool!;
  const store = createPgResultSetStore({ db });
  const quoted = await seedSession(db, 1);
  await store.recordQuoted({ appId: APP, sessionId: quoted.sessionId, runId: quoted.runIds[0]! }, [
    quote('c1'),
  ]);
  const other = await seedSession(db, 2);
  expect(
    await store.quotedRecently(
      { appId: APP, sessionId: other.sessionId, runId: other.runIds[1]! },
      8,
    ),
  ).toBe(false);
  expect(
    await store.quotedRecently(
      { appId: 'synthetic-b3-05p-other-app', sessionId: quoted.sessionId, runId: randomUUID() },
      8,
    ),
  ).toBe(false);
  expect(
    await store.quotedRecently({ appId: APP, sessionId: quoted.sessionId, runId: randomUUID() }, 8),
  ).toBe(true);
  expect(
    await store.quotedRecently({ appId: APP, sessionId: 'not-a-uuid', runId: 'not-a-uuid' }, 8),
  ).toBe(false);
});
