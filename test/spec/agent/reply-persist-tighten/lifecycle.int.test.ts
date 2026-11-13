// BR-AI-19：终态与回复同事务；BR-AI-05：只解析已提交卡片；BR-AI-22：清理后不得回填。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, ORDER_MODEL_TEXT, type Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, usePgEach } from '../stream-mount/kit.ts';
import { ask, cardRowsOf, cardTypesOf, productionRig, runIdOf } from '../trace-persist/kit.ts';
import {
  LIST_ASK,
  LIST_ARGS,
  EXPLAIN_ASK,
  cardIdsOf,
  expectAllOrNothing,
  withOrder,
} from '../reply-persist/kit.ts';
import { betweenReplyAndTerminal } from './fault.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zd#2][BR-AI-19] 回复与终态两组写操作之间持续故障：独立连接只能看到两者全有或全无，分两次提交会留下半截', async () => {
  const fault = betweenReplyAndTerminal(pg.db);
  const x = await productionRig(fault.db, {
    scripts: {
      [LIST_ASK]: [
        { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
        { text: ORDER_MODEL_TEXT },
      ],
    },
  });
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, LIST_ASK);
    expect(cardTypesOf(frames)).toEqual(['order_status']);
    expect(fault.failures(), '确实在两组写操作之间失败').toBeGreaterThan(0);
    const result = await expectAllOrNothing(
      pg.pool(),
      {
        appId: x.appId,
        sessionId,
        runId: runIdOf(frames),
      },
      frames,
    );
    expect(result, '持续故障不允许第二组写入完成').toBe('neither');
  } finally {
    fault.release();
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zd#3][BR-AI-19][BR-AI-05] 同一进程终态事务回滚：已发出的 card_id 在数据库和下一轮 explain_order 都不可引用', async () => {
  const fault = betweenReplyAndTerminal(pg.db);
  const scripts: Record<string, readonly Step[]> = {
    [LIST_ASK]: [
      { text: LEAD, calls: [{ name: 'list_my_orders', args: LIST_ARGS }] },
      { text: ORDER_MODEL_TEXT },
    ],
  };
  const x = await productionRig(fault.db, { scripts });
  try {
    withOrder(x);
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, LIST_ASK);
    const runId = runIdOf(first);
    const cardId = cardIdsOf(first)[0];
    expect(cardId).toBeTypeOf('string');
    expect(fault.failures()).toBeGreaterThan(0);
    expect((await runRow(pg.db, runId))['final_event']).toBeNull();
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    fault.release();
    await x.r.time.to(x.r.time.t + 60_000);
    scripts[EXPLAIN_ASK] = [
      { text: LEAD, calls: [{ name: 'explain_order', args: { card_id: cardId } }] },
      { text: ORDER_MODEL_TEXT },
    ];
    const next = await ask(x, x.f.caller, sessionId, EXPLAIN_ASK);
    expect(runIdOf(next)).not.toBe(runId);
    expect(x.complete?.mock.calls.some(([chat]) => chat.messages[0]?.content === EXPLAIN_ASK)).toBe(
      true,
    );
    expect(x.f.get).not.toHaveBeenCalled();
    expect(cardTypesOf(next)).not.toContain('order_status');
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
  } finally {
    fault.release();
    await x.r.runtime.close();
  }
}, 120_000);
