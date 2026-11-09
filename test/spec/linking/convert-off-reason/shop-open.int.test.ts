// B1-06zl rule tests: POST /v1/products/{product_key}/shop/open while convert.enabled.taobao is off
// (BR-PROD-10; BR-PRICE-21 细则「进店」50301 同 open; BR-TEXT-14 50301 行; D10-1139 选 A). The shop
// entry is the production composition (createShopOpen over the shop-open kit: real authorization
// reads, auth sessions and idempotency on a throwaway database); only shopOf and convertShop are
// stand-ins. The kit's configuration port holds the switch and convert.off_reason.taobao.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import {
  SHOP,
  compose,
  noAuthState,
  refusal,
  setup,
  shopJump,
  shopLink,
  untouched,
} from '../shop-open/kit.ts';
import { OFF_REASONS, expectNoSwitchData, expectPausedData, type Reason } from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** One shop entry of a switched-off Taobao: 50301 with exactly { platform, reason }, nothing done. */
async function pausedShop(
  enabled: false | undefined,
  offReason: string | undefined,
  reason: Reason,
) {
  const f = await setup(database());
  // The switch answers before authorization: an unbound caller gets no state either.
  await f.bind('unbound');
  if (enabled === undefined) f.config.delete('convert.enabled.taobao');
  else f.config.set('convert.enabled.taobao', enabled);
  if (offReason !== undefined) f.config.set('convert.off_reason.taobao', offReason);
  const result = await compose(f)();
  await refusal(result, f, 50301, 503);
  expectPausedData(result.envelope.data, 'taobao', enabled, offReason, reason);
  await noAuthState(result, f);
  untouched(f);
  expect(f.resolve).not.toHaveBeenCalled();
}

const ROWS = (['false', '未配置'] as const).flatMap((switchLabel) =>
  OFF_REASONS.map(([label, reason, stored]) => [switchLabel, label, reason, stored] as const),
);

it.each(ROWS)(
  '[AC-B1-06zl#7] 进店 taobao：convert.enabled %s、off_reason %s → 503 / 50301，data 恰好 {platform=taobao, reason=%s}，先于授权、不读店铺',
  async (switchLabel, _label, reason, stored) => {
    await pausedShop(switchLabel === 'false' ? false : undefined, stored, reason);
  },
);

it('[AC-B1-06zl#8] 进店 taobao：转链开关打开时 off_reason=maintenance 不起作用，照常进店（关闭时先带 data）', async () => {
  await pausedShop(false, 'maintenance', 'maintenance');
  const f = await setup(database());
  await f.bind('active');
  f.config.set('convert.off_reason.taobao', 'maintenance');
  const result = await compose(f)();
  shopJump(result, shopLink(SHOP.shopRef, 'rel-A'));
  expect(f.convertShop).toHaveBeenCalledTimes(1);
});

it('[AC-B1-06zl#9] 进店 taobao：无 active self_buy 推广位的 50301 保持原样（不带 reason / platform），即使 off_reason=maintenance 已配置', async () => {
  await pausedShop(undefined, undefined, 'not_launched');
  const f = await setup(database());
  await f.bind('active');
  f.config.set('convert.off_reason.taobao', 'maintenance');
  f.getActivePid.mockResolvedValue(null);
  const result = await compose(f)();
  await refusal(result, f, 50301, 503);
  expect(result.envelope.data).toBeUndefined();
  expectNoSwitchData(result.envelope.data);
  untouched(f);
});
