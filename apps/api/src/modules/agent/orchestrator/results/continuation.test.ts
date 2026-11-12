import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference } from '../core/card-references.ts';
import { orchestratorLimitsDefaults } from '../core/factories.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import { createIntentPort } from '../intents/index.ts';
import type { IntentDeps, IntentRequest } from '../intents/index.ts';
import { createKeywordResults } from './keyword.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createClarification, createRefinement, createResultsTools } from './index.ts';
import type { DeliveredProduct, ResultSetStore, ResultsDeps } from './index.ts';
import { openServerCall } from './references.ts';
import { priceRangeInvalidView } from '../../tools/search/index.ts';

// Synthetic only. BR-AI-08 / AC-B3-05g#3 / #11: a clarify answer continues the chain it answers
// even when the first search only asked (no product was ever delivered in the session).
const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const Q = '合成牛奶';

function input(runId: string): RunBodyInput {
  return {
    caller: {
      appId: APP,
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: SESSION,
    runId,
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成续答',
    redactedText: '合成续答' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function request(output: unknown, runId: string): IntentRequest {
  return {
    text: JSON.stringify(output),
    input: input(runId),
    proceed: {
      kind: 'proceed',
      modelText: '合成续答',
      placeholders: Object.freeze({}),
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

function productList(id: string): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: id, items: [{ product_key: 'jd:synthetic' }] },
    fallback_text: '合成商品列表',
  };
}

/** Same reference contract as the real search handler; every search finds one product. */
function searchHandler() {
  return vi.fn(async (call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => {
    const ref = cardReference(ctx, 0);
    return {
      kind: 'ok',
      modelView: { items: [{ card_id: ref, title: '<untrusted>合成牛奶</untrusted>' }] },
      cards: [productList(call.id)],
    };
  });
}

/** `deferred`: the production wiring (B3-03r), chains pending until a list's delivery receipt. */
function harness(deferred = false) {
  const execute = searchHandler();
  const inner: OrchestratorTools = {
    definitions: async () => [],
    execute,
    enabledSearchPlatforms: async () => ['jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const store: ResultSetStore = createMemoryResultSetStore();
  const keyword = createKeywordResults(store);
  const receipts = keyword.receipts(() => undefined);
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => `文案:${key}` },
    limits: orchestratorLimitsDefaults(),
    ...(deferred ? { chains: keyword } : {}),
  };
  const tools = createResultsTools(inner, deps);
  const clarification = createClarification({ ...deps, tools });
  const refinement = createRefinement({ ...deps, tools });
  const intentDeps: IntentDeps = {
    routes: { configured: async () => [], contract: () => bridge.routes },
    flags: { enabled: async () => true },
    tools: { registered: () => true },
    texts: deps.texts,
    trace: { calls: async () => [], record: vi.fn() },
    clarification,
    continuation: { previousIntent: async () => null, ...refinement },
  };
  const port = createIntentPort(intentDeps);

  /** A model search_products call in its own run (the core's path, through the decorator). */
  async function modelSearch(args: Readonly<Record<string, unknown>>, runId: string) {
    const id = `model-${runId}`;
    const scope = openServerCall(id, Object.freeze({}));
    const ctx: ToolContext = {
      subject: input(runId).caller,
      runId,
      sessionId: SESSION,
      signal: new AbortController().signal,
      placeholders: scope.placeholders,
    };
    try {
      return await tools.execute({ id, name: 'search_products', args }, ctx);
    } finally {
      scope.refs.close();
    }
  }

  /** The model's intent output of a later run, through the intent port. */
  async function intent(output: unknown, runId: string) {
    const cards: UnnumberedCard[] = [];
    const suggestions: unknown[] = [];
    const ctx: RunContext = {
      runId,
      sessionId: SESSION,
      signal: new AbortController().signal,
      cardsDelivered: 0,
      text: () => undefined,
      card: async (card, delivered) => {
        cards.push(card);
        delivered?.(`c${cards.length}`);
      },
      suggestions: (items) => {
        suggestions.push(...items);
      },
      toolStatus: () => undefined,
    };
    const result = await port.handle(request(output, runId), ctx);
    return { result, cards, suggestions };
  }

  return { execute, store, receipts, modelSearch, intent, clarification };
}

function noticeKeys(cards: readonly UnnumberedCard[]): unknown[] {
  return cards.filter((card) => card.type === 'notice').map((card) => card.data['text_key']);
}

async function firstSearchAsks(h: ReturnType<typeof harness>) {
  const asked = await h.modelSearch(
    { q: Q, price_min_fen: 5001, price_max_fen: 5000 },
    'search-run',
  );
  expect(asked).toMatchObject({ kind: 'ok', cards: [] });
  expect(asked.kind === 'ok' ? asked.suggestions : undefined).toHaveLength(3);
  expect(h.execute).not.toHaveBeenCalled();
  expect(await h.store.latestWithProducts(APP, SESSION)).toBeNull();
}

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] 首次搜索即追问、未出卡，下一轮 refine 再给非法价格：同链去价格检索并在卡前出 price_unrecognized', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 0 } },
    'answer-run',
  );
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0].args).toEqual({ q: Q });
  expect(out.cards.map((card) => card.type)).toEqual(['notice', 'product_list']);
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.price_unrecognized']);
  // No second ask on the same chain and slot.
  expect(out.suggestions).toEqual([]);
});

