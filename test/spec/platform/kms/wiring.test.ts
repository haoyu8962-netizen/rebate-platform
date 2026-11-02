// B1-30a 模块接线（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「接入」与测试要求第 7 条：createHttpApp /
// createWorkerContext 带 prod + KMS 配置时真的走到桩，别只测函数。规划/02 §12.6 的可读进程表：收款密钥只有 api
// 里的 payment（这里也看 worker，它跑收款的查询和对账任务，BR-PAY-08 ① 只把 stream、payout 排除在外），联盟
// secret 是 api、stream、worker，数据加密主密钥每个入口都用。
//
// 配置从 loadConfig 来（KMS_* → AppConfig.kms → 模块），不手拼。union/infra/endpoints.ts 打桩成三家 live：
// 打包的 config/union-endpoints 是 demo，prod 的 parseUnionEndpoints 会拒绝（unsafe_mode），union 的工厂就走不到。
//
// payout 没有 union、payment，也不依赖其他 prod 专属的装配，断言它完整启动并能用注入的 FieldCrypto。api、worker、
// stream 在这之前没人在 prod 上完整启动过（keyring 在最前面就 kms_unavailable 了），别的模块在 prod 怎么装配不归本
// 任务管：这里只断言读密钥的路真的走到了桩，启动失败时不是 KMS 相关的错误码。顶层 it。
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import {
  createWrappedKeyring,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { KmsSecretName } from '../../../../apps/api/src/modules/platform/kms/index.ts';
import {
  memoryLogger,
  platformIndex,
  settle,
  startEntry,
  startupErrorProblems,
  type Entry,
  type StartedApp,
} from '../crypto/wiring-kit.ts';
import {
  ALIPAY_APP,
  ALIPAY_APPID,
  ALIPAY_PLATFORM,
  APIV3_KEY,
  MCHID,
  MERCHANT,
  MERCHANT_SERIAL,
  PUBLIC_KEY_ID,
  SELLER_ID,
  WECHAT_PLATFORM,
  WX_APPID,
  commonEnv,
} from '../../payment/channels/kit.ts';
import {
  KMS,
  KMS_ENV,
  PROD_AGENT_KEY,
  accessOf,
  makeDir,
  removeDir,
  secretNameOf,
  secretsRead,
  setSecret,
  text,
} from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

vi.mock('../../../../apps/api/src/modules/union/infra/endpoints.ts', async (original) => ({
  ...(await original<typeof import('../../../../apps/api/src/modules/union/infra/endpoints.ts')>()),
  loadUnionEndpoints: () =>
    Promise.resolve(
      (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
        platform,
        mode: 'live',
        baseUrl: `https://${platform}.invalid/router`,
        quotaKey: `b1-30a:${platform}`,
      })),
    ),
}));

// 第一次加载 Nest 很慢，CI 更慢：显式放宽。
const NEST_TIMEOUT_MS = 90_000;
const REACH_TIMEOUT_MS = 30_000;

const PAY_SECRETS: readonly (readonly [KmsSecretName, string])[] = [
  ['pay/wechat/merchant-private-key', MERCHANT.privateKey],
  ['pay/wechat/apiv3-key', APIV3_KEY],
  ['pay/wechat/platform-public-key', WECHAT_PLATFORM.publicKey],
  ['pay/alipay/app-private-key', ALIPAY_APP.privateKey],
  ['pay/alipay/public-key', ALIPAY_PLATFORM.publicKey],
];
const UNION_SECRETS: readonly KmsSecretName[] = [
  'union/pdd/client-secret',
  'union/taobao/app-secret',
  'union/jd/app-secret',
  'union/dataoke/app-secret',
];

/** 启动失败时这些错误码说明是读密钥的路断了；别的错误不归本任务管。 */
const KMS_REFUSALS = [
  'kms_unavailable',
  'unwrap_failed',
  'keyring_invalid',
  'keyring_unreadable',
  'credentials_missing',
  'secret_invalid',
  'kms_read_failed',
];

