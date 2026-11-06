// B1-02zzc（D10-731 ②，来自 B1-02zza / D10-611）：staging 固定验证码只用于 App 内 login 与 step_up，
// 落地页注册（POST /v1/invites/landing-register）验码不认固定码。经真实 api AppModule 走到底：
// identity.module 交给落地页注册的必须是关掉固定码的那层短信码视图；改回直接传原服务，#1 会红。
// #2 是对照：同一个已启用的短信码服务在 App 登录路径上认固定码，排除「配置没生效」造成的假绿。
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { answer, fixture, noAccount, registered } from '../../growth/landing-register/kit.ts';
import { AUDIT_EVENT, auditLines } from '../staging-test-phone/kit.ts';
import {
  APP_SMS_PATH,
  FIXED,
  LOGIN_PATH,
  appClient,
  contractBody,
  landingBody,
  openKit,
  sessions,
  type Kit,
} from './kit.ts';

let server: Awaited<ReturnType<typeof acquireTestRedis>> | undefined;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let kit: Kit;
beforeAll(async () => {
  server = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  kit = await openKit(db, database.urlFor('couli_app'), server.url);
}, 180_000);
afterAll(async () => {
  try {
    await kit?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
      await database?.drop();
    } finally {
      await server?.stop();
    }
  }
}, 120_000);

it('[AC-B1-02zzc#1] staging 名单内号码落地页发码照常下发；落地页注册提交固定码按验证码错误 20002 拒绝：不建号、不建会话、不发令牌、不写测试号审计；随后用真实下发的码仍注册成功', async () => {
  const f = await fixture(kit);
  const number = kit.phones[0]!;
  const body = await landingBody(kit, f, number);
  expect(body.sms_code).not.toBe(FIXED);
  const start = kit.lines.length;

  const rejected = await f.post({ ...body, sms_code: FIXED });
  const refused = answer(f, rejected, 20002);
  const text = JSON.stringify(refused);
  expect(text).not.toContain('access_token');
  expect(text).not.toContain('refresh_token');
  await noAccount(f, number);
  expect(await sessions(kit, f.appId)).toEqual([]);
  expect(auditLines(kit.lines.slice(start))).toEqual([]);

  // The refusal is the fixed code's, not the number's: the delivered code still registers.
  answer(f, await f.post(body));
  await registered(f, number);
  expect(await sessions(kit, f.appId)).toEqual([]);
  expect(auditLines(kit.lines.slice(start))).toEqual([]);
});

it('[AC-B1-02zzc#2] 对照：同一装配下，名单内号码在 App 登录路径发码不调发送器，用固定码 /v1/auth/login/sms 登录成功（落地页注册的账号、is_new_user=false），建一条会话并写一条测试号审计', async () => {
  const f = await fixture(kit);
  const number = kit.phones[1]!;
  answer(f, await f.post(await landingBody(kit, f, number)));
  const user = await registered(f, number);

  // One send per number per 60 seconds across the landing page and the App (BR-ID-05).
  kit.clock.advanceMs(60_000);
  const c = await appClient(kit, f);
  const before = kit.sender.outbox().length;
  const sent = await c.send(number);
  expect(sent.statusCode).toBe(200);
  expect(contractBody(kit, APP_SMS_PATH, sent)).toMatchObject({ code: 0 });
  expect(kit.sender.outbox()).toHaveLength(before);

  const start = kit.lines.length;
  const login = await c.login(number, FIXED);
  expect(login.statusCode).toBe(200);
  const answered = contractBody(kit, LOGIN_PATH, login);
  expect(answered).toMatchObject({
    code: 0,
    data: {
      user_id: user.id,
      is_new_user: false,
      tokens: { access_token: expect.any(String), refresh_token: expect.any(String) },
    },
  });
  expect(await sessions(kit, f.appId)).toEqual([
    expect.objectContaining({ app_id: f.appId, user_id: user.id }),
  ]);
  expect(auditLines(kit.lines.slice(start))).toEqual([
    expect.objectContaining({
      event: AUDIT_EVENT,
      purpose: 'login',
      is_new_user: false,
      user_id: user.id,
    }),
  ]);
  expect(kit.sender.outbox()).toHaveLength(before);
});
