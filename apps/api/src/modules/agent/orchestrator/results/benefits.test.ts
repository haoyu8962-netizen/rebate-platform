// Implementer unit tests for B3-04k r2 (rule tests live in test/spec/agent/search-benefits):
// the 04 §8.5 conditions (benefits, brand, category_hint, exclude_keywords) travel with the chain
// into 换一批 / 再便宜点 / 换平台, and a taolijin chain never shows a product_list (BR-AI-17).
// Synthetic only; the real search_products handler runs behind the results decorator.
import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { CatalogCardEntry, ProductCard } from '../../../catalog/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import {
  createSearchProductsHandler,
  type AgentProductCard,
  type AgentSearchCandidate,
  type SearchProductsDeps,
} from '../../tools/search/index.ts';
import { cardReference } from '../core/card-references.ts';
import { orchestratorLimitsDefaults } from '../core/factories.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../core/ports.ts';
import { createIntentPort } from '../intents/index.ts';
import type { IntentDeps, IntentRequest } from '../intents/index.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createClarification, createRefinement, createResultsTools } from './index.ts';
import type { ResultsDeps } from './index.ts';
import { openServerCall } from './references.ts';

const APP = 'synthetic-app';
const SESSION = 'synthetic-session';
const NOW = '2026-10-17T12:00:00+08:00';
type Platform = AgentSearchCandidate['item']['platform'];

function candidate(key: string, platform: Platform, couponFen: number, price = 1000) {
  const row: AgentSearchCandidate = {
    item: {
      platform,
      item_id: key,
      title: `合成商品 ${key}`,
      price_fen: BigInt(price + couponFen),
      coupon_fen: BigInt(couponFen),
      final_price_fen: BigInt(price),
      commission_rate_bp: 1000n,
      quoted_at: NOW,
    },
    ref: {
      appId: APP,
      platform,
      productKey: key,
      rawItemId: `synthetic-raw-${key}`,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: `合成商品 ${key}`,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    sales: 1,
    categoryId: 'synthetic-category',
  };
  return row;
}

function productCard(row: AgentSearchCandidate): ProductCard {
  const coupon = Number(row.item.coupon_fen);
  return {
    product_key: row.ref.productKey,
    item_ref: 'synthetic-ref',
    platform: row.item.platform,
    title: row.item.title,
    image: 'https://example.invalid/synthetic.png',
    price_fen: Number(row.item.price_fen),
    coupon_fen: coupon,
    final_price_fen: Number(row.item.final_price_fen),
    est_net_price_fen: null,
    rebate_min_fen: 100,
    rebate_max_fen: 100,
    rebate_basis: 'normal',
    benefit_tags: coupon > 0 ? ['coupon'] : [],
    is_presale: false,
    link_id: `synthetic-link-${row.ref.productKey}`,
    cta: { text_key: 'product.buy' },
    quoted_at: NOW,
    stale: false,
    age_sec: 0,
    source: row.item.platform === 'jd' ? 'jd_union' : 'taobao_union',
    disclaimer_keys: ['price_basis.general'],
    availability: 'ok',
  };
}

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

function harness(rows: readonly AgentSearchCandidate[]) {
  let sets = 0;
  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    rows.filter((row) => row.item.platform === query.platform),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (entry) => {
    const row = rows.find((r) => r.ref.productKey === entry.ref.productKey)!;
    const { link_id, ...unlinked } = productCard(row);
    return { kind: 'prepared', card: unlinked, commit: async () => ({ ...unlinked, link_id }) };
  });
  const search = createSearchProductsHandler({
    clock: new FixedClock(NOW),
    config: {
      configValue: async (_app, key) =>
        key.startsWith('search.enabled.') ? { value: true, version: 1 } : null,
    },
    platforms: ['taobao', 'jd'],
    searchProducts,
    cardEntry: () => ({ assemble }),
    prohibited: async () => false,
    categoryAllowed: async () => true,
    newResultSetId: () => `synthetic-results-${++sets}`,
    cardReference: (ctx: ToolCallContext, index) => cardReference(ctx, index),
  });
  // The registry hands the handler a call context built from the tool context.
  const execute = vi.fn<OrchestratorTools['execute']>(async (call, ctx): Promise<ToolOutcome> =>
    search.run(call.args as Readonly<Record<string, unknown>>, {
      appId: ctx.subject.appId,
      userId: ctx.subject.userId,
      deviceId: ctx.subject.deviceId,
      phoneBound: ctx.subject.phoneBound,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      placeholders: ctx.placeholders,
    }),
  );
  const inner: OrchestratorTools = {
    definitions: async () => [],
    execute,
    enabledSearchPlatforms: async () => ['taobao', 'jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  const store = createMemoryResultSetStore();
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => `文案:${key}` },
    limits: orchestratorLimitsDefaults(),
  };
  const tools = createResultsTools(inner, deps);
  const intentDeps: IntentDeps = {
    routes: { configured: async () => [], contract: () => bridge.routes },
    flags: { enabled: async () => true },
    tools: { registered: () => true },
    texts: deps.texts,
    trace: { calls: async () => [], record: vi.fn() },
    clarification: createClarification({ ...deps, tools }),
    continuation: { previousIntent: async () => null, ...createRefinement({ ...deps, tools }) },
  };
  const port = createIntentPort(intentDeps);

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

  /** A later run's refine intent; delivered product_lists are recorded as written. */
  async function refine(conditions: Readonly<Record<string, unknown>>, runId: string) {
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
    await port.handle(request({ agent_intent: 'refine', conditions }, runId), ctx);
    return { cards, suggestions };
  }

  /** Mark the latest product_list of `outcome` as delivered (the core's receipt). */
  async function deliver(outcome: ToolOutcome) {
    if (outcome.kind !== 'ok') return;
    for (const card of outcome.cards) {
      if (card.type !== 'product_list') continue;
      const items = card.data['items'] as readonly AgentProductCard[];
      await store.recordDelivered(
        card.data['result_set_id'] as string,
        items.map((item, i) => ({
          card_id: `c${i + 1}`,
          product_key: item.product_key,
          platform: item.platform,
          final_price_fen: item.final_price_fen,
          card: { ...card, data: { ...card.data, items: [item] } },
        })),
      );
    }
  }

  const lastArgs = () => execute.mock.calls.at(-1)?.[0].args;
  return { execute, searchProducts, modelSearch, refine, deliver, lastArgs };
}

