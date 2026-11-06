import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionItem } from '../../union/index.ts';
import type { ProductRef } from '../domain/types.ts';
import type { CatalogConfigReader, RebateQuote, Viewer } from '../ports.ts';
import { createCardAssembler, createDemoRebateQuoter } from './card-assembler.ts';

const AT = '2026-10-06T10:00:00+08:00';

function item(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'taobao',
    item_id: 'unit-item',
    title: 'unit',
    price_fen: 5000n,
    coupon_fen: 1000n,
    final_price_fen: 4000n,
    commission_rate_bp: 500n,
    quoted_at: AT,
    ...overrides,
  };
}

const ref: ProductRef = {
  appId: 'app-u',
  platform: 'taobao',
  productKey: 'tb:unit',
  rawItemId: 'unit-item',
  rawFetchedAt: AT,
  receivedAt: AT,
  canonicalUrl: null,
  title: 'unit',
  shopId: null,
  shopType: null,
  source: 'search',
};

function setup(quote: Partial<RebateQuote> = {}, itemRef = 'ref-token') {
  const viewer: Viewer = { appId: 'app-u', userId: null, deviceId: null };
  const register = vi.fn(async () => ({ linkId: 'link-u' }));
  const service = createCardAssembler({
    clock: new FixedClock(AT),
    viewerContext: { current: async () => viewer },
    quoter: {
      quote: async () => ({
        rebateMinFen: 20n,
        rebateMaxFen: 20n,
        estNetPriceFen: 3980n,
        rebateBasis: 'normal',
        ...quote,
      }),
    },
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => itemRef },
  });
  return { service, register };
}

describe('createCardAssembler guards', () => {
  it('[AC-B1-05f] BR-PRICE-01: refuses an anomalous price instead of showing 0 yuan', async () => {
    const { service, register } = setup();
    for (const bad of [
      item({ price_fen: 0n, coupon_fen: 0n, final_price_fen: 0n }),
      item({ coupon_fen: 5000n, final_price_fen: 0n }),
      item({ final_price_fen: 4001n }),
    ]) {
      await expect(
        service.assemble({ item: bad, ref, entrySource: 'search', stale: false }),
      ).rejects.toThrow(TypeError);
    }
    expect(register).not.toHaveBeenCalled();
  });

  it('[AC-B1-05f] BR-PRICE-11: a quoted_at without an offset is refused', async () => {
    const { service } = setup();
    await expect(
      service.assemble({
        item: item({ quoted_at: '2026-10-06T10:00:00' }),
        ref,
        entrySource: 'search',
        stale: false,
      }),
    ).rejects.toThrow(/offset/u);
  });

  it('[AC-B1-05f] quote with a mismatched basis or inverted bounds is not registered', async () => {
    for (const quote of [
      // D10-641: a compare range (or a compare basis at all) is never shown before an order.
      { rebateBasis: 'price_compare_risk' as const },
      { rebateMinFen: 10n, rebateBasis: 'price_compare_risk' as const },
      { rebateMinFen: 10n },
      { rebateMinFen: 30n },
      { rebateMinFen: null },
    ]) {
      const { service, register } = setup(quote);
      await expect(
        service.assemble({ item: item(), ref, entrySource: 'search', stale: false }),
      ).rejects.toThrow(/quote rejected/u);
      expect(register).not.toHaveBeenCalled();
    }
  });

  it('[AC-B1-05f] BR-PROD-11: an item_ref over 1024 characters yields no card and no link', async () => {
    const { service, register } = setup({}, 'x'.repeat(1025));
    await expect(
      service.assemble({ item: item(), ref, entrySource: 'search', stale: false }),
    ).rejects.toThrow(/item_ref/u);
    expect(register).not.toHaveBeenCalled();
  });

  it('[AC-B1-04zzg] the card shop_name is the item shop name, or null when absent', async () => {
    const { service } = setup();
    const named = await service.assemble({
      item: item({ shop_name: '合成单测店' }),
      ref,
      entrySource: 'search',
      stale: false,
    });
    expect(named.shop_name).toBe('合成单测店');
    const unnamed = await service.assemble({
      item: item(),
      ref,
      entrySource: 'search',
      stale: false,
    });
    expect(unnamed.shop_name).toBeNull();
  });

  it('[AC-B1-05f] refuses a product ref of another app scope', async () => {
    const { service } = setup();
    await expect(
      service.assemble({
        item: item(),
        ref: { ...ref, appId: 'app-other' },
        entrySource: 'search',
        stale: false,
      }),
    ).rejects.toThrow(/app scope/u);
  });
});

describe('createDemoRebateQuoter', () => {
  it('[AC-B1-05zc] D10-641: refuses a compare basis, never reads the compare ratio, quotes one amount', async () => {
    const configValue = vi.fn<CatalogConfigReader['configValue']>(async (_appId, key) =>
      key === 'demo.rule'
        ? { value: { reserve_bp: 0, self_share_bp: 10000 }, version: 1 }
        : key === 'tech_fee_bp'
          ? { value: { taobao: 0 }, version: 1 }
          : null,
    );
    const quoter = createDemoRebateQuoter({
      appEnv: 'local',
      unionMode: 'demo',
      ruleConfigKey: 'demo.rule',
      config: { configValue },
    });
    const viewer: Viewer = { appId: 'app-u', userId: null, deviceId: null };
    await expect(
      quoter.quote(item(), viewer, {
        buyType: 'self',
        entrySource: 'search',
        rebateBasis: 'price_compare_risk',
      }),
    ).rejects.toThrow(TypeError);
    const normal = await quoter.quote(item(), viewer, {
      buyType: 'self',
      entrySource: 'pool',
      rebateBasis: 'normal',
    });
    // gross = floor(4000 × 500 / 10000) = 200; no fee, no reserve, full share.
    expect(normal).toEqual({
      rebateMinFen: 200n,
      rebateMaxFen: 200n,
      estNetPriceFen: 3800n,
      rebateBasis: 'normal',
    });
    // No context (guest, no entry source): taobao is one amount as well.
    await expect(quoter.quote(item(), viewer)).resolves.toEqual(normal);
    expect(configValue.mock.calls.map(([, key]) => key)).not.toContain(
      'rebate.taobao.compare_rate_ratio_bp',
    );
  });
});

describe('price_spec_hint wiring', () => {
  it('[AC-B1-05zh] BR-PROD-04: JD mode is read from the card product_key shape, never from item fields', async () => {
    const { service } = setup();
    const jdItem = item({ platform: 'jd', item_id: null, itemId: 'U_77', skuId: '1001' });
    const hint = async (productKey: string) => {
      const card = await service.assemble({
        item: jdItem,
        ref: { ...ref, platform: 'jd', productKey },
        entrySource: 'search',
        stale: false,
      });
      expect(card).toHaveProperty('price_spec_hint');
      return card.price_spec_hint;
    };
    expect(await hint('jd:1001')).toBeNull();
    expect(await hint('jd:i_77')).toBe('spec_uncertain');
    // Not of the derived shape: fail closed to item mode.
    expect(await hint('jd:')).toBe('spec_uncertain');
    const tb = await service.assemble({ item: item(), ref, entrySource: 'search', stale: true });
    expect(tb.price_spec_hint).toBe('spec_uncertain');
  });
});
