// B3-05q implementation unit tests: the entry path's data side (createScenarioEntryReaders) over
// synthetic catalog, card entry and order queries. No database, no listen.
import { expect, it, vi } from 'vitest';
import type { CatalogCardEntry } from '../../../catalog/index.ts';
import type { AgentCapableOrderQueries } from '../../../orders/index.ts';
import { OFF_SHELF, ParsingError, type ParsedUrlProduct } from '../../../parsing/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import type { OrderToolsDeps } from '../../tools/orders/index.ts';
import type { RebateQuoteDeps } from '../../tools/quote/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import { createScenarioEntryReaders } from './entry.ts';

const KEY = 'tb:synthetic-entry';
const ORDER = '0192f3a1-7c00-7000-8000-0000000e0001';

function context(patch: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...patch,
  };
}

const PRODUCT = {
  item: { title: '合成商品' },
  ref: { productKey: KEY },
} as unknown as ParsedUrlProduct;

function quoteDeps(
  readProduct: RebateQuoteDeps['catalog']['readProduct'],
  assemble: CatalogCardEntry['assemble'] = async () => ({ kind: 'price_unavailable' }),
): RebateQuoteDeps {
  return {
    parsing: {
      parseUrl: async () => {
        throw new Error('synthetic: no url on the entry path');
      },
    },
    catalog: { readProduct, cards: () => ({ assemble }) as unknown as CatalogCardEntry },
    references: { resolve: async () => ({ kind: 'invalid_args' }) },
  };
}

function texts(_app: string, key: string): Promise<string> {
  return Promise.resolve(`[${key}]`);
}

it('[B3-05q][BR-AI-15][BR-AI-04] quote：已下架、认不出是上游对商品的答复；50301、其他异常是服务端原因；price_unavailable 照传', async () => {
  const cases: readonly [unknown, unknown][] = [
    [
      new ParsingError(OFF_SHELF, 'synthetic'),
      { kind: 'parse_error', error_code: 30141, cards: [] },
    ],
    [new ParsingError(30132, 'synthetic'), { kind: 'parse_error', error_code: 30132, cards: [] }],
    [new ParsingError(50301, 'synthetic'), { kind: 'server_failed' }],
    [new Error('synthetic upstream timeout'), { kind: 'server_failed' }],
  ];
  for (const [error, expected] of cases) {
    const readProduct = vi.fn<RebateQuoteDeps['catalog']['readProduct']>(async () => {
      throw error;
    });
    const readers = createScenarioEntryReaders({
      quote: quoteDeps(readProduct),
      handoff: { texts },
    });
    expect(await readers.quote(KEY, context())).toEqual(expected);
    expect(readProduct).toHaveBeenCalledExactlyOnceWith(KEY, expect.anything());
  }

  const priced = createScenarioEntryReaders({
    quote: quoteDeps(async () => PRODUCT),
    handoff: { texts },
  });
  expect(await priced.quote(KEY, context())).toEqual({ kind: 'price_unavailable', cards: [] });

  const thrownCard = createScenarioEntryReaders({
    quote: quoteDeps(
      async () => PRODUCT,
      async () => {
        throw new Error('synthetic registration failure');
      },
    ),
    handoff: { texts },
  });
  expect(await thrownCard.quote(KEY, context())).toEqual({ kind: 'server_failed' });
});

function orderDeps(get: AgentCapableOrderQueries['get']): OrderToolsDeps {
  return {
    orders: {
      get,
      searchForAgent: async () => ({ orders: [], total: 0 }),
      findOwnByNumber: async () => [],
    },
    refs: { resolve: async () => ({ kind: 'invalid' }) },
    quota: { take: async () => true },
    clock: new FixedClock('2026-11-11T20:00:00.000Z'),
    config: async () => undefined,
    claim: {
      clicks: { read: async () => ({ logs: [], bindings: [] }) },
      clock: new FixedClock('2026-11-11T20:00:00.000Z'),
      config: async () => undefined,
      platforms: ['taobao', 'jd', 'pdd'],
      cardReference: () => {
        throw new Error('synthetic: no card reference on the entry path');
      },
    },
    handoff: { texts },
    cardReference: () => {
      throw new Error('synthetic: no card reference on the entry path');
    },
    texts,
  };
}

it('[B3-05q][BR-AI-07][BR-AI-01] order：只在调用者名下取这一笔；名下有 → order_status 卡；不在名下 → 与 0 笔相同的 handoff 卡', async () => {
  const detail = {
    order_id: ORDER,
    platform: 'taobao',
    title: '合成订单商品',
    is_other_product: false,
    display_status: 'PAID',
    reason: null,
    est_rebate_fen: 1,
    expected_credit_period: '2026-12',
    credit_overdue: true,
  };
  const get = vi.fn<AgentCapableOrderQueries['get']>(async (subject, orderId) =>
    subject.user_id === 'synthetic-user' && orderId === ORDER
      ? (detail as unknown as Awaited<ReturnType<AgentCapableOrderQueries['get']>>)
      : null,
  );
  const readers = createScenarioEntryReaders({
    quote: quoteDeps(async () => PRODUCT),
    orders: orderDeps(get),
    handoff: { texts },
  });
  const own = await readers.order(ORDER, context());
  expect(get).toHaveBeenCalledExactlyOnceWith(
    { app_id: 'synthetic-app', user_id: 'synthetic-user' },
    ORDER,
  );
  expect(own).toMatchObject({
    kind: 'ok',
    cards: [
      {
        type: 'order_status',
        // An overdue order shows no expired month (the detail cut of explain_order).
        data: { order_id: ORDER, display_status: 'PAID', expected_credit_period: null },
      },
    ],
    trace: { orders: [{ reason_code: null, display_status: 'PAID' }] },
  });
  // No card reference on the entry path: the model view carries no card_id.
  expect(JSON.stringify(own.modelView)).not.toContain('card_id');

  const others = await readers.order(ORDER, context({ userId: 'synthetic-other-user' }));
  expect(others).toMatchObject({
    kind: 'ok',
    cards: [
      {
        type: 'handoff',
        data: { entry: 'AgentChat', summary: '[agent.card.handoff.desc]' },
        fallback_text: '[agent.card.handoff.title]',
      },
    ],
    trace: { orders: [] },
  });

  const noOrders = createScenarioEntryReaders({
    quote: quoteDeps(async () => PRODUCT),
    handoff: { texts },
  });
  expect(await noOrders.order(ORDER, context())).toEqual({
    kind: 'failed',
    modelView: { error: 'tool_failed' },
  });
});

it('[B3-05q][BR-AI-05] resolve：就是 get_rebate_quote 自己的引用解析（只读，不查 catalog）', async () => {
  const readProduct = vi.fn<RebateQuoteDeps['catalog']['readProduct']>(async () => PRODUCT);
  const deps = quoteDeps(readProduct);
  const resolve = vi.fn<RebateQuoteDeps['references']['resolve']>(async () => ({
    kind: 'product',
    productKey: KEY,
  }));
  const readers = createScenarioEntryReaders({
    quote: { ...deps, references: { resolve } },
    handoff: { texts },
  });
  const ctx = context();
  expect(await readers.resolve({ ref_ordinal: 1 }, ctx)).toEqual({
    kind: 'product',
    productKey: KEY,
  });
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ ref_ordinal: 1 }, ctx);
  expect(readProduct).not.toHaveBeenCalled();
});
