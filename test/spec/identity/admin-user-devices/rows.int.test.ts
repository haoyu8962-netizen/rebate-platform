// B1-02zz §9 #6 · what a row holds (contract adminListUserDevices, schema AdminUserDevice): device_id,
// platform, app_version, created_at, last_seen_at and reverified, the record of this user for this
// device (source and created_at) or null; never device_hash, the install secret or last_login_sid.
// reverified_devices is keyed by app, user and device_hash, so the record of another account on a
// shared device is not this user's.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  device,
  list,
  listed,
  minutesAgo,
  noHash,
  noSecrets,
  normal,
  owned,
  pageOf,
  recorded,
  row,
  sessionOn,
  setup,
  user,
} from './kit.ts';

const h = useHarness();

it.each([
  { platform: 'ios', appVersion: '1.2.0' },
  { platform: 'android', appVersion: '1.1.0' },
  { platform: 'harmony', appVersion: '3.10.2-beta' },
] as const)(
  '[AC-B1-02zz#25] 一行恰好六个字段，值取自 devices（$platform $appVersion），两个时刻不混用',
  async ({ platform, appVersion }) => {
    const s = await setup(h);
    const target = await user(h, s.appId);
    const seeded = await owned(s, target, {
      platform,
      appVersion,
      createdAt: minutesAgo(s, 7 * 1440),
      lastSeenAt: minutesAgo(s, 15),
    });
    const page = await pageOf(s, target);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      'app_version',
      'created_at',
      'device_id',
      'last_seen_at',
      'platform',
      'reverified',
    ]);
    expect(page.items.map(normal)).toEqual([row(seeded)]);
  },
);

it('[AC-B1-02zz#26] reverified 按设备：自助加验 source self、后台登记 source admin、都没有为 null，created_at 是记录的时刻', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const self = await owned(s, target, { lastSeenAt: minutesAgo(s, 1) });
  const admin = await owned(s, target, { lastSeenAt: minutesAgo(s, 2) });
  const bare = await owned(s, target, { lastSeenAt: minutesAgo(s, 3) });
  const selfAt = minutesAgo(s, 90);
  const adminAt = minutesAgo(s, 45);
  await recorded(s, target, self, 'self', selfAt);
  await recorded(s, target, admin, 'admin', adminAt);
  const page = await pageOf(s, target);
  expect(page.items.map(normal)).toEqual([
    row(self, { source: 'self', at: selfAt }),
    row(admin, { source: 'admin', at: adminAt }),
    row(bare),
  ]);
  expect(page.total).toBe(3);
});

it('[AC-B1-02zz#27] reverified 按账号：共用一台设备，各看各的记录，没记录的账号是 null，也不多出行', async () => {
  const s = await setup(h);
  const first = await user(h, s.appId);
  const second = await user(h, s.appId);
  const third = await user(h, s.appId);
  const shared = await owned(s, first);
  await sessionOn(s, second, shared);
  await sessionOn(s, third, shared);
  const firstAt = minutesAgo(s, 90);
  const secondAt = minutesAgo(s, 45);
  await recorded(s, first, shared, 'self', firstAt);
  await recorded(s, second, shared, 'admin', secondAt);
  const cases = [
    { owner: first, want: row(shared, { source: 'self', at: firstAt }) },
    { owner: second, want: row(shared, { source: 'admin', at: secondAt }) },
    { owner: third, want: row(shared) },
  ];
  for (const { owner, want } of cases) {
    const page = await pageOf(s, owner);
    expect(page.items.map(normal)).toEqual([want]);
    expect(page.total).toBe(1);
  }
});

it('[AC-B1-02zz#28] 响应与日志都不出现 device_hash；响应也不出现 install secret、last_login_sid', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const seen = await owned(s, target, { lastLoginSid: 'sid-marker-of-the-last-login-1' });
  const verified = await owned(s, target, { lastLoginSid: 'sid-marker-of-the-last-login-2' });
  await recorded(s, target, verified, 'admin', minutesAgo(s, 5));
  const stray = await device(s, s.appId, { lastLoginSid: 'sid-marker-of-the-last-login-3' });
  const response = await list(s, target.id);
  expect((await listed(response)).total).toBe(2);
  noSecrets(response, [seen, verified, stray]);
  noHash(s, [seen, verified, stray], [response]);
});
