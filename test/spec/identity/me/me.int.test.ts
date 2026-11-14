// B1-02z GET /v1/me (04 §6.1). While getMe is planned the route is not registered (Nest 404 with
// no code), so every case is red on an assertion until the implementation and the mechanical
// removal of x-implementation: planned. Rule sources: BR-ID-01 (identity level from the database),
// BR-ID-12 (need_reconsent), BR-INV-07 (a)(b)(c) + BR-INV-21 (invite_backfill and the switch),
// BR-INV-18 (banned → invite_code null), OPS-12 (risk), OPS-20 (no user level); brief §9.3
// (item 13, D22 / D23: the sentinel avatar answers the app's me.default_avatar_url).
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AVATAR_KEY,
  BACKFILL_MS,
  DEFAULT_AVATAR,
  DEFAULT_AVATAR_URL,
  HOUR,
  ME,
  NICKNAME,
  appeal,
  at,
  binding,
  child,
  closeKit,
  config,
  consent,
  consentAll,
  envelope,
  fixture,
  instant,
  linesSince,
  me,
  openKit,
  operation,
  order,
  riskState,
  serverError,
  warnings,
  type Kit,
} from './http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

const ZERO = { available_fen: 0, withdrawable_fen: 0, estimated_total_fen: 0 };
const UNBOUND = [
  { platform: 'taobao', status: 'unbound' },
  { platform: 'pdd', status: 'unbound' },
];
const NORMAL = { state: 'normal', reason_category: null, frozen_until: null };

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

it('[AC-B1-02z#1] 新微信号：member、未绑手机、默认昵称头像、可补填且截止为建号 +168h、余额 0、两平台未授权、实名 none', async () => {
  const f = await fixture(kit);
  await consentAll(kit, f);
  const data = me(kit, await f.get());
  // invite_code 取值改由 [AC-B1-11k#*] 覆盖（E4）：这里只断言 invite_code 键存在（字符串或 null），
  // 其余字段照旧整体比对。
  expect(data).toHaveProperty('invite_code');
  const { invite_code: inviteCode, ...rest } = data;
  expect(inviteCode === null || typeof inviteCode === 'string').toBe(true);
  expect(rest).toEqual({
    user_id: f.uid,
    nickname: NICKNAME,
    avatar_url: DEFAULT_AVATAR_URL,
    inviter_bound: false,
    invite_backfill: { eligible: true, deadline_at: expect.any(String) },
    identity_level: 'member',
    phone_bound: false,
    balance: ZERO,
    union_bindings: UNBOUND,
    realname_status: 'none',
    need_reconsent: false,
    // Not appealing → prev_risk_state null (04 §6.1).
    risk: riskExpected(NORMAL, null),
  });
  at(data.invite_backfill.deadline_at, instant(BACKFILL_MS));
  // OPS-20: no user level (L1–L3) in the response.
  expect(Object.keys(data)).not.toContain('level');
});

it('[AC-B1-02z#2] users.avatar 原样返回（非默认头像）', async () => {
  const avatar = 'https://cdn.example.test/avatar/u-1.png';
  const f = await fixture(kit, { avatar });
  expect(me(kit, await f.get()).avatar_url).toBe(avatar);
});

it('[AC-B1-02z#3] 有 phone_hmac 即 phone 级别、phone_bound=true，补填照常计算', async () => {
  const f = await fixture(kit, { phone: true, method: 'sms' });
  const data = me(kit, await f.get());
  expect(data.identity_level).toBe('phone');
  expect(data.phone_bound).toBe(true);
  expect(data.invite_backfill.eligible).toBe(true);
  at(data.invite_backfill.deadline_at, instant(BACKFILL_MS));
});

