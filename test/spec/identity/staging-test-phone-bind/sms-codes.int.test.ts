import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createSmsCodeService,
  type SmsCodeService,
} from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { acquireRedis, limited, success, withFixture, type TestRedis } from '../sms-codes/kit.ts';
import { FIXED, distinctPhones, staging, testPhone } from '../staging-test-phone/kit.ts';

// Keep the generated SMS code distinct from FIXED while leaving the phone-number draws random.
const ISSUED_CODE = vi.hoisted(() => '135790');
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: (...args: unknown[]) =>
      args.length === 2 && args[0] === 0 && args[1] === 1_000_000
        ? Number(ISSUED_CODE)
        : Reflect.apply(actual.randomInt, actual, args),
  };
});

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-02zzzd#1] staging 名单内号码发 bind 码正常受理且不调发送器，59 秒后再次发码返回 42901', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      expect(await f.send('bind', `+86 ${phone}`)).toEqual({
        code: 0,
        data: { resend_after_sec: 60, expires_in_sec: 300 },
      });
      f.clock.advanceMs(59_000);
      limited(await f.send('bind', phone), 1);
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zzzd#2] 固定码核销当前 bind 码后两种码均返回 20003，login 与 step_up 仍不发短信且可用固定码核销', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      for (const purpose of ['login', 'step_up'] as const) {
        success(await f.send(purpose, phone));
        expect((await f.verify(FIXED, purpose, phone)).code).toBe(0);
        expect(f.sender.outbox()).toEqual([]);
        f.clock.advanceMs(60_000);
      }

      expect(await f.verify(FIXED, 'bind', phone)).toEqual({ code: 20003 });
      success(await f.send('bind', phone));
      expect((await f.verify(FIXED, 'bind', phone)).code).toBe(0);
      expect(await f.verify(FIXED, 'bind', phone)).toEqual({ code: 20003 });
      expect(await f.verify(ISSUED_CODE, 'bind', phone)).toEqual({ code: 20003 });
    },
    staging([phone]),
  );
});

it('[AC-B1-02zzzd#3] staging 名单外号码的 bind 码照常发送并可核销，固定码只对名单内号码有效', async () => {
  expect(server).toBeDefined();
  const [listed, other] = distinctPhones(2) as [string, string];
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('bind', other));
      expect(f.sender.outbox()).toEqual([
        expect.objectContaining({ app_id: 'couli', phone: other, purpose: 'bind' }),
      ]);
      expect(await f.verify(FIXED, 'bind', other)).toEqual({ code: 20002 });
      expect(await f.verify(f.lastCode(), 'bind', other)).toEqual({ code: 0 });

      success(await f.send('bind', listed));
      expect(f.sender.outbox()).toHaveLength(1);
      expect((await f.verify(FIXED, 'bind', listed)).code).toBe(0);
    },
    staging([listed]),
  );
});

it.each(['prod', 'local', 'test'] as const)(
  '[AC-B1-02zzzd#4] %s 环境不启用 bind 固定码，同一号码只在 staging 可用固定码核销',
  async (appEnv) => {
    expect(server).toBeDefined();
    const phone = testPhone();
    const request = { app_id: 'couli', phone, purpose: 'bind' } as const;
    const stagingTestPhones = { phones: [phone], code: FIXED };
    await withFixture(server!, async (f) => {
      const options = { ...f.options, appEnv };
      let service: SmsCodeService;
      try {
        service = createSmsCodeService({ ...options, stagingTestPhones });
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(error).toHaveProperty('message', expect.stringContaining('APP_ENV=staging'));
        service = createSmsCodeService(options);
      }
      success(await service.send(request));
      expect(f.sender.outbox()).toEqual([expect.objectContaining(request)]);
      expect(await service.verifyAndConsume({ ...request, code: FIXED })).toEqual({ code: 20002 });
      const sent = f.lastCode();
      expect(await service.verifyAndConsume({ ...request, code: sent })).toEqual({ code: 0 });
    });

    await withFixture(
      server!,
      async (f) => {
        success(await f.send('bind', phone));
        expect((await f.verify(FIXED, 'bind', phone)).code).toBe(0);
        expect(f.sender.outbox()).toEqual([]);
      },
      staging([phone]),
    );
  },
);
