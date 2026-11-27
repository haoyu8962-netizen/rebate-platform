import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import * as platform from '../../../../../apps/api/src/modules/platform/index.ts';
import { createWrappedKeyring } from '../../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { RedisTransport } from '../../../../../apps/api/src/modules/platform/redis/transport.ts';
import type { UnionEndpoint } from '../../../../../apps/api/src/modules/union/domain/types.ts';
import { memoryLogger } from '../../../platform/crypto/wiring-kit.ts';
import {
  KMS_ENV,
  PROD_AGENT_KEY,
  accessOf,
  makeDir,
  removeDir,
  secretsRead,
  setSecret,
  text,
} from '../../../platform/kms/kit.ts';
import { resetSdk, type createKmsSdkClient } from '../../../platform/kms/sdk-stub.ts';
import {
  ALIPAY_APP,
  ALIPAY_APPID,
  ALIPAY_PLATFORM,
  MCHID,
  MERCHANT,
  MERCHANT_SERIAL,
  PUBLIC_KEY_ID,
  SELLER_ID,
  WECHAT_PLATFORM,
  WX_APPID,
  commonEnv,
} from '../../../payment/channels/kit.ts';
import { ALIPAY_CERT, APP_CERT, APP_PRIVATE_KEY, ROOT_CERT } from '../cert-kit.ts';

vi.mock(
  '../../../../../apps/api/src/modules/platform/kms/sdk.ts',
  async (): Promise<{ createKmsSdkClient: typeof createKmsSdkClient }> => {
    const stub = await import('../../../platform/kms/sdk-stub.ts');
    return { createKmsSdkClient: stub.createKmsSdkClient };
  },
);

type Endpoints = typeof import('../../../../../apps/api/src/modules/union/infra/endpoints.ts');

// 生产环境不接受仓库里的 demo 端点，沿用 KMS wiring 测试的 live 端点夹具。
vi.mock(
  '../../../../../apps/api/src/modules/union/infra/endpoints.ts',
  async (original): Promise<Endpoints> => {
    const endpoints = await original<Endpoints>();
    const loadUnionEndpoints = async (): Promise<readonly UnionEndpoint[]> =>
      (['jd', 'pdd', 'taobao'] as const).map((name): UnionEndpoint => ({
        platform: name,
        mode: 'live',
        baseUrl: `https://${name}.invalid/router`,
        quotaKey: `b2-06ja:${name}`,
      }));
    return { ...endpoints, loadUnionEndpoints };
  },
);

vi.mock(
  '../../../../../apps/api/src/modules/platform/redis/ioredis-transport.ts',
  (): { createIoredisTransport: () => RedisTransport } => ({
    createIoredisTransport: (): RedisTransport => ({
      async connect(): Promise<void> {
        throw new Error('Redis access is forbidden in this test');
      },
      async call(): Promise<never> {
        throw new Error('Redis access is forbidden in this test');
      },
      async quit(): Promise<void> {},
      disconnect(): void {},
    }),
  }),
);

type NonPayoutEntry = Exclude<platform.EntryName, 'payout'>;

const originalExitCode = process.exitCode;
afterEach((): void => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.exitCode = originalExitCode;
});

async function prodKmsEnv(dir: string): Promise<Record<string, string>> {
  const provider = accessOf().keyProvider;
  const keyring = join(dir, 'keyring.json');
  const priorKeyring = join(dir, 'prior-keyring.json');
  writeFileSync(keyring, JSON.stringify(await createWrappedKeyring(provider)));
  writeFileSync(priorKeyring, JSON.stringify(await createWrappedKeyring(provider)));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    APP_ENV: 'prod',
    COULI_EXIT_AFTER_INIT: '1',
    ...KMS_ENV,
    ...PROD_AGENT_KEY,
    ...commonEnv(),
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: keyring,
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: priorKeyring,
    JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_KEY_ID: 'b2-06ja-jwt',
    JWT_VERIFY_KEYS_JSON: '{}',
    CONFIG_SIGN_KEY_ID: 'b2-06ja-config',
    ADMIN_TOKEN_SIGNING_KEY: randomBytes(32).toString('base64url'),
    ADMIN_IP_ALLOWLIST: '127.0.0.1',
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
    PAYOUT_MODE: 'live',
    ALIPAY_APP_ID: 'test-payout-cert-app',
    ALIPAY_GATEWAY_URL: 'https://payout-cert.test.invalid/gateway.do',
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/couli',
    DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli',
    REDIS_URL: 'redis://127.0.0.1:1/0',
  };
}

function seedSecrets(): void {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const unionSecret = text(randomBytes(24).toString('base64url'));
  setSecret('config/sign-private-key', text(pem));
  setSecret('union/pdd/client-secret', unionSecret);
  setSecret('union/taobao/app-secret', unionSecret);
  setSecret('union/jd/app-secret', unionSecret);
  setSecret('union/dataoke/app-secret', unionSecret);
  setSecret('pay/wechat/merchant-private-key', text(MERCHANT.privateKey));
  setSecret('pay/wechat/apiv3-key', text(randomBytes(24).toString('base64')));
  setSecret('pay/wechat/platform-public-key', text(WECHAT_PLATFORM.publicKey));
  setSecret('pay/alipay/app-private-key', text(ALIPAY_APP.privateKey));
  setSecret('pay/alipay/public-key', text(ALIPAY_PLATFORM.publicKey));
  setSecret('payout/alipay/app-private-key', text(APP_PRIVATE_KEY));
  setSecret('payout/alipay/app-cert', text(APP_CERT));
  setSecret('payout/alipay/public-cert', text(ALIPAY_CERT));
  setSecret('payout/alipay/root-cert', text(ROOT_CERT));
}

it.each(['api', 'worker', 'stream', 'admin'] as const)(
  '[AC-B2-06ja#2] prod + live 且 KMS 条目齐备时，%s 正常初始化且不读任何打款条目',
  async (entry): Promise<void> => {
    resetSdk();
    seedSecrets();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network access is forbidden')));
    const dir = makeDir('b2-06ja');
    const db = new Kysely<DB>({
      dialect: {
        createAdapter: (): PostgresAdapter => new PostgresAdapter(),
        createDriver: (): DummyDriver => new DummyDriver(),
        createIntrospector: (handle): PostgresIntrospector => new PostgresIntrospector(handle),
        createQueryCompiler: (): PostgresQueryCompiler => new PostgresQueryCompiler(),
      },
    });
    try {
      const env = await prodKmsEnv(dir);
      const config = platform.loadConfig(env, entry);
      const connection = platform.loadConnectionConfig(entry, env);
      // 真实启动器和 Nest 装配，外部 I/O 用替身。初始化完毕即关闭，不启动队列或监听端口。
      const { runEntry } = (await import(
        new URL('../../../../../apps/api/src/entry.ts', import.meta.url).href
      )) as { runEntry(name: NonPayoutEntry): Promise<void> };
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
      vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connection);
      vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
      vi.spyOn(platform, 'createDbHandles').mockReturnValue({
        db,
        dbRead: entry === 'admin' ? db : null,
        async close(): Promise<void> {},
      });
      const { logger, lines } = memoryLogger(entry, 'prod');
      vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);

      await runEntry(entry);

      const payoutReads = secretsRead().filter((name): boolean =>
        name.startsWith('couli/prod/payout/'),
      );
      expect(payoutReads).toEqual([]);
      const messages = lines.map((line): string => (JSON.parse(line) as { msg: string }).msg);
      expect(messages).toContain('started');
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      try {
        await db.destroy();
      } finally {
        removeDir(dir);
      }
    }
  },
  90_000,
);