it('[AC-B3-05g#3][AC-B3-05g#11][BR-AI-08] 首次搜索即追问、未出卡，下一轮 refine 给合法上限：沿用原搜索条件正常检索', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 6000 } },
    'answer-run',
  );
  expect(out.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    // A valid new price restarts at page 1 (AC-B3-05k#9).
    { q: Q, price_min_fen: 5001, price_max_fen: 6000, page: 1 },
  ]);
  expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
  expect(noticeKeys(out.cards)).toEqual([]);
});

it('[AC-B3-05g#8][BR-AI-08] 首次搜索即追问、未出卡，换平台沿用原搜索条件，只改 platforms', async () => {
  const h = harness();
  await h.modelSearch({ q: Q, price_max_fen: 0 }, 'search-run');
  expect(h.execute).not.toHaveBeenCalled();
  await h.intent({ agent_intent: 'refine', conditions: { platform: 'jd' } }, 'answer-run');
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([{ q: Q, platforms: ['jd'] }]);
});

it('[AC-B3-05g#3][BR-AI-08] 会话里既无追问链也无结果集时，refine 出 no_result，不检索', async () => {
  const h = harness();
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 6000 } },
    'answer-run',
  );
  expect(h.execute).not.toHaveBeenCalled();
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.no_result']);
  // B3-05o · BR-TEXT-22: nothing was searched, so no 「只搜{q_short}」 (the first and third only).
  expect(out.suggestions).toHaveLength(2);
});

it('[AC-B3-05g#7][BR-PRICE-15] 再便宜点仍依赖已下发商品：只有追问链、没有已下发商品时不检索', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const out = await h.intent({ agent_intent: 'refine', conditions: { cheaper: true } }, 'run-2');
  expect(h.execute).not.toHaveBeenCalled();
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.no_result']);
});

function emptySearch(spec: string | null): ToolOutcome {
  const trace = { link_registrations: [], search_params: { spec, page: 2 } };
  return { kind: 'ok', modelView: { items: [] }, cards: [], trace };
}

