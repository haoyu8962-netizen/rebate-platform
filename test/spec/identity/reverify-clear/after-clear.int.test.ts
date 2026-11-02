// B1-02zw round 2 (task §12; 编排 D10-584, money r1 S1). The manual clearing also restarts the dormancy
// clock: the transaction that clears the flag sets last_active_at to the clearing instant (injected
// Clock) and leaves last_login_device_hash alone, so the owner's next login on a new device is not
// flagged, while a new dormancy of the switch's days still is. And the user_profile_edit row says what
// happened to the identities: the providers really unbound and that the flag was cleared.
//
// One Harness over the B1-02zp kit, as withdraw.int.test.ts: the save is the real PATCH on an admin
// entry, the logins are real ones on the api entry, over the same database, Redis and field keyring.
// The two entries have a clock each: s.clock is the save's, kit.clock the login's; a login test moves
// kit.clock to the clearing instant plus the time it wants to pass.
//
// `extra` is what `after` says beyond the keys of B1-27b. #36 and #37 judge its two clearing keys,
// reverify_cleared and unbound_providers (task §13), against expectations written by hand, never
// against another audit under test; #35 to #37 also look for the providers in its JSON text.
//
// Every case ends on a step only this round's implementation passes: a case that says "nothing
// changes" goes on to a real clearing of the same account or of a flagged peer.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { hashAdminPassword } from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { ORIGIN, type Harness } from '../../admin/auth/kit.ts';
import {
  REASON,
  added,
  auditText,
  audits,
  edit,
  ok,
  row,
  testPhone,
  type AuditRow,
  type EditBody,
  type User,
} from '../admin-profile/kit.ts';
import { lockWaiters } from '../deletion-processing/kit.ts';
import {
  DORMANT,
  HOUR,
  SECOND,
  ago,
  closeKit,
  fixture,
  openKit,
  trustedOf,
  type Kit,
} from '../reverify/kit.ts';
import { phone } from '../sms-codes/kit.ts';
import {
  TOKEN,
  account,
  bindings,
  breakableAudit,
  expectCleared,
  phoneChangeClears,
  scene,
  spellings,
  state,
  type AccountSpec,
  type Provider,
  type Scene,
} from './kit.ts';

let kit: Kit;
let h: Harness;

beforeAll(async () => {
  kit = await openKit();
  const password = randomBytes(24).toString('base64url');
  const appKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  h = {
    db: kit.suite.db.withSchema('app'),
    redis: kit.suite.server,
    fields: kit.crypto,
    env: {
      APP_ENV: 'test',
      LOG_LEVEL: 'silent',
      FIELD_KEY_PROVIDER: 'local',
      FIELD_MASTER_KEY_FILE: join(kit.dir, 'master.hex'),
      FIELD_KEYRING_FILE: join(kit.dir, 'keyring.json'),
      ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
      ADMIN_IP_ALLOWLIST: '127.0.0.1,::1,192.0.2.0/24,2001:db8::/32',
      ADMIN_CORS_ORIGIN: ORIGIN,
      JWT_KEY_ID: 'b1-02zw-app',
      JWT_PRIVATE_KEY_PEM: appKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    password,
    passwordHash: await hashAdminPassword(password),
    appKey,
    apps: [],
  };
}, 180_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of h.apps.splice(0)) await app.close();
});
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

type Target = Pick<User, 'id' | 'appId'>;

const PROVIDERS: readonly Provider[] = ['apple', 'huawei', 'wechat'];
/** The keys of `after` since B1-27b. */
const PLAIN_KEYS = new Set(['user_id', 'reason', 'fields', 'phone_masked', 'nickname']);
/** Something to unbind, the Apple token included, and a trusted identity that stays. */
const FLAGGED: AccountSpec = {
  bound: ['apple', 'huawei', 'wechat'],
  trusted: ['wechat'],
  token: TOKEN,
};

const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
const spaced = (p: string) => `+86 ${p.slice(0, 3)} ${p.slice(3, 7)} ${p.slice(7)}`;