it('[AC-B1-02z#4] 等级按库当前状态判定：会话签发后再绑手机，同一令牌首次读取即为 phone', async () => {
  const f = await fixture(kit);
  await f.session();
  await f.db
    .updateTable('users')
    .set({ phone_hmac: `fixture-${f.uid}` })
    .where('app_id', '=', f.appId)
    .where('id', '=', f.uid)
    .execute();
  const data = me(kit, await f.get());
  expect(data.identity_level).toBe('phone');
  expect(data.phone_bound).toBe(true);
});

for (const [label, offset, eligible] of [
  ['边界前 1 秒', BACKFILL_MS - 1_000, true],
  ['恰好 168 小时', BACKFILL_MS, false],
  ['边界后 1 秒', BACKFILL_MS + 1_000, false],
] as const) {
  it(`[AC-B1-02z#5] 补填期限 ${label}：eligible=${eligible}，不可补填时 deadline_at 为 null`, async () => {
    const f = await fixture(kit);
    kit.clock.set(instant(offset));
    const backfill = me(kit, await f.get()).invite_backfill;
    expect(backfill.eligible).toBe(eligible);
    if (eligible) at(backfill.deadline_at, instant(BACKFILL_MS));
    else expect(backfill.deadline_at).toBeNull();
  });
}

for (const [label, rebate, platform] of [
  ['VOID', 'VOID', 'INVALID'],
  ['CLAWED_BACK', 'CLAWED_BACK', 'SETTLED'],
  ['ESTIMATED', 'ESTIMATED', 'PAID'],
  ['WAITING', 'WAITING', 'RECEIVED'],
] as const) {
  it(`[AC-B1-02z#6] 本人有任一订单（rebate_status=${label}）→ 不可补填`, async () => {
    const f = await fixture(kit);
    await order(kit, f, rebate, platform);
    const data = me(kit, await f.get());
    expect(data.invite_backfill).toEqual({ eligible: false, deadline_at: null });
    expect(data.inviter_bound).toBe(false);
  });
}

for (const status of ['normal', 'deleted'] as const) {
  it(`[AC-B1-02z#7] 有直属下级（下级 status=${status}）→ 不可补填`, async () => {
    const f = await fixture(kit);
    await child(kit, f, status);
    expect(me(kit, await f.get()).invite_backfill).toEqual({ eligible: false, deadline_at: null });
  });
}

it('[AC-B1-02z#8] 已有上级 → inviter_bound=true 且不可补填', async () => {
  const parent = await fixture(kit);
  const f = await fixture(kit, { appId: parent.appId, parentId: parent.uid });
  const data = me(kit, await f.get());
  expect(data.inviter_bound).toBe(true);
  expect(data.invite_backfill).toEqual({ eligible: false, deadline_at: null });
  // The parent itself now has a direct subordinate.
  expect(me(kit, await parent.get()).invite_backfill).toEqual({
    eligible: false,
    deadline_at: null,
  });
});

it('[AC-B1-02z#9] 用过自助绑定（self_bind_used=true、无上级）→ inviter_bound=false 且不可补填', async () => {
  const f = await fixture(kit, { selfBindUsed: true });
  const data = me(kit, await f.get());
  expect(data.inviter_bound).toBe(false);
  expect(data.invite_backfill).toEqual({ eligible: false, deadline_at: null });
});

it('[AC-B1-02z#10] 绑定开关 growth.invite_bind.enabled 关（false）→ 不可补填；开（true）→ 可补填', async () => {
  const off = await fixture(kit);
  await config(kit, off.appId, 'growth.invite_bind.enabled', false);
  expect(me(kit, await off.get()).invite_backfill).toEqual({ eligible: false, deadline_at: null });
  const on = await fixture(kit);
  await config(kit, on.appId, 'growth.invite_bind.enabled', true);
  const backfill = me(kit, await on.get()).invite_backfill;
  expect(backfill.eligible).toBe(true);
  at(backfill.deadline_at, instant(BACKFILL_MS));
});

