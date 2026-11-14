import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { IP, NOW, envelope, fixture, openKit, phone, type Kit } from './kit.ts';
import { assertAttemptTable, readAttempts } from './attempt-store.ts';

// Real AppModule, real isolated stores, fake SMS provider; no route or business-service mocks.
let server: Awaited<ReturnType<typeof acquireTestRedis>> | undefined;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let kit: Kit;
beforeAll(async () => {
  server = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  kit = await openKit(db, database.urlFor('couli_app'), server.url);
}, 180_000);
afterAll(async () => {
  try {
    await kit?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await server?.stop();
    }
  }
}, 120_000);

it('[AC-B1-11g#1] 无签名、设备、令牌与人机凭证可发 login 码，响应过契约且不签发令牌', async () => {
  const f = fixture(kit);
  const number = phone();
  const start = kit.lines.length;
  const response = await f.send(`＋８６ ${number.replaceAll('0', '０')}`);
  envelope(kit, response);
  expect(f.messages()).toHaveLength(1);
  expect(f.messages()[0]).toMatchObject({
    app_id: f.appId,
    phone: number,
    purpose: 'login',
    code: expect.stringMatching(/^\d{6}$/),
  });
  expect(await f.verify(number, f.messages()[0]!.code)).toEqual({ code: 0 });
  const visible = JSON.stringify(response.json()) + kit.lines.slice(start).join('');
  expect(visible).not.toContain(number);
  // Platform access logs retain the socket address by their own contract; only business logs
  // belong to this task's identity/risk paths.
  const businessLogs = kit.lines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['req'] === undefined && line['res'] === undefined);
  expect(JSON.stringify(businessLogs)).not.toContain(IP);
  expect(visible).not.toMatch(new RegExp(`(?<!\\d)${f.messages()[0]!.code}(?!\\d)`));
  expect(JSON.stringify(response.json())).not.toMatch(/access_token|refresh_token|h5_token/);
});

it('[AC-B1-11g#2] 低版本与无效签名、无效设备头不增加签名或设备判定', async () => {
  const f = fixture(kit);
  await kit.db
    .insertInto('app_versions')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      platform: 'ios',
      channel: 'appstore',
      latest_version: '9.0.0',
      min_supported_version: '9.0.0',
      update_title: 'test',
      update_notes: 'test',
      store_url: 'https://example.test/app',
      default_store: 'appstore',
      store_listings: JSON.stringify([]),
    })
    .execute();
  envelope(
    kit,
    await f.send(phone(), {
      headers: {
        'x-platform': 'ios',
        'x-channel': 'appstore',
        'x-app-version': '0.0.1',
        'x-device-id': 'not-a-device',
        'x-sign': 'invalid',
        'x-timestamp': '0',
        'x-nonce': 'invalid',
      },
    }),
  );
  expect(f.messages()).toHaveLength(1);
});

for (const input of ['', '12345678901', '+852 5123 4567', '1380013800', '170-invalid']) {
  it(`[AC-B1-11g#3] 非法号码 ${JSON.stringify(input)} 优先于黑名单与 IP 频控，返回 phone_invalid`, async () => {
    const f = fixture(kit);
    await f.accepted(Array.from({ length: 20 }, () => NOW));
    const response = await f.send(input);
    envelope(kit, response, 20001);
    expect(response.json()).toMatchObject({ data: { fields: ['phone'], reason: 'phone_invalid' } });
    expect(f.messages()).toEqual([]);
  });
}

for (const prefix of ['170', '171', '162', '165', '167']) {
  it(`[AC-B1-11g#4] 规范化后的默认黑名单号段 ${prefix} 优先于 IP 限额返回 44001`, async () => {
    const f = fixture(kit);
    await f.accepted(Array.from({ length: 20 }, () => NOW));
    envelope(kit, await f.send(`+86 ${phone(prefix)}`), 44001);
    expect(f.messages()).toEqual([]);
  });
}

it('[AC-B1-11g#5] 手机号 HMAC 黑名单按规范化后的号码匹配且先于 IP 频控', async () => {
  const f = fixture(kit);
  const number = phone();
  await f.blocked(number);
  await f.accepted(Array.from({ length: 20 }, () => NOW));
  envelope(kit, await f.send(`0086 ${number}`), 44001);
  expect(f.messages()).toEqual([]);
});

