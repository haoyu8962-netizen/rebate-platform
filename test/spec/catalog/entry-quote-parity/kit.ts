// B1-05zc rule-test kit (D10-641; 08 BR-PRICE-07, BR-CALC-20; 规划变更记录 20261105-返利按接口实际金额展示).
// Before an order the rebate is one amount computed from the union commission field: no
// price_compare_risk, no range, rebate.taobao.compare_rate_ratio_bp is never read. Every case
// prices the same synthetic taobao item (券前 3990、券 1000、券后 2990、佣金率 2000bp, the BR-CALC-20
// example) with the real commission quoter and with the demo quoter; both configurations
// deliberately carry compare_rate_ratio_bp = 5000. Expected: N = 598 − ⌊598 × 10%⌋ = 539, reserve 0,
// own share 50% → 269 fen, est_net_price_fen = 2990 − 269 = 2721 (the old range lower bound would be
// 135). Synthetic DTOs only; no platform recording, network or database here.
import { vi } from 'vitest';
import {
  createDemoRebateQuoter,
  type CardQuoteContext,
  type CardRebateQuoter,
  type CatalogConfigReader,
  type ProductRef,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import { commission, NOW as RULES_NOW, version } from '../../commission/quoter/fixtures.ts';

export const COMPARE_KEY = 'rebate.taobao.compare_rate_ratio_bp';
export const DEMO_RULE_KEY = 'demo.parity.quote_rule';
export const NOW = '2026-11-05T10:00:00+08:00';

/** The four price fields every entry gets for the same product. */
export const PRICE = {
  price_fen: 3990n,
  coupon_fen: 1000n,
  final_price_fen: 2990n,
  commission_rate_bp: 2000n,
} as const;

/** What every pre-order card of PRICE shows, whichever entry it came through. */
export const SINGLE = {
  rebate_basis: 'normal',
  rebate_min_fen: 269,
  rebate_max_fen: 269,
  est_net_price_fen: 2721,
  disclaimer_keys: ['price_basis', 'rebate_estimate'],
} as const;

/** The amounts of SINGLE (Agent cards add their own disclosure key to disclaimer_keys). */
export const SINGLE_AMOUNTS = {
  rebate_basis: SINGLE.rebate_basis,
  rebate_min_fen: SINGLE.rebate_min_fen,
  rebate_max_fen: SINGLE.rebate_max_fen,
  est_net_price_fen: SINGLE.est_net_price_fen,
} as const;

/** The quote port's own answer for PRICE. */
export const SINGLE_QUOTE = {
  rebateMinFen: 269n,
  rebateMaxFen: 269n,
  estNetPriceFen: 2721n,
  rebateBasis: 'normal',
} as const;

export type QuoterKind = 'commission' | 'demo';
export const QUOTER_KINDS: readonly QuoterKind[] = ['commission', 'demo'];

export type ConfigValue = NonNullable<
  Awaited<ReturnType<CatalogConfigReader['configValue']>>
>['value'];

/** One configuration for both quoters, the same in every app scope; compare 5000 on purpose. */
export function quoteConfig() {
  const values = new Map<string, ConfigValue>([
    ['commission.platforms', ['taobao', 'jd', 'pdd']],
    ['tech_fee_bp', { taobao: 1000, jd: 1000, pdd: 1000 }],
    [COMPARE_KEY, 5000],
    ['union.pdd.self_buy_factor_bp', 7500],
    ['union.pdd.account_level_factor_bp', 10000],
    [DEMO_RULE_KEY, { reserve_bp: 0, self_share_bp: 5000 }],
  ]);
  const configValue = vi.fn<CatalogConfigReader['configValue']>(async (_appId, key) => {
    const value = values.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  return { values, configValue };
}

export type QuoteConfig = ReturnType<typeof quoteConfig>;

/** Keys the quoter asked the configuration for (any app scope). */
export function readKeys(config: QuoteConfig): string[] {
  return config.configValue.mock.calls.map(([, key]) => key);
}

/**
 * The real commission quoter (published version: reserve 0, L1 own share 50%; every viewer L1)
 * or the demo quoter (reserve 0, self share 50%), behind a recorder of the contexts it received.
 */
export function quoterOf(kind: QuoterKind) {
  const config = quoteConfig();
  const inner: CardRebateQuoter =
    kind === 'commission'
      ? commission.createCommissionRebateQuoter({
          rules: { publishedVersions: async () => [version()] },
          levels: { levelOf: async () => 'L1' as const },
          config: { configValue: config.configValue },
          clock: new FixedClock(RULES_NOW),
        })
      : createDemoRebateQuoter({
          appEnv: 'test',
          unionMode: 'demo',
          config: { configValue: config.configValue },
          ruleConfigKey: DEMO_RULE_KEY,
        });
  const contexts: (CardQuoteContext | undefined)[] = [];
  const quoter: CardRebateQuoter = {
    quote: async (item, viewer, context) => {
      contexts.push(context);
      return inner.quote(item, viewer, context);
    },
  };
  return { kind, quoter, config, contexts };
}

export type ParityQuoter = ReturnType<typeof quoterOf>;

export function tbItem(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'taobao',
    item_id: 'synthetic-parity-001',
    title: '合成比价一致商品',
    ...PRICE,
    quoted_at: NOW,
    ...overrides,
  };
}

export function tbRef(appId: string, source: ProductRef['source'], at = NOW): ProductRef {
  return {
    appId,
    platform: 'taobao',
    productKey: 'tb:001',
    rawItemId: 'synthetic-parity-001',
    rawFetchedAt: at,
    receivedAt: at,
    canonicalUrl: null,
    title: '合成比价一致商品',
    shopId: null,
    shopType: null,
    source,
  };
}

export function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    appId: 'synthetic-parity',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    ...overrides,
  };
}

/** The rebate fields a card shows (ProductCard, a feed item, a detail or an Agent product). */
export function shown(card: object) {
  const fields = card as Record<string, unknown>;
  return {
    rebate_basis: fields['rebate_basis'],
    rebate_min_fen: fields['rebate_min_fen'],
    rebate_max_fen: fields['rebate_max_fen'],
    est_net_price_fen: fields['est_net_price_fen'],
    disclaimer_keys: fields['disclaimer_keys'],
  };
}

/** shown() without disclaimer_keys. */
export function amountsOf(card: object) {
  const { rebate_basis, rebate_min_fen, rebate_max_fen, est_net_price_fen } = shown(card);
  return { rebate_basis, rebate_min_fen, rebate_max_fen, est_net_price_fen };
}

/** Rejections become values, so an old-code failure is an assertion mismatch, not a throw. */
export async function observed<T>(action: () => Promise<T>) {
  try {
    return { outcome: 'returned' as const, value: await action() };
  } catch (error: unknown) {
    return { outcome: 'rejected' as const, error };
  }
}

/** A context outside the card types: price_compare_risk is refused, never quoted as a range. */
export function compareContext(entrySource: string | null = 'search'): CardQuoteContext {
  return {
    buyType: 'self',
    entrySource,
    rebateBasis: 'price_compare_risk',
  } as unknown as CardQuoteContext;
}
