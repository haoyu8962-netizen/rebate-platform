import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PHONE_BLIND_INDEX_CONTEXT } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import { createSmsLoginService } from '../../../../apps/api/src/modules/identity/application/sms-login.ts';
import { seedUser } from '../registration/kit.ts';
import { openKit, closeKit, fixture, rows, assertLogin, success, type Kit } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-02j#1][BR-ID-01] 受限判定失败时，非法手机号也不能抢先返回，验证码与建号均不执行', async () => {
  const f = await fixture(kit);
  const unavailable = new Error('version-reader-unavailable');
  f.minimum.mockRejectedValue(unavailable);
  const before = await rows(kit, f.appId);
  let failed = false;
  try {
    failed = (await f.login({ body: { ...f.command.body, phone: 'invalid' } })).code === 50001;
  } catch (error) {
    if (error !== unavailable) throw error;
    failed = true;
  }
  expect(failed).toBe(true);
  expect(f.minimum).toHaveBeenCalledWith(f.appId, 'ios', 'test_channel');
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
});

it('[AC-B1-02j#33][BR-ID-04/05] 已完成注销的手机号正常登录重新建号，旧账号保留', async () => {
  const f = await fixture(kit);
  const deleted = await f.account('deleted');
  const data = await assertLogin(kit, f, await f.login(), true, 'full');
  expect(data.user_id).not.toBe(deleted);
  const state = await rows(kit, f.appId);
  expect(state.users).toHaveLength(2);
  expect(state.users.find((row) => row.id === deleted)?.status).toBe('deleted');
  expect(state.registrations).toHaveLength(1);
});

it.each(['', '   ', '\u3000'])(
  '[AC-B1-02j#34][BR-INV-06] 新号空邀请码 %j 不调用绑定、不包含 invite_bind',
  async (invite) => {
    const bind = vi.fn(async () => ({ result: 'bound' as const, code: null }));
    const f = await fixture(kit, { bindInvite: bind });
    const data = success(await f.login({ body: { ...f.command.body, invite_code: invite } }));
    expect(data.is_new_user).toBe(true);
    expect(data).not.toHaveProperty('invite_bind');
    expect(bind).not.toHaveBeenCalled();
  },
);

it('[AC-B1-02j#35][BR-ID-05] 建号失败 50001 不写登录记录、不签会话', async () => {
  const f = await fixture(kit);
  f.register.mockResolvedValue({ code: 50001 });
  const before = await rows(kit, f.appId);
  expect(await f.login()).toEqual({ code: 50001 });
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(await rows(kit, f.appId)).toEqual(before);
});

it('[AC-B1-02j#36][BR-ID-05] 已有账号不受建号黑名单或设备注册上限影响', async () => {
  const f = await fixture(kit);
  const uid = await f.account();
  for (let i = 0; i < 3; i++) await seedUser(kit.db, f.appId, { hash: f.hash });
  const block = vi.fn(async () => ({ code: 44001 as const }));
  const data = await assertLogin(
    kit,
    f,
    await f.login({}, { phoneBlocklist: block }),
    false,
    'full',
  );
  expect(data.user_id).toBe(uid);
  expect(block).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect((await rows(kit, f.appId)).registrations).toHaveLength(3);
});

it('[AC-B1-02j#37][BR-ID-01] 缺少客户端版本且配置最低版本时受限，缺渠道则不判定', async () => {
  const f = await fixture(kit);
  await f.account();
  f.minimum.mockResolvedValue('3.0.0');
  const { version: omittedVersion, ...noVersion } = f.command;
  void omittedVersion;
  // Passing the complete no-version command must not be merged back with fixture defaults.
  const restricted = success(await createSmsLoginService(f.options).login(noVersion));
  expect(restricted.tokens.session_scope).toBe('deletion_only');
  const { channel: omittedChannel, ...noChannel } = noVersion;
  void omittedChannel;
  const full = success(await createSmsLoginService(f.options).login(noChannel));
  expect(full.tokens.session_scope).toBe('full');
});

it('[AC-S1-78#3][BR-ID-05] 判定作用域后规范化失败，20001 精确字段且不核销、不写库', async () => {
  const f = await fixture(kit);
  f.minimum.mockResolvedValue('3.0.0');
  const before = await rows(kit, f.appId);
  expect(await f.login({ body: { ...f.command.body, phone: '+852 5123 4567' } })).toEqual({
    code: 20001,
    data: { fields: ['phone'], reason: 'phone_invalid' },
  });
  expect(f.minimum).toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
});