it('[AC-B1-11g#6] 20001 与 44001 均不占发码额度，之后同 IP 的有效号码仍能发码', async () => {
  const f = fixture(kit);
  await assertAttemptTable(kit.db);
  await f.config('sms.ip_sends_per_hour', 1);
  envelope(kit, await f.send('bad-phone'), 20001);
  expect(await readAttempts(kit.db, f.appId)).toEqual([]);
  envelope(kit, await f.send(phone('170')), 44001);
  expect(await readAttempts(kit.db, f.appId)).toEqual([]);
  envelope(kit, await f.send(phone()));
  expect(await readAttempts(kit.db, f.appId)).toHaveLength(1);
  expect(f.messages()).toHaveLength(1);
});

it('[AC-B1-11g#7] 四个不同号码无需设备准入，废弃的人机验证开关不影响发码', async () => {
  const f = fixture(kit);
  await f.config('sms.device_distinct_phones_per_hour', 1);
  await f.config('sms.captcha_mode', 'always');
  for (let i = 0; i < 4; i++) envelope(kit, await f.send(phone()));
  expect(f.messages()).toHaveLength(4);
  expect(
    await kit.db.selectFrom('devices').select('id').where('app_id', '=', f.appId).execute(),
  ).toEqual([]);
});

it('[AC-B1-11g#8] 同 IP 新注册五个即拦；闭区间整小时仍拦，一秒后放行', async () => {
  const f = fixture(kit);
  await f.registrations(
    ['09:00:00', '09:10:00', '09:20:00', '09:30:00', '09:40:00'].map(
      (t) => `2026-10-18T${t}+08:00`,
    ),
  );
  kit.clock.set('2026-10-18T09:50:00+08:00');
  envelope(kit, await f.send(phone()), 42901, 601);
  kit.clock.set(NOW);
  envelope(kit, await f.send(phone()), 42901, 1);
  kit.clock.advanceMs(1000);
  envelope(kit, await f.send(phone()));
  expect(f.messages()).toHaveLength(1);
});

it('[AC-B1-11g#9] 超过注册阈值取第 N−L+1 条；未来记录与窗外记录不参与', async () => {
  const f = fixture(kit);
  await f.registrations(
    [
      '08:49:59',
      '09:00:00',
      '09:10:00',
      '09:20:00',
      '09:30:00',
      '09:40:00',
      '09:45:00',
      '09:50:01',
    ].map((t) => `2026-10-18T${t}+08:00`),
  );
  kit.clock.set('2026-10-18T09:50:00+08:00');
  envelope(kit, await f.send(phone()), 42901, 1201);
  expect(f.messages()).toEqual([]);
});

it('[AC-B1-11g#10] 同 IP 两项同时超限取较晚解除时刻，先于更晚的手机号额度', async () => {
  const f = fixture(kit);
  const number = phone();
  kit.clock.set('2026-10-18T10:59:50+08:00');
  envelope(kit, await f.send(number));
  await f.registrations(Array.from({ length: 5 }, () => '2026-10-18T10:00:00+08:00'));
  await f.accepted(Array.from({ length: 19 }, () => '2026-10-18T10:00:10+08:00'));
  kit.clock.set('2026-10-18T10:59:55+08:00');
  // IP registrations release in 6s, sends in 26s; phone releases in 55s, but is not reached.
  envelope(kit, await f.send(number), 42901, 26);
  expect(f.messages()).toHaveLength(1);
});

it('[AC-B1-11g#11] 发码默认上限二十条：换号码与伪造转发 IP 均不能绕过，其他 IP 不受影响', async () => {
  const f = fixture(kit);
  for (let i = 0; i < 20; i++) envelope(kit, await f.send(phone()));
  envelope(
    kit,
    await f.send(phone(), { headers: { 'x-forwarded-for': '198.51.100.88' } }),
    42901,
    3611,
  );
  envelope(kit, await f.send(phone(), { ip: '203.0.113.72' }));
  expect(f.messages()).toHaveLength(21);
});