async function activityOf(s: Scene, target: Target) {
  const { last_active_at, last_login_device_hash } = await row(s.h, target);
  return { last_active_at, last_login_device_hash };
}
type Activity = Awaited<ReturnType<typeof activityOf>>;

/**
 * The account was last seen `idle` ms ago on a device of its own; null leaves the value empty.
 * Returns what is stored.
 */
async function lastSeen(
  s: Scene,
  target: Target,
  idle: number | null = 2 * DORMANT,
  device = true,
): Promise<Activity> {
  const at = idle === null ? null : later(s.clock.now(), -idle);
  const hash = device ? randomBytes(32).toString('hex') : null;
  await sql`UPDATE app.users SET last_active_at = ${at}, last_login_device_hash = ${hash}
    WHERE app_id = ${target.appId} AND id = ${target.id}`.execute(s.h.db);
  return activityOf(s, target);
}

/** The dormancy clock restarted at the save just made (no time has passed on s.clock since). */
async function expectRestarted(s: Scene, target: Target, before: Activity) {
  expect(await activityOf(s, target)).toEqual({
    last_active_at: s.clock.now(),
    last_login_device_hash: before.last_login_device_hash,
  });
}

/** The users row as the next holder of its lock sees it: it waits for a save holding the lock. */
const readUnderLock = (s: Scene, target: Target) =>
  sql<{ last_active_at: Date | null; reverify_flagged_at: Date | null }>`
    SELECT last_active_at, reverify_flagged_at FROM app.users
    WHERE app_id = ${target.appId} AND id = ${target.id} FOR UPDATE`.execute(s.h.db);

/** A successful save; returns the one audit row it added. */
async function saved(s: Scene, target: Target, body: EditBody): Promise<AuditRow> {
  const before = await audits(s.h, s.appId);
  await ok(await edit(s, target.id, { ...body, reason: REASON }));
  const rows = added(before, await audits(s.h, s.appId));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ target: target.id });
  return rows[0]!;
}

/** What an audit's `after` says beyond the keys of B1-27b. */
function extra(entry: AuditRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries((entry.after ?? {}) as object).filter(([key]) => !PLAIN_KEYS.has(key)),
  );
}

/** The providers named anywhere in `told`, keys included. */
function named(told: Record<string, unknown>): Provider[] {
  const text = JSON.stringify(told);
  return PROVIDERS.filter((provider) => text.includes(provider));
}

/** What the audit of an ordinary phone change says: the contrast of a clearing. */
const ordinary = async (s: Scene) =>
  extra(
    await saved(s, await account(s, { bound: ['huawei'], flagged: false }), {
      phone: testPhone(),
    }),
  );

/**
 * A member of the B1-02zp fixture, flagged after a dormancy far over the switch, whose flag a real
 * phone change has just cleared. wechat is trusted and stays; huawei is unbound.
 */
async function reinstated() {
  const f = await fixture(kit);
  const earlier = await f.device();
  const { uid } = await f.user();
  await f.bind(uid, 'huawei');
  await f.bind(uid, 'wechat');
  await f.active(uid, ago(kit, 10 * DORMANT), earlier.hash);
  await f.flag(uid, { realname: false, providers: ['wechat'] });
  const s = await scene(h, { appId: f.appId });
  const number = phone('139');
  await ok(await edit(s, uid, { phone: number, reason: REASON }));
  expect(await f.state(uid)).toMatchObject({ reverify_flagged_at: null, reverify_trusted: null });
  return { f, uid, number, earlier, clearedAt: s.clock.now() };
}

it.each([
  { name: '久未活动', idle: 2 * DORMANT, device: true },
  { name: '最近活动为空', idle: null, device: true },
  { name: '上次登录设备为空', idle: 2 * DORMANT, device: false },
])(
  '[AC-B1-02zw#29] 带标记账号改号（$name）：last_active_at 置为清除时刻（注入时钟），last_login_device_hash 不动；同 App 另一带标记账号的活动不动',
  async ({ idle, device }) => {
    const s = await scene(h);
    const target = await account(s, FLAGGED);
    const peer = await account(s, FLAGGED);
    const before = await lastSeen(s, target, idle, device);
    const peerBefore = await lastSeen(s, peer);
    await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
    await expectCleared(s, target);
    await expectRestarted(s, target, before);
    expect(await activityOf(s, peer)).toEqual(peerBefore);
  },
);

