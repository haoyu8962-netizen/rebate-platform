import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createSmsCodeService,
  type SmsAttemptGate,
  type SmsAttemptSlot,
  type SmsCodeService,
  type SmsPurpose,
  type SmsResult,
} from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { acquireRedis, limited, success, withFixture, type TestRedis } from '../sms-codes/kit.ts';
import { FIXED, distinctPhones, expectNoLeak, staging, testPhone, wrongCodes } from './kit.ts';

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

/** A landing / device attempt gate whose commit always admits. */
function admittingGate(
  commit = vi.fn<SmsAttemptGate['commit']>(async () => ({
    code: 0,
    finish: async () => undefined,
  })),
): SmsAttemptGate {
  return { code: 0, commit };
}

it.each(['login', 'step_up'] as const)(
  '[AC-B1-02zza#9] staging 名单内号码发 %s 码：发送器调用 0 次、响应与正常受理相同；固定码核销成功一次，再用 20003',
  async (purpose) => {
    expect(server).toBeDefined();
    const phone = testPhone();
    await withFixture(
      server!,
      async (f) => {
        expect(await f.send(purpose, phone)).toEqual({
          code: 0,
          data: { resend_after_sec: 60, expires_in_sec: 300 },
        });
        expect(f.sender.outbox()).toEqual([]);
        const verified = await f.verify(FIXED, purpose, phone);
        expect(verified.code).toBe(0);
        expect(verified.staging_test_phone).toBe(true);
        expect(await f.verify(FIXED, purpose, phone)).toEqual({ code: 20003 });
      },
      staging([phone]),
    );
  },
);

it('[AC-B1-02zza#10] 名单内号码没先发码 20003；码按规范化号码、App、purpose 区分；规范化别名可发可核销', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      expect(await f.verify(FIXED, 'login', phone)).toEqual({ code: 20003 });
      expect(await f.verify(FIXED, 'step_up', phone)).toEqual({ code: 20003 });
      success(await f.send('login', `86${phone}`));
      expect(await f.verify(FIXED, 'step_up', phone)).toEqual({ code: 20003 });
      expect(await f.verify(FIXED, 'login', phone, 'other-app')).toEqual({ code: 20003 });
      expect((await f.verify(FIXED, 'login', `+86 ${phone}`)).code).toBe(0);
      expect(await f.verify(FIXED, 'login', phone)).toEqual({ code: 20003 });
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#11] 名单内号码的固定码 299 秒仍可核销，满 300 秒返回 20003', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('login', phone));
      f.clock.advanceMs(299_000);
      expect((await f.verify(FIXED, 'login', phone)).code).toBe(0);
      success(await f.send('step_up', phone));
      f.clock.advanceMs(300_000);
      expect(await f.verify(FIXED, 'step_up', phone)).toEqual({ code: 20003 });
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#12] 名单内号码错 4 次后固定码仍可核销；错满 5 次后正确的固定码也返回 20003', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  const wrong = wrongCodes(5);
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('login', phone));
      for (const code of wrong.slice(0, 4)) {
        expect(await f.verify(code, 'login', phone)).toEqual({ code: 20002 });
      }
      expect((await f.verify(FIXED, 'login', phone)).code).toBe(0);
      f.clock.advanceMs(60_000);
      success(await f.send('step_up', phone));
      for (const code of wrong) {
        expect(await f.verify(code, 'step_up', phone)).toEqual({ code: 20002 });
      }
      expect(await f.verify(FIXED, 'step_up', phone)).toEqual({ code: 20003 });
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#13] staging 名单外号码照常调发送器，提交固定码 20002，收到的码照常核销；名单内号码同时不调发送器', async () => {
  expect(server).toBeDefined();
  const [listed, other] = distinctPhones(2) as [string, string];
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('login', other));
      expect(f.sender.outbox()).toEqual([
        expect.objectContaining({ app_id: 'couli', phone: other, purpose: 'login' }),
      ]);
      const sent = f.lastCode();
      if (sent !== FIXED) {
        expect(await f.verify(FIXED, 'login', other)).toEqual({ code: 20002 });
      }
      expect(await f.verify(sent, 'login', other)).toEqual({ code: 0 });
      success(await f.send('step_up', listed));
      expect(f.sender.outbox()).toHaveLength(1);
      expect((await f.verify(FIXED, 'step_up', listed)).code).toBe(0);
      f.clock.advanceMs(60_000);
      success(await f.send('step_up', other));
      expect(f.sender.outbox()).toHaveLength(2);
      expect(f.sender.outbox().at(-1)).toEqual(
        expect.objectContaining({ phone: other, purpose: 'step_up' }),
      );
    },
    staging([listed]),
  );
});

