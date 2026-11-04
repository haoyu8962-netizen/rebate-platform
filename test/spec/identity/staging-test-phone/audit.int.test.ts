import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import type { SmsCodeService } from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { createStepUpService } from '../../../../apps/api/src/modules/identity/application/step-up.ts';
import { seedUser } from '../registration/kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import { closeKit, fixture, openKit, success, type Kit } from '../sms-login/kit.ts';
import { keys } from '../token/kit.ts';
import { AUDIT_EVENT, FIXED, auditLines, expectNoLeak, masked, testPhone } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

it('[AC-B1-02zza#23] 测试号首次登录成功写一条 pino 审计 staging_test_phone_login（purpose、is_new_user、phone_masked、user_id），日志与响应不含完整号码和固定码', async () => {
  const f = await fixture(kit);
  const phone = testPhone();
  f.verify.mockResolvedValue({ code: 0, staging_test_phone: true });
  const result = await f.login({ body: { ...f.command.body, phone, code: FIXED } });
  const data = success(result);
  expect(data.is_new_user).toBe(true);
  expect(f.verify).toHaveBeenCalledExactlyOnceWith({
    app_id: f.appId,
    phone,
    purpose: 'login',
    code: FIXED,
  });
  expect(auditLines(f.lines)).toEqual([
    expect.objectContaining({
      event: AUDIT_EVENT,
      purpose: 'login',
      is_new_user: true,
      phone_masked: masked(phone),
      user_id: data.user_id,
    }),
  ]);
  expectNoLeak(f.lines.join(''), phone);
  expectNoLeak(JSON.stringify(result), phone);
});

it('[AC-B1-02zza#24] 测试号已有账号登录写一条审计且 is_new_user=false；核销失败与普通号码登录不写审计', async () => {
  const f = await fixture(kit);
  const phone = testPhone();
  const uid = await f.account('normal', f.appId, phone);
  f.verify.mockResolvedValueOnce({ code: 20002 });
  expect(await f.login({ body: { ...f.command.body, phone, code: FIXED } })).toEqual({
    code: 20002,
  });
  f.verify.mockResolvedValueOnce({ code: 0 });
  success(await f.login());
  expect(auditLines(f.lines)).toEqual([]);
  f.verify.mockResolvedValueOnce({ code: 0, staging_test_phone: true });
  const result = await f.login({ body: { ...f.command.body, phone, code: FIXED } });
  const data = success(result);
  expect(data).toMatchObject({ user_id: uid, is_new_user: false });
  expect(auditLines(f.lines)).toEqual([
    expect.objectContaining({
      event: AUDIT_EVENT,
      purpose: 'login',
      is_new_user: false,
      phone_masked: masked(phone),
      user_id: uid,
    }),
  ]);
  expectNoLeak(f.lines.join(''), phone);
  expectNoLeak(JSON.stringify(result), phone);
});

it('[AC-B1-02zza#25] 测试号 step_up 成功写一条审计（purpose=step_up、is_new_user=false）；核销失败与普通号码不写；日志与响应不含完整号码和固定码', async () => {
  const appId = `stp_${randomBytes(10).toString('hex')}`;
  const phone = testPhone();
  const db = kit.db.withSchema('app');
  const uid = await seedUser(kit.db, appId, {
    phoneHmac: kit.crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT),
  });
  await db
    .updateTable('users')
    .set({ phone_cipher: Buffer.from(kit.crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8') })
    .where('id', '=', uid)
    .execute();
  const { logger, lines } = memoryLogger();
  const verifyAndConsume = vi.fn<SmsCodeService['verifyAndConsume']>(async () => ({
    code: 0,
    staging_test_phone: true,
  }));
  const service = createStepUpService({
    db,
    clock: new FixedClock('2026-11-04T10:00:00+08:00'),
    crypto: kit.crypto,
    keys: keys(),
    config: { configValue: async () => null },
    sms: { send: async () => ({ code: 50001 }), verifyAndConsume },
    attempts: { issue: async () => ({ code: 50001 }), consume: async () => ({ code: 50001 }) },
    logger,
  });
  const principal = {
    uid,
    app_id: appId,
    sid: randomUUID(),
    device_id: randomUUID(),
    scp: 'full' as const,
  };
  const command = {
    principal,
    verifiedDevice: { appId, deviceId: principal.device_id },
    body: { action: 'withdraw' as const, code: FIXED },
  };
  verifyAndConsume.mockResolvedValueOnce({ code: 20002 });
  expect(await service.verify(command)).toEqual({ code: 20002 });
  verifyAndConsume.mockResolvedValueOnce({ code: 0 });
  expect((await service.verify(command)).code).toBe(0);
  expect(auditLines(lines)).toEqual([]);
  const result = await service.verify(command);
  expect(result.code).toBe(0);
  expect(verifyAndConsume).toHaveBeenLastCalledWith({
    app_id: appId,
    phone,
    purpose: 'step_up',
    code: FIXED,
  });
  expect(auditLines(lines)).toEqual([
    expect.objectContaining({
      event: AUDIT_EVENT,
      purpose: 'step_up',
      is_new_user: false,
      phone_masked: masked(phone),
      user_id: uid,
    }),
  ]);
  expectNoLeak(lines.join(''), phone);
  expectNoLeak(JSON.stringify(result), phone);
});