it.each([20002, 20003] as const)(
  '[AC-B1-02j#2][BR-ID-04/05] 验证码 %s 先于查号建号，无登录记录',
  async (code) => {
    const f = await fixture(kit);
    f.minimum.mockResolvedValue('3.0.0');
    f.verify.mockResolvedValue({ code });
    const before = await rows(kit, f.appId);
    expect(await f.login()).toEqual({ code });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith({
      app_id: f.appId,
      phone: f.command.body.phone,
      purpose: 'login',
      code: '123456',
    });
    expect(f.minimum.mock.invocationCallOrder[0]).toBeLessThan(
      f.verify.mock.invocationCallOrder[0]!,
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(await rows(kit, f.appId)).toEqual(before);
  },
);

it.each(['missing', 'deleted'] as const)(
  '[AC-S1-83#16][BR-ID-01] 受限登录 %s 无账号时无任何 PG 写入',
  async (kind) => {
    const bind = vi.fn(async () => ({ result: 'bound' as const, code: null }));
    const f = await fixture(kit, { bindInvite: bind });
    if (kind === 'deleted') await f.account('deleted');
    f.minimum.mockResolvedValue('3.0.0');
    const block = vi.fn(async () => null);
    const before = await rows(kit, f.appId);
    expect(
      await f.login(
        { body: { ...f.command.body, invite_code: 'K7Q2MZ' } },
        { phoneBlocklist: block },
      ),
    ).toEqual({
      code: 10405,
      data: { reason: 'no_account', min_supported_version: '3.0.0' },
    });
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.register).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
    expect(await rows(kit, f.appId)).toEqual(before);
  },
);

it('[AC-S1-83#18][BR-ID-01] 受限判定后最低版本被删除，仍不建号，错误携带当前 null', async () => {
  const f = await fixture(kit);
  f.minimum.mockResolvedValue('3.0.0');
  f.verify.mockImplementation(async () => {
    f.minimum.mockResolvedValue(null);
    return { code: 0 };
  });
  const before = await rows(kit, f.appId);
  expect(await f.login()).toEqual({
    code: 10405,
    data: { reason: 'no_account', min_supported_version: null },
  });
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
});

it('[AC-B1-02j#3][BR-ID-01] 查账号在验证码核销之后，核销期间出现的账号以已有账号登录', async () => {
  const f = await fixture(kit);
  f.minimum.mockResolvedValue('3.0.0');
  let uid = '';
  f.verify.mockImplementation(async () => {
    uid = await f.account();
    return { code: 0 };
  });
  const data = await assertLogin(kit, f, await f.login(), false, 'deletion_only');
  expect(data.user_id).toBe(uid);
  expect(data).not.toHaveProperty('invite_bind');
  expect(f.register).not.toHaveBeenCalled();
});

it.each(
  (['normal', 'cooling'] as const).flatMap((state) =>
    [undefined, '', '   ', 'BAD'].map((invite) => ({ state, invite })),
  ),
)(
  '[AC-S1-83#17][BR-ID-01/INV-06] 已有账号 $state（含注销冷静期）受限登录只写登录必需数据，邀请码=$invite',
  async ({ state, invite }) => {
    const bind = vi.fn(async () => ({ result: 'bound' as const, code: null }));
    const f = await fixture(kit, { bindInvite: bind });
    // BR-ID-27: the cooling period is a users.status=normal account with a cooling deletion request.
    const uid = await f.account('normal');
    if (state === 'cooling') {
      const at = f.clock.now();
      await sql`INSERT INTO app.deletion_requests
        (id, app_id, user_id, status, apply_at, cooling_until, balance_snapshot_fen, created_at, updated_at)
        VALUES (${randomUUID()}, ${f.appId}, ${uid}, 'cooling', ${at},
          ${new Date(at.getTime() + 7 * 86_400_000)}, 0, ${at}, ${at})`.execute(kit.db);
    }
    f.minimum.mockResolvedValue('3.0.0');
    const before = await rows(kit, f.appId);
    const data = await assertLogin(
      kit,
      f,
      await f.login({
        body: { ...f.command.body, ...(invite === undefined ? {} : { invite_code: invite }) },
      }),
      false,
      'deletion_only',
    );
    expect(data.user_id).toBe(uid);
    if (invite?.trim())
      expect(data.invite_bind).toEqual({ result: 'ignored_existing_user', code: null });
    else expect(data).not.toHaveProperty('invite_bind');
    expect(bind).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    const after = await rows(kit, f.appId);
    const { expectOnlyLoginActivity } = await import('../reverify/login-activity.ts');
    expectOnlyLoginActivity(before.users, after.users, { uid, at: f.clock.now(), hash: f.hash });
    expect(after.registrations).toEqual(before.registrations);
  },
);

it.each([undefined, '', '   ', ' bad-code '])(
  '[AC-B1-02j#4][BR-INV-06] 已有账号不校验邀请码 %j，只有非空才含 invite_bind',
  async (invite) => {
    const f = await fixture(kit);
    const uid = await f.account();
    const body = { ...f.command.body, ...(invite === undefined ? {} : { invite_code: invite }) };
    const data = await assertLogin(kit, f, await f.login({ body }), false, 'full');
    expect(data.user_id).toBe(uid);
    if (invite?.trim())
      expect(data.invite_bind).toEqual({ result: 'ignored_existing_user', code: null });
    else expect(data).not.toHaveProperty('invite_bind');
    expect(f.register).not.toHaveBeenCalled();
  },
);

