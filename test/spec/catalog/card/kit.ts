import { expect, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type {
  ProductRef,
  RebateQuote,
  Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type {
  AssembleCardInput,
  CardAssembler,
  CardAssemblerOptions,
  CardQuoteContext,
  CardRebateQuoter,
  DemoRebateQuoterOptions,
  ProductCard,
} from '../../../../apps/api/src/modules/catalog/application/card-assembler.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';

export const QUOTED_AT = '2026-10-06T10:00:00+08:00';

export function assemblerFactory(): (options: CardAssemblerOptions) => CardAssembler {
  const exports = catalog as unknown as Record<string, unknown>;
  expect(exports['createCardAssembler'], 'catalog 公共入口导出 CardAssembler').toBeTypeOf(
    'function',
  );
  return exports['createCardAssembler'] as (options: CardAssemblerOptions) => CardAssembler;
}

export function demoFactory(): (options: DemoRebateQuoterOptions) => CardRebateQuoter {
  const exports = catalog as unknown as Record<string, unknown>;
  expect(exports['createDemoRebateQuoter'], 'catalog 公共入口导出演示报价').toBeTypeOf('function');
  return exports['createDemoRebateQuoter'] as (
    options: DemoRebateQuoterOptions,
  ) => CardRebateQuoter;
}

export function item(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'taobao',
    item_id: 'synthetic-item',
    title: '合成商品',
    price_fen: 12000n,
    coupon_fen: 2000n,
    final_price_fen: 10000n,
    commission_rate_bp: 1000n,
    quoted_at: QUOTED_AT,
    ...overrides,
  };
}

export function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return { appId: 'card-app-a', userId: 'viewer-a', deviceId: 'device-a', ...overrides };
}

export function ref(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    appId: 'card-app-a',
    platform: 'taobao',
    productKey: 'tb:synthetic',
    rawItemId: 'synthetic-item',
    rawFetchedAt: QUOTED_AT,
    receivedAt: QUOTED_AT,
    canonicalUrl: null,
    title: '合成商品',
    shopId: null,
    shopType: null,
    source: 'search',
    ...overrides,
  };
}

export function request(overrides: Partial<AssembleCardInput> = {}): AssembleCardInput {
  return { item: item(), ref: ref(), entrySource: 'search', stale: false, ...overrides };
}

/** B1-05zc (D10-641): a pre-order quote is one amount, rebate_basis normal, min = max. */
export function quote(overrides: Partial<RebateQuote> = {}): RebateQuote {
  return {
    rebateMinFen: 433n,
    rebateMaxFen: 433n,
    estNetPriceFen: 9567n,
    rebateBasis: 'normal',
    ...overrides,
  };
}

/**
 * The old compare range (211–433). The fixture answers it to any non-normal context, so an
 * assembler that still asks for price_compare_risk shows it and fails the single-value checks.
 * Cast: the quote type may lose price_compare_risk with the implementation.
 */
export function compareQuote(
  overrides: Partial<Pick<RebateQuote, 'rebateMinFen' | 'rebateMaxFen' | 'estNetPriceFen'>> = {},
): RebateQuote {
  return {
    ...quote({ rebateMinFen: 211n, estNetPriceFen: 9789n, ...overrides }),
    rebateBasis: 'price_compare_risk',
  } as unknown as RebateQuote;
}

/**
 * The basis a card asked the quoter for. Read loosely: the context type may lose the
 * price_compare_risk member (or the field) with the implementation.
 */
function requestedBasis(context: CardQuoteContext | undefined): unknown {
  return (context as { readonly rebateBasis?: unknown } | undefined)?.rebateBasis;
}

/**
 * B1-05zc: the quote port answers the basis it was asked for, as a real quoter does. A single
 * normal amount set by a test (e.g. `mockResolvedValue(quote())`) is returned unchanged to a
 * normal request; to a request for any other basis (an assembler still asking for
 * price_compare_risk) it comes back on that basis with the same amounts, so such an assembler
 * shows a non-normal card and fails assertions rather than its own basis check.
 */
function answerRequestedBasis(answer: RebateQuote, context: CardQuoteContext | undefined) {
  const basis = requestedBasis(context);
  if (basis === undefined || basis === 'normal' || answer.rebateBasis !== 'normal') return answer;
  return { ...answer, rebateBasis: basis } as unknown as RebateQuote;
}

/** Deliberately non-formula amounts: assembler must delegate, not duplicate quote arithmetic. */
export function fixture() {
  const create = assemblerFactory();
  const clock = new FixedClock('2026-10-06T10:05:00+08:00');
  const current = vi.fn(async () => viewer());
  const quoted = vi.fn(async (_item: UnionItem, _viewer: Viewer, context?: CardQuoteContext) =>
    requestedBasis(context) === 'normal' ? quote() : compareQuote(),
  );
  const register = vi.fn(async () => ({ linkId: 'registered-link' }));
  const entrySource = vi.fn(async (): Promise<string | null> => null);
  const issue = vi.fn(() => 'opaque-item-ref');
  const service = create({
    clock,
    viewerContext: { current },
    quoter: {
      quote: async (value: UnionItem, who: Viewer, context?: CardQuoteContext) =>
        answerRequestedBasis(await quoted(value, who, context), context),
    },
    registrar: { register },
    sourceLinks: { entrySource },
    itemRefs: { issue },
  });
  return { service, clock, current, quoted, register, entrySource, issue };
}

/** ProductCard JSON fields are numbers; every amount comparison is in integer fen bigint. */
export function fen(value: number | null): bigint {
  expect(value).not.toBeNull();
  expect(Number.isSafeInteger(value)).toBe(true);
  return BigInt(value!);
}

export function amounts(card: ProductCard) {
  return {
    price: fen(card.price_fen),
    coupon: fen(card.coupon_fen),
    final: fen(card.final_price_fen),
    min: fen(card.rebate_min_fen),
    max: fen(card.rebate_max_fen),
    net: card.est_net_price_fen === null ? null : fen(card.est_net_price_fen),
  };
}
