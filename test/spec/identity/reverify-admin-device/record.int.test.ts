// B1-02zx §9 #3, #4 · what a record writes (contract adminAddUserReverifiedDevice; 08 BR-WDR-01 细则
// 「清除标记只走人工」): one reverified_devices row, source admin, the device's device_hash. The flag,
// its time and the trusted identities stay, the failure count of 「加验依据」 is not touched, and
// nothing a phone change does happens here. A device already recorded is not written again.
//
// #33 goes beyond the §9 list: 08 BR-ID-28 细则「待加验记录」 removes 已加验设备 when processing
// starts and the tombstone keeps none, and B1-02zy closed this for the three writes it had. This
// operation is one more writer of reverified_devices.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  DELETING,
  REASON,
  REVOKED,
  account,
  body,
  deletion,
  deletionOvertakes,
  deviceOf,
  flag,
  livedIn,
  ok,
  record,
  recorded,
  records,
  rejected,
  sessionOn,
  setup,
  snapshot,
  stateOf,
  stepUp,
  user,
} from './kit.ts';

const h = useHarness();

const instant = (value: string) => new Date(value).getTime();

it('[AC-B1-02zx#25] 登记成功：写一行（source admin、设备的 device_hash、Clock 时刻），响应 created:true，不带 device_hash', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const spare = await deviceOf(s, target);
  const response = await record(s, target.id, body(device));
  const data = await ok(response);
  expect(data).toEqual({
    user_id: target.id,
    device_id: device.id,
    source: 'admin',
    created: true,
    created_at: expect.any(String),
  });
  expect(instant(data.created_at)).toBe(s.clock.now().getTime());
  expect(await records(h, target)).toEqual([
    expect.objectContaining({
      app_id: s.appId,
      user_id: target.id,
      device_hash: device.hash,
      source: 'admin',
      created_at: s.clock.now(),
    }),
  ]);
  expect(JSON.stringify(response.json())).not.toContain(device.hash);
  expect((await records(h, target)).map((row) => row.device_hash)).not.toContain(spare.hash);
});

it('[AC-B1-02zx#26] 标记、打标时刻、可信身份、失败计数不动；第三方绑定与会话也不动：这里不是改号', async () => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  const flaggedAt = new Date(s.clock.now().getTime() - 3_600_000);
  await flag(s, target, { realname: true, providers: ['wechat', 'apple'] }, flaggedAt);
  const device = await deviceOf(s, target);
  await livedIn(s, target, device);
  const before = await snapshot(h, s.appId);

  await ok(await record(s, target.id, body(device)));

  const after = await snapshot(h, s.appId);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.identities).toHaveLength(3);
  expect(after.identities).toEqual(before.identities);
  expect(after.sessions).toHaveLength(1);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.devices).toEqual(before.devices);
  expect(await stateOf(h, target)).toMatchObject({
    reverify_flagged_at: flaggedAt,
    reverify_trusted: { realname: true, providers: ['wechat', 'apple'] },
    reverify_fail_count: 3,
    reverify_fail_day: '2026-10-09',
    reverify_fail_epoch: 7,
  });
});

it('[AC-B1-02zx#27] 「已记录」只看本账号：别的账号登记过同一 device_hash，本账号仍写一行，created:true', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const someone = await user(h, s.appId);
  await recorded(s, someone, device, 'self', s.clock.now());
  const data = await ok(await record(s, target.id, body(device)));
  expect(data).toMatchObject({ source: 'admin', created: true });
  expect(await records(h, target)).toHaveLength(1);
  expect(await records(h, someone)).toHaveLength(1);
});

it('[AC-B1-02zx#28] 「已记录」按设备：同账号另一台设备再登记一次，各一行', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const second = await deviceOf(s, target);
  await ok(await record(s, target.id, body(device)));
  const data = await ok(await record(s, target.id, body(second)));
  expect(data).toMatchObject({ device_id: second.id, created: true });
  const hashes = (await records(h, target)).map((row) => row.device_hash);
  expect(hashes.sort()).toEqual([device.hash, second.hash].sort());
});

