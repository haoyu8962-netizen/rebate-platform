// B1-06zl rule tests: POST /v1/links/convert while convert.enabled.<platform> is off (BR-PROD-10;
// BR-TEXT-14 50301 行; D10-1139 选 A). The convert is the production composition
// (createLinkConvert over the convert kit: real catalog, registration, idempotency, link_logs and
// attempts on a throwaway database). The switch and convert.off_reason.<platform> are config_items
// rows of the tenant, read through content's reader like GET /v1/config.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture, failure, fixture, service } from '../convert/kit.ts';
import {
  OFF_REASONS,
  PLATFORMS,
  expectPausedData,
  storeSwitch,
  type Platform,
  type Reason,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** One convert of a switched-off platform: 50301 with exactly { platform, reason }, logged. */
async function pausedConvert(platform: Platform, offReason: string | undefined, reason: Reason) {
  const f = await fixture(database(), platform, 'active');
  await storeSwitch(f.db, f.appId, platform, false, offReason);
  const convert = service(f);
  const result = await convert.convert(f.request());
  await failure(result, f, 50301, 503);
  expectPausedData(result.envelope.data, platform, false, offReason, reason);
  expect(f.f.fetch).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
}

const ROWS = PLATFORMS.flatMap((platform) =>
  OFF_REASONS.map(([label, reason, stored]) => [platform, label, reason, stored] as const),
);

it.each(ROWS)(
  '[AC-B1-06zl#5] convert %s：convert.enabled=false、off_reason %s → 503 / 50301，data 恰好 {platform, reason=%s}，只记 convert 失败、不转链',
  async (platform, _label, reason, stored) => {
    await pausedConvert(platform, stored, reason);
  },
  60_000,
);

it('[AC-B1-06zl#6] convert jd：转链开关打开时 off_reason=maintenance 不起作用，照常生成链接（关闭时先带 data）', async () => {
  await pausedConvert('jd', 'not_launched', 'not_launched');
  const f = await fixture(database(), 'jd', 'active');
  await storeSwitch(f.db, f.appId, 'jd', true, 'maintenance');
  const convert = service(f);
  const result = await convert.convert(f.request());
  expect(result).toMatchObject({ status: 200, envelope: { code: 0 } });
  expect(f.convert).toHaveBeenCalledTimes(1);
}, 60_000);
