// B1-06zl rule tests: POST /v1/links/{link_id}/open while convert.enabled.<platform> is off
// (BR-PROD-10; BR-TEXT-14 50301 行; D10-1139 选 A). The open is the production composition
// (createTaobaoLinkOpen over the open-taobao kit: real registration, idempotency, attempts and
// authorization reads on a throwaway database). The switch and convert.off_reason.<platform> are
// config_items rows of the tenant, read through content's reader like GET /v1/config.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, failure, noAuthState, setup, success } from '../open-taobao/kit.ts';
import {
  OFF_REASONS,
  PLATFORMS,
  expectNoSwitchData,
  expectPausedData,
  storeSwitch,
  type Platform,
  type Reason,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

/** jd / pdd open from h5 (AC-B1-06f#25); Taobao from the app with an active binding. */
function clientOf(platform: Platform): 'ios' | 'h5' {
  return platform === 'taobao' ? 'ios' : 'h5';
}

async function fixture(platform: Platform) {
  const f = await setup(database(), 'detail', platform);
  if (platform === 'taobao') await f.bind('active');
  return f;
}

/** One open of a switched-off platform: 50301 with exactly { platform, reason }, nothing done. */
async function pausedOpen(
  platform: Platform,
  enabled: false | undefined,
  offReason: string | undefined,
  reason: Reason,
) {
  const f = await fixture(platform);
  // No row and no kit default: the switch is not configured at all (default off).
  if (enabled === undefined) f.f.config.delete(`convert.enabled.${platform}`);
  await storeSwitch(f.db, f.appId, platform, enabled, offReason);
  const open = compose(f);
  const result = await open(f.request({ client: clientOf(platform) }));
  await failure(result, f, 50301, 503);
  expectPausedData(result.envelope.data, platform, enabled, offReason, reason);
  await noAuthState(result, f);
  expect(f.f.fetch).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
}

const ROWS = PLATFORMS.flatMap((platform) =>
  OFF_REASONS.map(([label, reason, stored]) => [platform, label, reason, stored] as const),
);

it.each(ROWS)(
  '[AC-B1-06zl#1] open %s：convert.enabled=false、off_reason %s → 503 / 50301，data 恰好 {platform, reason=%s}，先于授权与取价',
  async (platform, _label, reason, stored) => {
    await pausedOpen(platform, false, stored, reason);
  },
  60_000,
);

it.each(PLATFORMS)(
  '[AC-B1-06zl#2] open %s：convert.enabled 与 off_reason 都未配置（缺省关闭）→ 50301，data 恰好 {platform, reason=not_launched}',
  async (platform) => {
    await pausedOpen(platform, undefined, undefined, 'not_launched');
  },
  60_000,
);

it.each(PLATFORMS)(
  '[AC-B1-06zl#3] open %s：转链开关打开时 off_reason=maintenance 不起作用，照常转链（关闭时先带 data）',
  async (platform) => {
    await pausedOpen(platform, false, 'maintenance', 'maintenance');
    const f = await fixture(platform);
    await storeSwitch(f.db, f.appId, platform, true, 'maintenance');
    const open = compose(f);
    const data = success(await open(f.request({ client: clientOf(platform) })));
    expect(data.jump.primary).toEqual(expect.objectContaining({ type: expect.any(String) }));
  },
  60_000,
);

it('[AC-B1-06zl#4] open jd：缺 attr_code 的 50301 保持原样（不带 reason / platform），即使 off_reason=maintenance 已配置', async () => {
  await pausedOpen('jd', false, 'not_launched', 'not_launched');
  const f = await fixture('jd');
  await storeSwitch(f.db, f.appId, 'jd', true, 'maintenance');
  const open = compose(f, { attrCodes: { attrCode: async () => null } });
  const result = await open(f.request({ client: 'h5' }));
  await failure(result, f, 50301, 503);
  expectNoSwitchData(result.envelope.data);
  expect(f.convert).not.toHaveBeenCalled();
}, 60_000);