it('[AC-B1-02zza#14] 名单内号码发 bind 码照常调发送器，固定码不能核销 bind 码；随后 login 不调发送器', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('bind', phone));
      expect(f.sender.outbox()).toEqual([
        expect.objectContaining({ app_id: 'couli', phone, purpose: 'bind' }),
      ]);
      const sent = f.lastCode();
      if (sent !== FIXED) {
        expect(await f.verify(FIXED, 'bind', phone)).toEqual({ code: 20002 });
      }
      expect((await f.verify(sent, 'bind', phone)).code).toBe(0);
      f.clock.advanceMs(60_000);
      success(await f.send('login', phone));
      expect(f.sender.outbox()).toHaveLength(1);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#15] 名单内号码走落地页注册发码（channel=landing）照常调发送器；随后 App 内 step_up 不调发送器', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      success(
        await f.service.send({ app_id: 'couli', phone, purpose: 'login', channel: 'landing' }),
      );
      expect(f.sender.outbox()).toEqual([
        expect.objectContaining({ app_id: 'couli', phone, purpose: 'login' }),
      ]);
      f.clock.advanceMs(60_000);
      success(await f.send('step_up', phone));
      expect(f.sender.outbox()).toHaveLength(1);
    },
    staging([phone], { hooks: { landingQuota: async () => admittingGate() } }),
  );
});

it('[AC-B1-02zza#16] 名单内号码频控照旧：同号 60 秒内第二次（任一 purpose、别名写法）42901，满 60 秒可发', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      success(await f.send('login', phone));
      f.clock.advanceMs(59_000);
      limited(await f.send('step_up', phone), 1);
      limited(await f.send('login', `+86 ${phone}`), 1);
      limited(await f.send('bind', phone), 1);
      f.clock.advanceMs(1000);
      success(await f.send('step_up', phone));
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#17] 名单内号码频控照旧：自然小时第 6 条 42901，等到整点', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      for (const minute of ['05', '10', '20', '30', '40']) {
        f.clock.set(`2026-10-06T10:${minute}:00+08:00`);
        success(await f.send(minute === '20' ? 'step_up' : 'login', phone));
      }
      f.clock.set('2026-10-06T10:50:00+08:00');
      limited(await f.send('login', phone), 600);
      f.clock.set('2026-10-06T11:00:00+08:00');
      success(await f.send('login', phone));
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#18] 名单内号码频控照旧：自然日第 11 条 42901，次日零点恢复', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      for (const hour of ['00', '01'])
        for (const minute of ['00', '10', '20', '30', '40']) {
          f.clock.set(`2026-10-06T${hour}:${minute}:00+08:00`);
          success(await f.send(hour === '01' ? 'step_up' : 'login', phone));
        }
      f.clock.set('2026-10-06T12:00:00+08:00');
      limited(await f.send('login', phone), 43_200);
      f.clock.set('2026-10-07T00:00:00+08:00');
      success(await f.send('login', phone));
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone]),
  );
});

it('[AC-B1-02zza#19] 名单内号码黑名单与号段拦截照旧 44001，被拦的号码没有可核销的码；未被拦的名单内号码不调发送器', async () => {
  expect(server).toBeDefined();
  const [blocked, open] = distinctPhones(2) as [string, string];
  await withFixture(
    server!,
    async (f) => {
      expect(await f.send('login', blocked)).toEqual({ code: 44001, kind: 'phone_blocklist' });
      expect(await f.send('step_up', open, 'prefixed')).toMatchObject({
        code: 44001,
        kind: 'blocked_prefix',
      });
      success(await f.send('login', open));
      expect(f.sender.outbox()).toEqual([]);
      expect(await f.verify(FIXED, 'login', blocked)).toEqual({ code: 20003 });
      expect(await f.verify(FIXED, 'step_up', open, 'prefixed')).toEqual({ code: 20003 });
      expect((await f.verify(FIXED, 'login', open)).code).toBe(0);
    },
    staging([blocked, open], {
      config: {
        configValue: async (appId) =>
          appId === 'prefixed' ? { value: ['+86199'], version: 1 } : null,
      },
      hooks: {
        phoneBlocklist: async (request) =>
          request.phone === blocked ? { code: 44001, kind: 'phone_blocklist' } : null,
      },
    }),
  );
});

