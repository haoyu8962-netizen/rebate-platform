import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRedisHandle } from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createSmsCodeService,
  type SmsCodeOptions,
} from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { createFakeSmsSender } from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';
import { makeHmac, memoryLogger, redisConnection } from '../sms-codes/kit.ts';
import { FIXED, testPhone } from './kit.ts';

it('[AC-B1-02zza#8] 服务在 local / test / prod 构造时塞进测试号配置即报错（不带号码与码）；不塞或为 null 照常构造，staging 照常构造', async () => {
  const { logger, lines } = memoryLogger();
  // Never connects: construction alone must decide.
  const handle = await createRedisHandle(redisConnection('redis://127.0.0.1:1/0'), {
    logger,
    transportFactory: () => ({
      connect: async () => {
        throw new Error('offline');
      },
      call: async () => {
        throw new Error('offline');
      },
      quit: async () => undefined,
      disconnect: () => undefined,
    }),
  });
  expect(handle).not.toBeNull();
  try {
    const phone = testPhone();
    const stagingTestPhones = { phones: [phone], code: FIXED };
    const base: SmsCodeOptions = {
      redis: handle!,
      clock: new FixedClock('2026-11-04T10:00:00+08:00'),
      logger,
      hmac: makeHmac(),
      config: { configValue: async () => null },
      sender: createFakeSmsSender('test'),
    };
    expect(() =>
      createSmsCodeService({ ...base, appEnv: 'staging', stagingTestPhones }),
    ).not.toThrow();
    for (const appEnv of ['local', 'test', 'prod'] as const) {
      expect(() => createSmsCodeService({ ...base, appEnv })).not.toThrow();
      expect(() =>
        createSmsCodeService({ ...base, appEnv, stagingTestPhones: null }),
      ).not.toThrow();
      let error: unknown;
      try {
        createSmsCodeService({ ...base, appEnv, stagingTestPhones });
      } catch (caught) {
        error = caught;
      }
      expect(error, appEnv).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(phone);
      expect(String(error)).not.toMatch(new RegExp(`(?<!\\d)${FIXED}(?!\\d)`));
    }
    const logs = lines.join('');
    expect(logs).not.toContain(phone);
    expect(logs).not.toMatch(new RegExp(`(?<!\\d)${FIXED}(?!\\d)`));
  } finally {
    await handle?.close();
  }
});