it('[AC-B1-02z#11] invite.backfill_hours 改值生效：截止随配置变，等于边界即不可补填', async () => {
  const two = await fixture(kit);
  await config(kit, two.appId, 'invite.backfill_hours', 2);
  const backfill = me(kit, await two.get()).invite_backfill;
  expect(backfill.eligible).toBe(true);
  at(backfill.deadline_at, instant(2 * HOUR));

  // Clock is CREATED + 1 h: with 1 hour the boundary is now itself.
  const one = await fixture(kit);
  await config(kit, one.appId, 'invite.backfill_hours', 1);
  expect(me(kit, await one.get()).invite_backfill).toEqual({ eligible: false, deadline_at: null });

  const long = await fixture(kit);
  await config(kit, long.appId, 'invite.backfill_hours', 200);
  kit.clock.set(instant(BACKFILL_MS + HOUR));
  const extended = me(kit, await long.get()).invite_backfill;
  expect(extended.eligible).toBe(true);
  at(extended.deadline_at, instant(200 * HOUR));
});

it('[AC-B1-02z#12] 封禁用户不被 10006 拦：invite_code=null，risk 为 banned 与原因类别', async () => {
  const f = await fixture(kit);
  await riskState(kit, f, 'banned', 'fraud_invite');
  const data = me(kit, await f.get());
  expect(data.invite_code).toBeNull();
  // Banned, not appealing → prev_risk_state null (04 §6.1).
  expect(data.risk).toEqual(
    riskExpected({ state: 'banned', reason_category: 'fraud_invite', frozen_until: null }, null),
  );
  expect(data.user_id).toBe(f.uid);
});

it('[AC-B1-02z#13] 申诉中且处理中的账号申诉 prev_risk_state=banned → invite_code=null', async () => {
  const f = await fixture(kit);
  await riskState(kit, f, 'appealing', 'other');
  await appeal(kit, f, 'banned');
  const data = me(kit, await f.get());
  expect(data.invite_code).toBeNull();
  // Appealing → prev_risk_state is the processing account appeal's original penalty (BR-ID-36 细则).
  expect(data.risk).toEqual(
    riskExpected({ state: 'appealing', reason_category: 'other', frozen_until: null }, 'banned'),
  );
});

it('[AC-B1-02z#14] 申诉中但申诉前为 frozen → invite_code 照常返回，risk 带 frozen_until', async () => {
  const f = await fixture(kit);
  const until = new Date(kit.clock.now().getTime() + 7 * 24 * HOUR);
  await riskState(kit, f, 'appealing', 'abnormal_trade', until);
  await appeal(kit, f, 'frozen');
  const data = me(kit, await f.get());
  // invite_code 取值改由 [AC-B1-11k#*] 覆盖（E4）。
  expect(data.risk.state).toBe('appealing');
  expect(data.risk.reason_category).toBe('abnormal_trade');
  at(data.risk.frozen_until, until);
  // Appealing → the processing account appeal's original penalty (BR-ID-36 细则, 04 §6.1).
  expect(data.risk).toMatchObject({ prev_risk_state: 'frozen' });
});

it('[AC-B1-02z#15] 冻结用户 invite_code 照常，risk 三字段为 frozen、原因类别、冻结截止', async () => {
  const f = await fixture(kit);
  const until = new Date(kit.clock.now().getTime() + 3 * 24 * HOUR);
  await riskState(kit, f, 'frozen', 'malicious_rights', until);
  const data = me(kit, await f.get());
  // invite_code 取值改由 [AC-B1-11k#*] 覆盖（E4）。
  expect(data.risk.state).toBe('frozen');
  expect(data.risk.reason_category).toBe('malicious_rights');
  at(data.risk.frozen_until, until);
  // Frozen, not appealing → prev_risk_state null (04 §6.1).
  expect(data.risk).toMatchObject({ prev_risk_state: null });
});

