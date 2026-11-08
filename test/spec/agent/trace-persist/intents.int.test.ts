// B3-08q · BR-AI-19: what the intent port writes (the core hands it the model's final
// {"agent_intent": …} text) is persisted like any other path's output: the page_guide card of a
// guide intent, and the product cards (with their link ids, the ToolTraceFragment's
// link_registrations) of a refine continuation (「换一批」). Production stream entry of [AC-B3-08g]
// over real PG; the model is scripted.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAD } from '../core-reply-templates/kit.ts';
import { rowAs } from '../stream-model-prereq-3/kit.ts';
import { openSession, usePgEach } from '../stream-mount/kit.ts';
import {
  KEYWORD,
  ask,
  cardRowsOf,
  cardTypesOf,
  expectCardsStored,
  finishOf,
  productionRig,
  runIdOf,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const GUIDE_ASK = '钱包在哪';
const SEARCH_ASK = '帮我找合成保温杯';
const NEXT_ASK = '换一批';

it('[AC-B3-08q#4][BR-AI-19] 意图端口·页面引导：模型终轮 {agent_intent: page_guide, guide_route: Wallet} → 意图端口写出的 page_guide 卡落 agent_cards（card_id、数据与帧一致，app / session / run 正确）', async () => {
  const x = await productionRig(pg.db, {
    routes: ['Wallet'],
    scripts: {
      [GUIDE_ASK]: [
        { text: JSON.stringify({ agent_intent: 'page_guide', guide_route: 'Wallet' }) },
      ],
    },
  });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const frames = await ask(x, x.f.caller, sessionId, GUIDE_ASK);
    expect(finishOf(frames)).toBe('stop');
    expect(cardTypesOf(frames)).toEqual(['page_guide']);
    const runId = runIdOf(frames);
    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId }, frames);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);

it('[AC-B3-08q#4][BR-AI-19] 意图端口·换一批：上一 run 模型搜索出过一批，本 run 终轮 {agent_intent: refine, next_batch} → 续翻写出的商品卡落在本 run 下，卡内商品 link_id 随数据落库；上一 run 的卡仍只在上一 run 下', async () => {
  const x = await productionRig(pg.db, {
    scripts: {
      [SEARCH_ASK]: [
        { text: LEAD, calls: [{ name: 'search_products', args: { q: KEYWORD } }] },
        { text: '好的。' },
      ],
      [NEXT_ASK]: [
        { text: JSON.stringify({ agent_intent: 'refine', conditions: { next_batch: true } }) },
      ],
    },
  });
  try {
    const sessionId = await openSession(x.r, x.f.caller);
    const first = await ask(x, x.f.caller, sessionId, SEARCH_ASK);
    expect(cardTypesOf(first)).toEqual(['product_list']);
    const firstRun = runIdOf(first);

    // The next page has another product (the fixture's search port answers every page alike).
    x.f.state.row = rowAs(x.f.state.row, 'synthetic-mug', '合成水杯 400ml');
    const searches = x.f.searchProducts.mock.calls.length;
    const second = await ask(x, x.f.caller, sessionId, NEXT_ASK);
    expect(finishOf(second)).toBe('stop');
    expect(
      x.f.searchProducts.mock.calls.length,
      'the refine continuation searched',
    ).toBeGreaterThan(searches);
    expect(cardTypesOf(second)).toContain('product_list');
    const secondRun = runIdOf(second);

    await expectCardsStored(pg.db, { appId: x.appId, sessionId, runId: firstRun }, first);
    const rows = await expectCardsStored(
      pg.db,
      { appId: x.appId, sessionId, runId: secondRun },
      second,
    );
    const products = rows
      .filter((row) => row.type === 'product_list')
      .flatMap((row) => (row.data as Row)['items'] as Row[]);
    expect(products.map((product) => product['product_key'])).toContain('tb:synthetic-mug');
    for (const product of products) {
      expect(product['link_id'], 'stored product link_id').toBeTypeOf('string');
    }
    // Run 1's card rows did not move to run 2.
    const firstIds = (await cardRowsOf(pg.db, 'run_id', firstRun)).map((row) => row.card_id);
    expect(rows.map((row) => row.card_id).filter((id) => firstIds.includes(id))).toEqual([]);
  } finally {
    await x.r.runtime.close();
  }
}, 120_000);
