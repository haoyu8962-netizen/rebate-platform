// B1-03zj: 自动到账判定 ⑨ 的黑名单命中维度顺序与 ③a 统一为 手机号 → 身份证 → 设备 → 收款账号
// (BR-WDR-29 ⑨, BR-WDR-03 ③a, BR-ID-36; D10-731 ①), through the real AppModule: POST
// /v1/withdrawals on the api entry (③a, the request's device), the evt.payout-auto-payout handler on
// the worker entry (⑨, every device of the member's sessions, revoked ones included; D10-571).
// Whether a check hits, the manual review of ⑨, the rule switches and the device scope stay as they
// are; only the dimension the hit row names changes where a device and the payee account are both
// listed. Before the implementation ⑨ names the payee account there, so every test opens with that
// case (./kit.ts expectDeviceBeforePayee or the same data inline); what already holds follows it.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { close, open, type Kit } from '../../identity/payout-account/kit.ts';
import { CHAIN_TIMEOUT, T, withWorker } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { RULE_OF, setRule } from '../../payout/risk-rule-toggle/kit.ts';
import {
  apply,
  blockDevice,
  blockMember,
  decide,
  deviceRow,
  expectNoHit,
  logout,
  member,
  newApp,
  post,
  refused,
  registerDevice,
  sessionRow,
  withdrawPrivacy,
} from '../blocklist-device-scope/kit.ts';
import {
  blockedHits,
  deviceDigest,
  expectBlockedHit,
  expectDeviceBeforePayee,
  expectManual,
  expectReviewHit,
  memberDigest,
  reviewHits,
  target,
} from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, 60_000);
beforeEach(() => {
  kit.clock.set(T);
});

