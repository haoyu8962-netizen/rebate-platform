import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { TaobaoPriceWarning } from '../../domain/taobao-price.ts';
import {
  UnionIdentity,
  type CallCtx,
  type IdentityClaims,
  type RegisteredPlatform,
} from '../../domain/types.ts';
import { DemoUnionAdapter } from './demo-adapter.ts';

// Local unit-test identifiers; synthetic demo data only.
const ctx: CallCtx = { appId: 'unit-app', requestId: 'unit-request', purpose: 'online' };

function adapter(platform: RegisteredPlatform, warnings: TaobaoPriceWarning[] = []) {
  return new DemoUnionAdapter({
    platform,
    seed: 'unit-seed',
    clock: new FixedClock('2031-02-03T04:05:06.789Z'),
    environment: 'test',
    warn: (warning) => warnings.push(warning),
  });
}

it('[AC-B1-04r-UNIT#1] 淘宝普通读价不产生告警，价格场景把告警交给注入的出口', async () => {
  const warnings: TaobaoPriceWarning[] = [];
  const port = adapter('taobao', warnings);
  const page = await port.searchItems({ keyword: '演示' }, ctx);
  expect(page.items.length).toBeGreaterThan(0);
  expect(warnings).toEqual([]);
  const item = page.items[0]!;
  await port.getItem(item, { ...ctx, scenario: 'price_anomaly' });
  expect(warnings).toEqual([{ code: 'PRICE_CALC_DIFF' }]);
  warnings.length = 0;
  await port.getItem(item, { ...ctx, scenario: 'unknown_promo' });
  expect(warnings).toEqual([{ code: 'PRICE_PROMO_UNKNOWN', title: '演示清单外优惠' }]);
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-04r-UNIT#2] %s 不接受淘宝专用的价格场景',
  async (platform) => {
    const port = adapter(platform);
    for (const scenario of ['price_anomaly', 'unknown_promo']) {
      await expect(
        port.searchItems({ keyword: '演示' }, { ...ctx, scenario }),
      ).rejects.toMatchObject({ code: 'demo_unknown_scenario' });
    }
  },
);

/** A server-built identity of this test (union exposes no public constructor). */
class UnitIdentity extends UnionIdentity {
  constructor(claims: Partial<IdentityClaims> = {}) {
    super({
      appId: ctx.appId,
      userId: 'a1b2c3d4',
      platform: 'pdd',
      promotionSlot: 'unit-slot-a',
      relationId: null,
      ...claims,
    });
  }
}

it('[AC-B1-06zf-UNIT#1] 演示拼多多授权链接：同一身份稳定、换推广位就变；身份不完整拒绝；非拼多多没有这个能力', async () => {
  const port = adapter('pdd');
  const first = await port.pddAuthorityUrl(new UnitIdentity(), ctx);
  expect(await port.pddAuthorityUrl(new UnitIdentity(), ctx)).toEqual(first);
  const other = await port.pddAuthorityUrl(new UnitIdentity({ promotionSlot: 'unit-slot-b' }), ctx);
  expect(other.schema_url).not.toBe(first.schema_url);
  expect(String(first.schema_url)).toMatch(/^couli-demo:\/\/pdd\/authority\/\S+$/);
  for (const link of [first.url, first.mobile_short_url]) {
    expect(new URL(String(link)).protocol).toBe('https:');
    expect(new URL(String(link)).hostname).toBe('demo.invalid');
  }
  for (const link of [first.url, first.schema_url, first.mobile_short_url]) {
    expect(String(link)).not.toContain('unit-slot-a');
    expect(String(link)).not.toContain('a1b2c3d4');
  }
  await expect(
    port.pddAuthorityUrl(new UnitIdentity(), { ...ctx, appId: 'other-app' }),
  ).rejects.toMatchObject({ code: 'invalid_identity' });
  await expect(
    adapter('jd').pddAuthorityUrl(new UnitIdentity({ platform: 'jd' }), ctx),
  ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
});
