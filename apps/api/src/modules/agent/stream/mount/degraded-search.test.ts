// B3-05n (实现第 2 轮) · BR-AI-14 细则「无模型降级」⑥: the model tool's switch
// agent.tools.search_products.enabled does not govern the no-model search. With it off, the
// assembly's degraded tools still run the registry's search_products handler with every condition
// taken (price, platforms, sort, exclusions), save the result set with those conditions, and the
// model path's registry still refuses the tool. Synthetic ports only; no database is queried.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import type { CatalogCardEntry, ProductCard } from '../../../catalog/index.ts';
import type { ParsingOptions } from '../../../parsing/index.ts';
import { FixedClock, type RootLogger, type Scheduler } from '../../../platform/index.ts';
import type { RunBodyInput } from '../../http/index.ts';
import { openCardCall } from '../../orchestrator/core/card-references.ts';
import type { ToolContext } from '../../orchestrator/core/ports.ts';
import { createRoutedDegradedPath } from '../../orchestrator/degraded/routing.ts';
import { createMemoryResultSetStore } from '../../orchestrator/results/index.ts';
import type { RedactedText } from '../admission/index.ts';
import type { RunContext, UnnumberedCard } from '../run/index.ts';
import type { AgentSearchCandidate } from '../../tools/search/index.ts';
import { createAgentStreamAssembly } from './assembly.ts';

const APP = 'synthetic-app';
const NOW = '2031-01-02T03:04:05+08:00';
type Platform = AgentSearchCandidate['item']['platform'];

function row(key: string, platform: Platform, title: string): AgentSearchCandidate {
  return {
    item: {
      platform,
      item_id: key,
      title,
      price_fen: 1000n,
      coupon_fen: 0n,
      final_price_fen: 1000n,
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
      title,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    categoryId: 'synthetic-category',
    sales: 10,
  };
}

function card(r: AgentSearchCandidate): ProductCard {
  return {
    product_key: r.ref.productKey,
    item_ref: `synthetic-ref-${r.ref.productKey}`,
    platform: r.item.platform,
    shop_type: null,
    title: r.item.title,
    image: 'https://example.invalid/synthetic.png',
    shop_name: '合成店铺',
    price_fen: 1000,
    coupon_fen: 0,
    final_price_fen: 1000,
    est_net_price_fen: null,
    rebate_min_fen: 100,
    rebate_max_fen: 100,
    rebate_basis: 'normal',
    benefit_tags: [],
    match_tag: 'matched',
    spec_text: null,
    is_presale: false,
    link_id: `synthetic-link-${r.ref.productKey}`,
    cta: { text_key: 'product.buy' },
    quoted_at: NOW,
    stale: false,
    age_sec: 0,
    source: r.item.platform === 'jd' ? 'jd_union' : 'taobao_union',
    disclaimer_keys: ['price_basis.general'],
    ad_label: null,
    availability: 'ok',
  };
}

/** A handle the assembly may keep but never queries in these tests. */
function inertDb(): Kysely<DB> {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('synthetic db is not used');
      },
    },
  ) as Kysely<DB>;
}

function fixture() {
  const rows = [
    row('jd:plain', 'jd', '合成纸巾'),
    row('jd:scented', 'jd', '合成香味纸巾'),
    row('tb:plain', 'taobao', '合成纸巾'),
  ];
  const settings = new Map<string, boolean>([
    ['search.enabled.taobao', true],
    ['search.enabled.jd', true],
    ['search.enabled.pdd', true],
    ['agent.tools.search_products.enabled', false],
  ]);
  const searchProducts = vi.fn(async (query: { platform: string }) =>
    rows.filter((r) => r.item.platform === query.platform),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    const full = card(rows.find((r) => r.ref.productKey === input.ref.productKey)!);
    if (input.deferLink !== true) return { kind: 'card', card: full };
    const { link_id, ...unlinked } = full;
    void link_id;
    return { kind: 'prepared', card: unlinked, commit: async () => full };
  });
  const store = createMemoryResultSetStore();
  const save = vi.spyOn(store, 'save');
  const texts = { text: async (_app: string, key: string) => key, toolDisplay: async () => '' };
  const assembly = createAgentStreamAssembly({
    db: inertDb(),
    clock: new FixedClock(NOW),
    logger: { warn: vi.fn() } as unknown as RootLogger,
    scheduler: {} as Scheduler,
    config: {
      configValue: async (_app, key) => {
        const value = settings.get(key);
        return value === undefined ? null : { value, version: 1 };
      },
    },
    texts,
    routes: { configured: async () => [], contract: () => ({}) },
    results: store,
    ports: {
      search: {
        platforms: ['taobao', 'jd', 'pdd'],
        searchProducts,
        prohibited: async () => false,
        categoryAllowed: async () => true,
      },
      readProduct: async () => {
        throw new Error('synthetic readProduct is not used');
      },
      parsing: {} as ParsingOptions,
      cards: () => ({ assemble }),
    },
  });
  return { assembly, searchProducts, save, texts };
}

