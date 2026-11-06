// B1-05zh (S-19, D10-713, BR-PROD-04): the Agent rebate_quote card (agent/tools/quote/index.ts, both
// the get_rebate_quote handler and the link runner) copies the catalog card's price_spec_hint. The
// catalog card comes from the real card entry, so the decision is the catalog one; a catalog value
// patched in shows the Agent card copies rather than recomputes. The quote card's match_tag stays
// matched and does not move the hint. Read loosely: the Agent card type gains the field with CT-26v.
import { expect, it, vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
  type CatalogCardResult,
  type ProductCard,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ParsedUrlProduct } from '../../../../apps/api/src/modules/parsing/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  createLinkQuoteRunner,
  createRebateQuoteHandler,
  type RebateQuoteDeps,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { APP_ID, EXPECTED, SHAPES, expectHint, itemOf, ports, refOf, type Shape } from './kit.ts';

const candidate = { kind: 'url' as const, raw: 'https://example.invalid/spec-hint', index: 0 };

function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: APP_ID,
    userId: 'spec-hint-user',
    deviceId: 'spec-hint-device',
    phoneBound: true,
    runId: 'spec-hint-run',
    sessionId: 'spec-hint-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...overrides,
  };
}

/** Quote-tool ports over the real catalog card entry; `patch` overlays the catalog card fields. */
function fixture(shape: Shape, patch: Readonly<Record<string, unknown>> = {}) {
  const p = ports();
  const entry = createCatalogCardEntry({ ...p.options, logger: { warn: vi.fn() } });
  const product: ParsedUrlProduct = {
    item: itemOf(shape),
    ref: refOf(shape, { source: 'parse' }),
  };
  async function assemble(input: CatalogCardInput): Promise<CatalogCardResult> {
    const result = await entry.assemble(input);
    if (result.kind !== 'prepared') return result;
    return {
      kind: 'prepared',
      card: { ...result.card, ...patch },
      commit: async () => ({ ...(await result.commit()), ...patch }) as ProductCard,
    };
  }
  const deps: RebateQuoteDeps = {
    parsing: { parseUrl: async () => product },
    catalog: { readProduct: async () => product, cards: () => ({ assemble }) },
    references: {
      resolve: async () => ({ kind: 'product', productKey: product.ref.productKey }),
    },
  };
  return { deps, product, register: p.register };
}

function productOf(cards: readonly UnnumberedCard[]): Record<string, unknown> {
  expect(cards).toHaveLength(1);
  const card = cards[0] as unknown as Record<string, unknown>;
  expect(card['type']).toBe('rebate_quote');
  const data = card['data'] as Record<string, unknown>;
  return data['product'] as Record<string, unknown>;
}

for (const shape of SHAPES) {
  const expected = EXPECTED[shape];

  it(`[AC-B1-05zh#21][BR-PROD-04] ${shape} 链接识别报价卡（resolve_link）带目录判定 ${String(expected)}`, async () => {
    const f = fixture(shape);
    const outcome = await createLinkQuoteRunner(f.deps).run(candidate, context());
    expect(outcome.kind).toBe('ok');
    const product = productOf(outcome.cards);
    expect(product['product_key']).toBe(f.product.ref.productKey);
    expect(product['match_tag']).toBe('matched');
    expectHint(product, expected);
  });

  it(`[AC-B1-05zh#22][BR-PROD-04] ${shape} get_rebate_quote（情境 product_key）报价卡带目录判定 ${String(expected)}`, async () => {
    const f = fixture(shape);
    const key = f.product.ref.productKey;
    const outcome = await createRebateQuoteHandler(f.deps).run(
      { product_key: key },
      context({ context: { product_key: key } }),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const product = productOf(outcome.cards);
    expect(product['product_key']).toBe(key);
    expectHint(product, expected);
    expect(f.register).toHaveBeenCalledTimes(1);
  });
}

it.each([
  { shape: 'taobao', hint: 'price_from' },
  { shape: 'taobao', hint: null },
  { shape: 'jd_sku', hint: 'spec_uncertain' },
  { shape: 'jd_sku', hint: 'price_from' },
  { shape: 'jd_item', hint: null },
] as const)(
  '[AC-B1-05zh#23][BR-PROD-04] Agent 报价卡照抄目录卡的值（$shape 目录卡给 $hint），不按平台自行重算',
  async ({ shape, hint }) => {
    const f = fixture(shape, { price_spec_hint: hint });
    const viaRunner = await createLinkQuoteRunner(f.deps).run(candidate, context());
    expect(viaRunner.kind).toBe('ok');
    expectHint(productOf(viaRunner.cards), hint);

    const viaHandler = await createRebateQuoteHandler(f.deps).run({ card_id: 'c1' }, context());
    expect(viaHandler.kind).toBe('ok');
    if (viaHandler.kind !== 'ok') return;
    const product = productOf(viaHandler.cards);
    expect(product['match_tag']).toBe('matched');
    expectHint(product, hint);
  },
);