it('[AC-B1-02z#16] 余额摘要缺省全 0（ledger 未建）', async () => {
  const f = await fixture(kit, { phone: true });
  await order(kit, f, 'CREDITED', 'SETTLED');
  expect(me(kit, await f.get()).balance).toEqual(ZERO);
});

it('[AC-B1-02z#17] union_bindings 固定 taobao、pdd 两项，有授权行时取其状态', async () => {
  const active = await fixture(kit);
  await binding(kit, active, 'taobao', 'active');
  await binding(kit, active, 'pdd', 'released');
  expect(me(kit, await active.get()).union_bindings).toEqual([
    { platform: 'taobao', status: 'active' },
    { platform: 'pdd', status: 'released' },
  ]);

  // The unreleased binding wins over a released row (linking's projection).
  const mixed = await fixture(kit);
  await binding(kit, mixed, 'taobao', 'released');
  await binding(kit, mixed, 'taobao', 'invalid');
  await binding(kit, mixed, 'pdd', 'pending_auth');
  expect(me(kit, await mixed.get()).union_bindings).toEqual([
    { platform: 'taobao', status: 'invalid' },
    { platform: 'pdd', status: 'pending_auth' },
  ]);
});

const LEGAL = { privacy: 3, agreement: 2 } as const;
async function legal(f: { appId: string }) {
  await config(kit, f.appId, 'legal.privacy.version', LEGAL.privacy);
  await config(kit, f.appId, 'legal.agreement.version', LEGAL.agreement);
}

it('[AC-B1-02z#18] need_reconsent：没有任何用户级同意记录 → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#19] need_reconsent：两类当前状态都已同意且版本不低于配置 → false', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement + 1, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(false);
});

it('[AC-B1-02z#20] need_reconsent：privacy 当前状态（server_at 最新一条）为拒绝 → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-2 * HOUR));
  await consent(kit, f, 'privacy', LEGAL.privacy, false, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#21] need_reconsent：agreement 当前状态为拒绝 → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement, false, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#22] need_reconsent：privacy 已同意但版本低于 legal.privacy.version → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy - 1, true, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#23] need_reconsent：agreement 已同意但版本低于 legal.agreement.version → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement - 1, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#24] need_reconsent：只有 privacy、缺 agreement 记录 → true', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#25] need_reconsent：当前状态取 server_at 最新一条，较新的低版本同意覆盖较旧的高版本', async () => {
  const f = await fixture(kit);
  await legal(f);
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-2 * HOUR));
  await consent(kit, f, 'privacy', LEGAL.privacy - 1, true, instant(-HOUR));
  await consent(kit, f, 'agreement', LEGAL.agreement, true, instant(-HOUR));
  expect(me(kit, await f.get()).need_reconsent).toBe(true);

  // Inverse order: the newer record is the current version → false.
  const g = await fixture(kit);
  await legal(g);
  await consent(kit, g, 'privacy', LEGAL.privacy - 1, true, instant(-2 * HOUR));
  await consent(kit, g, 'privacy', LEGAL.privacy, true, instant(-HOUR));
  await consent(kit, g, 'agreement', LEGAL.agreement, true, instant(-HOUR));
  expect(me(kit, await g.get()).need_reconsent).toBe(false);
});