it.each([
  { conditions: { platform: 'taobao' }, changes: { platforms: ['taobao'] } },
  { conditions: { next_batch: true }, changes: { page: 3 } },
  // AC-B3-05k#9: a valid new price condition restarts at page 1.
  { conditions: { price_min_fen: 200 }, changes: { price_min_fen: 200, page: 1 } },
])(
  '[AC-B3-05g#8][AC-B3-05g#11] 放宽出卡后跨轮续搜 %j 以实际生效条件为基准',
  async ({ conditions, changes }) => {
    const h = harness();
    const save = vi.spyOn(h.store, 'save');
    const original = {
      q: Q,
      spec: '24盒',
      platforms: ['jd'],
      sort: 'sales_desc',
      page: 2,
      price_min_fen: 100,
      price_max_fen: 5000,
    };
    h.execute.mockResolvedValueOnce(emptySearch('24盒'));
    h.execute.mockResolvedValueOnce(emptySearch(null));
    const first = await h.modelSearch(original, 'relax-run');
    expect(first.kind).toBe('ok');
    expect(first.kind === 'ok' ? noticeKeys(first.cards) : []).toEqual([
      'agent.notice.relaxed_spec',
      'agent.notice.relaxed_price',
    ]);
    const effective = {
      q: Q,
      platforms: ['jd'],
      sort: 'sales_desc',
      page: 2,
      price_min_fen: 100,
    };
    expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
      original,
      { ...effective, price_max_fen: 5000 },
      effective,
    ]);
    const saved = save.mock.calls[0]?.[0].conditions;
    expect(saved).toEqual({ ...effective, chain_id: expect.any(String) });
    const out = await h.intent({ agent_intent: 'refine', conditions }, 'continue-run');
    expect(h.execute).toHaveBeenCalledTimes(4);
    expect(h.execute.mock.calls[3]?.[0].args).toEqual({ ...effective, ...changes });
    expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
    expect(save.mock.calls[1]?.[0].conditions).toEqual({ ...saved, ...changes });
  },
);

it('[AC-B3-05g#8] 仅放宽规格后换平台不恢复规格，保留价格上限', async () => {
  const h = harness();
  h.execute.mockResolvedValueOnce(emptySearch('24盒'));
  await h.modelSearch({ q: Q, spec: '24盒', price_max_fen: 5000 }, 'relax-run');
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { platform: 'taobao' } },
    'continue-run',
  );
  expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([
    { q: Q, spec: '24盒', price_max_fen: 5000 },
    { q: Q, price_max_fen: 5000 },
    { q: Q, price_max_fen: 5000, platforms: ['taobao'] },
  ]);
  expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
});

it.each(['local', 'inner'] as const)(
  '[AC-B3-05g#3][AC-B3-05g#11] %s 价格追问跨轮直接续答，出卡后同关键词搜索重开链',
  async (source) => {
    const h = harness();
    const save = vi.spyOn(h.store, 'save');
    const invalid = { q: Q, price_min_fen: 6000, price_max_fen: 5000 };
    const args = source === 'local' ? invalid : { q: Q, price_max_fen: 5000 };
    if (source === 'inner') {
      h.execute.mockResolvedValueOnce({
        kind: 'ok',
        modelView: priceRangeInvalidView(),
        cards: [],
      });
    }
    const first = await h.modelSearch(args, 'question-run');
    expect(first).toMatchObject({ kind: 'ok', cards: [], suggestions: expect.any(Array) });
    expect(first.kind === 'ok' ? first.suggestions : []).toHaveLength(3);
    const req = request({ agent_intent: 'clarify', slot: 'price' }, 'scope-run');
    const pending = await h.clarification.scope(req);
    const answer = await h.modelSearch({ q: Q, price_max_fen: 6000 }, 'answer-run');
    expect(answer.kind === 'ok' ? answer.cards.map((card) => card.type) : []).toEqual([
      'product_list',
    ]);
    expect(save.mock.calls[0]?.[0].conditions.chain_id).toBe(pending.chainId);
    expect(await h.clarification.scope(req)).toEqual(pending);
    const before = h.execute.mock.calls.length;
    const next = await h.modelSearch(invalid, 'new-search-run');
    expect(h.execute).toHaveBeenCalledTimes(before);
    expect(next).toMatchObject({ kind: 'ok', cards: [] });
    expect(next.kind === 'ok' ? next.suggestions : []).toHaveLength(3);
    const fresh = await h.clarification.scope(req);
    expect(fresh.chainId).not.toBe(pending.chainId);
    const fallback = await h.modelSearch(invalid, 'new-answer-run');
    expect(h.execute).toHaveBeenCalledTimes(before + 1);
    expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: Q });
    expect(fallback.kind === 'ok' ? noticeKeys(fallback.cards) : []).toEqual([
      'agent.notice.price_unrecognized',
    ]);
    expect(save.mock.calls.at(-1)?.[0].conditions.chain_id).toBe(fresh.chainId);
  },
);

