// B1-06zl rule tests: POST /v1/shares while convert.enabled.<platform> is off (BR-PROD-10; BR-TEXT-14
// 50301 行; D10-1139 选 A: the reason is read from convert.off_reason.<platform>, no longer always
// maintenance). Through the real api entry of the shares kit (createHttpApp + inject over a
// throwaway PostgreSQL and Redis); the switch and convert.off_reason.<platform> are config_items rows
// of a fresh tenant, written before any request of that tenant reads them.
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  bodyOf,
  cardWith,
  expectRefused,
  expectShared,
  sharesHarness,
  type ShareBody,
} from '../shares/kit.ts';
import {
  OFF_REASONS,
  PLATFORMS,
  expectPausedData,
  storeSwitch,
  type Platform,
  type Reason,
} from './kit.ts';

const h = sharesHarness({ createTestDatabase, acquireTestRedis });

const PREFIX: Readonly<Record<Platform, string>> = { taobao: 'tb', jd: 'jd', pdd: 'pdd' };

/** One share of a switched-off platform: 50301 with exactly { platform, reason }, nothing written. */
async function pausedShare(platform: Platform, offReason: string | undefined, reason: Reason) {
  const t = await h.tenant();
  await storeSwitch(h.db(), t.appId, platform, false, offReason);
  const sharer = await t.user();
  h.clearObservations();
  const before = await h.persisted(t.appId);
  // The switch answers before the product is resolved: a synthetic key of the platform suffices.
  const body: ShareBody = { platform, product_key: `${PREFIX[platform]}:synthetic_off_reason` };
  const response = await sharer.share(body);
  const refused = await expectRefused(response, 503, 50301);
  expectPausedData(refused.data, platform, false, offReason, reason);
  expect(await h.persisted(t.appId)).toEqual(before);
  expect(h.converts()).toEqual([]);
}

it.each(PLATFORMS)(
  '[AC-B1-06zl#10] 分享 %s：convert.enabled=false → 503 / 50301，data 恰好 {platform, reason}，reason 取 off_reason（未配置 / not_launched / 不认识 → not_launched，maintenance → maintenance），不登记、不转链',
  async (platform) => {
    for (const [, reason, stored] of OFF_REASONS) await pausedShare(platform, stored, reason);
  },
  180_000,
);

it('[AC-B1-06zl#11] 分享 jd：转链开关打开时 off_reason=maintenance 不起作用，照常生成分享（关闭时先带 data）', async () => {
  await pausedShare('jd', undefined, 'not_launched');
  const t = await h.tenant();
  await storeSwitch(h.db(), t.appId, 'jd', true, 'maintenance');
  const sharer = await t.user();
  const card = cardWith(await sharer.search('jd'), true);
  const data = await expectShared(await sharer.share(bodyOf(card)));
  expect(data.link_id).toEqual(expect.any(String));
}, 120_000);
