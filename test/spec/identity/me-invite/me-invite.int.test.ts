// B1-11k §9: BR-INV-02/07/18/19. Observe only GET /v1/me through the real AppModule.
// Each case includes a changed invitation outcome, with its related positive/regression controls;
// no production skeleton or mock is needed to make the old D4 implementation fail assertions.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AVATAR,
  CREATED,
  NAME,
  NOW,
  appeal,
  close,
  config,
  fixture,
  open,
  risk,
  verified,
  type Kit,
} from './kit.ts';

/**
 * Expected `risk` for an exact comparison: the base fields plus prev_risk_state, always present,
 * with the value derived from BR-ID-36 细则 (04 §6.1).
 */
function riskExpected(
  base: Record<string, unknown>,
  prev: 'frozen' | 'banned' | null,
): Record<string, unknown> {
  return { ...base, prev_risk_state: prev };
}

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
}, 120_000);
beforeEach(() => {
  kit.clock.set(NOW);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
}, 120_000);

it('[AC-B1-11k#1] normal 未实名按成年展示本人码，未绑手机仍 200 但邀请码为 null', async () => {
  const results = [];
  const expected = [];
  for (const status of ['absent', 'none', 'failed'] as const) {
    const f = await fixture(kit);
    if (status !== 'absent') {
      await sql`INSERT INTO app.realname (id, app_id, user_id, status)
        VALUES (${randomUUID()}, ${f.appId}, ${f.uid}, ${status})`.execute(kit.db);
    }
    const data = await f.get();
    results.push([data.invite_code, data.realname_status, data.identity_level, data.phone_bound]);
    expected.push([f.inviteCode, status === 'absent' ? 'none' : status, 'phone', true]);
  }
  const member = await fixture(kit, { phone: false });
  const data = await member.get();
  results.push([data.invite_code, data.realname_status, data.identity_level, data.phone_bound]);
  expected.push([null, 'none', 'member', false]);
  expect(results).toEqual(expected);
});

it('[AC-B1-11k#2] 风险矩阵：banned、frozen、appealing 均隐藏，申诉前状态及有无申诉单不影响结果', async () => {
  const cases = [
    { state: 'normal', previous: null },
    { state: 'banned', previous: null },
    { state: 'frozen', previous: null },
    { state: 'appealing', previous: 'banned' },
    { state: 'appealing', previous: 'frozen' },
    { state: 'appealing', previous: null },
  ] as const;
  const results = [];
  const expected = [];
  for (const item of cases) {
    const f = await fixture(kit);
    await risk(kit, f, item.state);
    if (item.previous !== null) await appeal(kit, f, item.previous);
    const data = await f.get();
    results.push({ code: data.invite_code, risk: data.risk, backfill: data.invite_backfill });
    expected.push({
      code: item.state === 'normal' ? f.inviteCode : null,
      // prev_risk_state: appealing → the processing account appeal's original penalty (fixture
      // `previous`; no appeal row → null), any other state → null (BR-ID-36 细则, 04 §6.1).
      risk: riskExpected(
        {
          state: item.state,
          reason_category: item.state === 'normal' ? null : 'other',
          frozen_until: item.state === 'frozen' ? '2035-01-01T00:00:00.000Z' : null,
        },
        item.state === 'appealing' ? item.previous : null,
      ),
      backfill: { eligible: true, deadline_at: '2026-10-08T02:00:00.000Z' },
    });
  }
  expect(results).toEqual(expected);
});

it('[AC-B1-11k#3] 同一账号已读取后变为 frozen 再恢复 normal，按调用时当前风险决定邀请码', async () => {
  const f = await fixture(kit);
  const before = await f.get();
  await risk(kit, f, 'frozen');
  const frozen = await f.get();
  await risk(kit, f, 'normal');
  const restored = await f.get();
  expect([before.invite_code, frozen.invite_code, restored.invite_code]).toEqual([
    f.inviteCode,
    null,
    f.inviteCode,
  ]);
  expect([before.risk.state, frozen.risk.state, restored.risk.state]).toEqual([
    'normal',
    'frozen',
    'normal',
  ]);
});