it('[AC-B1-11g#12] IP 阈值取配置，已有条数超过阈值时等第 N−L+1 条滑出', async () => {
  const f = fixture(kit);
  await f.config('sms.ip_sends_per_hour', 2);
  await f.accepted(['09:00:00', '09:10:00', '09:20:00'].map((t) => `2026-10-18T${t}+08:00`));
  kit.clock.set('2026-10-18T09:50:00+08:00');
  envelope(kit, await f.send(phone()), 42901, 1211);
  kit.clock.set('2026-10-18T10:10:10+08:00');
  envelope(kit, await f.send(phone()), 42901, 1);
  kit.clock.advanceMs(1000);
  envelope(kit, await f.send(phone()));
  expect(f.messages()).toHaveLength(1);
});

for (const appFirst of [true, false]) {
  it(`[AC-B1-11g#13] App 与落地页共用同 IP 发码计数，App 先发=${appFirst}`, async () => {
    const f = fixture(kit);
    await f.config('sms.ip_sends_per_hour', 1);
    const appSend = await f.appSender();
    envelope(kit, await (appFirst ? appSend(phone()) : f.send(phone())));
    envelope(kit, await (appFirst ? f.send(phone()) : appSend(phone())), 42901, 3611);
    expect(f.messages()).toHaveLength(1);
  });
}

it('[AC-B1-11g#14] 规范化别名共享六十秒窗口，五十九秒 Retry-After=1，六十秒可重发', async () => {
  const f = fixture(kit);
  const number = phone();
  envelope(kit, await f.send(number));
  kit.clock.advanceMs(59_000);
  envelope(
    kit,
    await f.send(`＋８６\u3000${number.slice(0, 3)}—${number.slice(3)}\u200b`),
    42901,
    1,
  );
  kit.clock.advanceMs(1000);
  envelope(kit, await f.send(`0086${number}`));
  expect(f.messages()).toHaveLength(2);
});

it('[AC-B1-11g#15] 手机号 login、bind、step_up 三种 purpose 与落地页合计限频', async () => {
  const f = fixture(kit);
  const appSend = await f.appSender();
  const number = phone();
  const { randomBytes } = await import('node:crypto');
  const { createSession } =
    await import('../../../../apps/api/src/modules/identity/application/sessions.ts');
  const { TOKEN_SERVICE } =
    await import('../../../../apps/api/src/modules/identity/application/tokens.ts');
  const { FIELD_CRYPTO } = await import('../../../../apps/api/src/modules/platform/index.ts');
  const { seedUser } = await import('../registration/kit.ts');
  const { sign } = await import('../../risk/signature/kit.ts');
  type TokenService =
    import('../../../../apps/api/src/modules/identity/application/access-tokens.ts').TokenService;
  type FieldCrypto = import('../../../../apps/api/src/modules/platform/index.ts').FieldCrypto;
  const headers = { ...f.headers, 'x-platform': 'ios', 'x-app-version': '2.0.0' };
  const created = await kit.app.inject({
    method: 'POST',
    url: '/v1/devices',
    remoteAddress: IP,
    headers,
    payload: JSON.stringify({
      device_hash: randomBytes(32).toString('hex'),
      id_source: 'idfv',
    }),
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ code: 0 });
  const { data } = created.json<{ data: { device_id: string; install_secret: string } }>();
  const scopedDb = kit.db;
  const crypto = kit.app.get<FieldCrypto>(FIELD_CRYPTO);
  const uid = await seedUser(scopedDb, f.appId);
  await scopedDb
    .updateTable('users')
    .set({
      phone_hmac: crypto.blindIndex(number, 'users.phone'),
      phone_cipher: Buffer.from(crypto.encrypt(number, 'users.phone'), 'utf8'),
    })
    .where('id', '=', uid)
    .execute();
  const tokens = kit.app.get<TokenService>(TOKEN_SERVICE);
  const session = await scopedDb
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        { uid, app_id: f.appId, device_id: data.device_id, scp: 'full' },
        { clock: kit.clock, tokens },
      ),
    );
  const sendStepUp = (payload: Record<string, unknown>) => {
    const path = '/v1/auth/sms-codes';
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(kit.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    return kit.app.inject({
      method: 'POST',
      url: path,
      remoteAddress: IP,
      payload: raw,
      headers: {
        ...headers,
        authorization: `Bearer ${session.access_token}`,
        'x-device-id': data.device_id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-sign': sign('POST', path, Buffer.from(raw), timestamp, nonce, data.install_secret),
      },
    });
  };
  for (const purpose of ['bind', 'step_up'] as const) {
    envelope(
      kit,
      purpose === 'step_up'
        ? await sendStepUp({
            purpose: 'step_up',
            captcha_token: `captcha-${randomUUID()}`,
            action: 'account_deletion',
          })
        : await appSend(number, purpose),
    );
    envelope(kit, await f.send(`86${number}`), 42901, 60);
    kit.clock.advanceMs(60_000);
  }
  envelope(kit, await f.send(number));
  envelope(kit, await appSend(number, 'login'), 42901, 60);
  expect(f.messages()).toHaveLength(3);
});

