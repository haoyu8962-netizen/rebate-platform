// B1-03zg (money r1 S1): a disabled DEVICE_REGISTER_LIMIT takes no part in the registration decision
// (BR-ID-36 细则「规则清单的启停」; BR-ID-05 same-device limit). The rule is toggled through the admin
// console of its app; registrations go through the real api entry on a device that is already at
// the default limit. After each toggle the api entry's injected clock moves past REFRESH_MS (the
// config_items cache period), no real waiting (see effects-kit.ts).
// - disabled: the next registration on the full device is admitted and no DEVICE_REGISTER_LIMIT
//   hit is written; enabled again: refused with 44001 and the hit is written again;
// - hits and appeals written before the disable stay as they were;
// - one app's disable leaves another app's rule of the same code deciding.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DEVICE_RULE,
  REFRESH_MS,
  admitted,
  appealBlocked,
  appealsOf,
  consoleOf,
  expectDeviceHit,
  hitsOf,
  newApp,
  publicEntry,
  refused,
  registerRule,
  ruleRowOf,
} from './effects-kit.ts';

const h = useHarness();
const DEVICE_SEED = { rule_id: DEVICE_RULE, scene: 'register', risk_action: 'block' } as const;

it('[AC-B1-03zg#41] 停用 DEVICE_REGISTER_LIMIT 后满额设备的注册不再被拦、不写该规则命中；重新启用后恢复拦截与记命中', async () => {
  const appId = newApp();
  await registerRule(h, appId, DEVICE_SEED);
  const admin = await consoleOf(h, appId);
  const pub = await publicEntry(h);
  const device = await pub.fullDevice(appId);

  // Enabled: the full device is refused and the refusal is recorded.
  await refused((await device.register()).response);
  const first = await hitsOf(h, appId, DEVICE_RULE);
  expect(first).toHaveLength(1);
  expectDeviceHit(first[0], appId, device.deviceHash);

  // Disabled: the limit no longer decides; no hit of the rule.
  await admin.toggle('disable', DEVICE_RULE);
  pub.api.clock.advanceMs(REFRESH_MS);
  await admitted((await device.register()).response);
  expect(
    await hitsOf(h, appId, DEVICE_RULE),
    'no DEVICE_REGISTER_LIMIT hit while disabled',
  ).toEqual(first);

  // Enabled again: refused and recorded, as before.
  await admin.toggle('enable', DEVICE_RULE);
  pub.api.clock.advanceMs(REFRESH_MS);
  await refused((await device.register()).response);
  const last = await hitsOf(h, appId, DEVICE_RULE);
  expect(last).toHaveLength(2);
  expect(last[0]).toEqual(first[0]);
  expectDeviceHit(last[1], appId, device.deviceHash);
  expect(last[1]!.ref_id).not.toBe(first[0]!.ref_id);
}, 120_000);

it('[AC-B1-03zg#42] 停用前写的 DEVICE_REGISTER_LIMIT 命中与申诉不受停用影响；停用后的判定不补写也不删', async () => {
  const appId = newApp();
  await registerRule(h, appId, DEVICE_SEED);
  const admin = await consoleOf(h, appId);
  const pub = await publicEntry(h);
  const device = await pub.fullDevice(appId);

  await refused((await device.register()).response);
  const [hit] = await hitsOf(h, appId, DEVICE_RULE);
  expect(hit, 'the refusal before the disable is recorded').toBeDefined();
  await appealBlocked(h, hit!, pub.api.clock.now());
  const hitsBefore = await hitsOf(h, appId);
  const appealsBefore = await appealsOf(h, appId);
  expect(appealsBefore).toHaveLength(1);

  await admin.toggle('disable', DEVICE_RULE);
  pub.api.clock.advanceMs(REFRESH_MS);
  await admitted((await device.register()).response);

  // The rule's hits are exactly the ones written before; every earlier row of the app is intact.
  expect(await hitsOf(h, appId, DEVICE_RULE)).toEqual([hit]);
  expect(await hitsOf(h, appId)).toEqual(expect.arrayContaining(hitsBefore));
  expect(await appealsOf(h, appId)).toEqual(appealsBefore);
}, 120_000);

it('[AC-B1-03zg#43] 跨 app：A 停用 DEVICE_REGISTER_LIMIT 不影响 B 同名规则的判定', async () => {
  const appA = newApp();
  const appB = newApp();
  await registerRule(h, appA, DEVICE_SEED);
  const ruleB = await registerRule(h, appB, DEVICE_SEED);
  const adminA = await consoleOf(h, appA);
  const pub = await publicEntry(h);
  const deviceA = await pub.fullDevice(appA);
  const deviceB = await pub.fullDevice(appB);

  await adminA.toggle('disable', DEVICE_RULE);
  pub.api.clock.advanceMs(REFRESH_MS);

  await admitted((await deviceA.register()).response);
  expect(await hitsOf(h, appA, DEVICE_RULE)).toEqual([]);

  await refused((await deviceB.register()).response);
  const hitsB = await hitsOf(h, appB, DEVICE_RULE);
  expect(hitsB).toHaveLength(1);
  expectDeviceHit(hitsB[0], appB, deviceB.deviceHash);
  expect(await ruleRowOf(h, appB, DEVICE_RULE)).toEqual(ruleB);
}, 120_000);