it('[AC-B1-02zx#41] 同一台设备两个账号都用过：两个账号都算自己的设备，各写一行、都 created:true', async () => {
  const s = await setup(h);
  const { target: first, device } = await account(s);
  const second = await user(h, s.appId);
  await flag(s, second);
  await sessionOn(s, second, device);
  for (const owner of [first, second]) {
    const data = await ok(await record(s, owner.id, body(device)));
    expect(data).toMatchObject({ user_id: owner.id, device_id: device.id, created: true });
    expect((await records(h, owner)).map((row) => row.device_hash)).toEqual([device.hash]);
  }
});

it.each([
  { case: '只有已吊销的会话', laterUser: false },
  { case: '只有已吊销的会话、设备之后由别的账号在用', laterUser: true },
])('[AC-B1-02zx#42] 本用户在设备上$case也算本人设备：写一行，会话不动', async ({ laterUser }) => {
  const s = await setup(h);
  const target = await user(h, s.appId);
  await flag(s, target);
  const device = await deviceOf(s, target, REVOKED);
  if (laterUser) await sessionOn(s, await user(h, s.appId), device);
  const before = await snapshot(h, s.appId);
  const data = await ok(await record(s, target.id, body(device)));
  expect(data).toMatchObject({ user_id: target.id, device_id: device.id, created: true });
  expect((await records(h, target)).map((row) => row.device_hash)).toEqual([device.hash]);
  expect((await snapshot(h, s.appId)).sessions).toEqual(before.sessions);
});

it('[AC-B1-02zx#29] 注销冷静期不拦：冷静期 users.status 还是 normal，账号带标记照常登记', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  await deletion(h, target, 'cooling');
  const data = await ok(await record(s, target.id, body(device)));
  expect(data).toMatchObject({ source: 'admin', created: true });
  expect(await records(h, target)).toHaveLength(1);
});

it('[AC-B1-02zx#30] 用户自助加验过的设备：不再写，created:false，source 与 created_at 是首次记录的', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const first = new Date(s.clock.now().getTime() - 86_400_000);
  await recorded(s, target, device, 'self', first);
  const before = await records(h, target);
  const data = await ok(await record(s, target.id, body(device)));
  expect(data).toMatchObject({
    user_id: target.id,
    device_id: device.id,
    source: 'self',
    created: false,
  });
  expect(instant(data.created_at)).toBe(first.getTime());
  expect(await records(h, target)).toEqual(before);
});

it('[AC-B1-02zx#31] 之前后台登记过的设备：不再写，created:false，created_at 是首次登记的', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const first = await ok(await record(s, target.id, body(device)));
  const before = await records(h, target);
  const retried = await ok(await record(s, target.id, body(device, `${REASON}（二次核对）`)));
  expect(retried).toMatchObject({ source: 'admin', created: false });
  expect(retried.created_at).toBe(first.created_at);
  expect(await records(h, target)).toEqual(before);
});

it('[AC-B1-02zx#32] 同一设备并发登记两次：都成功，恰好一行，一个 created:true、一个 created:false', async () => {
  const s = await setup(h);
  const { target, device } = await account(s);
  const steps = [await stepUp(s), await stepUp(s)];
  const answers = await Promise.all(
    steps.map((step) => record(s, target.id, body(device), { stepUp: step })),
  );
  const data = await Promise.all(answers.map(ok));
  expect(data.map((entry) => entry.created).sort()).toEqual([false, true]);
  expect(await records(h, target)).toHaveLength(1);
});

it.each([
  { case: '转入处理中、标记还在', cleaned: false },
  { case: '转入处理中、清理也清掉了标记', cleaned: true },
])(
  '[AC-B1-02zx#33] 注销抢在写入前提交（$case）：不写回，回 account_deleting，不是 reverify_not_pending',
  async ({ cleaned }) => {
    const s = await setup(h);
    const { target, device } = await account(s);
    const step = await stepUp(s);
    const response = await deletionOvertakes(h, target, cleaned, () =>
      record(s, target.id, body(device), { stepUp: step }),
    );
    await rejected(response, 30419, DELETING);
    expect(await records(h, target)).toEqual([]);
  },
);
