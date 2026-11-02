// B1-02zx §9 #2, §10 · the user, the device and the account (contract adminAddUserReverifiedDevice):
// each is refused alone here, the order between them is order.int.test.ts, the audit of these
// refusals audit.int.test.ts. Every target but the one under test is in order: the account carries
// the flag and the device is a live one of this user. A device of this user is one a session of
// this user was bound to, revoked sessions included (D10-585; kit.ts).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DELETING,
  NOT_UUIDS,
  REVOKED,
  account,
  body,
  deleted,
  deleting,
  deviceOf,
  flag,
  ok,
  record,
  recorded,
  rejected,
  revoke,
  setup,
  snapshot,
  unflag,
  unowned,
  user,
  watch,
  type Device,
  type Setup,
  type Target,
} from './kit.ts';

const h = useHarness();

const UNKNOWN_USER = { fields: ['user_id'] };
const UNKNOWN_DEVICE = { fields: ['device_id'] };
const NOT_PENDING = { reason: 'reverify_not_pending' };
const ACCOUNT_DELETED = { reason: 'account_deleted' };

it('[AC-B1-02zx#12] 未知 user_id、别的 app 的用户（带不带 X-App-Id）都是 20001 [user_id]，什么都不写', async () => {
  const s = await setup(h);
  // A real local account stays present: a write that forgets the user_id filter must show.
  const local = await account(s);
  const otherApp = `foreign-${randomUUID()}`;
  const foreign = await account(s, otherApp);
  const before = await snapshot(h, s.appId);
  const foreignBefore = await snapshot(h, otherApp);
  const cases: [string, Device, Record<string, string>][] = [
    [randomUUID(), local.device, {}],
    [foreign.target.id, foreign.device, {}],
    [foreign.target.id, foreign.device, { 'x-app-id': otherApp }],
  ];
  for (const [id, device, headers] of cases) {
    const response = await record(s, id, body(device), { headers });
    await rejected(response, 20001, UNKNOWN_USER);
  }
  expect(await snapshot(h, s.appId)).toEqual(before);
  expect(await snapshot(h, otherApp)).toEqual(foreignBefore);
});

it.each(NOT_UUIDS)(
  '[AC-B1-02zx#43] user_id 合乎 Id 形状但不是 UUID（%s）→ 20001 [user_id]，不是 5XX，什么都不写、不记审计',
  async (id) => {
    const s = await setup(h);
    const { device } = await account(s);
    const nothingChanged = await watch(s);
    await rejected(await record(s, id, body(device)), 20001, UNKNOWN_USER);
    await nothingChanged();
  },
);

const FOREIGN_DEVICES: readonly {
  case: string;
  device: (s: Setup, target: Target) => Promise<Pick<Device, 'id'>>;
}[] = [
  { case: '未知的', device: async () => ({ id: randomUUID() }) },
  {
    case: '别的 app 的',
    device: async (s) => deviceOf(s, await user(h, `foreign-${randomUUID()}`)),
  },
  {
    case: '设备表已吊销、本用户有会话的',
    device: async (s, target) => {
      const device = await deviceOf(s, target);
      await revoke(s, device);
      return device;
    },
  },
  {
    case: '同 app 别的用户会话关联、本用户没有的',
    device: async (s) => deviceOf(s, await user(h, s.appId)),
  },
  {
    case: '同 app 别的用户已吊销的会话关联、本用户没有的',
    device: async (s) => deviceOf(s, await user(h, s.appId), REVOKED),
  },
  { case: '没有任何会话的', device: (s) => unowned(s) },
];

it.each(FOREIGN_DEVICES)(
  '[AC-B1-02zx#13] device_id 是$case设备 → 20001 [device_id]，不写 reverified_devices',
  async ({ device }) => {
    const s = await setup(h);
    const { target } = await account(s);
    const stray = await device(s, target);
    const before = await snapshot(h, s.appId);
    await rejected(await record(s, target.id, body(stray)), 20001, UNKNOWN_DEVICE);
    expect(await snapshot(h, s.appId)).toEqual(before);
  },
);

it.each(NOT_UUIDS)(
  '[AC-B1-02zx#14] device_id 合乎 Id 形状但不是 UUID（%s）→ 20001 [device_id]，不是 5XX，什么都不写、不记审计',
  async (id) => {
    const s = await setup(h);
    const { target } = await account(s);
    const nothingChanged = await watch(s);
    await rejected(await record(s, target.id, body({ id })), 20001, UNKNOWN_DEVICE);
    await nothingChanged();
  },
);

it('[AC-B1-02zx#15] 账号没有待加验标记 → 30419 reverify_not_pending，不写 reverified_devices', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const device = await deviceOf(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, NOT_PENDING);
  expect(await snapshot(h, s.appId)).toEqual(before);

  // The same request once the account carries the flag: only the flag decided.
  await flag(s, target);
  expect((await ok(await record(s, target.id, body(device)))).created).toBe(true);
});

it('[AC-B1-02zx#16] 无标记先于已记录：设备早已登记、标记后来清除 → 30419 reverify_not_pending，不是 created:false', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  await recorded(s, target, device, 'self', s.clock.now());
  await unflag(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, NOT_PENDING);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-02zx#17] 账号已完成注销 → 30419 account_deleted，不带 data.stage，不写 reverified_devices', async () => {
  const s = await setup(h);
  const target = await deleted(s);
  const device = await deviceOf(s, target, REVOKED);
  await flag(s, target);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, ACCOUNT_DELETED);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-02zx#44] users.status=deleting 且标记还在 → 30419 account_deleting，data.stage=processing，不写 reverified_devices', async () => {
  const s = await setup(h);
  const { target, device } = await deleting(s);
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, DELETING);
  expect(await snapshot(h, s.appId)).toEqual(before);
});

it('[AC-B1-02zx#45] 注销中先于已记录：设备早已登记 → 还是 account_deleting，不是 created:false', async () => {
  const s = await setup(h);
  const { target, device } = await deleting(s);
  await recorded(s, target, device, 'self', s.clock.now());
  const before = await snapshot(h, s.appId);
  await rejected(await record(s, target.id, body(device)), 30419, DELETING);
  expect(await snapshot(h, s.appId)).toEqual(before);
});