function listKeys(cards: readonly UnnumberedCard[]): string[] {
  return cards
    .filter((card) => card.type === 'product_list')
    .flatMap((card) =>
      (card.data['items'] as readonly AgentProductCard[]).map((i) => i.product_key),
    );
}

function noticeKeys(cards: readonly UnnumberedCard[]): unknown[] {
  return cards.filter((card) => card.type === 'notice').map((card) => card.data['text_key']);
}

const ROWS = [
  candidate('tb:synthetic-coupon', 'taobao', 200, 1500),
  candidate('tb:synthetic-plain', 'taobao', 0, 1200),
  candidate('jd:synthetic-coupon', 'jd', 300, 1800),
  candidate('jd:synthetic-plain', 'jd', 0, 900),
];

it('coupon chain: 换一批 keeps benefits=[coupon] and still shows only couponed cards', async () => {
  const h = harness(ROWS);
  const first = await h.modelSearch({ q: '合成商品', benefits: ['coupon'] }, 'search-run');
  expect(first.kind === 'ok' ? listKeys(first.cards) : []).toEqual([
    'tb:synthetic-coupon',
    'jd:synthetic-coupon',
  ]);
  await h.deliver(first);
  const next = await h.refine({ next_batch: true }, 'next-run');
  expect(h.lastArgs()).toEqual({ q: '合成商品', benefits: ['coupon'], page: 2 });
  expect(listKeys(next.cards)).toEqual(['tb:synthetic-coupon', 'jd:synthetic-coupon']);
});

