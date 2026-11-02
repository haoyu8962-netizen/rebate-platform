// B1-03zi: 提现设备黑名单线上生效 (BR-ID-31, BR-WDR-03 ③a, BR-WDR-29 ⑨, BR-WDR-30 ⑫; D10-571,
// FU-DEVICE-USER-ID 方案 B), through the real AppModule: POST /v1/withdrawals and GET
// /v1/withdrawals/rules on the api entry, the evt.payout-auto-payout handler on the worker entry.
// ③a looks at the device of the request; ⑨ at every device the member's sessions were ever on,
// revoked sessions and revoked devices included. Members come from real SMS logins (./kit.ts), so
// devices.user_id is NULL as in production. Before the implementation the device dimension never
// hits, so every test opens with a hit that must happen; what already holds (a device that must not
// count, another dimension, a disabled rule) follows it in the same test.
import { randomBytes } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { close, open, type Kit } from '../../identity/payout-account/kit.ts';
import { CHAIN_TIMEOUT, T, withWorker } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { RULE_OF, setRule, settled } from '../../payout/risk-rule-toggle/kit.ts';
import {
  apply,
  blockCode,
  blockDevice,
  blockMember,
  decide,
  deviceRow,
  expectHit,
  expectNoHit,
  logout,
  member,
  newApp,
  post,
  refused,
  registerDevice,
  rules,
  sessionRow,
  withdrawPrivacy,
  withdrawalRow,
} from './kit.ts';