it('[AC-B1-11g#16] 自然小时五条与六十秒同时命中取最晚解除时刻，整点仍不能抢发', async () => {
  const f = fixture(kit);
  const number = phone();
  for (const time of ['10:05:00', '10:10:00', '10:20:00', '10:30:00', '10:59:50']) {
    kit.clock.set(`2026-10-18T${time}+08:00`);
    envelope(kit, await f.send(number));
  }
  kit.clock.set('2026-10-18T10:59:55+08:00');
  envelope(kit, await f.send(number), 42901, 55);
  kit.clock.set('2026-10-18T11:00:00+08:00');
  envelope(kit, await f.send(number), 42901, 50);
  kit.clock.advanceMs(50_000);
  envelope(kit, await f.send(number));
  expect(f.messages()).toHaveLength(6);
});

it('[AC-B1-11g#17] 当日十条跨午夜仍受滑动二十四小时保护，最早一条满二十四小时后可发', async () => {
  const f = fixture(kit);
  const number = phone();
  for (const [time, resendAfterSec] of [
    ['22:10:00', 60],
    ['22:20:00', 60],
    ['22:30:00', 60],
    ['22:40:00', 60],
    ['22:50:00', 600],
    ['23:10:00', 60],
    ['23:20:00', 60],
    ['23:30:00', 60],
    ['23:40:00', 60],
    ['23:50:00', 80_400],
  ] as const) {
    kit.clock.set(`2026-10-18T${time}+08:00`);
    envelope(kit, await f.send(number), 0, undefined, resendAfterSec);
  }
  kit.clock.set('2026-10-18T23:55:00+08:00');
  envelope(kit, await f.send(number), 42901, 80_100);
  kit.clock.set('2026-10-19T00:10:00+08:00');
  envelope(kit, await f.send(number), 42901, 79_200);
  kit.clock.set('2026-10-19T22:10:00+08:00');
  envelope(kit, await f.send(number), 0, undefined, 600);
  expect(f.messages()).toHaveLength(11);
});

it('[AC-B1-11g#18] 结果未知回 SendSmsCodeResponse，新 login 码生效、旧码作废且占手机号额度', async () => {
  const f = fixture(kit);
  const number = phone();
  envelope(kit, await f.send(number));
  const old = f.messages()[0]!.code;
  kit.clock.advanceMs(60_000);
  kit.sender.enqueueResult('unknown');
  envelope(kit, await f.send(number));
  expect(f.messages()).toHaveLength(2);
  const current = f.messages()[1]!.code;
  expect(current).not.toBe(old);
  expect(await f.verify(number, old)).toEqual({ code: 20003 });
  expect(await f.verify(number, current)).toEqual({ code: 0 });
  expect(await f.verify(number, current)).toEqual({ code: 20003 });
  envelope(kit, await f.send(number), 42901, 60);
});

it('[AC-B1-11g#19] 结果未知同样计入 IP 发码额度', async () => {
  const f = fixture(kit);
  await f.config('sms.ip_sends_per_hour', 1);
  kit.sender.enqueueResult('unknown');
  envelope(kit, await f.send(phone()));
  envelope(kit, await f.send(phone()), 42901, 3611);
  expect(f.messages()).toHaveLength(1);
});

