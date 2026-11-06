import { describe, expect, it, vi } from 'vitest';
import type { CatalogCardInput, ProductCard } from '../../../catalog/index.ts';
import type { ParsedUrlProduct } from '../../../parsing/index.ts';
import {
  cardReference as coreCardReference,
  openCardCall,
} from '../../orchestrator/core/card-references.ts';
import type { ToolCallContext } from '../registry/index.ts';
import { createLinkQuoteRunner, createRebateQuoteHandler, type RebateQuoteDeps } from './index.ts';

// Synthetic data only (example.invalid, synthetic ids); no I/O.
const KEY = 'jd:synthetic-unit';

function product(): ParsedUrlProduct {
  return {
    item: {
      platform: 'jd',
      itemId: 'synthetic-unit',
      title: '合成单测商品',
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      commission_rate_bp: 1000n,
      quoted_at: '2026-10-15T08:00:00+08:00',
    },
    ref: {
      appId: 'synthetic-app',
      platform: 'jd',
      productKey: KEY,
      rawItemId: 'synthetic-unit',
      rawFetchedAt: '2026-10-15T08:00:00+08:00',
      receivedAt: '2026-10-15T00:00:00.000Z',
      canonicalUrl: null,
      title: '合成单测商品',
      shopId: null,
      shopType: null,
      source: 'parse',
    },
  };
}

function productCard(): ProductCard {
  return {
    product_key: KEY,
    item_ref: 'synthetic-item-ref',
    platform: 'jd',
    shop_type: null,
    title: '合成单测商品',
    image: null,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    est_net_price_fen: 2853,
    rebate_min_fen: 137,
    rebate_max_fen: 137,
    rebate_basis: 'normal',
    benefit_tags: ['有券'],
    is_presale: false,
    link_id: 'synthetic-link',
    // A retired key on the incoming card: the delivered button is re-keyed from rebate_basis.
    cta: { text_key: 'btn.buy.coupon' },
    quoted_at: '2026-10-15T08:00:00+08:00',
    stale: false,
    age_sec: 0,
    source: 'jd_union',
    disclaimer_keys: ['price_basis', 'rebate_estimate'],
    availability: 'ok',
  };
}

function setup(options: { cardReference?: RebateQuoteDeps['cardReference']; noCard?: boolean }) {
  const assemble = vi.fn(async (input: CatalogCardInput) => {
    void input;
    if (options.noCard === true) return { kind: 'price_unavailable' as const };
    const { link_id, ...unlinked } = productCard();
    void link_id;
    return { kind: 'prepared' as const, card: unlinked, commit: async () => productCard() };
  });
  const deps: RebateQuoteDeps = {
    parsing: { parseUrl: vi.fn(async () => product()) },
    catalog: { readProduct: vi.fn(async () => product()), cards: () => ({ assemble }) },
    references: { resolve: vi.fn(async () => ({ kind: 'product' as const, productKey: KEY })) },
    ...(options.cardReference === undefined ? {} : { cardReference: options.cardReference }),
  };
  return { deps, assemble };
}

function context(placeholders: Readonly<Record<string, string>> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: false,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    context: { product_key: KEY },
    placeholders,
  };
}

describe('B3-04c get_rebate_quote card references (B3-05i)', () => {
  it('[AC-B3-04c#unit-1] the model view carries the whole reference of outcome.cards[0]', async () => {
    const cardReference = vi.fn((_ctx: ToolCallContext, index: number) => `@ref-${index}`);
    const { deps } = setup({ cardReference });
    const ctx = context();
    const outcome = await createRebateQuoteHandler(deps).run({ product_key: KEY }, ctx);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.cards).toHaveLength(1);
    expect(outcome.cards[0]?.type).toBe('rebate_quote');
    expect(cardReference).toHaveBeenCalledExactlyOnceWith(ctx, 0);
    expect(outcome.modelView).toEqual({
      products: [
        {
          card_id: '@ref-0',
          title: '<untrusted>合成单测商品</untrusted>',
          platform: 'jd',
          benefit_tags: ['有券'],
        },
      ],
    });
  });

  it('[AC-B3-04c#unit-2] the core resolves the reference to the delivered frame card_id', async () => {
    const table = Object.freeze({});
    const call = openCardCall('synthetic-call', table);
    // The production port: bound to this call through the placeholders table identity.
    const { deps } = setup({ cardReference: coreCardReference });
    const outcome = await createRebateQuoteHandler(deps).run({ product_key: KEY }, context(table));
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    call.delivered('c7');
    expect(call.view(outcome.modelView)).toEqual({
      products: [
        {
          card_id: 'c7',
          title: '<untrusted>合成单测商品</untrusted>',
          platform: 'jd',
          benefit_tags: ['有券'],
        },
      ],
    });
  });

  it('[AC-B3-04c#unit-3] no card goes out: no reference is issued', async () => {
    const cardReference = vi.fn(() => '@ref');
    const { deps } = setup({ cardReference, noCard: true });
    const outcome = await createRebateQuoteHandler(deps).run({ product_key: KEY }, context());
    expect(outcome.kind).toBe('failed');
    expect(cardReference).not.toHaveBeenCalled();
  });

  it('[AC-B3-04c#unit-4] the deterministic runner also references its quote card', async () => {
    const cardReference = vi.fn((_ctx: ToolCallContext, index: number) => `@ref-${index}`);
    const { deps } = setup({ cardReference });
    const outcome = await createLinkQuoteRunner(deps).run(
      { kind: 'url', raw: 'https://example.invalid/synthetic', index: 0 },
      context(),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.cards).toHaveLength(1);
    expect(cardReference).toHaveBeenCalledWith(expect.anything(), 0);
    expect(outcome.modelView).toMatchObject({ products: [{ card_id: '@ref-0' }] });
  });
});

describe('B1-05zg get_rebate_quote buy button (BR-TEXT-12)', () => {
  it('[AC-B1-05zg#unit-quote] the delivered button follows rebate_basis, not the incoming key', async () => {
    const { deps } = setup({});
    const outcome = await createRebateQuoteHandler(deps).run({ product_key: KEY }, context());
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const data = outcome.cards[0]?.data as { product: Record<string, unknown> };
    expect(data.product['rebate_basis']).toBe('normal');
    expect(data.product['cta']).toEqual({ text_key: 'btn.buy.rebate' });
  });
});
