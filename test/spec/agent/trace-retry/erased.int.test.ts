// B3-08y · BR-AI-22 (注销后 Agent 数据处理, D10-175) × BR-AI-19 (24-hour local queue): a trace
// written again after the account deletion's purge (purgeAgentDataForUser) must not put plain
// tool arguments or card data back into a session already detached from its user. The writer
// (agent/store/results createPgAgentTraceWriter) locks the session row in its transaction and
// answers 'skipped' for a detached session, writing nothing; the queue drops such a run without a
// lost line; guests (no user_hash) are written as before. Real PG; contract: ./kit.ts header.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createPgAgentTraceWriter } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { createAgentDataPurge } from '../../../../apps/api/src/modules/agent/deletion/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import { insertRun, sessionOf } from '../stream-assembly-orders/kit.ts';
import {
  framesOf,
  message,
  newGuest,
  newMember,
  openAgent,
  openSession,
  send,
  until,
  usePgEach,
} from '../stream-mount/kit.ts';
import {
  KEYWORD,
  cardFramesOf,
  cardRowsOf,
  pause,
  runIdOf,
  toolCallRowsOf,
} from '../trace-persist/kit.ts';
import { HOUR, LEVEL, LOST, SKIPPED, WRITE_FAILED, notice, toolCall } from './kit.ts';
import {
  HASH_KEY,
  driveUntil,
  letTimePass,
  purgeUser,
  traceRig,
  uuid,
  type TraceRig,
} from './runtime-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const SEARCH_ASK = '帮我找合成保温杯';
const AT = new FixedClock('2026-12-01T00:00:00.000Z').now();

function searchScripts(): Record<string, readonly Step[]> {
  return {
    [SEARCH_ASK]: [
      { text: LEAD, calls: [{ name: 'search_products', args: { q: KEYWORD } }] },
      { text: '好的。' },
    ],
  };
}

async function ask(x: TraceRig, caller: AgentCaller, sessionId: string, text: string) {
  return framesOf((await send(x.r, caller, sessionId, message(text))).chunks);
}

async function firstFailure(x: TraceRig, runId: string): Promise<void> {
  await until(
    'the failing writer was reached for this run and warned',
    () =>
      x.writer.of(runId, 'throw').length > 0 &&
      x.logs.of(WRITE_FAILED).some((line) => line['run_id'] === runId),
  );
}

function userIdOf(caller: AgentCaller): string {
  expect(caller.userId, 'a member').toBeTypeOf('string');
  return caller.userId ?? '';
}

/** A member's session with one finished run, then the member's agent data purged (committed). */
async function erasedRun() {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  const sessionId = await sessionOf(pg.db, member);
  const runId = await insertRun(pg.db, sessionId);
  const purged = await purgeUser(pg.db, { appId: member.appId, userId: userIdOf(member), at: AT });
  expect(purged.sessions).toBe(1);
  return { appId: member.appId, sessionId, runId };
}