it('[AC-B3-05g#11] 已出卡链上的 refine 保留已用追问次数，同关键词直接搜索重置', async () => {
  const h = harness();
  await firstSearchAsks(h);
  await h.modelSearch({ q: Q, price_max_fen: 6000 }, 'answer-run');
  const req = request({ agent_intent: 'clarify', slot: 'price' }, 'scope-run');
  const previous = await h.clarification.scope(req);
  const refined = await h.intent(
    { agent_intent: 'refine', conditions: { price_max_fen: 0 } },
    'refine-run',
  );
  expect(refined.suggestions).toEqual([]);
  expect(noticeKeys(refined.cards)).toEqual(['agent.notice.price_unrecognized']);
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: Q });
  expect(await h.clarification.scope(req)).toEqual(previous);
  const next = await h.modelSearch({ q: Q, price_max_fen: 0 }, 'new-search-run');
  expect(next.kind === 'ok' ? next.suggestions : []).toHaveLength(3);
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect((await h.clarification.scope(req)).chainId).not.toBe(previous.chainId);
});

it('[AC-B3-05g#11] 尚未回答的价格追问遇到不同关键词也重开链', async () => {
  const h = harness();
  await firstSearchAsks(h);
  const req = request({ agent_intent: 'clarify', slot: 'price' }, 'scope-run');
  const previous = await h.clarification.scope(req);
  const next = await h.modelSearch({ q: '合成咖啡', price_max_fen: 0 }, 'new-search-run');
  expect(next.kind === 'ok' ? next.suggestions : []).toHaveLength(3);
  expect(h.execute).not.toHaveBeenCalled();
  expect((await h.clarification.scope(req)).chainId).not.toBe(previous.chainId);
});

// B3-05k rule-test review S2: a store with the chain port but no chain appended yet (a session
// from before the port) continues from the latest result set that delivered products.
it.each([
  { conditions: { next_batch: true }, args: { q: Q, platforms: ['jd'], page: 3 } },
  { conditions: { platform: 'taobao' }, args: { q: Q, platforms: ['taobao'], page: 2 } },
  {
    conditions: { price_max_fen: 6000 },
    args: { q: Q, platforms: ['jd'], price_max_fen: 6000, page: 1 },
  },
])(
  '[AC-B3-05k#3][BR-AI-05] 端口从未追加过链时续搜 %j 回落到最近已下发商品的结果集条件',
  async ({ conditions, args }) => {
    const h = harness();
    const legacy = {
      q: Q,
      platforms: ['jd'] as const,
      page: 2,
      chain_id: 'synthetic-legacy-chain',
    };
    await h.store.save({
      id: 'synthetic-legacy-set',
      appId: APP,
      sessionId: SESSION,
      runId: 'legacy-run',
      conditions: { ...legacy, platforms: [...legacy.platforms] },
    });
    await h.store.recordDelivered('synthetic-legacy-set', [
      {
        card_id: 'c1',
        product_key: 'jd:synthetic',
        platform: 'jd',
        final_price_fen: 2990,
        card: productList('synthetic-legacy-set'),
      },
    ]);
    expect(await h.store.currentChain?.(APP, SESSION)).toBeNull();
    const out = await h.intent({ agent_intent: 'refine', conditions }, 'continue-run');
    expect(noticeKeys(out.cards)).toEqual([]);
    expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
    expect(h.execute.mock.calls.map(([call]) => call.args)).toEqual([args]);
    expect(await h.store.currentChain?.(APP, SESSION)).toEqual({
      chainId: legacy.chain_id,
      status: 'has_products',
      conditions: { ...args, chain_id: legacy.chain_id },
    });
  },
);

