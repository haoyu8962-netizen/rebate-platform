// Synthetic normalized inputs only; no platform recordings, network, or persistence.
import { vi } from 'vitest';
import type {
  CatalogConfigReader,
  Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type {
  CommissionQuoteContext,
  CommissionRebateQuoter,
} from '../../../../apps/api/src/modules/commission/application/types.ts';
import type {
  RuleSetReader,
  RuleVersion,
} from '../../../../apps/api/src/modules/commission/domain/rules.ts';
import type {
  UserLevelReader,
  UserLevel,
} from '../../../../apps/api/src/modules/identity/ports/user-level.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';

// Match the identity rule tests: exercise the public entry at runtime without pulling
// Nest parameter decorators into the test project's erasable-only TypeScript graph.
export const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  createCommissionRebateQuoter(options: {
    rules: RuleSetReader;
    levels: UserLevelReader;
    config: CatalogConfigReader;
    clock: FixedClock;
  }): CommissionRebateQuoter;
  selectRuleVersion: typeof import('../../../../apps/api/src/modules/commission/domain/rules.ts').selectRuleVersion;
  selectQuoteTerms: typeof import('../../../../apps/api/src/modules/commission/domain/rules.ts').selectQuoteTerms;
  createRuleSetReader: typeof import('../../../../apps/api/src/modules/commission/infra/rule-set-reader.ts').createRuleSetReader;
} & Record<string, unknown>;

export const APP = 'quote-app-a';
export const OTHER_APP = 'quote-app-b';
export const NOW = '2026-11-01T00:00:00+08:00';
export const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
// B1-05zc (D10-641): a quote no longer reads rebate.taobao.compare_rate_ratio_bp, so neither the
// keys a quote reads nor an open's pre-reads contain it. Untyped on purpose: the key tuple type
// loses that member only with the implementation.
export const CONFIG_KEYS = [
  'commission.platforms',
  'tech_fee_bp',
  'union.pdd.self_buy_factor_bp',
  'union.pdd.account_level_factor_bp',
] as const;
export const NORMAL = {
  buyType: 'self',
  entrySource: 'pool',
  rebateBasis: 'normal',
} as const satisfies CommissionQuoteContext;
/**
 * B1-05zc (D10-641): a price_compare_risk context, which the quoter now refuses (never quoted as a
 * range). Cast so the tests do not depend on the context type still naming that basis.
 */
export const COMPARE = {
  buyType: 'self',
  entrySource: 'search',
  rebateBasis: 'price_compare_risk',
} as unknown as CommissionQuoteContext;
export type ConfigValue = NonNullable<
  Awaited<ReturnType<CatalogConfigReader['configValue']>>
>['value'];

export function version(overrides: Partial<RuleVersion> = {}): RuleVersion {
  return {
    rule_version_id: '00000000-0000-4000-8000-000000000001',
    effective_from: new Date('2026-10-01T00:00:00+08:00'),
    indirect_enabled: false,
    rules: PLATFORMS.flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: { L1: 5000, L2: 5500, L3: 6000 }[level],
          r_direct_bp: 1000,
          r_indirect_bp: 0,
        })),
      ),
    ),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 0 })),
    ...overrides,
  };
}

export function item(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'taobao',
    item_id: 'synthetic-product',
    title: '合成报价商品',
    price_fen: 12000n,
    coupon_fen: 2000n,
    final_price_fen: 10000n,
    commission_rate_bp: 1000n,
    quoted_at: '2026-10-10T00:00:00+08:00',
    ...overrides,
  };
}

export function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return { appId: APP, userId: null, deviceId: null, ...overrides };
}

export function fixture() {
  const versions = new Map<string, readonly RuleVersion[]>([[APP, [version()]]]);
  const userLevels = new Map<string, UserLevel | null>([
    [`${APP}/viewer-l1`, 'L1'],
    [`${APP}/viewer-l2`, 'L2'],
    [`${APP}/viewer-l3`, 'L3'],
  ]);
  const values = new Map<string, ConfigValue>([
    ['commission.platforms', [...PLATFORMS]],
    ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
    // B1-05zc: kept on purpose (5000, the old placeholder); a quote must not read it.
    ['rebate.taobao.compare_rate_ratio_bp', 5000],
    ['union.pdd.self_buy_factor_bp', 7500],
    ['union.pdd.account_level_factor_bp', 10000],
  ]);
  const configByApp = new Map([[APP, values]]);
  const publishedVersions = vi.fn<RuleSetReader['publishedVersions']>(
    async (appId) => versions.get(appId) ?? [],
  );
  const levelOf = vi.fn<UserLevelReader['levelOf']>(
    async ({ appId, userId }) => userLevels.get(`${appId}/${userId}`) ?? null,
  );
  const configValue = vi.fn<CatalogConfigReader['configValue']>(async (appId, key) => {
    const value = configByApp.get(appId)?.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  const clock = new FixedClock(NOW);
  // Always construct outside rejection assertions: NotImplemented cannot satisfy a negative case.
  const quoter = commission.createCommissionRebateQuoter({
    rules: { publishedVersions },
    levels: { levelOf },
    config: { configValue },
    clock,
  });
  return {
    quoter,
    clock,
    versions,
    userLevels,
    values,
    configByApp,
    publishedVersions,
    levelOf,
    configValue,
  };
}