it('[AC-B1-11k#4] users.status=deleted 即不可邀请，full 与 deletion_only 均只隐藏本人码', async () => {
  const f = await fixture(kit);
  const before = await f.get();
  await sql`UPDATE app.users SET status = 'deleted' WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(
    kit.db,
  );
  const full = await f.get();
  const restricted = await f.get('deletion_only');
  expect(before.invite_code).toBe(f.inviteCode);
  expect(full).toEqual({ ...before, invite_code: null });
  expect(restricted).toEqual(full);
});

it('[AC-B1-11k#5] 已实名普通生日：满 18 周岁时刻前 1ms 隐藏，等于及之后恢复本人码', async () => {
  kit.clock.set('2026-10-18T15:00:00.000Z');
  const f = await fixture(kit);
  const birth = '2008-10-19';
  await verified(kit, f, birth);
  const results = [];
  // BR-INV-19 uses reachedAgeAt: the day AFTER the 18th birthday, 00:00 +08:00.
  for (const at of [
    '2026-10-18T16:00:00.000Z',
    '2026-10-19T15:59:59.999Z',
    '2026-10-19T16:00:00.000Z',
    '2026-10-19T16:00:00.001Z',
  ]) {
    kit.clock.set(at);
    results.push(await f.get());
  }
  expect(results.map((data) => data.invite_code)).toEqual([null, null, f.inviteCode, f.inviteCode]);
  expect(results.map((data) => [data.realname_status, data.identity_level])).toEqual(
    Array.from({ length: 4 }, () => ['verified', 'realname']),
  );
  const written = JSON.stringify(results) + kit.lines.join('\n');
  expect(written).not.toContain(NAME);
  expect(written).not.toContain(birth);
  expect(written).not.toContain(`synthetic-${f.uid}`);
});

it('[AC-B1-11k#6] 2 月 29 日出生非闰年按 3 月 1 日生日，次日零点才满 18 周岁', async () => {
  kit.clock.set('2026-02-28T15:00:00.000Z');
  const f = await fixture(kit, { createdAt: '2026-02-27T00:00:00.000Z' });
  await verified(kit, f, '2008-02-29');
  const results = [];
  for (const at of [
    '2026-02-28T16:00:00.000Z',
    '2026-03-01T15:59:59.999Z',
    '2026-03-01T16:00:00.000Z',
    '2026-03-01T16:00:00.001Z',
  ]) {
    kit.clock.set(at);
    results.push((await f.get()).invite_code);
  }
  expect(results).toEqual([null, null, f.inviteCode, f.inviteCode]);
});

it('[AC-B1-11k#7] 实名年龄只看当前用户及 app，同 app 成年人和另一 app 未实名用户不受未成年人影响', async () => {
  const minor = await fixture(kit);
  const adult = await fixture(kit, { appId: minor.appId });
  const otherApp = await fixture(kit);
  await verified(kit, minor, '2010-05-20');
  await verified(kit, adult, '2000-05-20');
  const results = [await adult.get(), await minor.get(), await otherApp.get()];
  expect(results.map((data) => [data.user_id, data.invite_code, data.realname_status])).toEqual([
    [adult.uid, adult.inviteCode, 'verified'],
    [minor.uid, null, 'verified'],
    [otherApp.uid, otherApp.inviteCode, 'none'],
  ]);
});

it('[AC-B1-11k#8] 未绑手机邀请码隐藏；第 5 天绑手机后恢复本人码，补填截止仍从建号起算', async () => {
  kit.clock.set('2026-10-06T02:00:00.000Z');
  const f = await fixture(kit, { phone: false });
  const before = await f.get();
  await sql`UPDATE app.users SET phone_hmac = ${randomBytes(32).toString('hex')}
    WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(kit.db);
  const after = await f.get();
  expect([before.invite_code, after.invite_code]).toEqual([null, f.inviteCode]);
  expect([before.phone_bound, after.phone_bound]).toEqual([false, true]);
  expect(before.invite_backfill).toEqual({
    eligible: true,
    deadline_at: '2026-10-08T02:00:00.000Z',
  });
  expect(after.invite_backfill).toEqual(before.invite_backfill);
});