it('[AC-B1-02z#26] need_reconsent：登录用户只看用户级记录，设备级同意不算', async () => {
  const f = await fixture(kit);
  await legal(f);
  const session = await f.session();
  const device = { device: session.deviceId };
  await consent(kit, f, 'privacy', LEGAL.privacy, true, instant(-HOUR), device);
  await consent(kit, f, 'agreement', LEGAL.agreement, true, instant(-HOUR), device);
  expect(me(kit, await f.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#27] need_reconsent：版本配置缺失时只看是否已同意', async () => {
  const accepted = await fixture(kit);
  await consentAll(kit, accepted);
  expect(me(kit, await accepted.get()).need_reconsent).toBe(false);
  const refused = await fixture(kit);
  await consent(kit, refused, 'privacy', 1, true, instant(-HOUR));
  await consent(kit, refused, 'agreement', 1, false, instant(-HOUR));
  expect(me(kit, await refused.get()).need_reconsent).toBe(true);
});

it('[AC-B1-02z#28] deletion_only 会话可读，内容与 full 会话相同', async () => {
  const f = await fixture(kit, { phone: true });
  await consentAll(kit, f);
  await binding(kit, f, 'taobao', 'active');
  const restricted = me(kit, await f.get('deletion_only'));
  const full = me(kit, await f.get('full'));
  expect(restricted).toEqual(full);
  expect(restricted.user_id).toBe(f.uid);
  expect(restricted.identity_level).toBe('phone');
});

it('[AC-B1-02z#29] 游客（不带令牌）→ 10001', async () => {
  const f = await fixture(kit);
  const session = await f.session();
  const response = await session.request(ME, { guest: true });
  envelope(kit, response, 10001);
  expect(response.json<{ code: number }>().code).toBe(10001);
});

it('[AC-B1-02z#30] 只读令牌对应的 app 与用户：别的用户、别的 app 的数据不可见', async () => {
  const other = await fixture(kit, { phone: true });
  await config(kit, other.appId, 'invite.backfill_hours', 1);
  await config(kit, other.appId, 'growth.invite_bind.enabled', false);
  await order(kit, other, 'ESTIMATED', 'PAID');
  await child(kit, other);
  await binding(kit, other, 'taobao', 'active');
  await consentAll(kit, other);
  await riskState(kit, other, 'banned', 'other');

  const sameApp = await fixture(kit, { appId: other.appId });
  const same = me(kit, await sameApp.get());
  expect(same.user_id).toBe(sameApp.uid);
  // invite_code 取值改由 [AC-B1-11k#*] 覆盖（E4）。
  expect(same.identity_level).toBe('member');
  expect(same.union_bindings).toEqual(UNBOUND);
  expect(same.need_reconsent).toBe(true);
  expect(same.risk).toEqual(riskExpected(NORMAL, null));
  // App-level settings of that app still apply: switch off → not eligible.
  expect(same.invite_backfill).toEqual({ eligible: false, deadline_at: null });

  const otherApp = await fixture(kit);
  const data = me(kit, await otherApp.get());
  expect(data.user_id).toBe(otherApp.uid);
  expect(data.invite_backfill.eligible).toBe(true);
  at(data.invite_backfill.deadline_at, instant(BACKFILL_MS));
  expect(data.union_bindings).toEqual(UNBOUND);
  expect(data.need_reconsent).toBe(true);
  expect(data.risk).toEqual(riskExpected(NORMAL, null));

  // The other user's own view is unchanged by these reads.
  const own = me(kit, await other.get());
  expect(own.invite_code).toBeNull();
  expect(own.union_bindings[0]).toEqual({ platform: 'taobao', status: 'active' });
});

it('[AC-B1-02z#31] 同 app 另一用户的订单与下级不影响本人补填资格', async () => {
  const other = await fixture(kit);
  await order(kit, other, 'VOID', 'INVALID');
  await child(kit, other);
  const f = await fixture(kit, { appId: other.appId });
  const backfill = me(kit, await f.get()).invite_backfill;
  expect(backfill.eligible).toBe(true);
  at(backfill.deadline_at, instant(BACKFILL_MS));
});

it('[AC-B1-02z#32] 只读：GET 不写 users、同意记录与风控行', async () => {
  const f = await fixture(kit);
  await consentAll(kit, f);
  const before = await f.row();
  const count = async (table: 'consent_records' | 'user_risk_state' | 'appeals') =>
    (
      await f.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('app_id', '=', f.appId)
        .executeTakeFirstOrThrow()
    ).n;
  const counts = [
    await count('consent_records'),
    await count('user_risk_state'),
    await count('appeals'),
  ];
  me(kit, await f.get());
  me(kit, await f.get());
  expect(await f.row()).toEqual(before);
  expect([
    await count('consent_records'),
    await count('user_risk_state'),
    await count('appeals'),
  ]).toEqual(counts);
});

it('[AC-B1-02z#33] 契约 getMe 已实现：不再标 planned，接受 full 与 deletion_only', () => {
  const op = operation(kit);
  expect(op['operationId']).toBe('getMe');
  expect(op['x-implementation']).toBeUndefined();
  expect(op['x-session-scopes']).toEqual(['full', 'deletion_only']);
  expect(op['x-auth']).toBe('login');
});

it('[AC-B1-02z#34] 默认头像哨兵 avatar:default → avatar_url 为本 app 配置的 me.default_avatar_url，库里的哨兵不变', async () => {
  const f = await fixture(kit, { avatar: DEFAULT_AVATAR });
  const data = me(kit, await f.get());
  expect(data.avatar_url).toBe(DEFAULT_AVATAR_URL);
  expect(data.avatar_url).not.toBe(DEFAULT_AVATAR);
  expect((await f.row()).avatar).toBe(DEFAULT_AVATAR);
  // deletion_only answers the same address.
  expect(me(kit, await f.get('deletion_only')).avatar_url).toBe(DEFAULT_AVATAR_URL);
});

it('[AC-B1-02z#35] 哨兵头像而本 app 没有 me.default_avatar_url → 50001，记一条告警，日志不含 user_id、昵称、手机号', async () => {
  const f = await fixture(kit, { phone: true, method: 'sms', avatarUrl: null });
  await f.session();
  const row = await f.row();
  const from = kit.lines.length;
  serverError(kit, await f.get());
  const lines = linesSince(kit, from);
  expect(warnings(lines)).toHaveLength(1);
  const written = lines.join('\n');
  expect(written).not.toContain(f.uid);
  expect(written).not.toContain(NICKNAME);
  expect(written).not.toContain(row.phone_hmac!);
  // The user row is not changed by the failed read.
  expect(await f.row()).toEqual(row);
});

for (const [label, value] of [
  ['http:// 地址', 'http://cdn.example.test/avatar/default.png'],
  ['相对路径', '/static/avatar/default.png'],
] as const) {
  it(`[AC-B1-02z#36] me.default_avatar_url 不是 https 绝对地址（${label}）→ 哨兵头像用户得 50001 并记一条告警`, async () => {
    const f = await fixture(kit, { avatarUrl: value });
    await f.session();
    const from = kit.lines.length;
    serverError(kit, await f.get());
    const lines = linesSince(kit, from);
    expect(warnings(lines)).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(f.uid);
  });
}

it('[AC-B1-02z#37] me.default_avatar_url 按 app 取：两个 app 配不同地址，各自的哨兵用户各得本 app 的地址', async () => {
  const firstUrl = 'https://cdn.example.test/avatar/app-one.png';
  const secondUrl = 'https://static.example.test/brand-two/default-avatar.png';
  const first = await fixture(kit, { avatarUrl: firstUrl });
  const second = await fixture(kit, { avatarUrl: secondUrl });
  const firstPeer = await fixture(kit, { appId: first.appId });
  expect(me(kit, await first.get()).avatar_url).toBe(firstUrl);
  expect(me(kit, await second.get()).avatar_url).toBe(secondUrl);
  expect(me(kit, await firstPeer.get()).avatar_url).toBe(firstUrl);
  const rows = await kit.suite.db
    .withSchema('app')
    .selectFrom('config_items')
    .select(['app_id', 'value'])
    .where('key', '=', AVATAR_KEY)
    .where('app_id', 'in', [first.appId, second.appId])
    .orderBy('app_id')
    .execute();
  expect(rows).toHaveLength(2);
});