it('[AC-B1-02zw#30] 清除后原主人在新设备登录不打标：开关大于 0、清除前已休眠远超开关天数也一样，活动照常覆盖', async () => {
  const { f, uid, number, clearedAt } = await reinstated();
  kit.clock.set(later(clearedAt, HOUR));
  const fresh = await f.device();
  expect((await f.smsLogin(number, fresh)).user_id).toBe(uid);
  expect(await f.state(uid)).toMatchObject({
    reverify_flagged_at: null,
    reverify_trusted: null,
    last_active_at: kit.clock.now(),
    last_login_device_hash: fresh.hash,
  });
});

it.each([
  { name: '差 1 秒不到开关天数：不打标', idle: DORMANT - SECOND, flags: false },
  { name: '恰好满开关天数：照常打标，可信身份按此刻重新固定', idle: DORMANT, flags: true },
])(
  '[AC-B1-02zw#31] 清除后再休眠、换设备登录（$name）：休眠从清除时刻算起，比较的仍是清除前的上次登录设备',
  async ({ idle, flags }) => {
    const { f, uid, number, earlier, clearedAt } = await reinstated();
    expect(await f.state(uid)).toMatchObject({
      last_active_at: clearedAt,
      last_login_device_hash: earlier.hash,
    });
    kit.clock.set(later(clearedAt, idle));
    const fresh = await f.device();
    await f.smsLogin(number, fresh);
    const after = await f.state(uid);
    expect(after).toMatchObject({
      reverify_flagged_at: flags ? kit.clock.now() : null,
      last_active_at: kit.clock.now(),
      last_login_device_hash: fresh.hash,
    });
    expect(trustedOf(after)).toEqual(flags ? { realname: false, providers: ['wechat'] } : null);
  },
);

it('[AC-B1-02zw#32] 同事务：改号后段出错（审计写失败）回滚时 last_active_at 与上次登录设备不变；重试成功才写入', async () => {
  const s = await scene(h);
  const target = await account(s, FLAGGED);
  const before = await lastSeen(s, target);
  await breakableAudit(s);
  s.control.failAudit = true;
  const response = await edit(s, target.id, { phone: testPhone(), reason: REASON });
  expect(s.control.failAudit, '审计失败没有发生').toBe(false);
  expect(response.statusCode).toBe(500);
  expect(await activityOf(s, target)).toEqual(before);
  await phoneChangeClears(s, target);
  await expectRestarted(s, target, before);
});

it('[AC-B1-02zw#33] 同事务：保存持有 users 行锁时排队的读者，保存一提交就读到清标记后的行，last_active_at 已是清除时刻（不是提交后补写）', async () => {
  const s = await scene(h);
  const target = await account(s, FLAGGED);
  await lastSeen(s, target);
  const queuedRead: { row?: ReturnType<typeof readUnderLock> } = {};
  s.control.onSend = async () => {
    queuedRead.row = readUnderLock(s, target);
    await lockWaiters(s.h.db, 1);
  };
  await ok(await edit(s, target.id, { phone: testPhone(), reason: REASON }));
  expect(queuedRead.row, '保存没有写撤销作业').toBeDefined();
  const { rows } = await queuedRead.row!;
  expect(rows).toEqual([{ last_active_at: s.clock.now(), reverify_flagged_at: null }]);
});

const UNEDITED: { name: string; body: (current: string) => EditBody }[] = [
  { name: '只改昵称', body: () => ({ nickname: '小狸' }) },
  { name: '手机号规范化后等于原号', body: (current) => ({ phone: spaced(current) }) },
];

