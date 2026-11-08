// B3-08w · BR-AI-01 细则「判定顺序」②「承接上文的订单按 order_query」③ identity first; BR-AI-20;
// BR-AI-19. The production stream entry of [AC-B3-08g] / [AC-B3-08q] over real PG, a guest caller,
// the model scripted (../trace-persist/kit.ts productionRig). The first run's agent_runs.intent is
// set by the test (B3-08t writes it in production); the second run asks 「那返了吗」 and the model
// ends with {"agent_intent":"earnings_query"}. A guest sees which intent was kept: order_query →
// agent.need_login, earnings_query → agent.earnings.need_login (both auth_required(login)).
// The runtime's clock is manual: nextTurn() moves it between every two turns, so each run is
// accepted strictly after the one before (the contract's "earlier" is strict). Contract in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEVEL, openSession, usePgEach } from '../stream-mount/kit.ts';
import { ask, runIdOf } from '../trace-persist/kit.ts';
import {
  ASK,
  EARNINGS_LOGIN,
  OPENER,
  OPENER_2,
  ORDER_LOGIN,
  PREVIOUS_INTENT_WARN,
  expectLogin,
  guestRig,
  nextTurn,
  setIntent,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08w#12][BR-AI-01] 游客：上一轮 intent=order_query，本轮「那返了吗」（模型给 earnings_query）→ 承接订单：auth_required(login)，文案 agent.need_login；读取以本 run 的 app / 会话 / run 问一次，答 order_query', async () => {
  const { x, reader } = await guestRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, OPENER);
    await setIntent(pg.db, runIdOf(first), 'order_query');

    await nextTurn(x);
    const frames = await ask(x, x.f.caller, sessionId, ASK);
    const runId = runIdOf(frames);
    expectLogin(frames, ORDER_LOGIN);
    expect(reader.of(runId)).toEqual([
      { query: { appId: x.appId, sessionId, runId }, answer: 'order_query' },
    ]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08w#13][BR-AI-01] 游客：上一轮 intent=earnings_query → 本轮「那返了吗」仍按查收益：auth_required(login)，文案 agent.earnings.need_login；读取答 earnings_query', async () => {
  const { x, reader } = await guestRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, OPENER);
    await setIntent(pg.db, runIdOf(first), 'earnings_query');

    await nextTurn(x);
    const frames = await ask(x, x.f.caller, sessionId, ASK);
    const runId = runIdOf(frames);
    expect(reader.of(runId)).toEqual([
      { query: { appId: x.appId, sessionId, runId }, answer: 'earnings_query' },
    ]);
    expectLogin(frames, EARNINGS_LOGIN);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it.each(['search', 'page_guide', 'rule_qa', null] as const)(
  '[AC-B3-08w#14][BR-AI-01] 游客：上一轮 intent=%s（不是本人查询）→ 读取答 null，本轮「那返了吗」按查收益：agent.earnings.need_login',
  async (intent) => {
    const { x, reader } = await guestRig(pg.db);
    try {
      const sessionId = await openSession(x.r, x.f.caller);
      const first = await ask(x, x.f.caller, sessionId, OPENER);
      await setIntent(pg.db, runIdOf(first), intent);

      await nextTurn(x);
      const frames = await ask(x, x.f.caller, sessionId, ASK);
      const runId = runIdOf(frames);
      expect(reader.of(runId)).toEqual([
        { query: { appId: x.appId, sessionId, runId }, answer: null },
      ]);
      expectLogin(frames, EARNINGS_LOGIN);
    } finally {
      await x.r.runtime.close();
    }
  },
  120_000,
);

it('[AC-B3-08w#15][BR-AI-01] 不往前跳：order_query 之后隔了一轮 search，第三轮「那返了吗」→ 读取答 null，按查收益：agent.earnings.need_login', async () => {
  const { x, reader } = await guestRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, OPENER);
    await setIntent(pg.db, runIdOf(first), 'order_query');
    await nextTurn(x);
    const second = await ask(x, x.f.caller, sessionId, OPENER_2);
    await setIntent(pg.db, runIdOf(second), 'search');

    await nextTurn(x);
    const frames = await ask(x, x.f.caller, sessionId, ASK);
    const runId = runIdOf(frames);
    expect(reader.of(runId)).toEqual([
      { query: { appId: x.appId, sessionId, runId }, answer: null },
    ]);
    expectLogin(frames, EARNINGS_LOGIN);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08w#16][BR-AI-20] 别的会话不算：会话 A 上一轮 order_query，同一游客新会话 B 的第一句「那返了吗」→ 读取以会话 B 问、答 null，按查收益：agent.earnings.need_login', async () => {
  const { x, reader } = await guestRig(pg.db);
  try {
    const sessionA = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionA, OPENER);
    await setIntent(pg.db, runIdOf(first), 'order_query');

    await nextTurn(x);
    const sessionB = await openSession(x.r, x.f.caller);
    expect(sessionB, 'a new session (A already has a run)').not.toBe(sessionA);
    const frames = await ask(x, x.f.caller, sessionB, ASK);
    const runId = runIdOf(frames);
    expect(reader.of(runId)).toEqual([
      { query: { appId: x.appId, sessionId: sessionB, runId }, answer: null },
    ]);
    expectLogin(frames, EARNINGS_LOGIN);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08w#17][BR-AI-19] 读取出错：上一轮 order_query 但读取拒绝 → 只记一条 warn（run_id，不含用户原文），本轮照常完成并按查收益：auth_required(login)，agent.earnings.need_login', async () => {
  const { x, reader } = await guestRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, OPENER);
    await setIntent(pg.db, runIdOf(first), 'order_query');
    expect(x.f.logs.of(PREVIOUS_INTENT_WARN), 'no warn before').toEqual([]);

    reader.fail();
    await nextTurn(x);
    const frames = await ask(x, x.f.caller, sessionId, ASK);
    const runId = runIdOf(frames);
    expect(reader.of(runId)).toEqual([
      { query: { appId: x.appId, sessionId, runId }, answer: 'rejected' },
    ]);
    const lines = x.f.logs.of(PREVIOUS_INTENT_WARN);
    expect(lines, 'one warn line').toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: LEVEL.warn, run_id: runId });
    expect(JSON.stringify(lines[0]), 'no user text in the warn line').not.toContain(ASK);
    expectLogin(frames, EARNINGS_LOGIN);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
