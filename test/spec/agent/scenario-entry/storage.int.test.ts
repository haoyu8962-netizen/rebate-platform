// B3-05q · BR-AI-01 细则「情境入口」on the real stream runtime and PostgreSQL (B3-03j's fixture:
// production assembly, synthetic product ports, the fixed no-model route): the entry card of a
// context.product_key message is written like a link message's card (agent_cards), and a message
// carrying context.text leaves no trace of the clipboard text in any stored row of the round
// (agent_messages, agent_runs, agent_tool_calls, agent_cards, agent_result_sets) nor in its frames.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { framesOf, message, openSession, send, usePgEach, type Row } from '../stream-mount/kit.ts';
import { fixture } from '../stream-assembly/kit.ts';
import { serialized } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const CLIPBOARD = '合成剪贴板原文-请勿落库-Q7X';
/** The product of B3-03j's synthetic catalog (its readProduct answers with it). */
const ENTRY_KEY = 'tb:synthetic-cup';

it('[AC-B3-05q#18][BR-AI-01][BR-AI-19] 真实 stream runtime + PG：context.product_key 的入口报价卡照常下发并落库、不改做关键词搜索；带 context.text 的消息在本轮任何落库行与帧里都没有剪贴板原文', async () => {
  const f = await fixture(pg.db);
  const r = f.mount(f.build());
  try {
    const sessionId = await openSession(r, f.caller);

    const entry = framesOf(
      (
        await send(r, f.caller, sessionId, {
          ...message('这个值得买吗'),
          context: { product_key: ENTRY_KEY },
        })
      ).chunks,
    );
    const quotes = entry.filter(
      (frame) => frame.event === 'card' && frame.data['type'] === 'rebate_quote',
    );
    expect(quotes).toHaveLength(1);
    expect((quotes[0]?.data['data'] as Row | undefined)?.['product']).toMatchObject({
      product_key: ENTRY_KEY,
    });
    expect(f.readProduct).toHaveBeenCalledTimes(1);
    expect(f.readProduct.mock.calls[0]?.[0]).toBe(ENTRY_KEY);
    expect(f.searchProducts).not.toHaveBeenCalled();
    expect(entry.at(-1)?.data['finish_reason']).toBe('stop');
    const stored = await pg.db.selectFrom('agent_cards').select(['type']).execute();
    expect(stored.map((row) => row.type)).toEqual(['rebate_quote']);

    const clipped = framesOf(
      (
        await send(r, f.caller, sessionId, {
          ...message('保温杯'),
          context: { text: CLIPBOARD },
        })
      ).chunks,
    );
    expect(clipped.at(-1)?.event).toBe('done');
    expect(serialized(clipped)).not.toContain(CLIPBOARD);
    const rows = {
      agent_messages: await pg.db.selectFrom('agent_messages').selectAll().execute(),
      agent_runs: await pg.db.selectFrom('agent_runs').selectAll().execute(),
      agent_tool_calls: await pg.db.selectFrom('agent_tool_calls').selectAll().execute(),
      agent_cards: await pg.db.selectFrom('agent_cards').selectAll().execute(),
      agent_result_sets: await pg.db.selectFrom('agent_result_sets').selectAll().execute(),
    };
    // Both rounds were stored (so the scan below reads real rows).
    expect(rows.agent_runs).toHaveLength(2);
    for (const [table, list] of Object.entries(rows)) {
      expect(serialized(list), table).not.toContain(CLIPBOARD);
    }
  } finally {
    await r.runtime.close();
  }
}, 120_000);
