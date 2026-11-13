// 2026-11-13 按编排 D10-1522 从 reply-persist-tighten/ 机械拆出（测试体逐字未改）。
// BR-AI-19：终态与回复同事务；BR-AI-05：只解析已提交卡片；BR-AI-22：清理后不得回填。
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, type Step } from '../core-reply-templates/kit.ts';
import { openSession, runRow, usePgEach } from '../stream-mount/kit.ts';
import {
  ask,
  cardFramesOf,
  cardRowsOf,
  cardTypesOf,
  productionRig,
  runIdOf,
} from '../trace-persist/kit.ts';
import { carded, held, heldRun, messageRowOf, waitAt } from '../reply-persist/kit.ts';
import { purgeUser } from '../trace-retry/runtime-kit.ts';
import { betweenReplyAndTerminal } from '../reply-persist-tighten/fault.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it('[AC-B3-08zd#3][BR-AI-19][BR-AI-05] 商品卡已发帧但终态回滚：同进程下一轮也不得通过提前写入的下发记录解析 card_id', async () => {
  const fault = betweenReplyAndTerminal(pg.db);
  const searchAsk = '帮我找合成保温杯';
  const referenceAsk = '引用上一轮合成商品';
  const scripts: Record<string, readonly Step[]> = {
    [searchAsk]: [
      { calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] },
      { text: '合成搜索结束。' },
    ],
  };
  const x = await productionRig(fault.db, { scripts });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, searchAsk);
    const list = cardFramesOf(first).find((card) => card.data['type'] === 'product_list');
    expect(list).toBeDefined();
    const data = list!.data['data'] as { items: { card_id: string }[] };
    expect(data.items).toBeInstanceOf(Array);
    const cardId = data.items[0]?.card_id;
    expect(cardId).toBeTypeOf('string');
    const runId = runIdOf(first);
    expect(fault.failures()).toBeGreaterThan(0);
    expect((await runRow(pg.db, runId))['final_event']).toBeNull();
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
    fault.release();
    await x.r.time.to(x.r.time.t + 60_000);
    x.f.readProduct.mockClear();
    scripts[referenceAsk] = [
      { calls: [{ name: 'get_rebate_quote', args: { card_id: cardId } }] },
      { text: '合成引用结束。' },
    ];
    const next = await ask(x, x.f.caller, sessionId, referenceAsk);
    expect(runIdOf(next)).not.toBe(runId);
    expect(
      x.complete?.mock.calls.some(([chat]) => chat.messages[0]?.content === referenceAsk),
    ).toBe(true);
    expect(x.f.readProduct, '未提交卡片不能解析成商品').not.toHaveBeenCalled();
    expect(cardTypesOf(next)).not.toContain('rebate_quote');
    expect(await cardRowsOf(pg.db, 'run_id', runId)).toEqual([]);
  } finally {
    fault.release();
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08zd#4][BR-AI-22] run 进行中清理账号，断线后继续收尾：已有自由文本保持清空，不新增卡片和下发记录', async () => {
  const h = held();
  const askText = '帮我找合成保温杯';
  const x = await productionRig(pg.db, {
    scripts: {
      [askText]: [
        { text: LEAD, calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] },
        {
          before: waitAt(h),
          text: '继续查找合成保温杯',
          calls: [{ name: 'search_products', args: { q: '合成水杯' } }],
        },
        { text: '这是合成结论。' },
      ],
    },
  });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const running = await heldRun(x, h, sessionId, askText, carded);
    const runId = runIdOf(running.frames());
    const purged = await purgeUser(pg.db, {
      appId: x.appId,
      userId: x.f.caller.userId!,
      at: x.r.time.clock.now(),
    });
    expect(purged.sessions).toBe(1);
    const snapshot = async () => ({
      cards: await cardRowsOf(pg.db, 'run_id', runId),
      deliveries: (
        await sql`SELECT * FROM app.agent_result_deliveries WHERE session_id = ${sessionId}::uuid ORDER BY card_id`.execute(
          pg.db,
        )
      ).rows,
    });
    const cleaned = await snapshot();
    expect(cleaned.deliveries.length, '清理前确实有商品下发记录').toBeGreaterThan(0);
    running.reply.close();
    await running.finish();
    expect((await runRow(pg.db, runId))['final_event']).not.toBeNull();
    expect((await messageRowOf(pg.db, runId, 'assistant')).text ?? '').toBe('');
    expect((await messageRowOf(pg.db, runId, 'assistant')).card_ids).toEqual([]);
    expect((await messageRowOf(pg.db, runId, 'user')).text ?? '').toBe('');
    expect((await runRow(pg.db, runId))['user_text'] ?? '').toBe('');
    expect(await snapshot()).toEqual(cleaned);
    const sets = await pg.db
      .selectFrom('agent_result_sets')
      .select('conditions')
      .where('run_id', '=', runId)
      .execute();
    for (const set of sets) expect(set.conditions).toEqual({});
    const chains = await pg.db
      .selectFrom('agent_result_chains')
      .select(['chain_id', 'conditions'])
      .where('session_id', '=', sessionId)
      .execute();
    for (const chain of chains) {
      if (chain.conditions !== null) expect(chain.conditions).toEqual({ chain_id: chain.chain_id });
    }
  } finally {
    h.gate.open();
    await x.r.runtime.close();
  }
}, 120_000);
