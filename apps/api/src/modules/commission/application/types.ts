import type { components } from '@couli/contracts-ts';
import type {
  CardQuoteContext,
  CardRebateQuoter,
  RebateQuote,
  Viewer,
} from '../../catalog/index.ts';
import type { UnionItem } from '../../union/index.ts';

/**
 * Configuration keys a quote reads (all in the viewer's app scope); an open pre-reads all.
 * rebate.taobao.compare_rate_ratio_bp is not among them (D10-641: stays registered in content,
 * never read by a quote).
 */
export type COMMISSION_QUOTE_CONFIG_KEYS = readonly [
  'commission.platforms',
  'tech_fee_bp',
  'union.pdd.self_buy_factor_bp',
  'union.pdd.account_level_factor_bp',
];

export const COMMISSION_QUOTE_CONFIG_KEYS: COMMISSION_QUOTE_CONFIG_KEYS = Object.freeze([
  'commission.platforms',
  'tech_fee_bp',
  'union.pdd.self_buy_factor_bp',
  'union.pdd.account_level_factor_bp',
] as const);

/** Cards supply self; the commission port also accepts callers' share quotes. */
export interface CommissionQuoteContext extends Omit<CardQuoteContext, 'buyType'> {
  readonly buyType: components['schemas']['OrderScope'];
}

export interface CommissionRebateQuoter extends CardRebateQuoter {
  quote(item: UnionItem, viewer: Viewer, context?: CommissionQuoteContext): Promise<RebateQuote>;
}