function caller(): RunBodyInput['caller'] {
  return {
    appId: APP,
    traceId: 'synthetic-trace',
    deviceId: 'synthetic-device',
    deviceHash: 'synthetic-hash',
    ipKey: 'synthetic-ip-key',
    userId: 'synthetic-user',
    phoneBound: true,
  };
}

/** A tool call's context in its own card-reference scope, as the core (and the routed degraded
 * path) open one per call. */
function toolContext(id: string): ToolContext {
  const placeholders = Object.freeze({});
  openCardCall(id, placeholders);
  return {
    subject: caller(),
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders,
  };
}

function runContext(cards: UnnumberedCard[], texts: string[]): RunContext {
  return {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => {
      texts.push(text);
    },
    toolStatus: () => undefined,
    card: async (c) => {
      cards.push(c);
    },
    suggestions: () => undefined,
  };
}

const ARGS = {
  q: '纸巾',
  platforms: ['jd'],
  sort: 'rebate_desc',
  price_max_fen: 3000,
  exclude_keywords: ['香味'],
};

it('[AC-B3-05n][BR-AI-14] 找货工具开关关：模型路径仍拒绝 search_products，降级工具照常带全部条件检索', async () => {
  const f = fixture();
  const model = await f.assembly.tools.execute(
    { id: 'synthetic-call', name: 'search_products', args: ARGS },
    toolContext('synthetic-call'),
  );
  expect(model.kind).toBe('rejected');
  expect(f.searchProducts).not.toHaveBeenCalled();

  const degraded = await f.assembly.degraded!.tools.execute(
    { id: 'degraded-search_products', name: 'search_products', args: ARGS },
    toolContext('degraded-search_products'),
  );
  expect(degraded.kind).toBe('ok');
  expect(f.searchProducts.mock.calls.map(([query]) => query.platform)).toEqual(['jd']);
  for (const [query] of f.searchProducts.mock.calls) {
    expect(query).toMatchObject({ q: '纸巾', platform: 'jd', price_max_fen: 3000 });
  }
  const list =
    degraded.kind === 'ok' ? degraded.cards.find((c) => c.type === 'product_list') : undefined;
  expect(list?.data['items']).toEqual([expect.objectContaining({ product_key: 'jd:plain' })]);
  // Result set registration unchanged: saved with the conditions searched.
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.save.mock.calls[0]![0]).toMatchObject({
    appId: APP,
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    conditions: {
      q: '纸巾',
      platforms: ['jd'],
      sort: 'rebate_desc',
      price_max_fen: 3000,
      exclude_keywords: ['香味'],
    },
  });
});

it('[AC-B3-05n][BR-AI-14] 找货工具开关关：降级 ⑥ 经装配的降级工具搜索，不回落成只有 q 与平台的关键词搜索', async () => {
  const f = fixture();
  const ports = f.assembly.degraded!;
  const execute = vi.spyOn(ports.tools, 'execute');
  const searchKeyword = vi.spyOn(ports.tools, 'searchKeyword');
  const path = createRoutedDegradedPath({
    ...ports,
    texts: f.texts,
    errorMsg: async (_app, code) => `synthetic-${code}`,
  });
  const question = '京东纸巾 30元以内 不要香味 哪个返利最高';
  const cards: UnnumberedCard[] = [];
  const texts: string[] = [];
  const result = await path.run(
    {
      reason: 'route_no_model',
      input: {
        caller: caller(),
        sessionId: 'synthetic-session',
        runId: 'synthetic-run',
        userMessageId: 'synthetic-user-message',
        assistantMessageId: 'synthetic-assistant-message',
        text: question,
        redactedText: question as RedactedText,
        limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
      },
      proceed: {
        kind: 'proceed',
        modelText: question,
        placeholders: {},
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      },
    },
    runContext(cards, texts),
  );
  expect(result).toEqual({ kind: 'done', finishReason: 'fallback' });
  expect(searchKeyword).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]![0]).toMatchObject({ name: 'search_products', args: ARGS });
  for (const [query] of f.searchProducts.mock.calls) {
    expect(query).toMatchObject({ platform: 'jd', price_max_fen: 3000 });
  }
  const list = cards.find((c) => c.type === 'product_list');
  expect(list?.data['items']).toEqual([expect.objectContaining({ product_key: 'jd:plain' })]);
  expect(texts).toEqual(['agent.degraded']);
});
