// B3-08ze (3) · a member's session after the account deletion cleanup is no guest's (BR-AI-20;
// BR-AI-22; B3-08zd (8) merged here, D10-1347). The member opens a session on device D through the
// real stream entry and runs one turn; the deletion cleanup's agent step — the very function
// app.module's agentDeletionCleanup assembles for identity's cleanup round (agent's
// purgeAgentDataForUser under the configured user hash key), on a transaction of its own as the
// cleanup runs it — detaches the session (user_id NULL, user_hash written, device_id D kept). A
// guest of D afterwards (no token, X-Device-Id D, device-level AI consent) does not get it from
// getCurrentAgentSession, cannot send to it (30504, no run) and cannot read its history (30504).
// Guest ownership is a session that never had a user: user_id NULL alone, on the same device, is
// not enough.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { DeletionCleanupStep } from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  Logs,
  agentSnapshot,
  consent,
  newMember,
  openAgent,
  runsOf,
  sessionRow,
  usePgEach,
} from '../stream-mount/kit.ts';
import {
  createSession,
  expectHistoryRefused,
  guestClient,
  historyUrl,
  json,
  memberClient,
  sendTurn,
  startClock,
  streamApp,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** Synthetic agent user hash key of this test's configuration. */
const HASH_KEY = 'synthetic-b3-08ze-agent-user-hash-key';

/** The agent step of the deletion cleanup as app.module assembles it from the configuration. */
async function agentCleanupStep(): Promise<DeletionCleanupStep> {
  // Dynamic, as test/spec/agent/deletion-wiring/wiring.test.ts loads it (decorated sources).
  const appModule = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as {
    agentDeletionCleanup(config: AppConfig, logger: RootLogger, database: unknown): unknown;
  };
  const config = loadConfig({ APP_ENV: 'test', AGENT_USER_HASH_KEY: HASH_KEY });
  const port = appModule.agentDeletionCleanup(config, new Logs().logger, pg.db);
  expect(typeof port, 'with the key the agent cleanup step is a function').toBe('function');
  return port as DeletionCleanupStep;
}

it('[AC-B3-08ze#3][BR-AI-20][BR-AI-22] 注销后同设备游客：会员在设备 D 开会话并跑一轮，注销清理（agent 清理步骤）后会话 user_id 为空、user_hash 已写、device_id 仍为 D；D 上不带 token 的游客（设备级已同意）——sessions/current 不返回该会话，向它发消息 30504 且不建 run，读它的历史 30504（无 data）', async () => {
  const clock = startClock();
  const member = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, member);
  // The same device D without an access token: a guest of D, with its own device-level consent.
  const guestOnD: AgentCaller = { ...member, userId: null, phoneBound: false };
  await consent(pg.db, guestOnD);
  const step = await agentCleanupStep();
  const app = await streamApp(pg.db, clock);
  try {
    const call = await memberClient(app, pg.db, clock, member);
    const sessionId = await createSession(call);
    await sendTurn(call, sessionId, '帮我找个保温杯');
    expect(await runsOf(pg.db, sessionId)).toHaveLength(1);

    clock.advanceMs(60_000);
    const purge = { appId: member.appId, userId: member.userId!, at: clock.now() };
    await pg.db.transaction().execute((trx) => step(trx, purge));
    const detached = await sessionRow(pg.db, sessionId);
    expect(detached['user_id'], 'detached from the account').toBeNull();
    expect(String(detached['user_hash']), 'user_hash written').toMatch(/^[0-9a-f]{64}$/u);
    expect(detached['device_id'], 'device kept').toBe(member.deviceId);

    const guest = guestClient(app, guestOnD);
    const current = await guest('GET', '/v1/agent/sessions/current');
    expect(current.response.statusCode, current.response.body).toBe(200);
    const currentBody = json(current.response);
    expect(currentBody['code'], current.response.body).toBe(0);
    expect(
      (currentBody['data'] as Row)['session'],
      'the deleted member’s session is not the guest’s current session',
    ).toBeNull();

    const before = await agentSnapshot(pg.db);
    const sent = await guest('POST', `/v1/agent/sessions/${sessionId}/messages`, {
      client_msg_id: randomUUID(),
      text: '刚才说到哪了',
    });
    expect(json(sent.response)['code'], sent.response.body).toBe(30504);
    expect(await runsOf(pg.db, sessionId), 'no run on the detached session').toHaveLength(1);
    expect(await agentSnapshot(pg.db), 'the refused message writes nothing').toBe(before);

    await expectHistoryRefused(await guest('GET', historyUrl(sessionId)), 30504);
  } finally {
    await app.close();
  }
}, 120_000);
