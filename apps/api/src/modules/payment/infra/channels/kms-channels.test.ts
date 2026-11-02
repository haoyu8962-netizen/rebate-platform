import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock, type AppConfig, type RootLogger } from '../../../platform/index.ts';
import { createPayChannelSet } from './index.ts';

const captured = vi.hoisted(() => ({ wechat: null as unknown, alipay: null as unknown }));

vi.mock('./wechat/wechat-pay-channel.ts', async (original) => {
  const real = await original<typeof import('./wechat/wechat-pay-channel.ts')>();
  return {
    ...real,
    WechatPayChannel: class extends real.WechatPayChannel {
      constructor(options: ConstructorParameters<typeof real.WechatPayChannel>[0]) {
        super(options);
        captured.wechat = options.keys;
      }
    },
  };
});
vi.mock('./alipay/alipay-pay-channel.ts', async (original) => {
  const real = await original<typeof import('./alipay/alipay-pay-channel.ts')>();
  return {
    ...real,
    AlipayPayChannel: class extends real.AlipayPayChannel {
      constructor(options: ConstructorParameters<typeof real.AlipayPayChannel>[0]) {
        super(options);
        captured.alipay = options.keys;
      }
    },
  };
});

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock('../../../platform/kms/sdk.ts', () => ({
  createKmsSdkClient: async () => ({
    getSecretValue: async (request: { secretName: string }) => ({
      secretData: secrets.get(request.secretName),
      secretDataType: 'text',
    }),
  }),
}));

const pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

// The rule tests check the secret names and the channel classes; this pins which secret goes where.
it('[AC-B1-30a-U#4] each KMS secret reaches its own key slot of its own channel', async () => {
  const merchant = pem();
  const wechatPlatform = pem();
  const app = pem();
  const alipayPlatform = pem();
  const v3 = 'k'.repeat(32);
  secrets.set('couli/prod/pay/wechat/merchant-private-key', merchant.privateKey);
  secrets.set('couli/prod/pay/wechat/apiv3-key', v3);
  secrets.set('couli/prod/pay/wechat/platform-public-key', wechatPlatform.publicKey);
  secrets.set('couli/prod/pay/alipay/app-private-key', app.privateKey);
  secrets.set('couli/prod/pay/alipay/public-key', alipayPlatform.publicKey);
  const config = {
    appEnv: 'prod',
    kms: {
      regionId: 'cn-hangzhou',
      endpoint: 'kms-vpc.cn-hangzhou.aliyuncs.com',
      keyId: 'key-unit',
      ramRole: 'role-unit',
    },
    payChannels: {
      appId: 'app-unit',
      impl: null,
      notifyBaseUrl: 'https://pay.example.test',
      wechat: {
        appId: 'wx-unit',
        mchId: 'mch-unit',
        merchantSerial: 'serial-unit',
        privateKeyFile: null,
        apiV3KeyFile: null,
        publicKeyFile: null,
        publicKeyId: 'pub-unit',
        testMerchant: false,
      },
      alipay: {
        appId: 'ali-unit',
        sellerId: 'seller-unit',
        privateKeyFile: null,
        publicKeyFile: null,
        appCertFile: null,
        publicCertFile: null,
        rootCertFile: null,
        gateway: null,
        keyMode: 'public_key',
      },
    },
  } as unknown as AppConfig;
  await createPayChannelSet(config, {
    clock: new FixedClock('2026-11-02T00:00:00.000Z'),
    logger: { warn: vi.fn(), info: vi.fn(), child: vi.fn() } as unknown as RootLogger,
  });
  expect(captured.wechat).toEqual({
    privateKeyPem: merchant.privateKey.replace(/\n$/, ''),
    apiV3Key: v3,
    publicKeyPem: wechatPlatform.publicKey.replace(/\n$/, ''),
  });
  expect(captured.alipay).toEqual({
    privateKeyPem: app.privateKey.replace(/\n$/, ''),
    alipayPublicKeyPem: alipayPlatform.publicKey.replace(/\n$/, ''),
  });
});