it(
  '[AC-B1-03zj#1] ⑨ 先设备后收款账号：先后登录 X、Y、Z，从 Y 发起；最早登录的 X 或最近登录的 Z 与收款账号同时在黑名单，转人工，risk_hits 记 device（该设备哈希、BLACKLIST_DEVICE）',
  async () => {
    await withWorker(kit, async (worker) => {
      for (const listed of ['earliest', 'latest'] as const) {
        const appId = await newApp(kit);
        const x = await registerDevice(kit, appId);
        const y = await registerDevice(kit, appId);
        const z = await registerDevice(kit, appId);
        const m = await member(kit, appId, x);
        const onY = await m.login(y);
        await m.login(z);

        const id = await apply(kit, onY);
        const device = listed === 'earliest' ? x : z;
        await blockDevice(kit, device, 'malicious_rights');
        await blockMember(kit, m, 'alipay', 'fraud_invite');
        await expectManual(kit, appId, id, await decide(kit, worker, m, id));
        await expectReviewHit(kit, appId, id, target('device', await deviceDigest(kit, device)));
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zj#2] ⑨ 先设备后收款账号，设备口径不变：会话已退出登录的设备、撤回同意吊销了的设备与收款账号同时在黑名单，仍转人工、risk_hits 记 device',
  async () => {
    await withWorker(kit, async (worker) => {
      for (const revocation of ['logout', 'privacy'] as const) {
        const appId = await newApp(kit);
        const revoked = await registerDevice(kit, appId);
        const current = await registerDevice(kit, appId);
        const m = await member(kit, appId, revoked);
        const onCurrent = await m.login(current);
        if (revocation === 'logout') {
          await logout(kit, m.first);
        } else {
          await withdrawPrivacy(kit, m.first);
          expect((await deviceRow(kit, revoked)).revoked_at).not.toBeNull();
        }
        expect((await sessionRow(kit, m.first)).revoked_at).not.toBeNull();

        const id = await apply(kit, onCurrent);
        await blockDevice(kit, revoked, 'malicious_rights');
        await blockMember(kit, m, 'alipay', 'fraud_invite');
        await expectManual(kit, appId, id, await decide(kit, worker, m, id));
        await expectReviewHit(kit, appId, id, target('device', await deviceDigest(kit, revoked)));
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zj#3] ③a 与 ⑨ 一致：设备 X 与收款账号同时在黑名单，从 X 发起得 44001（设备的违规类型）且 blocked_request 记 device；同一会员从 Y 发起的单 ⑨ 也记同一台 device',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const x = await registerDevice(kit, appId);
      const y = await registerDevice(kit, appId);
      const m = await member(kit, appId, x);
      const id = await apply(kit, await m.login(y));
      await blockDevice(kit, x, 'malicious_rights');
      await blockMember(kit, m, 'alipay', 'fraud_invite');
      const device = target('device', await deviceDigest(kit, x));

      const answer = await post(kit, m.first);
      expect(answer.statusCode).toBe(403);
      expect(answer.json()).toMatchObject(refused('malicious_rights'));
      await expectBlockedHit(kit, appId, device);

      await expectManual(kit, appId, id, await decide(kit, worker, m, id));
      await expectReviewHit(kit, appId, id, device);
      const [blocked] = await blockedHits(kit, appId);
      const [reviewed] = await reviewHits(kit, appId, id);
      expect(reviewed?.dimension).toBe(blocked?.dimension);
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zj#4] 顺序前段不变：手机号或身份证与设备、收款账号同时在黑名单，⑨ 与 ③a 都记手机号 / 身份证',
  async () => {
    await withWorker(kit, async (worker) => {
      await expectDeviceBeforePayee(kit, worker, await newApp(kit));

      for (const front of ['phone', 'id_no'] as const) {
        const appId = await newApp(kit);
        const x = await registerDevice(kit, appId);
        const y = await registerDevice(kit, appId);
        const m = await member(kit, appId, x);
        const id = await apply(kit, await m.login(y));
        await blockMember(kit, m, front, 'other');
        await blockDevice(kit, x, 'malicious_rights');
        await blockMember(kit, m, 'alipay', 'fraud_invite');
        const expected = target(front, await memberDigest(kit, m, front));

        await expectManual(kit, appId, id, await decide(kit, worker, m, id));
        await expectReviewHit(kit, appId, id, expected);

        const answer = await post(kit, m.first);
        expect(answer.json()).toMatchObject(refused('other'));
        await expectBlockedHit(kit, appId, expected);
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zj#5] 收款账号不丢：只有收款账号在黑名单时 ⑨ 与 ③a 都记收款账号；什么都不在黑名单时 ⑨ 不命中、无记录',
  async () => {
    await withWorker(kit, async (worker) => {
      await expectDeviceBeforePayee(kit, worker, await newApp(kit));

      const appId = await newApp(kit);
      const x = await registerDevice(kit, appId);
      const y = await registerDevice(kit, appId);
      const m = await member(kit, appId, x);
      const id = await apply(kit, await m.login(y));
      await blockMember(kit, m, 'alipay', 'fraud_invite');
      const payee = target('alipay', await memberDigest(kit, m, 'alipay'));

      await expectManual(kit, appId, id, await decide(kit, worker, m, id));
      await expectReviewHit(kit, appId, id, payee);
      const answer = await post(kit, m.first);
      expect(answer.json()).toMatchObject(refused('fraud_invite'));
      await expectBlockedHit(kit, appId, payee);

      const cleanApp = await newApp(kit);
      const a = await registerDevice(kit, cleanApp);
      const b = await registerDevice(kit, cleanApp);
      const clean = await member(kit, cleanApp, a);
      const cleanId = await apply(kit, await clean.login(b));
      expectNoHit(await decide(kit, worker, clean, cleanId));
      expect(await reviewHits(kit, cleanApp, cleanId)).toEqual([]);
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zj#6] 启停语义不变（BR-ID-36）：BLACKLIST_DEVICE 启用时记 device；停用时设备与收款账号同时在黑名单，⑨ 与 ③a 都记收款账号',
  async () => {
    await withWorker(kit, async (worker) => {
      // Each status is set before the app's first request, so no reader holds an older answer.
      const enabledApp = await newApp(kit);
      await setRule(kit.db, enabledApp, RULE_OF.device, 'enabled', kit.clock.now());
      await expectDeviceBeforePayee(kit, worker, enabledApp);

      const disabledApp = await newApp(kit);
      await setRule(kit.db, disabledApp, RULE_OF.device, 'disabled', kit.clock.now());
      const x = await registerDevice(kit, disabledApp);
      const y = await registerDevice(kit, disabledApp);
      const m = await member(kit, disabledApp, x);
      const id = await apply(kit, await m.login(y));
      await blockDevice(kit, x, 'malicious_rights');
      await blockMember(kit, m, 'alipay', 'fraud_invite');
      const payee = target('alipay', await memberDigest(kit, m, 'alipay'));

      await expectManual(kit, disabledApp, id, await decide(kit, worker, m, id));
      await expectReviewHit(kit, disabledApp, id, payee);
      const answer = await post(kit, m.first);
      expect(answer.json()).toMatchObject(refused('fraud_invite'));
      await expectBlockedHit(kit, disabledApp, payee);
    });
  },
  CHAIN_TIMEOUT,
);
