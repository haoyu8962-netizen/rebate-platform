// B1-09n: the blacklist step's keyring rule, the part of the worker assembly the rule tests cannot
// reach (they run in APP_ENV=test, and a keyless cloud config does not load).
import { expect, it, vi } from 'vitest';
import { contentAdminOptions, orderBlacklistKeyring } from './app.module.ts';
import { normalizePoolTags } from './modules/catalog/index.ts';
import type { FieldCrypto } from './modules/platform/index.ts';

const crypto = { blindIndex: vi.fn() } as unknown as FieldCrypto;

it.each(['staging', 'prod'] as const)(
  '[AC-B1-09n#u4] %s 缺字段密钥：拒绝装配，不静默跳过第 ③ 步',
  (appEnv) => {
    const logger = { warn: vi.fn() };
    expect(() => orderBlacklistKeyring({ crypto: undefined, appEnv, logger })).toThrow(
      /field keyring/u,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  },
);

it.each(['local', 'test'] as const)(
  '[AC-B1-09n#u5] %s 缺字段密钥：第 ③ 步跳过，不报错，打一条告警',
  (appEnv) => {
    const logger = { warn: vi.fn() };
    expect(orderBlacklistKeyring({ crypto: undefined, appEnv, logger })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-09n#u6] 有字段密钥：原样给出，任何环境都不告警', () => {
  const logger = { warn: vi.fn() };
  expect(orderBlacklistKeyring({ crypto, appEnv: 'prod', logger })).toBe(crypto);
  expect(logger.warn).not.toHaveBeenCalled();
});

// CT-07g (FU-POOL-TAGS-NORMALIZE-SINGLE, D10-2034): the admin entry hands content's page save the
// one normalization of pool tags, catalog's, not a copy.
it('[CT-07g][D10-2034] ContentAdminOptions 的池标签规范化就是 catalog/index.ts 导出的 normalizePoolTags', () => {
  expect(contentAdminOptions().normalizePoolTags).toBe(normalizePoolTags);
});
