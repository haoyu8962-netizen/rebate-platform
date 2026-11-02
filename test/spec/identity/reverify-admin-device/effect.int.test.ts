// B1-02zx §9 #6 · what a record does to the member (08 BR-WDR-01 细则「已加验设备」「清除标记只走人工」):
// the api entry and the admin entry over one database. The record frees that one device of that one
// account; the flag stays, so every other device still answers 10010 with the method the account
// had. The gate and the page are the real ones of B1-02zp / B1-02zq, reached through HTTP; the
// member and the withdrawal are the fixtures of reverify-gates/kit.ts. What makes a device the
// member's is a session (D10-585): the fixtures' f.on() and f.client() bind one when they first
// call, #46 gets it from a real SMS login.
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Harness } from '../../admin/auth/kit.ts';
import {
  ID_NUMBER,
  MANUAL,
  WITHDRAW,
  answer,
  gates,
  oauth,
  refused,
  type PendingData,
} from '../reverify-gates/kit.ts';
import {
  FAIL_LIMIT,
  NOT_REQUIRED,
  closeKit,
  idNumberRequired,
  openKit,
  statusOf,
  type Kit,
  type Trusted,
} from '../reverify/kit.ts';
import { REASON, adminHarness, ok, record, setup } from './kit.ts';

let kit: Kit;
let h: Harness;
beforeAll(async () => {
  kit = await openKit();
  h = await adminHarness(kit);
}, 180_000);
afterEach(async () => {
  for (const app of h.apps.splice(0)) await app.close();
});
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const REQUIREMENTS: readonly { method: string; trusted: Trusted; data: PendingData }[] = [
  { method: 'id_number', trusted: { realname: true, providers: [] }, data: ID_NUMBER },
  { method: 'oauth', trusted: { realname: false, providers: ['wechat'] }, data: oauth(['wechat']) },
  { method: 'manual', trusted: { realname: false, providers: [] }, data: MANUAL },
];

it.each(REQUIREMENTS)(
  '[AC-B1-02zx#38] 登记后（$method）：该设备提现不再 10010，别的设备仍 10010，标记保留',
  async ({ trusted, data }) => {
    const f = await gates(kit);
    const s = await setup(h, f.appId);
    const m = await f.member();
    const other = await f.device();
    await f.flag(m.uid, trusted);
    const flagged = await f.state(m.uid);
    refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), data);

    const payload = { device_id: m.device.id, reason: REASON };
    expect(await ok(await record(s, m.uid, payload))).toMatchObject({
      source: 'admin',
      created: true,
    });
    expect(await f.devices(m.uid)).toEqual([{ device_hash: m.device.hash, source: 'admin' }]);

    refused(kit, WITHDRAW, 'post', await f.on(m, other).withdraw(), data);
    expect(await f.withdrawals(m.uid)).toEqual([]);
    const accepted = answer(kit, WITHDRAW, 'post', await f.on(m).withdraw(), 0);
    expect(accepted.data).toMatchObject({ status: 'PENDING_REVIEW', amount_fen: 1000 });

    const after = await f.state(m.uid);
    expect(after.reverify_flagged_at).toEqual(flagged.reverify_flagged_at);
    expect(after.reverify_trusted).toEqual(flagged.reverify_trusted);
  },
);

it('[AC-B1-02zx#39] GET /v1/me/reverify 同一结论：该设备不再要求加验；别的设备仍要求，失败计数没被清', async () => {
  const f = await gates(kit);
  const s = await setup(h, f.appId);
  const { uid } = await f.user();
  const device = await f.device();
  const other = await f.device();
  await f.flag(uid, { realname: true, providers: [] });
  await f.failures(uid, 3);
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(
    idNumberRequired(FAIL_LIMIT - 3),
  );
  const before = await f.state(uid);

  await ok(await record(s, uid, { device_id: device.id, reason: REASON }));

  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(NOT_REQUIRED);
  expect(statusOf(kit, await f.client(uid, other).status())).toEqual(
    idNumberRequired(FAIL_LIMIT - 3),
  );
  const after = await f.state(uid);
  expect(after.reverify_fail_count).toBe(before.reverify_fail_count);
  expect(after.reverify_fail_day).toBe(before.reverify_fail_day);
});

it('[AC-B1-02zx#40] 只放行这个账号：同一台设备上另一个带标记的账号仍 10010', async () => {
  const f = await gates(kit);
  const s = await setup(h, f.appId);
  const m = await f.member();
  const someone = await f.member();
  await f.flag(m.uid, { realname: true, providers: [] });
  await f.flag(someone.uid, { realname: true, providers: [] });
  refused(kit, WITHDRAW, 'post', await f.on(m).withdraw(), ID_NUMBER);

  await ok(await record(s, m.uid, { device_id: m.device.id, reason: REASON }));

  refused(kit, WITHDRAW, 'post', await f.on(someone, m.device).withdraw(), ID_NUMBER);
  expect(await f.withdrawals(someone.uid)).toEqual([]);
});

it('[AC-B1-02zx#46] 走真实短信登录的设备可以登记：POST /v1/devices 注册、登录建的会话就是归属依据', async () => {
  const f = await gates(kit);
  const s = await setup(h, f.appId);
  const { uid, number } = await f.user();
  const device = await f.device();
  expect((await f.smsLogin(number, device)).user_id).toBe(uid);
  await f.flag(uid, { realname: true, providers: [] });

  const data = await ok(await record(s, uid, { device_id: device.id, reason: REASON }));

  expect(data).toMatchObject({ user_id: uid, device_id: device.id, created: true });
  expect(await f.devices(uid)).toEqual([{ device_hash: device.hash, source: 'admin' }]);
  expect(statusOf(kit, await f.client(uid, device).status())).toEqual(NOT_REQUIRED);
});