it('coupon chain: 换平台 and 再便宜点 keep benefits=[coupon]', async () => {
  const h = harness(ROWS);
  await h.deliver(await h.modelSearch({ q: '合成商品', benefits: ['coupon'] }, 'search-run'));
  const switched = await h.refine({ platform: 'jd' }, 'switch-run');
  expect(h.lastArgs()).toEqual({ q: '合成商品', benefits: ['coupon'], platforms: ['jd'] });
  expect(listKeys(switched.cards)).toEqual(['jd:synthetic-coupon']);
  await h.refine({ cheaper: true }, 'cheap-run');
  expect(h.lastArgs()).toMatchObject({
    q: '合成商品',
    benefits: ['coupon'],
    sort: 'final_price_asc',
    page: 1,
  });
});

it('brand / category_hint / exclude_keywords survive 换一批, 换平台 and 再便宜点', async () => {
  const h = harness(ROWS);
  const kept = { brand: '合成牌', category_hint: '饮品', exclude_keywords: ['plain'] };
  const first = await h.modelSearch({ q: '合成商品', ...kept }, 'search-run');
  expect(first.kind === 'ok' ? listKeys(first.cards) : []).toEqual([
    'tb:synthetic-coupon',
    'jd:synthetic-coupon',
  ]);
  expect(h.searchProducts.mock.calls[0]?.[0].q).toBe('合成牌 合成商品 饮品');
  await h.deliver(first);
  await h.refine({ next_batch: true }, 'next-run');
  expect(h.lastArgs()).toEqual({ q: '合成商品', ...kept, page: 2 });
  await h.refine({ platform: 'taobao' }, 'switch-run');
  expect(h.lastArgs()).toEqual({ q: '合成商品', ...kept, platforms: ['taobao'], page: 2 });
  await h.refine({ cheaper: true }, 'cheap-run');
  expect(h.lastArgs()).toMatchObject({ q: '合成商品', ...kept, sort: 'final_price_asc' });
});

it('taolijin chain: 换一批 / 换平台 / 再便宜点 / price answer only show tlj notices, never search', async () => {
  const h = harness(ROWS);
  // An earlier chain that did show products must not leak into the taolijin chain's follow-ups.
  await h.deliver(await h.modelSearch({ q: '合成旧商品' }, 'old-run'));
  h.searchProducts.mockClear();
  const first = await h.modelSearch(
    { q: '合成商品', benefits: ['taolijin'], price_max_fen: 5000 },
    'tlj-run',
  );
  expect(first.kind === 'ok' ? noticeKeys(first.cards) : []).toEqual(['agent.notice.tlj_none']);
  const follow = [
    [{ next_batch: true }, ['agent.notice.tlj_none']],
    [{ cheaper: true }, ['agent.notice.tlj_none']],
    [{ price_max_fen: 3000 }, ['agent.notice.tlj_none']],
    [{ platform: 'jd' }, ['agent.notice.tlj_none', 'agent.notice.tlj_taobao_only']],
  ] as const;
  for (const [conditions, keys] of follow) {
    const out = await h.refine(conditions, `refine-${JSON.stringify(conditions)}`);
    expect(h.lastArgs()).toMatchObject({ q: '合成商品', benefits: ['taolijin'] });
    expect(out.cards.map((card) => card.type)).toEqual(keys.map(() => 'notice'));
    expect(noticeKeys(out.cards)).toEqual([...keys]);
    expect(out.suggestions).toEqual([]);
  }
  expect(h.searchProducts).not.toHaveBeenCalled();
});

it('taolijin result is terminal in the decorator: one inner call, handler outcome unchanged', async () => {
  const h = harness(ROWS);
  const args = { q: '合成商品', benefits: ['taolijin'], spec: '24盒', price_max_fen: 5000 };
  const outcome = await h.modelSearch(args, 'tlj-run');
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(outcome).toMatchObject({
    kind: 'ok',
    modelView: { items: [], server_notices: ['tlj_none'] },
  });
  expect(outcome.kind === 'ok' ? outcome.suggestions : 'x').toBeUndefined();
});
