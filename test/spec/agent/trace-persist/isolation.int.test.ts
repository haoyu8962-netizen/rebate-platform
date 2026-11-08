// B3-08q · BR-AI-19 / BR-AI-03: the trace of a run is written under that run's own app, session
// and run, taken from the server-side run context only: runs of two apps on one production stream
// runtime never write into each other's rows, and an app named in the model's arguments is refused
// by the registry and recorded under the caller's app. Production stream entry of [AC-B3-08g] over
// real PG; app.agent_rule_chunks rows per app; the model is scripted.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, MODEL_TEXT } from '../core-reply-templates/kit.ts';
import { insertChunk } from '../rule-search-wiring/kit.ts';
import {
  consent,
  newMember,
  openAgent,
  openSession,
  setConfig,
  usePgEach,
} from '../stream-mount/kit.ts';
import {
  ask,
  cardRowsOf,
  cardTypesOf,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  toolCallRowsOf,
  toolCallsOnce,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ASK_A = '提现最低多少';
const ASK_B = '提现多久到账';
const FORGED_ASK = '帮我查一下提现规则';

it('[AC-B3-08q#6][BR-AI-19][BR-AI-03] 同一生产 runtime 上 A、B 两个 app 各跑一个 search_rules run：卡与工具调用各落在本 app / 本会话 / 本 run 下，A 的 run 不写到 B，B 的也不写到 A', async () => {
  const appB = `synthetic-b3-08q-${randomUUID()}`;
  const x = await productionRig(pg.db, {
    scripts: {
      [ASK_A]: [
        { text: LEAD, calls: [{ name: 'search_rules', args: { question: ASK_A } }] },
        { text: MODEL_TEXT },
      ],
      [ASK_B]: [
        { text: LEAD, calls: [{ name: 'search_rules', args: { question: ASK_B } }] },
        { text: MODEL_TEXT },
      ],
    },
  });
  try {
    const memberB = await newMember(pg.db, { appId: appB });
    await openAgent(pg.db, appB);
    await consent(pg.db, memberB);
    await setConfig(pg.db, appB, 'agent.tools.search_rules.enabled', true);
    const chunkA = await insertChunk(pg.db, { appId: x.appId, title: ASK_A, text: ASK_A });
    const chunkB = await insertChunk(pg.db, { appId: appB, title: ASK_B, text: ASK_B });

    const sessionA = await openSession(x.r, x.f.caller);
    const sessionB = await openSession(x.r, memberB);
    const framesA = await ask(x, x.f.caller, sessionA, ASK_A);
    const framesB = await ask(x, memberB, sessionB, ASK_B);
    expect(cardTypesOf(framesA)).toEqual(['rule_ref']);
    expect(cardTypesOf(framesB)).toEqual(['rule_ref']);
    const runA = runIdOf(framesA);
    const runB = runIdOf(framesB);

    const rowsA = await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId: sessionA, runId: runA },
      framesA,
    );
    const rowsB = await expectCardsStored(
      pg.db,
      { appId: appB, sessionId: sessionB, runId: runB },
      framesB,
    );
    expect(rowsA.map((row) => (row.data as Row)['chunk_id'])).toEqual([chunkA.chunk_id]);
    expect(rowsB.map((row) => (row.data as Row)['chunk_id'])).toEqual([chunkB.chunk_id]);

    const callsA = await toolCallsOnce(pg.db, runA, 1);
    const callsB = await toolCallsOnce(pg.db, runB, 1);
    expect(callsA.map((call) => [call.app_id, call.name, call.status])).toEqual([
      [x.appId, 'search_rules', 'ok'],
    ]);
    expect(callsB.map((call) => [call.app_id, call.name, call.status])).toEqual([
      [appB, 'search_rules', 'ok'],
    ]);

    // Every row of app B belongs to B's session and run, and the other way round.
    const cardsOfB = await cardRowsOf(pg.db, 'app_id', appB);
    expect(cardsOfB.map((row) => [row.session_id, row.run_id])).toEqual(
      rowsB.map(() => [sessionB, runB]),
    );
    const cardsOfA = await cardRowsOf(pg.db, 'app_id', x.appId);
    expect(cardsOfA.every((row) => row.session_id === sessionA && row.run_id === runA)).toBe(true);
    expect((await toolCallRowsOf(pg.db, 'app_id', appB)).map((call) => call.run_id)).toEqual([
      runB,
    ]);
    expect((await toolCallRowsOf(pg.db, 'app_id', x.appId)).map((call) => call.run_id)).toEqual([
      runA,
    ]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#6][BR-AI-03][BR-AI-19] 模型参数里带 app_id = B：调用被拒（rejected），该调用记在调用者自己的 app 与 run 下，参数为 traceMask 结果；B app 名下没有任何卡或工具调用行', async () => {
  const appB = `synthetic-b3-08q-${randomUUID()}`;
  const forged = { question: FORGED_ASK, app_id: appB };
  const x = await productionRig(pg.db, {
    scripts: {
      [FORGED_ASK]: [
        { text: LEAD, calls: [{ name: 'search_rules', args: forged }] },
        { text: MODEL_TEXT },
      ],
    },
  });
  try {
    await insertChunk(pg.db, { appId: appB, title: FORGED_ASK, text: FORGED_ASK });
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, FORGED_ASK);
    expect(finishOf(frames), 'the reply ended').toBeTypeOf('string');
    expect(cardTypesOf(frames)).not.toContain('rule_ref');
    const runId = runIdOf(frames);

    const calls = await toolCallsOnce(pg.db, runId, 1);
    expect(calls.map((call) => [call.seq, call.app_id, call.name, call.status])).toEqual([
      [1, x.appId, 'search_rules', 'rejected'],
    ]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask(forged, {}));
    expect(await toolCallRowsOf(pg.db, 'app_id', appB)).toEqual([]);
    expect(await cardRowsOf(pg.db, 'app_id', appB)).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