it('[AC-B1-11k#9] 未绑手机默认 168h 补填窗口：前 1 秒可补填，等于及超过截止不可补填', async () => {
  const f = await fixture(kit, { phone: false });
  const results = [];
  for (const at of [
    '2026-10-08T01:59:59.000Z',
    '2026-10-08T02:00:00.000Z',
    '2026-10-08T02:00:01.000Z',
  ]) {
    kit.clock.set(at);
    const data = await f.get();
    results.push({ code: data.invite_code, backfill: data.invite_backfill });
  }
  expect(results).toEqual([
    { code: null, backfill: { eligible: true, deadline_at: '2026-10-08T02:00:00.000Z' } },
    { code: null, backfill: { eligible: false, deadline_at: null } },
    { code: null, backfill: { eligible: false, deadline_at: null } },
  ]);
});

it('[AC-B1-11k#10] 各 app 的 backfill_hours 改值生效，0 小时立即截止，均不使未绑手机展示邀请码', async () => {
  const cases = [
    { hours: 0, at: CREATED, eligible: false, deadline: null },
    { hours: 1, at: NOW, eligible: false, deadline: null },
    {
      hours: 2,
      at: '2026-10-01T03:59:59.000Z',
      eligible: true,
      deadline: '2026-10-01T04:00:00.000Z',
    },
    { hours: 2, at: '2026-10-01T04:00:00.000Z', eligible: false, deadline: null },
    {
      hours: 240,
      at: '2026-10-10T02:00:00.000Z',
      eligible: true,
      deadline: '2026-10-11T02:00:00.000Z',
    },
  ];
  const results = [];
  for (const item of cases) {
    kit.clock.set(item.at);
    const f = await fixture(kit, { phone: false });
    // Independent app IDs avoid depending on the content configuration cache's refresh timing.
    await config(kit, f.appId, 'invite.backfill_hours', item.hours);
    const data = await f.get();
    results.push({ code: data.invite_code, backfill: data.invite_backfill });
  }
  expect(results).toEqual(
    cases.map((item) => ({
      code: null,
      backfill: { eligible: item.eligible, deadline_at: item.deadline },
    })),
  );
});

it('[AC-B1-11k#11] 补填保留建号毫秒精度：截止前 1ms 可补填，等于边界不可补填，未实名未绑手机不展示码', async () => {
  const f = await fixture(kit, { phone: false, createdAt: '2026-10-01T02:00:00.789Z' });
  await config(kit, f.appId, 'invite.backfill_hours', 2);
  kit.clock.set('2026-10-01T04:00:00.788Z');
  const before = await f.get();
  kit.clock.set('2026-10-01T04:00:00.789Z');
  const at = await f.get();
  expect([before.invite_code, at.invite_code]).toEqual([null, null]);
  expect(before.invite_backfill).toEqual({
    eligible: true,
    deadline_at: '2026-10-01T04:00:00.789Z',
  });
  expect(at.invite_backfill).toEqual({ eligible: false, deadline_at: null });
});

