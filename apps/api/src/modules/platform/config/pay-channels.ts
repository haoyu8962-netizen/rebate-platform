// B2-15k: the environment of the real collection channels (task §9.8; BR-PAY-08; rule tests:
// test/spec/payment/channels/config.test.ts). The contract is
// loadConfig(env, entry): it fills AppConfig.payChannels from readPayChannelsConfig and merges its
// problems. Pure: looks only at the given object, reads no file, never echoes a value; the key
// files are read once at startup through ./startup-secret-file.ts by the payment module's factory.
// - loadConfig(env), without an entry, reads none of these (payChannels is null, a PAY_* written
//   wrong does not throw): tracing/boot.ts calls it so. bootstrap.ts and entry.ts pass the entry.
// - local / test: fake channels; the credential names go into PAY_CREDENTIAL_ENV_NAMES
//   (./credential-env.ts), so setting one refuses to start.
// - staging / prod: only the api, worker and admin entries read these variables; stream and payout
//   never do (BR-PAY-08 ①).
// - PAY_CHANNEL_IMPL accepts only `fake`, and prod refuses it. PAY_NOTIFY_BASE_URL must be https.
// - prod: the gateway is the documented official one; PAY_ALIPAY_GATEWAY set there refuses to start.
//   Ruling D10-554: the checks stand, but the payment module's factory opens no key file in prod
//   (keys only in KMS, BR-PAY-08 ②): B1-30a reads them from KMS; without KMS configured both channels
//   stay unavailable. PAY_ALIPAY_KEY_MODE says which Alipay secrets KMS holds.
// - not prod: WeChat Pay needs PAY_WECHAT_TEST_MERCHANT=1, Alipay needs PAY_ALIPAY_GATEWAY other
//   than the production gateway; otherwise that channel is unavailable (BR-PAY-08 ②).
import type { EntryName } from '../entries.ts';
import type { AppEnv } from './app-env.ts';

export interface PayWechatEnv {
  readonly appId: string | null;
  readonly mchId: string | null;
  readonly merchantSerial: string | null;
  readonly privateKeyFile: string | null;
  readonly apiV3KeyFile: string | null;
  readonly publicKeyFile: string | null;
  readonly publicKeyId: string | null;
  readonly testMerchant: boolean;
}

export interface PayAlipayEnv {
  readonly appId: string | null;
  readonly sellerId: string | null;
  readonly privateKeyFile: string | null;
  readonly publicKeyFile: string | null;
  readonly appCertFile: string | null;
  readonly publicCertFile: string | null;
  readonly rootCertFile: string | null;
  readonly gateway: string | null;
  /** B1-30a: prod only, which Alipay secrets KMS holds; default public_key. */
  readonly keyMode: 'public_key' | 'cert';
}

/** Names and paths only, never a key. Absent on the stream and payout entries. */
export interface PayChannelsConfig {
  readonly appId: string | null;
  readonly impl: 'fake' | null;
  readonly notifyBaseUrl: string | null;
  readonly wechat: PayWechatEnv;
  readonly alipay: PayAlipayEnv;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): string | null => {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
};

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:';
}

export function readPayChannelsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
  entry: EntryName,
): { readonly payChannels: PayChannelsConfig | null; readonly problems: readonly string[] } {
  // BR-PAY-08 ①: stream and payout never read these, whatever they hold.
  if (entry === 'stream' || entry === 'payout') return { payChannels: null, problems: [] };
  const problems: string[] = [];
  const impl = set(env, 'PAY_CHANNEL_IMPL');
  if (impl !== null && impl !== 'fake') {
    problems.push('PAY_CHANNEL_IMPL: only accepts fake');
  } else if (impl !== null && appEnv === 'prod') {
    problems.push(
      'PAY_CHANNEL_IMPL: must not be set when APP_ENV=prod (prod has no fake channels)',
    );
  }
  // local / test always run the fake channels and read nothing else; startupViolations refuses the
  // credential names there.
  if (appEnv === 'local' || appEnv === 'test') return { payChannels: null, problems };
  const notifyBaseUrl = set(env, 'PAY_NOTIFY_BASE_URL');
  if (notifyBaseUrl !== null && !isHttpsUrl(notifyBaseUrl)) {
    problems.push('PAY_NOTIFY_BASE_URL: must be an https address');
  }
  const gateway = set(env, 'PAY_ALIPAY_GATEWAY');
  if (gateway !== null && appEnv === 'prod') {
    problems.push(
      'PAY_ALIPAY_GATEWAY: must not be set when APP_ENV=prod (prod uses the official gateway)',
    );
  }
  const keyMode = set(env, 'PAY_ALIPAY_KEY_MODE');
  if (keyMode !== null && keyMode !== 'public_key' && keyMode !== 'cert') {
    problems.push('PAY_ALIPAY_KEY_MODE: must be public_key or cert');
  }
  return {
    payChannels: {
      appId: set(env, 'PAY_APP_ID'),
      impl: impl === 'fake' ? 'fake' : null,
      notifyBaseUrl,
      wechat: {
        appId: set(env, 'PAY_WECHAT_APPID'),
        mchId: set(env, 'PAY_WECHAT_MCHID'),
        merchantSerial: set(env, 'PAY_WECHAT_MERCHANT_SERIAL'),
        privateKeyFile: set(env, 'PAY_WECHAT_PRIVATE_KEY_FILE'),
        apiV3KeyFile: set(env, 'PAY_WECHAT_APIV3_KEY_FILE'),
        publicKeyFile: set(env, 'PAY_WECHAT_PUBLIC_KEY_FILE'),
        publicKeyId: set(env, 'PAY_WECHAT_PUBLIC_KEY_ID'),
        testMerchant: env['PAY_WECHAT_TEST_MERCHANT'] === '1',
      },
      alipay: {
        appId: set(env, 'PAY_ALIPAY_APPID'),
        sellerId: set(env, 'PAY_ALIPAY_SELLER_ID'),
        privateKeyFile: set(env, 'PAY_ALIPAY_PRIVATE_KEY_FILE'),
        publicKeyFile: set(env, 'PAY_ALIPAY_PUBLIC_KEY_FILE'),
        appCertFile: set(env, 'PAY_ALIPAY_APP_CERT_FILE'),
        publicCertFile: set(env, 'PAY_ALIPAY_PUBLIC_CERT_FILE'),
        rootCertFile: set(env, 'PAY_ALIPAY_ROOT_CERT_FILE'),
        gateway,
        keyMode: keyMode === 'cert' ? 'cert' : 'public_key',
      },
    },
    problems,
  };
}
