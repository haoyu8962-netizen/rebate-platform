// B3-08zc · listAgentSessionMessages (GET /v1/agent/sessions/{id}/messages; 04 §6.5; BR-AI-19 细则
// 「助手回复落库」, BR-AI-20): the owner reads a session's messages oldest first — per turn the user
// message as stored (the BR-AI-14 storage form, never the raw text) and the reply with its text and
// cards as framed — from committed rows, through a read side of its own
// (createAgentHistoryRuntime on another pool). An expired session is still read by its owner
// (data.expired = true). Production stream entry of [AC-B3-08g] over real PG; contract in
// ../reply-persist/kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgentRedactor } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, sessionRow, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  demoUrl,
  finishOf,
  productionRig,
  runIdOf,
} from '../trace-persist/kit.ts';
import {
  assistantItemOf,
  expectHistory,
  expectReplyStored,
  held,
  heldRun,
  historySide,
  listHistory,
  messageRowOf,
  timeOf,
  timelessItems,
  userItemOf,
  waitAt,
} from '../reply-persist/kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** A synthetic long number (BR-AI-14: only its last four digits may be kept). */
const LONG_NUMBER = '3021987654321098';
const DAY_MS = 86_400_000;

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 历史接口：所有者按时间顺序读到每轮的用户消息与助手回复——用户文本是落库的脱敏形式（长数字只留后 4 位，不是原文），助手带文字与卡片（卡片同帧、无 seq），finish_reason 同终止帧；响应过契约 AgentHistoryResponse，expired=false、next_cursor=null', async () => {
  const x = await productionRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const searched = await ask(x, x.f.caller, sessionId, KEYWORD);
    expect(cardTypesOf(searched)).toEqual(['product_list']);
    await x.f.time.to(x.f.time.t + 1_000);
    const raw = `${KEYWORD} 订单号 ${LONG_NUMBER}`;
    const second = await ask(x, x.f.caller, sessionId, raw);
    await x.f.time.to(x.f.time.t + 1_000);
    const quoted = await ask(x, x.f.caller, sessionId, await demoUrl(x));
    expect(cardTypesOf(quoted)).toEqual(['rebate_quote']);

    // The user's message is stored redacted; the history gives that form back.
    const stored = await messageRowOf(pg.db, runIdOf(second), 'user');
    const redacted: string = await createAgentRedactor().redact(x.appId, raw);
    expect(stored.text, 'the stored user text').toBe(redacted);
    expect(redacted).not.toContain(LONG_NUMBER);
    expect(redacted).toContain(LONG_NUMBER.slice(-4));

    const history = await historySide(pg.pool(), x.f.time.clock);
    const { reply, caller } = await listHistory(history, x.f.caller, sessionId);
    const data = await expectHistory(reply, caller);
    expect(data.expired).toBe(false);
    expect(data.next_cursor).toBeNull();
    expect(timelessItems(data.items)).toEqual([
      await userItemOf(pg.db, runIdOf(searched)),
      await assistantItemOf(pg.db, searched),
      await userItemOf(pg.db, runIdOf(second)),
      await assistantItemOf(pg.db, second),
      await userItemOf(pg.db, runIdOf(quoted)),
      await assistantItemOf(pg.db, quoted),
    ]);
    expect(data.items[2]?.text).toBe(redacted);
    expect(JSON.stringify(data), 'the raw long number is nowhere').not.toContain(LONG_NUMBER);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 过期会话（last_active_at + 24 小时 ≤ now）：所有者仍得到 200 只读历史，data.expired=true，内容与过期前相同；差 1 毫秒时 expired=false', async () => {
  const x = await productionRig(pg.db);
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, KEYWORD);
    const lastActive = new Date(
      (await sessionRow(pg.db, sessionId))['last_active_at'] as string | Date,
    ).getTime();
    const expected = [
      await userItemOf(pg.db, runIdOf(frames)),
      await assistantItemOf(pg.db, frames),
    ];

    const justBefore = await historySide(
      pg.pool(),
      new FixedClock(new Date(lastActive + DAY_MS - 1)),
    );
    const early = await listHistory(justBefore, x.f.caller, sessionId);
    const live = await expectHistory(early.reply, early.caller);
    expect(live.expired).toBe(false);
    expect(timelessItems(live.items)).toEqual(expected);

    const atExpiry = await historySide(pg.pool(), new FixedClock(new Date(lastActive + DAY_MS)));
    const late = await listHistory(atExpiry, x.f.caller, sessionId);
    const expired = await expectHistory(late.reply, late.caller);
    expect(expired.expired).toBe(true);
    expect(timelessItems(expired.items)).toEqual(expected);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

const SEARCH_ASK = '帮我找合成保温杯';
/** How long the run goes on after its message was accepted (manual time; well within runMaxMs). */
const RUN_FOR_MS = 8_000;

it('[AC-B3-08zc#6][BR-AI-19][BR-AI-20] 过期从受理算起：消息受理后 run 又跑了 8 秒才结束——终态事务（同时写回复）不改 agent_sessions.last_active_at，仍是受理时的值；历史在「受理 + 24 小时 − 1 毫秒」expired=false、在「受理 + 24 小时」expired=true（不是从 run 结束算起）', async () => {
  const h = held();
  const scripts: Record<string, readonly Step[]> = {
    [SEARCH_ASK]: [
      {
        before: waitAt(h),
        text: LEAD,
        calls: [{ name: 'search_products', args: { q: KEYWORD } }],
      },
      { text: '好的。' },
    ],
  };
  const x = await productionRig(pg.db, { scripts });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const run = await heldRun(x, h, sessionId, SEARCH_ASK);
    const runId = runIdOf(run.frames());
    const accepted = timeOf((await sessionRow(pg.db, sessionId))['last_active_at']);
    const deadline = timeOf((await runRow(pg.db, runId))['deadline_at']);
    expect(
      deadline - x.f.time.clock.now().getTime(),
      'the run may go on for RUN_FOR_MS',
    ).toBeGreaterThan(2 * RUN_FOR_MS);
    await x.f.time.to(x.f.time.t + RUN_FOR_MS);

    const frames = await run.finish();
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['product_list']);
    const ended = timeOf((await runRow(pg.db, runId))['ended_at']);
    expect(ended, 'the run ended RUN_FOR_MS after acceptance').toBeGreaterThanOrEqual(
      accepted + RUN_FOR_MS,
    );
    await expectReplyStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    expect(
      timeOf((await sessionRow(pg.db, sessionId))['last_active_at']),
      'last_active_at is still the acceptance time',
    ).toBe(accepted);

    const before = await historySide(pg.pool(), new FixedClock(new Date(accepted + DAY_MS - 1)));
    const live = await listHistory(before, x.f.caller, sessionId);
    expect((await expectHistory(live.reply, live.caller)).expired).toBe(false);
    const at = await historySide(pg.pool(), new FixedClock(new Date(accepted + DAY_MS)));
    const late = await listHistory(at, x.f.caller, sessionId);
    const data = await expectHistory(late.reply, late.caller);
    expect(data.expired, 'expired 24 hours after acceptance, not after the run ended').toBe(true);
    expect(timelessItems(data.items)).toEqual([
      await userItemOf(pg.db, runId),
      await assistantItemOf(pg.db, frames),
    ]);
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}, 120_000);