it('[AC-B3-05k#7][BR-AI-08] 端口从未追加过链但有已下发结果集时 scope 沿用该链，不新开链', async () => {
  const h = harness();
  await h.store.save({
    id: 'synthetic-legacy-set',
    appId: APP,
    sessionId: SESSION,
    runId: 'legacy-run',
    conditions: { q: Q, chain_id: 'synthetic-legacy-chain' },
  });
  await h.store.recordDelivered('synthetic-legacy-set', [
    {
      card_id: 'c1',
      product_key: 'jd:synthetic',
      platform: 'jd',
      final_price_fen: 2990,
      card: productList('synthetic-legacy-set'),
    },
  ]);
  const append = vi.spyOn(h.store, 'appendChain');
  const scope = await h.clarification.scope(request({}, 'scope-run'));
  expect(scope.chainId).toBe('synthetic-legacy-chain');
  expect(append).not.toHaveBeenCalled();
});

// B3-03r · BR-AI-05: with deferred chains a round without a product_list still records the query
// the user just asked (as before the deferral), while a list not confirmed as written never does.
function delivered(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: 'jd:synthetic',
    platform: 'jd',
    final_price_fen: 1000,
    card: productList('unused'),
  };
}

async function seenBatch(h: ReturnType<typeof harness>) {
  await h.modelSearch({ q: '合成保温杯' }, 'seen-run');
  await h.receipts.recordDelivered('model-seen-run', [delivered('c1')]);
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯' },
  });
}

it('[AC-B3-03r#2][BR-AI-05] 无结果的一轮当场记下本次查询：之后换平台只改 platforms、沿用刚问过的查询', async () => {
  const h = harness(true);
  await seenBatch(h);
  h.execute.mockResolvedValueOnce(emptySearch(null));
  const empty = await h.modelSearch({ q: '合成水杯', platforms: ['taobao'] }, 'empty-run');
  expect(empty.kind === 'ok' ? noticeKeys(empty.cards) : []).toEqual(['agent.notice.no_result']);
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'searching',
    conditions: { q: '合成水杯', platforms: ['taobao'] },
  });
  await h.intent({ agent_intent: 'refine', conditions: { platform: 'jd' } }, 'switch-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成水杯', platforms: ['jd'] });
});

it('[AC-B3-03r#2][BR-AI-05] 无结果的一轮后价格追问基于刚问过的查询，从第 1 页检索', async () => {
  const h = harness(true);
  await seenBatch(h);
  h.execute.mockResolvedValueOnce(emptySearch(null));
  await h.modelSearch({ q: '合成水杯' }, 'empty-run');
  await h.intent({ agent_intent: 'refine', conditions: { price_max_fen: 10000 } }, 'price-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({
    q: '合成水杯',
    price_max_fen: 10000,
    page: 1,
  });
});

it('[AC-B3-03r#2][BR-AI-05] 新会话首搜无结果、检索失败的一轮同样记下查询，换平台不回落为 no_result', async () => {
  const h = harness(true);
  h.execute.mockResolvedValueOnce({ kind: 'failed', modelView: { error: 'tool_failed' } });
  await h.modelSearch({ q: '合成水杯' }, 'failed-run');
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'searching',
    conditions: { q: '合成水杯' },
  });
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { platform: 'taobao' } },
    'switch-run',
  );
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成水杯', platforms: ['taobao'] });
  expect(out.cards.map((card) => card.type)).toEqual(['product_list']);
});