it('[AC-B1-02zza#20] 名单内号码设备与 IP 判定照旧：人机验证 44003、设备额度 42901 照常拦截；受理时尝试照常提交且不记为失败，受理后计数照常', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  const order: string[] = [];
  let captchaRefuses = false;
  let deviceRefuses = false;
  const finish = vi.fn<SmsAttemptSlot['finish']>(async () => undefined);
  const commit = vi.fn<SmsAttemptGate['commit']>(async () => ({ code: 0, finish }));
  const afterAccepted = vi.fn(async () => undefined);
  await withFixture(
    server!,
    async (f) => {
      captchaRefuses = true;
      expect(await f.send('login', phone)).toEqual({ code: 44003 });
      captchaRefuses = false;
      deviceRefuses = true;
      expect(await f.send('step_up', phone)).toEqual({ code: 42901, retryAfterSec: 30 });
      deviceRefuses = false;
      success(await f.send('login', phone));
      expect(order).toEqual(['captcha', 'captcha', 'device', 'captcha', 'device']);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish.mock.calls[0]?.[0]).not.toBe('failed');
      expect(afterAccepted).toHaveBeenCalledTimes(1);
      expect(afterAccepted).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: 'couli', phone, purpose: 'login' }),
      );
      expect(f.sender.outbox()).toEqual([]);
    },
    staging([phone], {
      hooks: {
        captcha: async () => {
          order.push('captcha');
          return captchaRefuses ? { code: 44003 } : null;
        },
        deviceQuota: async () => {
          order.push('device');
          return deviceRefuses ? { code: 42901, retryAfterSec: 30 } : admittingGate(commit);
        },
        afterAccepted,
      },
    }),
  );
});

it('[AC-B1-02zza#21] 运行时硬关：没给 staging 的服务（手工拼的选项、prod）即使带着测试号配置，若能构造也与没配一样——照常调发送器、固定码 20002', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  const stagingTestPhones = { phones: [phone], code: FIXED };
  await withFixture(server!, async (f) => {
    // f.options carries no appEnv (a hand-built configuration).
    const staged = createSmsCodeService({ ...f.options, appEnv: 'staging', stagingTestPhones });
    success(await staged.send({ app_id: 'couli', phone, purpose: 'login' }));
    expect(f.sender.outbox()).toEqual([]);
    expect(
      (await staged.verifyAndConsume({ app_id: 'couli', phone, purpose: 'login', code: FIXED }))
        .code,
    ).toBe(0);

    const unconfigured = async (service: SmsCodeService, purpose: SmsPurpose) => {
      f.clock.advanceMs(60_000);
      const before = f.sender.outbox().length;
      success(await service.send({ app_id: 'couli', phone, purpose }));
      expect(f.sender.outbox()).toHaveLength(before + 1);
      expect(f.sender.outbox().at(-1)).toEqual(expect.objectContaining({ phone, purpose }));
      const sent = f.lastCode();
      if (sent !== FIXED) {
        expect(
          await service.verifyAndConsume({ app_id: 'couli', phone, purpose, code: FIXED }),
        ).toEqual({ code: 20002 });
      }
      expect(
        await service.verifyAndConsume({ app_id: 'couli', phone, purpose, code: sent }),
      ).toEqual({ code: 0 });
    };
    let handBuilt: SmsCodeService | undefined;
    try {
      handBuilt = createSmsCodeService({ ...f.options, stagingTestPhones });
    } catch {
      handBuilt = undefined;
    }
    if (handBuilt !== undefined) await unconfigured(handBuilt, 'step_up');
    await unconfigured(createSmsCodeService({ ...f.options, appEnv: 'prod' }), 'login');
    await unconfigured(createSmsCodeService({ ...f.options }), 'step_up');
  });
});

it('[AC-B1-02zza#22] 名单内号码的发码、错码、核销、限流：日志与响应体都不含固定码与完整号码', async () => {
  expect(server).toBeDefined();
  const phone = testPhone();
  await withFixture(
    server!,
    async (f) => {
      const results: (SmsResult | { readonly code: number })[] = [];
      results.push(await f.send('login', `+86 ${phone}`));
      results.push(await f.verify(wrongCodes(1)[0]!, 'login', phone));
      results.push(await f.verify(FIXED, 'login', phone));
      results.push(await f.send('step_up', phone));
      f.clock.advanceMs(60_000);
      results.push(await f.send('step_up', phone));
      results.push(await f.verify(FIXED, 'step_up', phone));
      expect(results.map((result) => result.code)).toEqual([0, 20002, 0, 42901, 0, 0]);
      expect(f.sender.outbox()).toEqual([]);
      expectNoLeak(f.lines.join(''), phone);
      expectNoLeak(JSON.stringify(results), phone);
    },
    staging([phone]),
  );
});