let dir: string;

beforeEach(() => {
  resetSdk();
  dir = makeDir('wiring');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network access is forbidden')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeDir(dir);
});

function jwtEnv(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_KEY_ID: 'b1-30a-test',
    JWT_VERIFY_KEYS_JSON: '{}',
  };
}

/** 两个 keyring 文件用桩的 KMS 现包；完整的 prod 环境，没有任何 *_FILE。 */
async function prodKmsEnv(): Promise<Record<string, string>> {
  const provider = accessOf().keyProvider;
  const keyringFile = join(dir, 'keyring.json');
  const priorFile = join(dir, 'prior-keyring.json');
  writeFileSync(keyringFile, JSON.stringify(await createWrappedKeyring(provider)));
  writeFileSync(priorFile, JSON.stringify(await createWrappedKeyring(provider)));
  sdk.created = [];
  sdk.encrypt.mockClear();
  sdk.decrypt.mockClear();
  return {
    APP_ENV: 'prod',
    LOG_LEVEL: 'silent',
    ...PROD_AGENT_KEY,
    ...KMS_ENV,
    ...jwtEnv(),
    ...commonEnv(),
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: keyringFile,
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: priorFile,
    PDD_CLIENT_ID: 'public-pdd-id',
    TAOBAO_APP_KEY: 'public-taobao-key',
    JD_APP_KEY: 'public-jd-key',
    DATAOKE_APP_KEY: 'public-dataoke-key',
    PAY_WECHAT_APPID: WX_APPID,
    PAY_WECHAT_MCHID: MCHID,
    PAY_WECHAT_MERCHANT_SERIAL: MERCHANT_SERIAL,
    PAY_WECHAT_PUBLIC_KEY_ID: PUBLIC_KEY_ID,
    PAY_ALIPAY_APPID: ALIPAY_APPID,
    PAY_ALIPAY_SELLER_ID: SELLER_ID,
  };
}

function setAllSecrets(): void {
  for (const [logical, value] of PAY_SECRETS) setSecret(logical, text(value));
  for (const logical of UNION_SECRETS) setSecret(logical, text('synthetic-union-secret'));
}

/** loadConfig 真的产出了 kms：骨架上这里先红，后面就不会拿着 kms_unavailable 去等桩。 */
function configFor(env: Record<string, string>, entry: Entry) {
  const config = loadConfig(env, entry);
  expect((config as unknown as { readonly kms?: unknown }).kms).toEqual(KMS);
  return config;
}

