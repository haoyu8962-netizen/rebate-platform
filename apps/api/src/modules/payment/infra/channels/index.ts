// B2-15k: the channel set of a process (task §9.1, §9.8, §9.9). payment.module provides it through
// createPayChannelSet: fake channels where the configuration says so, a real adapter per channel
// with complete credentials, UnavailablePayChannel otherwise. It never throws for a missing
// credential and never falls back to a fake channel; prod never has a fake one. The key files are
// read here once, at startup, and the adapters keep them in memory; the warn of an unavailable
// channel names the channel and the variables, never a path or a content.
// Ruling D10-554 (BR-PAY-08 ②: prod keys only in KMS): prod opens no key file. B1-30a: prod reads its
// keys from KMS once, at startup; without KMS configured both channels are unavailable with
// kms_unavailable. A secret that cannot be read makes that channel kms_unavailable, never a fake one.
// The process starts all the same.
// Also compiled by the `test` project: erasable syntax only.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  PAY_REASON_KMS_UNAVAILABLE,
  PayChannelSet,
  type PayChannel,
} from '../../application/pay-channel.ts';
import type { PayChannelCode } from '../../domain/types.ts';
import {
  KMS_SECRETS,
  kmsAccessOf,
  readStartupSecretFile,
  type AppConfig,
  type Clock,
  type KmsAccess,
  type KmsSecretName,
  type PayAlipayEnv,
  type PayChannelsConfig,
  type PayWechatEnv,
  type RootLogger,
} from '../../../platform/index.ts';
import {
  ALIPAY_PRODUCTION_GATEWAY,
  AlipayPayChannel,
  type AlipayCertSerials,
} from './alipay/alipay-pay-channel.ts';
import { certSn, publicKeyFromCert, rootCertSn } from './alipay/cert-sn.ts';
import { FakePayChannel } from './fake-pay-channel.ts';
import { fetchPayTransport, type PayTransport } from './transport.ts';
import { UnavailablePayChannel } from './unavailable-pay-channel.ts';
import { WechatPayChannel } from './wechat/wechat-pay-channel.ts';

export { AlipayPayChannel } from './alipay/alipay-pay-channel.ts';
export { WechatPayChannel } from './wechat/wechat-pay-channel.ts';
export { UnavailablePayChannel } from './unavailable-pay-channel.ts';
export { fetchPayTransport } from './transport.ts';
export type { PayHttpRequest, PayHttpResponse, PayTransport } from './transport.ts';

export interface PayChannelSetDeps {
  /** Defaults to fetchPayTransport. */
  readonly transport?: PayTransport;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

/** PEM keys and certificates are a few KiB; a root bundle a few of those. */
const KEY_FILE_MAX_BYTES = 64 * 1024;
/** docs-mirror/wechat-pay/pages/4012071382.txt: the APIv3 key is 32 bytes. */
const APIV3_KEY_BYTES = 32;

const EMPTY_WECHAT: PayWechatEnv = {
  appId: null,
  mchId: null,
  merchantSerial: null,
  privateKeyFile: null,
  apiV3KeyFile: null,
  publicKeyFile: null,
  publicKeyId: null,
  testMerchant: false,
};

const EMPTY_ALIPAY: PayAlipayEnv = {
  appId: null,
  sellerId: null,
  privateKeyFile: null,
  publicKeyFile: null,
  appCertFile: null,
  publicCertFile: null,
  rootCertFile: null,
  gateway: null,
  keyMode: 'public_key',
};

const EMPTY: PayChannelsConfig = {
  appId: null,
  impl: null,
  notifyBaseUrl: null,
  wechat: EMPTY_WECHAT,
  alipay: EMPTY_ALIPAY,
};

/** Reads one key file and checks it; collects the variable's name instead of throwing. */
class KeyReader {
  readonly problems: string[] = [];