it('[AC-B1-11g#20] 明确拒绝不占 IP 或手机号额度，保留旧码，同秒重试能成功', async () => {
  const f = fixture(kit);
  await f.config('sms.ip_sends_per_hour', 2);
  const number = phone();
  envelope(kit, await f.send(number));
  const old = f.messages()[0]!.code;
  kit.clock.advanceMs(60_000);
  kit.sender.enqueueResult('rejected');
  envelope(kit, await f.send(number), 50001);
  expect(f.messages()).toHaveLength(1);
  expect(await f.verify(number, old)).toEqual({ code: 0 });
  envelope(kit, await f.send(number));
  expect(f.messages()).toHaveLength(2);
});

it('[AC-B1-11g#21] login 码五分钟边界失效，累计错五次后正确码也无效', async () => {
  const f = fixture(kit);
  const number = phone();
  envelope(kit, await f.send(number));
  const code = f.messages()[0]!.code;
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) expect(await f.verify(number, wrong)).toEqual({ code: 20002 });
  expect(await f.verify(number, code)).toEqual({ code: 20003 });
  kit.clock.advanceMs(60_000);
  envelope(kit, await f.send(number));
  kit.clock.advanceMs(300_000);
  expect(await f.verify(number, f.messages()[1]!.code)).toEqual({ code: 20003 });
});

it('[AC-B1-11g#22] 新落地页 login 码作废 App login 码，不影响同号码的 bind 码', async () => {
  const f = fixture(kit);
  const appSend = await f.appSender();
  const number = phone();
  envelope(kit, await appSend(number, 'login'));
  const old = f.messages()[0]!.code;
  kit.clock.advanceMs(60_000);
  envelope(kit, await appSend(number, 'bind'));
  const bind = f.messages()[1]!.code;
  kit.clock.advanceMs(60_000);
  envelope(kit, await f.send(number));
  expect(await f.verify(number, old)).toEqual({ code: 20003 });
  expect(await f.verify(number, bind, 'bind')).toEqual({ code: 0 });
  expect(await f.verify(number, f.messages()[2]!.code)).toEqual({ code: 0 });
});

it('[AC-B1-11g#23] 并发规范化别名只有一次发码成功，其余返回 42901', async () => {
  const f = fixture(kit);
  const number = phone();
  const responses = await Promise.all(
    [number, `+86${number}`, `0086${number}`, `86${number}`].map((n) => f.send(n)),
  );
  expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(3);
  for (const response of responses)
    envelope(kit, response, response.statusCode === 200 ? 0 : 42901);
  expect(f.messages()).toHaveLength(1);
});

it('[AC-B1-11g#24] IP 额度与验证码按 app_id 隔离，另一个 app 的 IP 满额不拦本 app', async () => {
  const first = fixture(kit);
  const second = fixture(kit);
  await first.accepted(Array.from({ length: 20 }, () => NOW));
  envelope(kit, await first.send(phone()), 42901, 3611);
  const number = phone();
  envelope(kit, await second.send(number));
  const code = second.messages()[0]!.code;
  expect(await first.verify(number, code)).toEqual({ code: 20003 });
  expect(await second.verify(number, code)).toEqual({ code: 0 });
});

for (const extra of [{ purpose: 'bind' }, { captcha_token: 'unused' }, { app_id: 'other_app' }]) {
  it(`[AC-B1-11g#25] 请求体拒绝额外身份或发码参数 ${Object.keys(extra)[0]}`, async () => {
    const f = fixture(kit);
    envelope(kit, await f.send(phone(), { body: extra }), 20001);
    expect(f.messages()).toEqual([]);
  });
}

it('[AC-B1-11g#27] 手机号频控的 42901 不计入同 IP 发码条数，换号可用完剩余额度', async () => {
  const f = fixture(kit);
  await f.config('sms.ip_sends_per_hour', 2);
  const number = phone();
  envelope(kit, await f.send(number));
  envelope(kit, await f.send(number), 42901, 60);
  expect(f.messages()).toHaveLength(1);
  envelope(kit, await f.send(phone()));
  expect(f.messages()).toHaveLength(2);
  envelope(kit, await f.send(phone()), 42901, 3611);
  expect(f.messages()).toHaveLength(2);
});