/** 入口运行器给 createDbHandles 的东西；查询之前不连库。 */
function dbHandlesFor(entry: Entry, logger: object) {
  return createDbHandles(
    loadConnectionConfig(entry, {
      DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/couli',
      DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli',
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    { logger: logger as Parameters<typeof createDbHandles>[1]['logger'] },
  );
}

function codeOfError(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
}

/**
 * 启动 entry，等 expected 里的 secret 都被读到、keyring 都解开；启动失败时不许是 KMS 相关的错误码。
 * 返回启动日志，结束时关闭入口。
 */
async function expectReached(
  entry: Entry,
  env: Record<string, string>,
  expected: readonly KmsSecretName[],
  withDatabase: boolean,
): Promise<readonly string[]> {
  const config = configFor(env, entry);
  const { logger, lines } = memoryLogger(entry, 'prod');
  const started = await settle(
    startEntry(entry, {
      config,
      logger,
      ...(withDatabase ? { dbHandles: dbHandlesFor(entry, logger) } : {}),
    }),
  );
  try {
    const names = expected.map((logical) => secretNameOf(logical));
    await vi.waitFor(
      () => {
        // 数据密钥与盲索引密钥，两个 keyring 各两次。
        expect(sdk.decrypt.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(secretsRead()).toEqual(expect.arrayContaining(names));
      },
      { timeout: REACH_TIMEOUT_MS, interval: 50 },
    );
    if ('error' in started) expect(KMS_REFUSALS).not.toContain(codeOfError(started.error));
    // 一个配置对象一个客户端：keyring、联盟、收款共用。
    expect(sdk.created).toEqual([KMS]);
  } finally {
    if ('value' in started) await started.value.close();
  }
  return lines;
}

it(
  '[AC-B1-30a#80] api 入口 prod + KMS：两个 keyring、四家联盟、收款的 secret 都走到桩，日志没有 SDK 原文和密钥内容',
  async () => {
    const env = await prodKmsEnv();
    setAllSecrets();
    const lines = await expectReached(
      'api',
      env,
      [...UNION_SECRETS, ...PAY_SECRETS.map(([logical]) => logical)],
      true,
    );
    const log = lines.join('\n');
    for (const value of [SDK_MARKER, 'PRIVATE KEY', APIV3_KEY, 'synthetic-union-secret']) {
      expect(log).not.toContain(value);
    }
  },
  NEST_TIMEOUT_MS,
);

it(
  '[AC-B1-30a#81] worker 入口 prod + KMS：keyring、联盟、收款都走到桩',
  async () => {
    const env = await prodKmsEnv();
    setAllSecrets();
    await expectReached(
      'worker',
      env,
      [...UNION_SECRETS, ...PAY_SECRETS.map(([logical]) => logical)],
      true,
    );
  },
  NEST_TIMEOUT_MS,
);

it(
  '[AC-B1-30a#82] stream 入口 prod + KMS：keyring、联盟走到桩，收款的 secret 一个都不读（BR-PAY-08 ①）',
  async () => {
    const env = await prodKmsEnv();
    setAllSecrets();
    await expectReached('stream', env, UNION_SECRETS, false);
    expect(secretsRead().filter((name) => name.includes('/pay/'))).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);

it(
  '[AC-B1-30a#83] payout 入口 prod + KMS：完整启动，注入的两个 FieldCrypto 能用且互相解不开；不读联盟和收款的 secret（BR-PAY-08 ①）',
  async () => {
    const env = await prodKmsEnv();
    setAllSecrets();
    const config = configFor(env, 'payout');
    const { logger } = memoryLogger('payout', 'prod');
    const started = await settle(startEntry('payout', { config, logger }));
    expect('value' in started ? 'started' : started.error).toBe('started');
    const app = (started as { readonly value: StartedApp }).value;
    try {
      const index = await platformIndex();
      const field = app.get(index['FIELD_CRYPTO']) as FieldCrypto;
      const prior = app.get(index['PRIOR_IDENTITY_FIELD_CRYPTO']) as FieldCrypto;
      const context = 'users.id_no';
      const cipher = field.encrypt('synthetic-value', context);
      expect(field.decrypt(cipher, context)).toBe('synthetic-value');
      expect(prior.decrypt(prior.encrypt('synthetic-value', context), context)).toBe(
        'synthetic-value',
      );
      expect(() => prior.decrypt(cipher, context)).toThrow();
      // 数据密钥与盲索引密钥，两个 keyring 各两次。
      expect(sdk.decrypt.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(sdk.created).toEqual([KMS]);
      expect(secretsRead()).toEqual([]);
    } finally {
      await app.close();
    }
  },
  NEST_TIMEOUT_MS,
);

it(
  '[AC-B1-30a#84] KMS 解不开时入口拒绝启动：createWorkerContext 带 KeyringStartupError unwrap_failed，不带 SDK 原文，日志也没有',
  async () => {
    const env = await prodKmsEnv();
    const config = configFor(env, 'payout');
    sdk.decrypt.mockRejectedValue(new Error(SDK_MARKER));
    const { logger, lines } = memoryLogger('payout', 'prod');
    const started = await settle(startEntry('payout', { config, logger }));
    expect(
      'error' in started ? startupErrorProblems(started.error, 'unwrap_failed') : ['started'],
    ).toEqual([]);
    expect(lines.join('\n')).not.toContain(SDK_MARKER);
  },
  NEST_TIMEOUT_MS,
);