it('[AC-B1-11k#12] 本人未成年隐藏本人码但保留已绑定状态，其余字段不变，不透露邀请人或实名资料', async () => {
  const parent = await fixture(kit);
  const f = await fixture(kit, { appId: parent.appId });
  await sql`UPDATE app.users SET parent_id = ${parent.uid}, parent_bind_source = 'register',
    parent_bound_at = ${new Date(CREATED)}, self_bind_used = true
    WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(kit.db);
  await sql`UPDATE app.users SET nickname = '私有邀请人昵称'
    WHERE app_id = ${parent.appId} AND id = ${parent.uid}`.execute(kit.db);
  // B1-02zzza: phone_bound=true needs a real encrypted number so masked_phone can be derived.
  const number = '13800138000';
  const { FIELD_CRYPTO } = await import('../../../../apps/api/src/modules/platform/index.ts');
  type FieldCrypto = import('../../../../apps/api/src/modules/platform/index.ts').FieldCrypto;
  const crypto = kit.app.get<FieldCrypto>(FIELD_CRYPTO);
  await kit.db
    .withSchema('app')
    .updateTable('users')
    .set({
      phone_hmac: crypto.blindIndex(number, 'users.phone'),
      phone_cipher: Buffer.from(crypto.encrypt(number, 'users.phone'), 'utf8'),
    })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
  await verified(kit, f, '2010-05-20');
  const userBefore = await sql`SELECT * FROM app.users WHERE id = ${f.uid}`.execute(kit.db);
  const realnameBefore = await sql`SELECT * FROM app.realname WHERE user_id = ${f.uid}`.execute(
    kit.db,
  );
  const data = await f.get();
  expect(data).toEqual({
    user_id: f.uid,
    nickname: '邀请字段测试用户',
    avatar_url: AVATAR,
    invite_code: null,
    inviter_bound: true,
    invite_backfill: { eligible: false, deadline_at: null },
    identity_level: 'realname',
    phone_bound: true,
    masked_phone: '138****8000',
    balance: { available_fen: 0, withdrawable_fen: 0, estimated_total_fen: 0 },
    union_bindings: [
      { platform: 'taobao', status: 'unbound' },
      { platform: 'pdd', status: 'unbound' },
    ],
    realname_status: 'verified',
    need_reconsent: true,
    // Normal → prev_risk_state null (04 §6.1).
    risk: riskExpected({ state: 'normal', reason_category: null, frozen_until: null }, null),
  });
  const response = JSON.stringify(data);
  for (const value of [parent.uid, parent.inviteCode, '私有邀请人昵称', NAME, '2010-05-20']) {
    expect(response).not.toContain(value);
  }
  expect(kit.lines.join('\n')).not.toContain(NAME);
  expect(kit.lines.join('\n')).not.toContain('2010-05-20');
  expect((await sql`SELECT * FROM app.users WHERE id = ${f.uid}`.execute(kit.db)).rows).toEqual(
    userBefore.rows,
  );
  expect(
    (await sql`SELECT * FROM app.realname WHERE user_id = ${f.uid}`.execute(kit.db)).rows,
  ).toEqual(realnameBefore.rows);
});

it('[AC-B1-11k#13] 无法展示邀请码不替代补填条件：自助绑定已用、已有下级或开关关闭仍不可补填', async () => {
  const results = [];
  for (const condition of ['unused', 'used', 'child', 'off', 'false'] as const) {
    const f = await fixture(kit, { phone: false });
    if (condition === 'used') {
      await sql`UPDATE app.users SET self_bind_used = true
        WHERE app_id = ${f.appId} AND id = ${f.uid}`.execute(kit.db);
    }
    if (condition === 'child') {
      const child = await fixture(kit, { appId: f.appId });
      await sql`UPDATE app.users SET parent_id = ${f.uid}, parent_bind_source = 'register',
        parent_bound_at = ${new Date(CREATED)}, status = 'deleted'
        WHERE app_id = ${child.appId} AND id = ${child.uid}`.execute(kit.db);
    }
    if (condition === 'off' || condition === 'false') {
      await config(kit, f.appId, 'growth.invite_bind.enabled', condition === 'off' ? 'off' : false);
    }
    const data = await f.get();
    results.push([data.invite_code, data.inviter_bound, data.invite_backfill]);
  }
  expect(results).toEqual([
    [null, false, { eligible: true, deadline_at: '2026-10-08T02:00:00.000Z' }],
    ...Array.from({ length: 4 }, () => [null, false, { eligible: false, deadline_at: null }]),
  ]);
});