  async read<T>(name: string, path: string, parse: (text: string) => T): Promise<T | null> {
    try {
      return parse(
        await readStartupSecretFile(path, KEY_FILE_MAX_BYTES, () => new Error('unreadable')),
      );
    } catch {
      this.problems.push(name);
      return null;
    }
  }
}

function privateKeyPem(text: string): string {
  createPrivateKey(text);
  return text;
}

function publicKeyPem(text: string): string {
  // createPublicKey also derives from a private key: that file is not a public key.
  if (text.includes('PRIVATE KEY')) throw new Error('not a public key');
  createPublicKey(text);
  return text;
}

function apiV3Key(text: string): string {
  if (Buffer.byteLength(text, 'utf8') !== APIV3_KEY_BYTES) throw new Error('not an APIv3 key');
  return text;
}

/** Any https address that is not the production gateway's host counts (BR-PAY-08 ②). */
function isSandboxGateway(gateway: string): boolean {
  if (!URL.canParse(gateway)) return false;
  const url = new URL(gateway);
  const host = url.hostname.replace(/\.$/, '');
  return url.protocol === 'https:' && host !== new URL(ALIPAY_PRODUCTION_GATEWAY).hostname;
}

interface BuildContext {
  readonly pay: PayChannelsConfig;
  readonly transport: PayTransport;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

function missing(entries: readonly (readonly [string, unknown])[]): string[] {
  return entries.filter(([, value]) => value === null || value === false).map(([name]) => name);
}

function commonMissing(pay: PayChannelsConfig): string[] {
  return missing([
    ['PAY_APP_ID', pay.appId],
    ['PAY_NOTIFY_BASE_URL', pay.notifyBaseUrl],
  ]);
}

function unavailable(
  context: BuildContext,
  channel: PayChannelCode,
  names: readonly string[],
): UnavailablePayChannel {
  context.logger.warn({ channel, variables: names }, 'pay_channel_unavailable');
  return new UnavailablePayChannel(channel);
}

async function wechatChannel(context: BuildContext): Promise<PayChannel> {
  const { pay } = context;
  const { wechat } = pay;
  const names = [
    ...commonMissing(pay),
    ...missing([
      ['PAY_WECHAT_APPID', wechat.appId],
      ['PAY_WECHAT_MCHID', wechat.mchId],
      ['PAY_WECHAT_MERCHANT_SERIAL', wechat.merchantSerial],
      ['PAY_WECHAT_PRIVATE_KEY_FILE', wechat.privateKeyFile],
      ['PAY_WECHAT_APIV3_KEY_FILE', wechat.apiV3KeyFile],
      ['PAY_WECHAT_PUBLIC_KEY_FILE', wechat.publicKeyFile],
      ['PAY_WECHAT_PUBLIC_KEY_ID', wechat.publicKeyId],
      // BR-PAY-08 ②: outside prod only a test merchant.
      ['PAY_WECHAT_TEST_MERCHANT', wechat.testMerchant],
    ]),
  ];
  if (
    names.length > 0 ||
    pay.appId === null ||
    pay.notifyBaseUrl === null ||
    wechat.appId === null ||
    wechat.mchId === null ||
    wechat.merchantSerial === null ||
    wechat.privateKeyFile === null ||
    wechat.apiV3KeyFile === null ||
    wechat.publicKeyFile === null ||
    wechat.publicKeyId === null
  ) {
    return unavailable(context, 'wechat_pay', names);
  }
  const reader = new KeyReader();
  const merchantKey = await reader.read(
    'PAY_WECHAT_PRIVATE_KEY_FILE',
    wechat.privateKeyFile,
    privateKeyPem,
  );
  const v3Key = await reader.read('PAY_WECHAT_APIV3_KEY_FILE', wechat.apiV3KeyFile, apiV3Key);
  const publicKey = await reader.read(
    'PAY_WECHAT_PUBLIC_KEY_FILE',
    wechat.publicKeyFile,
    publicKeyPem,
  );
  if (merchantKey === null || v3Key === null || publicKey === null) {
    return unavailable(context, 'wechat_pay', reader.problems);
  }
  return new WechatPayChannel({
    config: {
      payAppId: pay.appId,
      appId: wechat.appId,
      mchId: wechat.mchId,
      merchantSerial: wechat.merchantSerial,
      publicKeyId: wechat.publicKeyId,
      notifyBaseUrl: pay.notifyBaseUrl,
    },
    keys: { privateKeyPem: merchantKey, apiV3Key: v3Key, publicKeyPem: publicKey },
    transport: context.transport,
    clock: context.clock,
    logger: context.logger,
  });
}

/** Certificate mode: the three files; the public key is the one inside the Alipay certificate. */
async function alipayCertMode(
  alipay: PayAlipayEnv,
  reader: KeyReader,
): Promise<{ readonly serials: AlipayCertSerials; readonly publicKey: string } | null> {
  const app = await reader.read('PAY_ALIPAY_APP_CERT_FILE', alipay.appCertFile ?? '', certSn);
  const platform = await reader.read(
    'PAY_ALIPAY_PUBLIC_CERT_FILE',
    alipay.publicCertFile ?? '',
    (text) => ({ sn: certSn(text), key: publicKeyFromCert(text) }),
  );
  const root = await reader.read(
    'PAY_ALIPAY_ROOT_CERT_FILE',
    alipay.rootCertFile ?? '',
    rootCertSn,
  );
  if (app === null || platform === null || root === null) return null;
  return {
    serials: { appCertSn: app, alipayRootCertSn: root, alipayCertSn: platform.sn },
    publicKey: platform.key,
  };
}

async function alipayChannel(context: BuildContext): Promise<PayChannel> {
  const { pay } = context;
  const { alipay } = pay;
  const certMode =
    alipay.appCertFile !== null || alipay.publicCertFile !== null || alipay.rootCertFile !== null;
  const { gateway } = alipay;
  const names = [
    ...commonMissing(pay),
    ...missing([
      ['PAY_ALIPAY_APPID', alipay.appId],
      ['PAY_ALIPAY_SELLER_ID', alipay.sellerId],
      ['PAY_ALIPAY_PRIVATE_KEY_FILE', alipay.privateKeyFile],
      ...(certMode
        ? ([
            ['PAY_ALIPAY_APP_CERT_FILE', alipay.appCertFile],
            ['PAY_ALIPAY_PUBLIC_CERT_FILE', alipay.publicCertFile],
            ['PAY_ALIPAY_ROOT_CERT_FILE', alipay.rootCertFile],
          ] as const)
        : ([['PAY_ALIPAY_PUBLIC_KEY_FILE', alipay.publicKeyFile]] as const)),
      // BR-PAY-08 ②: outside prod only a sandbox gateway.
      ['PAY_ALIPAY_GATEWAY', gateway !== null && isSandboxGateway(gateway) ? gateway : null],
    ]),
  ];
  if (
    names.length > 0 ||
    pay.appId === null ||
    pay.notifyBaseUrl === null ||
    alipay.appId === null ||
    alipay.sellerId === null ||
    alipay.privateKeyFile === null ||
    gateway === null
  ) {
    return unavailable(context, 'alipay', names);
  }
  const reader = new KeyReader();
  const appKey = await reader.read(
    'PAY_ALIPAY_PRIVATE_KEY_FILE',
    alipay.privateKeyFile,
    privateKeyPem,
  );
  const certificates = certMode ? await alipayCertMode(alipay, reader) : null;
  const publicKey = certMode
    ? (certificates?.publicKey ?? null)
    : await reader.read('PAY_ALIPAY_PUBLIC_KEY_FILE', alipay.publicKeyFile ?? '', publicKeyPem);
  if (appKey === null || publicKey === null) {
    return unavailable(context, 'alipay', reader.problems);
  }
  return new AlipayPayChannel({
    config: {
      payAppId: pay.appId,
      appId: alipay.appId,
      sellerId: alipay.sellerId,
      gateway,
      notifyBaseUrl: pay.notifyBaseUrl,
      certSerials: certificates?.serials ?? null,
    },
    keys: { privateKeyPem: appKey, alipayPublicKeyPem: publicKey },
    transport: context.transport,
    clock: context.clock,
    logger: context.logger,
  });
}

/** Reads one KMS secret and checks it; collects its logical name instead of throwing. */
class KmsKeyReader {
  readonly problems: string[] = [];
  readonly #kms: KmsAccess;