it('[AC-B3-03r#2][BR-AI-05] 搜到商品但列表未确认写出的一轮仍不切链：换平台与换一批沿用上一批', async () => {
  const h = harness(true);
  await seenBatch(h);
  const unwritten = await h.modelSearch({ q: '合成水杯' }, 'unwritten-run');
  expect(unwritten.kind === 'ok' ? unwritten.cards.map((card) => card.type) : []).toEqual([
    'product_list',
  ]);
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯' },
  });
  await h.intent({ agent_intent: 'refine', conditions: { platform: 'taobao' } }, 'switch-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成保温杯', platforms: ['taobao'] });
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'next-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成保温杯', page: 2 });
});

it('[AC-B3-03r#5][BR-PRICE-15] 延后切链时再便宜点无结果仍不改条件', async () => {
  const h = harness(true);
  await seenBatch(h);
  const before = await h.store.currentChain?.(APP, SESSION);
  h.execute.mockResolvedValueOnce(emptySearch(null));
  const out = await h.intent(
    { agent_intent: 'refine', conditions: { cheaper: true } },
    'cheap-run',
  );
  expect(noticeKeys(out.cards)).toEqual(['agent.notice.no_cheaper']);
  expect(await h.store.currentChain?.(APP, SESSION)).toEqual(before);
});

// B3-03r (D10-333) · BR-AI-05: a round without a product_list records the query, never a page the
// user did not see — a failed 换一批 keeps the shown page, so the next 换一批 asks for it again.
it.each([
  ['失败结果', () => ({ kind: 'failed', modelView: { error: 'tool_failed' } }) as const],
  [
    '检索抛错',
    () => {
      throw new Error('synthetic upstream failure');
    },
  ],
] as const)(
  '[AC-B3-03r#7][BR-AI-05] 换一批（%s）没出商品列表：当前链页码不变，再换一批请求的仍是第 2 页',
  async (_label, fail) => {
    const h = harness(true);
    await seenBatch(h);
    const before = await h.store.currentChain?.(APP, SESSION);
    h.execute.mockImplementationOnce(async () => fail());
    await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'failed-run');
    expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成保温杯', page: 2 });
    expect(await h.store.currentChain?.(APP, SESSION)).toEqual(before);
    await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'again-run');
    expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成保温杯', page: 2 });
  },
);

it('[AC-B3-03r#7][BR-AI-05] 第 2 页已见后价格追问失败：记下新价格、页码回到第 1 页，不沿用旧查询的页码', async () => {
  const h = harness(true);
  await seenBatch(h);
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'page-two-run');
  const pageTwo = h.execute.mock.calls.at(-1)?.[0];
  expect(pageTwo?.args).toEqual({ q: '合成保温杯', page: 2 });
  await h.receipts.recordDelivered(pageTwo!.id, [delivered('c2')]);
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯', page: 2 },
  });
  h.execute.mockResolvedValueOnce({ kind: 'failed', modelView: { error: 'tool_failed' } });
  await h.intent({ agent_intent: 'refine', conditions: { price_max_fen: 10000 } }, 'price-run');
  expect(await h.store.currentChain?.(APP, SESSION)).toMatchObject({
    conditions: { q: '合成保温杯', price_max_fen: 10000, page: 1 },
  });
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'next-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({
    q: '合成保温杯',
    price_max_fen: 10000,
    page: 2,
  });
});

it('[AC-B3-03r#7][BR-AI-05] 新查询直接请求第 3 页但失败：新链从第 1 页记起', async () => {
  const h = harness(true);
  await seenBatch(h);
  h.execute.mockResolvedValueOnce({ kind: 'failed', modelView: { error: 'tool_failed' } });
  await h.modelSearch({ q: '合成水杯', page: 3 }, 'failed-run');
  const chain = await h.store.currentChain?.(APP, SESSION);
  expect(chain?.conditions?.q).toBe('合成水杯');
  expect(chain?.conditions?.page ?? 1).toBe(1);
  await h.intent({ agent_intent: 'refine', conditions: { next_batch: true } }, 'next-run');
  expect(h.execute.mock.calls.at(-1)?.[0].args).toEqual({ q: '合成水杯', page: 2 });
});
