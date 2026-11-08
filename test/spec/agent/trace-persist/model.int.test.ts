// B3-08q · BR-AI-19 / BR-AI-14 on the model path of the production stream entry ([AC-B3-08g]'s
// ordersFixture → createProductionStreamAssembly → createAgentStreamRuntime, real PG): after a run
// the delivered cards are in app.agent_cards and the model's tool calls in app.agent_tool_calls,
// tool arguments masked by the runtime's traceMask before they are stored. The model is scripted
// (kit.ts scriptModel); everything else is what the runtime built.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD, MODEL_TEXT, ORDER_MODEL_TEXT } from '../core-reply-templates/kit.ts';
import { insertChunk } from '../rule-search-wiring/kit.ts';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardTypesOf,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  toolCallsOnce,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const SEARCH_ASK = '帮我找合成保温杯';
const RULE_ASK = '提现最低多少';
const ORDER_ASK = '我的订单返了吗';
const ORDER_NO = '3900112233445566778';
const PHONE = '13800138000';

it('[AC-B3-08q#1][BR-AI-19] 生产流装配·模型路径：一个 run 调 search_products 出 product_list，run 结束后 agent_cards 有该卡（card_id 与下发帧一致，app / session / run 正确），agent_tool_calls 有该调用（seq 1、search_products、ok、参数为 traceMask 结果）', async () => {
  const args = { q: KEYWORD };
  const x = await productionRig(pg.db, {
    scripts: {
      [SEARCH_ASK]: [
        { text: LEAD, calls: [{ name: 'search_products', args }] },
        { text: '好的。' },
      ],
    },
  });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, SEARCH_ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['product_list']);
    const runId = runIdOf(frames);

    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    const calls = await toolCallsOnce(pg.db, runId, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status, call.app_id])).toEqual([
      [1, 'search_products', 'ok', x.appId],
    ]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask(args, {}));
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#1][BR-AI-19] 生产流装配·模型路径：一个 run 调 search_rules（命中）出 rule_ref，agent_cards 有该卡、agent_tool_calls 有 search_rules / ok；模板替换后的文本不影响落库', async () => {
  const args = { question: RULE_ASK };
  const x = await productionRig(pg.db, {
    scripts: {
      [RULE_ASK]: [{ text: LEAD, calls: [{ name: 'search_rules', args }] }, { text: MODEL_TEXT }],
    },
  });
  try {
    const chunk = await insertChunk(pg.db, { appId: x.appId, title: RULE_ASK, text: RULE_ASK });
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, RULE_ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['rule_ref']);
    const runId = runIdOf(frames);

    const rows = await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    expect(rows.map((row) => (row.data as Record<string, unknown>)['chunk_id'])).toEqual([
      chunk.chunk_id,
    ]);
    const calls = await toolCallsOnce(pg.db, runId, 1);
    expect(calls.map((call) => [call.seq, call.name, call.status, call.app_id])).toEqual([
      [1, 'search_rules', 'ok', x.appId],
    ]);
    expect(calls[0]?.args).toEqual(x.r.runtime.traceMask(args, {}));
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#1][BR-AI-14][BR-AI-19] 工具参数落库前脱敏：explain_order 的单号、list_my_orders 关键词里的手机号不以明文进 agent_tool_calls.args；args 恰为运行时 traceMask 的结果，seq 按调用顺序 1、2', async () => {
  const explain = { order_no: ORDER_NO, platform: 'taobao' };
  const list = { date_from: '2026-10-01', date_to: '2026-10-06', keyword: PHONE };
  const x = await productionRig(pg.db, {
    scripts: {
      [ORDER_ASK]: [
        { text: LEAD, calls: [{ name: 'explain_order', args: explain }] },
        { calls: [{ name: 'list_my_orders', args: list }] },
        { text: ORDER_MODEL_TEXT },
      ],
    },
  });
  try {
    // The runtime's own masking hides both values (the oracle the stored args are held to).
    const masked = [x.r.runtime.traceMask(explain, {}), x.r.runtime.traceMask(list, {})];
    expect(JSON.stringify(masked)).not.toContain(ORDER_NO);
    expect(JSON.stringify(masked)).not.toContain(PHONE);

    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, ORDER_ASK);
    expect(finishOf(frames), 'the reply ended').toBeTypeOf('string');
    expect(x.f.findOwnByNumber).toHaveBeenCalledTimes(1);
    expect(x.f.searchForAgent).toHaveBeenCalledTimes(1);
    const runId = runIdOf(frames);

    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
    const calls = await toolCallsOnce(pg.db, runId, 2);
    expect(calls.map((call) => [call.seq, call.name, call.status, call.app_id])).toEqual([
      [1, 'explain_order', 'ok', x.appId],
      [2, 'list_my_orders', 'ok', x.appId],
    ]);
    expect(calls.map((call) => call.args)).toEqual(masked);
    const stored = JSON.stringify(calls);
    expect(stored).not.toContain(ORDER_NO);
    expect(stored).not.toContain(PHONE);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
