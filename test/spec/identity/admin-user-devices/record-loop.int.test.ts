// B1-02zz §9 #8 · the loop the console runs (contract adminListUserDevices: 「This is where the
// console picks the device_id it records as re-verified」): a device_id taken from the list is
// accepted by POST /admin/v1/users/{user_id}/reverified-devices, and the list then shows the record.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  REVOKED,
  account,
  body,
  flag,
  instant,
  minutesAgo,
  normal,
  owned,
  pageOf,
  record,
  recorded,
  row,
  saved,
  sessionOn,
  setup,
  user,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-02zz#29] 列表里选一台登记：这一台 reverified 变成 admin 与登记时刻，另一台还是 null', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const spare = await owned(s, target, { lastSeenAt: minutesAgo(s, 5) });

  const before = await pageOf(s, target);
  expect(before.items.map((item) => item.reverified)).toEqual([null, null]);
  const picked = before.items.find((item) => item.device_id === device.id);
  expect(picked, '登记用的 device_id 必须取自列表').toBeDefined();

  const data = await saved(await record(s, target.id, body({ id: picked!.device_id })));
  expect(data).toMatchObject({
    user_id: target.id,
    device_id: device.id,
    source: 'admin',
    created: true,
  });

  const after = await pageOf(s, target);
  expect(after.total).toBe(2);
  const rows = after.items.map(normal);
  expect(rows.find((item) => item.device_id === device.id)?.reverified).toEqual({
    source: 'admin',
    created_at: instant(data.created_at),
  });
  expect(rows.find((item) => item.device_id === spare.id)).toEqual(row(spare));
});

it('[AC-B1-02zz#30] 只有已吊销会话的设备可以从列表选来登记；共用这台设备的另一账号 reverified 仍是 null', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await flag(s, target);
  const shared = await owned(s, target, {}, REVOKED);
  const someone = await user(h, s.appId);
  await sessionOn(s, someone, shared);

  const [picked] = (await pageOf(s, target)).items;
  expect(picked?.device_id).toBe(shared.id);
  const data = await saved(await record(s, target.id, body({ id: picked!.device_id })));
  expect(data).toMatchObject({ device_id: shared.id, source: 'admin', created: true });

  const mine = await pageOf(s, target);
  expect(mine.items.map(normal)).toEqual([
    { ...row(shared), reverified: { source: 'admin', created_at: instant(data.created_at) } },
  ]);
  expect((await pageOf(s, someone)).items.map(normal)).toEqual([row(shared)]);
});

it('[AC-B1-02zz#31] 自助加验过的设备再登记一次（created:false）：列表还是首次记录的 source 与时刻', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const first = minutesAgo(s, 1440);
  await recorded(s, target, device, 'self', first);

  const before = await pageOf(s, target);
  expect(before.items.map(normal)[0]?.reverified).toEqual({
    source: 'self',
    created_at: first.getTime(),
  });
  const data = await saved(await record(s, target.id, body(device)));
  expect(data).toMatchObject({ source: 'self', created: false });
  expect(await pageOf(s, target)).toEqual(before);
});