  constructor(kms: KmsAccess) {
    this.#kms = kms;
  }

  async read<T>(name: KmsSecretName, parse: (text: string) => T): Promise<T | null> {
    try {
      return parse(await this.#kms.readSecret(name, KEY_FILE_MAX_BYTES));
    } catch {
      this.problems.push(name);
      return null;
    }
  }
}

/** A secret is missing, unreadable or malformed: fail closed, never a fake channel (D10-554). */
function kmsUnavailable(
  context: BuildContext,
  channel: PayChannelCode,
  secrets: readonly string[],
): UnavailablePayChannel {
  context.logger.warn(
    { channel, reason: PAY_REASON_KMS_UNAVAILABLE, secrets },
    'pay_channel_unavailable',
  );
  return new UnavailablePayChannel(channel, PAY_REASON_KMS_UNAVAILABLE);
}

async function wechatChannelFromKms(context: BuildContext, kms: KmsAccess): Promise<PayChannel> {
  const { pay } = context;
  const { wechat } = pay;
  const names = [
    ...commonMissing(pay),
    ...missing([
      ['PAY_WECHAT_APPID', wechat.appId],
      ['PAY_WECHAT_MCHID', wechat.mchId],
      ['PAY_WECHAT_MERCHANT_SERIAL', wechat.merchantSerial],
      ['PAY_WECHAT_PUBLIC_KEY_ID', wechat.publicKeyId],
    ]),
  ];
  if (
    names.length > 0 ||
    pay.appId === null ||
    pay.notifyBaseUrl === null ||
    wechat.appId === null ||
    wechat.mchId === null ||
    wechat.merchantSerial === null ||
    wechat.publicKeyId === null
  ) {
    return unavailable(context, 'wechat_pay', names);
  }
  const { pay: secrets } = KMS_SECRETS;
  const reader = new KmsKeyReader(kms);
  const merchantKey = await reader.read(secrets.wechatMerchantPrivateKey, privateKeyPem);
  const v3Key = await reader.read(secrets.wechatApiV3Key, apiV3Key);
  const publicKey = await reader.read(secrets.wechatPlatformPublicKey, publicKeyPem);
  if (merchantKey === null || v3Key === null || publicKey === null) {
    return kmsUnavailable(context, 'wechat_pay', reader.problems);
  }
  return new WechatPayChannel({
    config: {
      payAppId: pay.appId,
      appId: wechat.appId,
      mchId: wechat.mchId,
      merchantSerial: wechat.merchantSerial,
      publicKeyId: wechat.publicKeyId,
      notifyBaseUrl: pay.notifyBaseUrl,
    },
    keys: { privateKeyPem: merchantKey, apiV3Key: v3Key, publicKeyPem: publicKey },
    transport: context.transport,
    clock: context.clock,
    logger: context.logger,
  });
}

async function alipayChannelFromKms(context: BuildContext, kms: KmsAccess): Promise<PayChannel> {
  const { pay } = context;
  const { alipay } = pay;
  const names = [
    ...commonMissing(pay),
    ...missing([
      ['PAY_ALIPAY_APPID', alipay.appId],
      ['PAY_ALIPAY_SELLER_ID', alipay.sellerId],
    ]),
  ];
  if (
    names.length > 0 ||
    pay.appId === null ||
    pay.notifyBaseUrl === null ||
    alipay.appId === null ||
    alipay.sellerId === null
  ) {
    return unavailable(context, 'alipay', names);
  }
  const { pay: secrets } = KMS_SECRETS;
  const reader = new KmsKeyReader(kms);
  const appKey = await reader.read(secrets.alipayAppPrivateKey, privateKeyPem);
  let serials: AlipayCertSerials | null = null;
  let publicKey: string | null;
  if (alipay.keyMode === 'cert') {
    const app = await reader.read(secrets.alipayAppCert, certSn);
    const platform = await reader.read(secrets.alipayPublicCert, (text) => ({
      sn: certSn(text),
      key: publicKeyFromCert(text),
    }));
    const root = await reader.read(secrets.alipayRootCert, rootCertSn);
    publicKey = platform?.key ?? null;
    if (app !== null && platform !== null && root !== null) {
      serials = { appCertSn: app, alipayRootCertSn: root, alipayCertSn: platform.sn };
    }
  } else {
    publicKey = await reader.read(secrets.alipayPublicKey, publicKeyPem);
  }
  if (appKey === null || publicKey === null || reader.problems.length > 0) {
    return kmsUnavailable(context, 'alipay', reader.problems);
  }
  return new AlipayPayChannel({
    config: {
      payAppId: pay.appId,
      appId: alipay.appId,
      sellerId: alipay.sellerId,
      gateway: ALIPAY_PRODUCTION_GATEWAY,
      notifyBaseUrl: pay.notifyBaseUrl,
      certSerials: serials,
    },
    keys: { privateKeyPem: appKey, alipayPublicKeyPem: publicKey },
    transport: context.transport,
    clock: context.clock,
    logger: context.logger,
  });
}

export async function createPayChannelSet(
  config: AppConfig,
  deps: PayChannelSetDeps,
): Promise<PayChannelSet> {
  const { appEnv } = config;
  const pay = config.payChannels ?? EMPTY;
  if (appEnv === 'local' || appEnv === 'test' || (appEnv !== 'prod' && pay.impl === 'fake')) {
    return new PayChannelSet([new FakePayChannel('wechat_pay'), new FakePayChannel('alipay')]);
  }
  if (appEnv === 'prod') {
    const kms = kmsAccessOf(config);
    if (kms === null) {
      return new PayChannelSet(
        (['wechat_pay', 'alipay'] as const).map((channel) => {
          deps.logger.warn(
            { channel, reason: PAY_REASON_KMS_UNAVAILABLE },
            'pay_channel_unavailable',
          );
          return new UnavailablePayChannel(channel, PAY_REASON_KMS_UNAVAILABLE);
        }),
      );
    }
    const context: BuildContext = {
      pay,
      transport: deps.transport ?? fetchPayTransport,
      clock: deps.clock,
      logger: deps.logger,
    };
    return new PayChannelSet([
      await wechatChannelFromKms(context, kms),
      await alipayChannelFromKms(context, kms),
    ]);
  }
  const context: BuildContext = {
    pay,
    transport: deps.transport ?? fetchPayTransport,
    clock: deps.clock,
    logger: deps.logger,
  };
  return new PayChannelSet([await wechatChannel(context), await alipayChannel(context)]);
}