it('[AC-B1-02j#5][BR-ID-04] 新号建号后写同意、日志和会话；建号上下文来自当前设备', async () => {
  const f = await fixture(kit);
  const data = await assertLogin(kit, f, await f.login(), true, 'full');
  expect(data).not.toHaveProperty('invite_bind');
  const state = await rows(kit, f.appId);
  expect(state.users).toHaveLength(1);
  expect(state.registrations).toHaveLength(1);
  expect(f.register).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      app_id: f.appId,
      phone: f.command.body.phone,
      register_method: 'sms',
      channel: 'test_channel',
      device_hash: f.hash,
      device_id: f.deviceId,
      client_ip: f.command.client_ip,
    }),
  );
});

it('[AC-B1-02j#6][BR-ID-05] 三个同设备账号后返回 44001，验证码已校验且不留下注册或登录写入', async () => {
  const f = await fixture(kit);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, f.appId, { hash: f.hash });
  // Fixture records default to database time; count them strictly before the injected now.
  f.clock.advanceMs(60_000);
  const before = await rows(kit, f.appId);
  expect(await f.login()).toMatchObject({ code: 44001 });
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(await rows(kit, f.appId)).toEqual(before);
});

it('[AC-B1-02j#7][BR-ID-05] 手机号黑名单扩展点在建号前，仅收到 app 与手机号 HMAC', async () => {
  const f = await fixture(kit);
  const block = vi.fn(async () => ({ code: 44001 as const, data: { risk_msg_code: 'blocked' } }));
  const before = await rows(kit, f.appId);
  expect(await f.login({}, { phoneBlocklist: block })).toEqual({
    code: 44001,
    data: { risk_msg_code: 'blocked' },
  });
  expect(block).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    app_id: f.appId,
    phone_hmac: kit.crypto.blindIndex(f.command.body.phone, PHONE_BLIND_INDEX_CONTEXT),
  });
  expect(f.verify.mock.invocationCallOrder[0]).toBeLessThan(block.mock.invocationCallOrder[0]!);
  expect(f.register).not.toHaveBeenCalled();
  expect(await rows(kit, f.appId)).toEqual(before);
});

it('[AC-B1-02j#8][BR-ID-31] 风控封禁仍校验验证码并签发会话，不返回 10006', async () => {
  const f = await fixture(kit);
  const uid = await f.account();
  await sql`INSERT INTO app.user_risk_state (app_id,user_id,state,reason_category,changed_by,changed_at)
    VALUES (${f.appId},${uid},'banned','other','test',${f.clock.now()})`.execute(kit.db);
  const data = await assertLogin(kit, f, await f.login(), false, 'full');
  expect(data.user_id).toBe(uid);
  expect(f.verify).toHaveBeenCalledTimes(1);
});

it('[AC-B1-02j#9][BR-ID-01] 同手机号其他 app 的账号不可被受限登录找到', async () => {
  const f = await fixture(kit);
  await f.account('normal', `${f.appId}_other`);
  f.minimum.mockResolvedValue('3.0.0');
  expect(await f.login()).toEqual({
    code: 10405,
    data: { reason: 'no_account', min_supported_version: '3.0.0' },
  });
  expect((await rows(kit, f.appId)).users).toHaveLength(0);
});

it.each([
  { platform: 'ios' as const, version: '1.0.9', minimum: '1.1.0', scope: 'deletion_only' as const },
  { platform: 'android' as const, version: '', minimum: '1.1.0', scope: 'deletion_only' as const },
  {
    platform: 'harmony' as const,
    version: 'bad',
    minimum: '1.1.0',
    scope: 'deletion_only' as const,
  },
  { platform: 'ios' as const, version: '1.10.0', minimum: '1.2.0', scope: 'full' as const },
  { platform: 'android' as const, version: '1.1.0', minimum: '1.1.0', scope: 'full' as const },
  { platform: 'ios' as const, version: 'bad', minimum: null, scope: 'full' as const },
  { platform: 'h5' as const, version: 'bad', minimum: '3.0.0', scope: 'full' as const },
  { platform: 'admin' as const, version: 'bad', minimum: '3.0.0', scope: 'full' as const },
])(
  '[AC-B1-02j#10][BR-ID-01] 每次请求版本 $platform/$version/$minimum 签发 $scope',
  async (entry) => {
    const f = await fixture(kit);
    await f.account();
    f.minimum.mockResolvedValue(entry.minimum);
    const data = success(await f.login({ platform: entry.platform, version: entry.version }));
    expect(data.tokens.session_scope).toBe(entry.scope);
    expect((await f.tokens.verifyAccess(data.tokens.access_token)).scp).toBe(entry.scope);
  },
);