it('[AC-B3-08y#6][BR-AI-22][BR-AI-19] 首次写入失败后完成注销清理：队列再写时不写入任何 agent_cards / agent_tool_calls 行，不记 lost，记一条 info agent_trace_skipped_erased（run_id），之后不再写', async () => {
  const x = await traceRig(pg.db, { scripts: searchScripts() });
  try {
    x.writer.set('throw');
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, SEARCH_ASK);
    const cardIds = cardFramesOf(frames).map((frame) => String(frame.data['card_id']));
    expect(cardIds.length, 'the reply carried card frames').toBeGreaterThan(0);
    const runId = runIdOf(frames);
    // B3-08zc (BR-AI-19 细则「助手回复落库」): the cards were committed with the ending, before
    // any trace write and whatever the writer does — there at once (no polling), once each.
    const ending = (await cardRowsOf(pg.db, 'run_id', runId)).map((row) => row.card_id).sort();
    expect(ending, 'cards stored with the ending').toEqual([...cardIds].sort());
    await firstFailure(x, runId);

    const purged = await purgeUser(pg.db, {
      appId: x.appId,
      userId: userIdOf(x.f.caller),
      at: x.time.clock.now(),
    });
    expect(purged.sessions).toBeGreaterThanOrEqual(1);

    x.writer.set('pass');
    await driveUntil(
      x.time,
      'the queue wrote again after the purge and logged the skip',
      async () => ({
        again: x.writer.of(runId, 'pass').length,
        skipped: x.logs.of(SKIPPED).filter((line) => line['run_id'] === runId).length,
      }),
      (seen) => seen.again > 0 && seen.skipped > 0,
    );
    await pause(300);
    // The write again adds no agent_cards row: the run's rows are those of the ending, no more.
    const storedIds = async () =>
      (await cardRowsOf(pg.db, 'run_id', runId)).map((row) => row.card_id).sort();
    expect(await storedIds(), 'no card row added by the write again').toEqual(ending);
    expect(
      x.writer.of(runId).filter((call) => call.method === 'recordCards'),
      'cards never go through the trace writer or its queue',
    ).toEqual([]);
    expect(await toolCallRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    const skipped = x.logs.of(SKIPPED);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: LEVEL.info, run_id: runId });

    const calls = x.writer.of(runId).length;
    await letTimePass(x.time, HOUR);
    expect(x.writer.of(runId), 'not written again after the skip').toHaveLength(calls);
    expect(await storedIds(), 'still only the rows of the ending').toEqual(ending);
    expect(await toolCallRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    expect(x.logs.of(LOST)).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08y#6][BR-AI-22] 写者本身：会话已脱离用户时 recordCards / recordToolCalls 答 skipped、一行不写；游客会话与未注销会员会话照常写入', async () => {
  const erased = await erasedRun();
  const writer = createPgAgentTraceWriter({ db: pg.db, newId: uuid });

  expect(
    await writer.recordCards(erased.appId, erased.sessionId, erased.runId, [notice('c1')]),
  ).toBe('skipped');
  expect(await writer.recordToolCalls(erased.appId, erased.runId, [toolCall(1)])).toBe('skipped');
  expect(await cardRowsOf(pg.db, 'run_id', erased.runId)).toEqual([]);
  expect(await toolCallRowsOf(pg.db, 'run_id', erased.runId)).toEqual([]);

  for (const caller of [await newGuest(pg.db), await newMember(pg.db)]) {
    const sessionId = await sessionOf(pg.db, caller);
    const runId = await insertRun(pg.db, sessionId);
    const who = caller.userId === null ? 'guest' : 'member';
    expect(await writer.recordCards(caller.appId, sessionId, runId, [notice('c1')]), who).not.toBe(
      'skipped',
    );
    expect(await writer.recordToolCalls(caller.appId, runId, [toolCall(1)]), who).not.toBe(
      'skipped',
    );
    expect(
      (await cardRowsOf(pg.db, 'run_id', runId)).map((row) => row.card_id),
      who,
    ).toEqual(['c1']);
    expect(
      (await toolCallRowsOf(pg.db, 'run_id', runId)).map((row) => row.seq),
      who,
    ).toEqual([1]);
  }
}, 120_000);

it('[AC-B3-08y#6][BR-AI-22] 注销清理事务进行中（会话行已锁、未提交）时到达的写入：等清理提交后才判断，答 skipped，一行不写', async () => {
  await openAgent(pg.db);
  const member = await newMember(pg.db);
  const sessionId = await sessionOf(pg.db, member);
  const runId = await insertRun(pg.db, sessionId);
  const port = createAgentDataPurge({ userHashKey: HASH_KEY });
  const writer = createPgAgentTraceWriter({ db: pg.db, newId: uuid });

  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let purgedInTx!: () => void;
  const statementsDone = new Promise<void>((resolve) => {
    purgedInTx = resolve;
  });
  const purge = pg.db.transaction().execute(async (trx) => {
    const result = await port.purgeAgentDataForUser(trx, {
      appId: member.appId,
      userId: userIdOf(member),
      at: AT,
    });
    purgedInTx();
    await gate;
    return result;
  });
  try {
    await statementsDone;
    const cards = writer.recordCards(member.appId, sessionId, runId, [notice('c1')]);
    const calls = writer.recordToolCalls(member.appId, runId, [toolCall(1)]);
    let settled = 0;
    const mark = () => {
      settled += 1;
    };
    cards.then(mark, mark);
    calls.then(mark, mark);
    await pause(500);
    expect(settled, 'the writes wait for the purge transaction').toBe(0);

    commit();
    expect((await purge).sessions).toBe(1);
    expect(await cards).toBe('skipped');
    expect(await calls).toBe('skipped');
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    expect(await toolCallRowsOf(pg.db, 'run_id', runId)).toEqual([]);
  } finally {
    commit();
    await purge.catch(() => undefined);
  }
}, 120_000);