const DAY_MS = 86_400_000;

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
  '[AC-B1-03zi#1] 真实注册登录后设备哈希进黑名单：从这台设备 POST /v1/withdrawals 得 44001，此时 devices.user_id 是 null',
  async () => {
    const appId = await newApp(kit);
    const device = await registerDevice(kit, appId);
    const m = await member(kit, appId, device);
    expect(m.first.isNewUser).toBe(true);
    expect(await deviceRow(kit, device)).toMatchObject({ user_id: null });

    await blockDevice(kit, device, 'malicious_rights');
    const answer = await post(kit, m.first);
    expect(answer.json()).toMatchObject(refused('malicious_rights'));
    expect(answer.statusCode).toBe(403);
    expect(await deviceRow(kit, device)).toMatchObject({ user_id: null });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#2] 真实注册登录后设备哈希进黑名单：从这台设备 GET /v1/withdrawals/rules 的 block_code 是 44001，此时 devices.user_id 是 null',
  async () => {
    const appId = await newApp(kit);
    const device = await registerDevice(kit, appId);
    const m = await member(kit, appId, device);

    await blockDevice(kit, device);
    expect(await blockCode(kit, m.first)).toBe(44001);
    expect(await deviceRow(kit, device)).toMatchObject({ user_id: null });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#3] ③a 只看发起请求的设备：同一账号的设备 X 被拉黑，从 X 发起 44001，从 Y 发起不是 44001',
  async () => {
    const appId = await newApp(kit);
    const x = await registerDevice(kit, appId);
    const y = await registerDevice(kit, appId);
    const m = await member(kit, appId, x);
    const onY = await m.login(y);

    await blockDevice(kit, x);
    expect((await post(kit, m.first)).json()).toMatchObject(refused('other'));
    expect(await blockCode(kit, m.first)).toBe(44001);

    expect(await blockCode(kit, onY)).not.toBe(44001);
    const id = await apply(kit, onY);
    expect(await withdrawalRow(kit, appId, id)).toMatchObject({ status: 'PENDING_REVIEW' });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#4] ⑨ 看用过的所有设备：从 Y 发起的单，设备 X 申请后或申请前被拉黑，自动到账判定都命中 blacklist_hit、转人工',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const after = await registerDevice(kit, appId);
      const clean = await registerDevice(kit, appId);
      const m = await member(kit, appId, after);
      const id = await apply(kit, await m.login(clean));
      await blockDevice(kit, after);
      expectHit(await decide(kit, worker, m, id));
      expect(await withdrawalRow(kit, appId, id)).toMatchObject({
        status: 'PENDING_REVIEW',
        review_mode: 'manual',
      });

      const before = await registerDevice(kit, appId);
      const other = await registerDevice(kit, appId);
      const next = await member(kit, appId, before);
      const onOther = await next.login(other);
      await blockDevice(kit, before);
      const second = await apply(kit, onOther);
      expectHit(await decide(kit, worker, next, second));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#5] 多账号不覆盖：A 登过 D、B 后登 D（last_login_sid 已是 B 的），D 被拉黑后 A 从 D 发起 44001，A 从别的设备发起的单 ⑨ 仍命中',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const shared = await registerDevice(kit, appId);
      const own = await registerDevice(kit, appId);
      const a = await member(kit, appId, shared);
      const onOwn = await a.login(own);
      const b = await member(kit, appId, shared);
      expect(await deviceRow(kit, shared)).toMatchObject({
        user_id: null,
        last_login_sid: b.first.sid,
      });
      expect(b.userId).not.toBe(a.userId);

      const id = await apply(kit, onOwn);
      await blockDevice(kit, shared);
      expect((await post(kit, a.first)).json()).toMatchObject(refused('other'));
      expect((await post(kit, b.first)).json()).toMatchObject(refused('other'));
      expectHit(await decide(kit, worker, a, id));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#6] 不牵连：别的用户的设备被拉黑，那个用户命中；本账号（从未登过那台）③a、⑨ 都不命中',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const theirs = await registerDevice(kit, appId);
      const mine = await registerDevice(kit, appId);
      const owner = await member(kit, appId, theirs);
      const m = await member(kit, appId, mine);
      const ownerId = await apply(kit, owner.first);

      await blockDevice(kit, theirs);
      expect((await post(kit, owner.first)).json()).toMatchObject(refused('other'));
      expectHit(await decide(kit, worker, owner, ownerId));

      expect(await blockCode(kit, m.first)).not.toBe(44001);
      const id = await apply(kit, m.first);
      expectNoHit(await decide(kit, worker, m, id));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#7] 不牵连：别的 app 同 hash 的黑名单行不算；那个 app 自己的会员命中，本 app 同 hash 设备的会员 ③a、⑨ 都不命中',
  async () => {
    await withWorker(kit, async (worker) => {
      const sameHash = randomBytes(32).toString('hex');
      const listedApp = await newApp(kit);
      const listedDevice = await registerDevice(kit, listedApp, sameHash);
      const listed = await member(kit, listedApp, listedDevice);
      const appId = await newApp(kit);
      const device = await registerDevice(kit, appId, sameHash);
      const m = await member(kit, appId, device);

      await blockDevice(kit, listedDevice);
      expect((await post(kit, listed.first)).json()).toMatchObject(refused('other'));

      expect(await blockCode(kit, m.first)).not.toBe(44001);
      const id = await apply(kit, m.first);
      expectNoHit(await decide(kit, worker, m, id));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#8] 已吊销仍算：会话已退出登录的设备被拉黑，⑨ 仍命中',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const signedOut = await registerDevice(kit, appId);
      const current = await registerDevice(kit, appId);
      const m = await member(kit, appId, signedOut);
      const onCurrent = await m.login(current);
      await logout(kit, m.first);
      expect((await sessionRow(kit, m.first)).revoked_at).not.toBeNull();
      expect((await sessionRow(kit, onCurrent)).revoked_at).toBeNull();

      const id = await apply(kit, onCurrent);
      await blockDevice(kit, signedOut);
      expectHit(await decide(kit, worker, m, id));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#9] 已吊销仍算：撤回同意吊销了的设备被拉黑，⑨ 仍命中',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const withdrawn = await registerDevice(kit, appId);
      const current = await registerDevice(kit, appId);
      const m = await member(kit, appId, withdrawn);
      const onCurrent = await m.login(current);
      await withdrawPrivacy(kit, m.first);
      expect((await deviceRow(kit, withdrawn)).revoked_at).not.toBeNull();
      expect((await sessionRow(kit, m.first)).revoked_at).not.toBeNull();

      const id = await apply(kit, onCurrent);
      await blockDevice(kit, withdrawn);
      expectHit(await decide(kit, worker, m, id));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#10] 其他维度行为不变：设备命中 44001 之外，手机号、身份证、收款账号命中仍 44001，申请后才登记的仍记 ⑨',
  async () => {
    await withWorker(kit, async (worker) => {
      const deviceApp = await newApp(kit);
      const device = await registerDevice(kit, deviceApp);
      const listed = await member(kit, deviceApp, device);
      await blockDevice(kit, device);
      expect((await post(kit, listed.first)).json()).toMatchObject(refused('other'));

      for (const dimension of ['phone', 'id_no', 'alipay'] as const) {
        const appId = await newApp(kit);
        const m = await member(kit, appId, await registerDevice(kit, appId));
        const id = await apply(kit, m.first);
        await blockMember(kit, m, dimension, 'fraud_invite');
        const answer = await post(kit, m.first);
        expect(answer.statusCode).toBe(403);
        expect(answer.json()).toMatchObject(refused('fraud_invite'));
        expectHit(await decide(kit, worker, m, id));
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#11] 规则启停（B2-11f）：BLACKLIST_DEVICE 启用时命中；停用时 ③a、⑨ 都跳过设备维度；手机号规则停用时往下看到设备维度',
  async () => {
    await withWorker(kit, async (worker) => {
      const enabledApp = await newApp(kit);
      await setRule(kit.db, enabledApp, RULE_OF.device, 'enabled', kit.clock.now());
      const enabledDevice = await registerDevice(kit, enabledApp);
      const enabled = await member(kit, enabledApp, enabledDevice);
      await blockDevice(kit, enabledDevice);
      expect((await post(kit, enabled.first)).json()).toMatchObject(refused('other'));

      // The status is set before the app's first request, so no reader holds an older answer.
      const skippedPhoneApp = await newApp(kit);
      await setRule(kit.db, skippedPhoneApp, RULE_OF.phone, 'disabled', kit.clock.now());
      const nextDevice = await registerDevice(kit, skippedPhoneApp);
      const next = await member(kit, skippedPhoneApp, nextDevice);
      await blockMember(kit, next, 'phone', 'fraud_invite');
      await blockDevice(kit, nextDevice, 'malicious_rights');
      expect((await post(kit, next.first)).json()).toMatchObject(refused('malicious_rights'));

      const disabledApp = await newApp(kit);
      await setRule(kit.db, disabledApp, RULE_OF.device, 'disabled', kit.clock.now());
      const listedDevice = await registerDevice(kit, disabledApp);
      const otherDevice = await registerDevice(kit, disabledApp);
      const m = await member(kit, disabledApp, listedDevice);
      const onOther = await m.login(otherDevice);
      await blockDevice(kit, listedDevice);
      expect(await blockCode(kit, m.first)).not.toBe(44001);
      const fromListed = await apply(kit, m.first);
      expectNoHit(await decide(kit, worker, m, fromListed));
      const fromOther = await apply(kit, onOther);
      expectNoHit(await decide(kit, worker, m, fromOther));
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#12] worker 真实角色能读 sessions：真实 worker 入口的判定在 couli_app 连接上命中 ⑨，不是超级用户直连',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const listedDevice = await registerDevice(kit, appId);
      const current = await registerDevice(kit, appId);
      const m = await member(kit, appId, listedDevice);
      const id = await apply(kit, await m.login(current));
      await blockDevice(kit, listedDevice);

      // Collected first: a permission error of the role must show as this assertion's failure.
      const outcome = await settled(() => decide(kit, worker, m, id));
      expect(outcome).toMatchObject({ ok: true });
      expectHit(outcome.ok ? outcome.value : null);

      const { rows } = await sql<{ role: string; superuser: boolean; reads_sessions: boolean }>`
        SELECT current_user AS role,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          has_table_privilege(current_user, 'app.sessions', 'SELECT') AS reads_sessions`.execute(
        kit.db,
      );
      expect(rows[0]).toEqual({ role: 'couli_app', superuser: false, reads_sessions: true });
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#13] 日志与错误不含手机号、设备哈希明文（BR-ID-33）：44001 响应、rules 响应、⑨ 判定及两个入口的日志',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      const listedDevice = await registerDevice(kit, appId);
      const current = await registerDevice(kit, appId);
      const m = await member(kit, appId, listedDevice);
      const onCurrent = await m.login(current);
      const from = kit.lines.length;
      const fromWorker = worker.lines.length;

      const id = await apply(kit, onCurrent);
      await blockDevice(kit, listedDevice);
      const answer = await post(kit, m.first);
      expect(answer.json()).toMatchObject(refused('other'));
      const ruled = await rules(kit, m.first);
      expect(ruled.json()).toMatchObject({ data: { block_code: 44001 } });
      const decision = await decide(kit, worker, m, id);
      expectHit(decision);

      const text = [
        ...kit.lines.slice(from),
        ...worker.lines.slice(fromWorker),
        answer.body,
        ruled.body,
        JSON.stringify(decision),
      ].join('\n');
      for (const plain of [m.number, listedDevice.deviceHash, current.deviceHash]) {
        expect(text.includes(plain)).toBe(false);
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#14] ⑨ 不只看最早的设备：先后登录 X、Y、Z，从 X 发起，拉黑最后登录的 Z 或居中的 Y，都命中 blacklist_hit、转人工',
  async () => {
    await withWorker(kit, async (worker) => {
      for (const listed of ['latest', 'middle'] as const) {
        const appId = await newApp(kit);
        const x = await registerDevice(kit, appId);
        const y = await registerDevice(kit, appId);
        const z = await registerDevice(kit, appId);
        const m = await member(kit, appId, x);
        await m.login(y);
        await m.login(z);

        const id = await apply(kit, m.first);
        await blockDevice(kit, listed === 'latest' ? z : y);
        expectHit(await decide(kit, worker, m, id));
        expect(await withdrawalRow(kit, appId, id)).toMatchObject({
          status: 'PENDING_REVIEW',
          review_mode: 'manual',
        });
      }
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B1-03zi#15] ⑨ 不设时间窗：比 T 早 40 天在 X 上真实登录，回到 T 在 Y 上登录并发起，拉黑 X，仍命中 blacklist_hit、转人工',
  async () => {
    await withWorker(kit, async (worker) => {
      const appId = await newApp(kit);
      kit.clock.set(new Date(Date.parse(T) - 40 * DAY_MS));
      const old = await registerDevice(kit, appId);
      const m = await member(kit, appId, old);

      kit.clock.set(T);
      const current = await registerDevice(kit, appId);
      const onCurrent = await m.login(current);
      const { created_at } = await sessionRow(kit, m.first);
      expect(Date.parse(T) - created_at.getTime()).toBeGreaterThan(39 * DAY_MS);

      const id = await apply(kit, onCurrent);
      await blockDevice(kit, old);
      expectHit(await decide(kit, worker, m, id));
      expect(await withdrawalRow(kit, appId, id)).toMatchObject({
        status: 'PENDING_REVIEW',
        review_mode: 'manual',
      });
    });
  },
  CHAIN_TIMEOUT,
);
