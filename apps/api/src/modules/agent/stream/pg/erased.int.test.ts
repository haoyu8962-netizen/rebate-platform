// B3-08zh (BR-AI-22 细则「立即删除的做法」, review r1 S2 ②), over real PostgreSQL: the account
// deletion purge detaches the session while its run is still going; the run then ends with an
// error frame carrying the user's search term (50302 with fallback_q). The terminal transaction
// stores final_event and end_draft without data.msg / data.fallback_q (JSON null, as the purge
// leaves them), the rest as usual; the reply is not written back. RunManager on createPgRunPorts
// (the live tail). Synthetic values only; the scheduler never fires on its own.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { Scheduler } from '../../../platform/index.ts';
import { createAgentDataPurge } from '../../deletion/index.ts';
import type { AdmissionLimits, RedactedText } from '../admission/index.ts';
import { createRunManager, runConfigDefaults } from '../run/index.ts';
import type { RunBody, RunSink } from '../run/index.ts';
import { redactedStored } from './frames.ts';
import { createPgRunPorts } from './index.ts';

const APP = 'couli';
const START = '2026-10-06T10:00:00+08:00';
const SECRET = '合成用户搜索词';
const LIMITS: AdmissionLimits = {
  memberDaily: 100,
  guestDaily: 100,
  guestIpDaily: 100,
  perMinute: 100,
  maxRounds: 100,
};

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

function db(): Kysely<DB> {
  if (pool === undefined) throw new Error('database not ready');
  return pool;
}