it.each(UNEDITED)(
  '[AC-B1-02zw#34] $name：标记还在，last_active_at 与上次登录设备不动，审计与普通改号一样不提解绑和清除；之后真改号才写入',
  async ({ body }) => {
    const s = await scene(h);
    const plain = await ordinary(s);
    const target = await account(s, FLAGGED);
    const before = await lastSeen(s, target);
    const entry = await saved(s, target, body(target.phone!));
    expect(extra(entry)).toEqual(plain);
    expect(await activityOf(s, target)).toEqual(before);
    expect((await state(s, target)).reverify_flagged_at).not.toBeNull();
    await phoneChangeClears(s, target);
    await expectRestarted(s, target, before);
  },
);

it('[AC-B1-02zw#35] 账号无标记时改手机号：last_active_at 与上次登录设备不动，审计不提解绑；同一请求路径上带标记的账号才写入', async () => {
  const s = await scene(h);
  const target = await account(s, { bound: ['apple', 'huawei'], token: TOKEN, flagged: false });
  const before = await lastSeen(s, target);
  const entry = await saved(s, target, { phone: testPhone() });
  expect(named(extra(entry))).toEqual([]);
  expect(await activityOf(s, target)).toEqual(before);

  const peer = await account(s, { bound: ['huawei'] });
  const peerBefore = await lastSeen(s, peer);
  expect(named(extra(await saved(s, peer, { phone: testPhone() })))).toEqual(['huawei']);
  await expectRestarted(s, peer, peerBefore);
});

const UNBOUND: { name: string; spec: AccountSpec; gone: Provider[] }[] = [
  {
    name: 'Apple 带令牌、华为一起解绑，可信的微信留着',
    spec: FLAGGED,
    gone: ['apple', 'huawei'],
  },
  {
    name: 'Apple 没存 refresh token：没有作业也照记',
    spec: { bound: ['apple'] },
    gone: ['apple'],
  },
  {
    name: '快照里的身份早已不在：只记实际删掉的行',
    spec: { bound: ['wechat'], trusted: ['huawei'] },
    gone: ['wechat'],
  },
];

it.each(UNBOUND)(
  '[AC-B1-02zw#36] 带标记账号改号解绑（$name）：审计 after 含实际解绑的 provider 和标记已清除，没绑过或留下的身份不算，不含令牌',
  async ({ spec, gone }) => {
    const s = await scene(h);
    const target = await account(s, spec);
    const stored = await bindings(s, target);
    const entry = await saved(s, target, { phone: testPhone() });
    const told = extra(entry);
    expect(told['reverify_cleared']).toBe(true);
    expect(told['unbound_providers']).toEqual(gone);
    expect(named(told)).toEqual(gone);
    const text = auditText(entry);
    const ciphers = stored.flatMap((binding) =>
      binding.apple_refresh_token_cipher === null
        ? []
        : spellings(binding.apple_refresh_token_cipher),
    );
    for (const secret of [...spellings(Buffer.from(TOKEN, 'utf8')), ...ciphers]) {
      expect(text).not.toContain(secret);
    }
  },
);

const NOTHING_UNBOUND: { name: string; spec: AccountSpec }[] = [
  { name: '全部可信', spec: { bound: ['huawei', 'wechat'], trusted: ['huawei', 'wechat'] } },
  { name: '没有第三方身份', spec: { bound: [] } },
];

it.each(NOTHING_UNBOUND)(
  '[AC-B1-02zw#37] 带标记账号改号但没有解绑（$name）：审计不写解绑内容，标记已清除仍比普通改号多记一笔',
  async ({ spec }) => {
    const s = await scene(h);
    const plain = await ordinary(s);
    expect(plain).not.toHaveProperty('reverify_cleared');
    expect(plain).not.toHaveProperty('unbound_providers');
    const target = await account(s, spec);
    const told = extra(await saved(s, target, { phone: testPhone() }));
    await expectCleared(s, target);
    expect(told['reverify_cleared']).toBe(true);
    expect(told).not.toHaveProperty('unbound_providers');
    expect(named(told)).toEqual([]);
  },
);
