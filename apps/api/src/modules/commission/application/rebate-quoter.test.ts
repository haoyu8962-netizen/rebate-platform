import { expect, it } from 'vitest';
import type { CatalogConfigReader } from '../../catalog/index.ts';
import type { UserLevelReader } from '../../identity/index.ts';
import { FixedClock } from '../../platform/index.ts';
import type { UnionItem } from '../../union/index.ts';
import type { RuleVersion } from '../domain/rules.ts';
import { createCommissionRebateQuoter } from './rebate-quoter.ts';

const APP = 'unit-app';
const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

function version(id: string, effective: string, ownBp: number): RuleVersion {
  return {
    rule_version_id: id,
    effective_from: new Date(effective),
    indirect_enabled: false,
    rules: PLATFORMS.flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: ownBp,
          r_direct_bp: 1000,
          r_indirect_bp: 0,
        })),
      ),
    ),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 0 })),
  };
}

const CONFIG = new Map<string, unknown>([
  ['commission.platforms', [...PLATFORMS]],
  ['tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 }],
]);

const config: CatalogConfigReader = {
  configValue: async (_appId, key) => {
    const value = CONFIG.get(key);
    return value === undefined ? null : ({ value, version: 1 } as never);
  },
};

// gross = floor(10000 × 1000 / 10000) = 1000，fee 0 → N = 1000，reserve 0。
const ITEM: UnionItem = {
  platform: 'taobao',
  item_id: 'unit-item',
  title: '单元测试商品',
  price_fen: 10000n,
  coupon_fen: 0n,
  final_price_fen: 10000n,
  commission_rate_bp: 1000n,
  quoted_at: '2026-10-31T00:00:00+08:00',
};
const NORMAL = { buyType: 'self', entrySource: 'pool', rebateBasis: 'normal' } as const;

const V1 = version('v1', '2026-10-01T00:00:00+08:00', 5000);
const V2 = version('v2', '2026-11-01T00:00:00+08:00', 4000);

it('[AC-B2-03c-UNIT#4] live 报价按读端口之前的时刻选版本：读规则期间跨过 v2 生效时刻仍用 v1', async () => {
  const clock = new FixedClock('2026-10-31T23:59:59.100+08:00');
  const levels: UserLevelReader = { levelOf: async () => 'L1' };
  const quoter = createCommissionRebateQuoter({
    rules: {
      publishedVersions: async () => {
        // 读取慢：返回前时钟已到次日 00:00:00.100（v2 可能已在此期间被撤销）。
        clock.set('2026-11-01T00:00:00.100+08:00');
        return [V1, V2];
      },
    },
    levels,
    config,
    clock,
  });
  // v1 本人 = floor(1000 × 5000 / 10000) = 500；误用读后时刻会选 v2 得 400。
  expect(await quoter.quote(ITEM, { appId: APP, userId: null, deviceId: null }, NORMAL)).toEqual({
    rebateMinFen: 500n,
    rebateMaxFen: 500n,
    estNetPriceFen: 9500n,
    rebateBasis: 'normal',
  });
});

it('[AC-B2-03c-UNIT#5] live 报价在等级读取期间跨过生效时刻也不改用新版本', async () => {
  const clock = new FixedClock('2026-10-31T23:59:59.100+08:00');
  const quoter = createCommissionRebateQuoter({
    rules: { publishedVersions: async () => [V1, V2] },
    levels: {
      levelOf: async () => {
        clock.set('2026-11-01T00:00:00.100+08:00');
        return 'L2';
      },
    },
    config,
    clock,
  });
  const quote = await quoter.quote(ITEM, { appId: APP, userId: 'u1', deviceId: null }, NORMAL);
  expect(quote.rebateMaxFen).toBe(500n);
  // 下一次报价在新时刻读时钟，v2 已生效：floor(1000 × 4000 / 10000) = 400。
  const next = await quoter.quote(ITEM, { appId: APP, userId: 'u1', deviceId: null }, NORMAL);
  expect(next.rebateMaxFen).toBe(400n);
});

it('[AC-B1-05zc-UNIT#1] D10-641：price_compare_risk 口径一律拒绝（TypeError），省略 context 的淘宝报单值', async () => {
  const keys: string[] = [];
  const quoter = createCommissionRebateQuoter({
    rules: { publishedVersions: async () => [V1] },
    levels: { levelOf: async () => 'L1' },
    config: {
      configValue: async (appId, key) => {
        keys.push(key);
        return config.configValue(appId, key);
      },
    },
    clock: new FixedClock('2026-10-31T12:00:00+08:00'),
  });
  const guest = { appId: APP, userId: null, deviceId: null };
  const compare = { ...NORMAL, rebateBasis: 'price_compare_risk' } as const;
  for (const platform of PLATFORMS) {
    await expect(quoter.quote({ ...ITEM, platform }, guest, compare)).rejects.toThrow(TypeError);
  }
  expect(keys).toEqual([]);
  expect(await quoter.quote(ITEM, guest)).toEqual({
    rebateMinFen: 500n,
    rebateMaxFen: 500n,
    estNetPriceFen: 9500n,
    rebateBasis: 'normal',
  });
  expect(keys).not.toContain('rebate.taobao.compare_rate_ratio_bp');
});