/** A member's session (user row, device) started 1 s before START. */
async function memberSession(): Promise<{ userId: string; sessionId: string }> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const at = new Date(Date.parse(START) - 1_000);
  const code = randomUUID().replaceAll('-', '').slice(0, 12);
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method)
    VALUES (${userId}, ${APP}, '合成用户', 'synthetic-avatar', ${`i${code}`}, ${`a${code}`},
      'normal', 'phone')`.execute(db());
  await sql`INSERT INTO app.devices
    (id, app_id, install_secret_cipher, device_hash, id_source, platform, app_version, last_seen_at)
    VALUES (${deviceId}, ${APP}, ${Buffer.from('synthetic-install-secret')},
      ${deviceId.replaceAll('-', '').repeat(2)}, 'idfv', 'ios', 'synthetic@1', ${at})`.execute(
    db(),
  );
  await sql`INSERT INTO app.agent_sessions
    (id, app_id, user_id, device_id, started_at, last_active_at)
    VALUES (${sessionId}, ${APP}, ${userId}, ${deviceId}, ${at}, ${at})`.execute(db());
  return { userId, sessionId };
}

/** Waits never end on their own; only an abort rejects them. */
const idle: Scheduler = {
  now: () => 0,
  sleep: (_ms, signal) =>
    new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
};

class Client implements RunSink {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  onClose(): void {
    // The client stays.
  }
}

function rig() {
  const clock = new FixedClock(START);
  const ports = createPgRunPorts({
    db: db(),
    clock,
    timings: { runMaxMs: 20_000, lockGraceMs: 30_000, cancelPgPollMs: 2_000 },
    limits: { current: () => Promise.resolve({ ...LIMITS }) },
    texts: { errorMsg: (code) => `错误提示-${String(code)}` },
  });
  let next = 1;
  const manager = createRunManager({
    admission: ports.admission,
    registry: ports.registry,
    cards: {
      reserve: (_sessionId, count) => {
        const first = next;
        next += count;
        return Promise.resolve(first);
      },
    },
    texts: { text: () => '本轮超时', errorMsg: (code) => `错误提示-${String(code)}` },
    guard: { check: () => Promise.resolve(null) },
    clock,
    scheduler: idle,
    config: runConfigDefaults(),
  });
  return { ports, manager, clock };
}

async function round(
  x: ReturnType<typeof rig>,
  member: { userId: string; sessionId: string },
  body: RunBody,
) {
  const assistantMessageId = randomUUID();
  const runId = randomUUID();
  const text = '合成提问' as RedactedText;
  const admitted = await x.ports.admission.admit(
    {
      sessionId: member.sessionId,
      clientMsgId: `m-${randomUUID()}`,
      runId,
      messageId: randomUUID(),
      subject: { tier: 'member', userId: member.userId },
      reply: {
        assistantMessageId,
        promptVersion: 'synthetic-prompt@1',
        modelSnapshot: null,
        runUserText: text,
        messageText: text,
      },
    },
    LIMITS,
  );
  if (admitted.kind !== 'accepted') throw new Error(`not accepted: ${admitted.kind}`);
  const client = new Client();
  const final = await x.manager.start(
    {
      ticket: admitted.ticket,
      ownerKey: `u:${member.userId}`,
      limits: LIMITS,
      meta: {
        message_id: assistantMessageId,
        prompt_version: 'synthetic-prompt@1',
        model_label: '演示模型',
        ai_label: '内容由 AI 生成，仅供参考',
      },
      sink: client,
    },
    body,
  );
  return { runId, final, client };
}

it('[AC-B3-08zh#4][BR-AI-22] redactedStored：data.msg / data.fallback_q 有则置 null，不新增键，其余照旧', () => {
  expect(
    redactedStored({
      type: 'error',
      data: { code: 50302, msg: '提示', retryable: true, fallback: 'search_page', fallback_q: 'q' },
    }),
  ).toEqual({
    type: 'error',
    data: { code: 50302, msg: null, retryable: true, fallback: 'search_page', fallback_q: null },
  });
  expect(redactedStored({ type: 'done', data: { finish_reason: 'stop', quota_left: 3 } })).toEqual({
    type: 'done',
    data: { finish_reason: 'stop', quota_left: 3 },
  });
});

it('[AC-B3-08zh#4][BR-AI-22] run 进行中被注销清理、之后以 50302（带 fallback_q）收尾：final_event 与 end_draft 的 msg、fallback_q 为 null，其余照常；回复文字不回写', async () => {
  const x = rig();
  const member = await memberSession();
  const purge = createAgentDataPurge({
    userHashKey: ['synthetic', 'b3-08zh', 'erased'].join('-'),
  });
  const { runId, final } = await round(x, member, async (ctx) => {
    ctx.text('合成回答正文');
    const out = await db()
      .transaction()
      .execute((trx) =>
        purge.purgeAgentDataForUser(trx, { appId: APP, userId: member.userId, at: x.clock.now() }),
      );
    expect(out.sessions).toBe(1);
    return {
      kind: 'error',
      error: {
        code: 50302,
        msg: '错误提示-50302',
        retryable: true,
        fallback: 'search_page',
        fallback_q: SECRET,
      },
    };
  });
  expect(final.terminal?.event).toBe('error');
  const rows = await sql<{
    final_event: unknown;
    end_draft: unknown;
    finish_reason: string | null;
    settle_result: string | null;
  }>`SELECT final_event, end_draft, finish_reason, settle_result FROM app.agent_runs
    WHERE id = ${runId}`.execute(db());
  const row = rows.rows[0];
  expect(row?.final_event).toEqual({
    type: 'error',
    data: { code: 50302, msg: null, retryable: true, fallback: 'search_page', fallback_q: null },
  });
  expect(row?.end_draft).toEqual({
    type: 'error',
    data: { code: 50302, msg: null, retryable: true, fallback: 'search_page', fallback_q: null },
  });
  expect(row?.finish_reason).toBe('error');
  expect(row?.settle_result).not.toBeNull();
  const messages = await sql<{ text: string | null }>`SELECT text FROM app.agent_messages
    WHERE run_id = ${runId} AND role = 'assistant'`.execute(db());
  expect(messages.rows).toEqual([{ text: null }]);
  expect(JSON.stringify(rows.rows)).not.toContain(SECRET);
}, 120_000);
