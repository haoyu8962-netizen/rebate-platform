// B1-30a 收款两渠道（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「接入」；08 BR-PAY-08 ①②；
// 规划/02 §12.6；payment/AGENTS.md 第 6 条。编排 04:12 核定：读不到或格式不对时该渠道不可用
// （kms_unavailable），不回退假通道，进程照常启动。密钥在 payment/channels/kit.ts 里运行时现生成。
// SDK 打桩，渠道走内存 transport，不联网。顶层 it。
import { expect, it, beforeEach, vi } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import { FakePayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/fake-pay-channel.ts';
import {
  AlipayPayChannel,
  UnavailablePayChannel,
  WechatPayChannel,
} from '../../../../apps/api/src/modules/payment/infra/channels/index.ts';
import type { KmsSecretName } from '../../../../apps/api/src/modules/platform/kms/index.ts';
import {
  ALIPAY_APP,
  ALIPAY_APPID,
  ALIPAY_ORDER,
  ALIPAY_PLATFORM,
  APIV3_KEY,
  MCHID,
  MERCHANT,
  MERCHANT_SERIAL,
  OFFICIAL_GATEWAY,
  ORDER,
  OTHER,
  OUT,
  PAY_APP_ID,
  PUBLIC_KEY_ID,
  QUERY_NODE,
  SANDBOX_GATEWAY,
  SELLER_ID,
  WECHAT_API,
  WECHAT_PLATFORM,
  WX_APPID,
  aliAnswer,
  aliParams,
  aliTrade,
  baseEnv,
  channelSetOf,
  commonEnv,
  expectAliSigned,
  expectedSn,
  loadFor,
  okOf,
  selfSignedCert,
  stagingEnv,
  warnLines,
  withKeyDir,
  wxAnswer,
  wxTrade,
  type CertAttribute,
  type Route,
} from '../../payment/channels/kit.ts';
import { KMS_ENV, secretNameOf, secretsRead, setSecret, text } from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

const WECHAT_SECRETS: readonly (readonly [KmsSecretName, string])[] = [
  ['pay/wechat/merchant-private-key', MERCHANT.privateKey],
  ['pay/wechat/apiv3-key', APIV3_KEY],
  ['pay/wechat/platform-public-key', WECHAT_PLATFORM.publicKey],
];
const ALIPAY_SECRETS: readonly (readonly [KmsSecretName, string])[] = [
  ['pay/alipay/app-private-key', ALIPAY_APP.privateKey],
  ['pay/alipay/public-key', ALIPAY_PLATFORM.publicKey],
];

const ROOT_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'O', value: 'Test Root' },
  { name: 'CN', value: 'test-root' },
];
const APP_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'CN', value: 'test-app' },
];
const ALIPAY_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'CN', value: 'test-alipay' },
];
const APP_SERIAL = 11n;
const ALIPAY_SERIAL = 2n ** 70n + 5n;
const ROOT_SERIALS = [21n, 22n] as const;
const APP_SN = expectedSn(APP_ATTRIBUTES, APP_SERIAL);
const ALIPAY_SN = expectedSn(ALIPAY_ATTRIBUTES, ALIPAY_SERIAL);
const ROOT_SN = ROOT_SERIALS.map((serial) => expectedSn(ROOT_ATTRIBUTES, serial)).join('_');
const CERT_SECRETS: readonly (readonly [KmsSecretName, string])[] = [
  ['pay/alipay/app-private-key', ALIPAY_APP.privateKey],
  ['pay/alipay/app-cert', selfSignedCert(APP_ATTRIBUTES, APP_SERIAL, ALIPAY_APP)],
  ['pay/alipay/public-cert', selfSignedCert(ALIPAY_ATTRIBUTES, ALIPAY_SERIAL, ALIPAY_PLATFORM)],
  [
    'pay/alipay/root-cert',
    ROOT_SERIALS.map((serial) => selfSignedCert(ROOT_ATTRIBUTES, serial, OTHER)).join(''),
  ],
];

const IDENTITY_VALUES = [
  PAY_APP_ID,
  WX_APPID,
  MCHID,
  MERCHANT_SERIAL,
  PUBLIC_KEY_ID,
  ALIPAY_APPID,
  SELLER_ID,
];

/** 日志里不许有的东西：密钥内容、SDK 原文。 */
const SECRET_TEXTS = [
  'PRIVATE KEY',
  'PUBLIC KEY',
  'CERTIFICATE',
  APIV3_KEY,
  SDK_MARKER,
  'not-a-valid-secret',
];

beforeEach(() => {
  resetSdk();
});

/** prod、配齐 KMS 与非密钥变量；没有任何 *_FILE、PAY_WECHAT_TEST_MERCHANT、PAY_ALIPAY_GATEWAY。 */
function kmsEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...baseEnv('prod'),
    ...commonEnv(),
    ...KMS_ENV,
    PAY_WECHAT_APPID: WX_APPID,
    PAY_WECHAT_MCHID: MCHID,
    PAY_WECHAT_MERCHANT_SERIAL: MERCHANT_SERIAL,
    PAY_WECHAT_PUBLIC_KEY_ID: PUBLIC_KEY_ID,
    PAY_ALIPAY_APPID: ALIPAY_APPID,
    PAY_ALIPAY_SELLER_ID: SELLER_ID,
    ...extra,
  };
}

function withoutVariables(env: Record<string, string>, ...names: string[]): Record<string, string> {
  const copy = { ...env };
  for (const name of names) delete copy[name];
  return copy;
}

function setSecrets(secrets: readonly (readonly [KmsSecretName, string])[]): void {
  for (const [logical, value] of secrets) setSecret(logical, text(value));
}

function setPublicKeyModeSecrets(): void {
  setSecrets(WECHAT_SECRETS);
  setSecrets(ALIPAY_SECRETS);
}

function sortedNames(secrets: readonly (readonly [KmsSecretName, string])[]): string[] {
  return secrets.map(([logical]) => secretNameOf(logical)).toSorted();
}

const ANSWER_QUERIES: Route = (request) =>
  request.url.startsWith(WECHAT_API) ? wxAnswer(200, wxTrade()) : aliAnswer(QUERY_NODE, aliTrade());

/** warn 行解析成对象，按 channel 字段筛。 */
function warnsOf(logs: readonly string[], channel: PayChannelCode): Record<string, unknown>[] {
  return warnLines(logs)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['channel'] === channel);
}

function expectNoSecretIn(logs: readonly string[]): void {
  const all = logs.join('\n');
  for (const value of SECRET_TEXTS) expect(all).not.toContain(value);
}

/** pino 自带的字段；除此之外只许有 channel、reason、secrets（任务书「warn 字段只有」）。 */
const LOG_BASE = new Set(['level', 'time', 'entry', 'env', 'pid', 'msg', 'module']);

function expectKmsUnavailableWarn(
  logs: readonly string[],
  channel: PayChannelCode,
  logical: KmsSecretName,
): void {
  const warns = warnsOf(logs, channel);
  expect(warns).toHaveLength(1);
  const [warn] = warns;
  expect(warn?.['reason']).toBe('kms_unavailable');
  expect(warn?.['secrets']).toEqual([logical]);
  expect(
    Object.keys(warn ?? {})
      .filter((key) => !LOG_BASE.has(key))
      .toSorted(),
  ).toEqual(['channel', 'reason', 'secrets']);
  expectNoSecretIn(logs);
}

const KMS_UNAVAILABLE = { kind: 'unknown', reason: 'kms_unavailable' };
const UNCONFIGURED = { kind: 'unknown', reason: 'channel_unconfigured' };

it.each(['api', 'worker', 'admin'] as const)(
  '[AC-B1-30a#50] %s 入口 prod + KMS 全齐：两渠道是真实类，用读到的密钥验签，支付宝走官方网关；没有 warn；密钥启动时读一次',
  async (entry) => {
    setPublicKeyModeSecrets();
    const { set, calls, logs } = await channelSetOf(loadFor(kmsEnv(), entry), ANSWER_QUERIES);
    const wechat = set.of('wechat_pay');
    const alipay = set.of('alipay');
    expect(wechat).toBeInstanceOf(WechatPayChannel);
    expect(alipay).toBeInstanceOf(AlipayPayChannel);
    expect(secretsRead().toSorted()).toEqual(sortedNames([...WECHAT_SECRETS, ...ALIPAY_SECRETS]));

    // 应答是用微信支付公钥、支付宝公钥那一对的私钥签的：密钥读错这里就是 unknown。
    okOf(await wechat.query(OUT));
    okOf(await alipay.query(OUT));
    expect(calls[0]?.url.startsWith(`${WECHAT_API}/`)).toBe(true);
    expect(calls[1]?.url.startsWith(OFFICIAL_GATEWAY)).toBe(true);
    expectAliSigned(aliParams(calls[1]!));

    expect(warnLines(logs)).toEqual([]);
    expectNoSecretIn(logs);
    expect(sdk.getSecretValue).toHaveBeenCalledTimes(5);
  },
);

it('[AC-B1-30a#51] prod 不看 *_FILE：指向不存在的路径也不读文件、也不缺；显式 public_key 与默认相同', async () => {
  setPublicKeyModeSecrets();
  const env = kmsEnv({
    PAY_WECHAT_PRIVATE_KEY_FILE: '/nonexistent/wechat-private.pem',
    PAY_WECHAT_APIV3_KEY_FILE: '/nonexistent/wechat-apiv3.key',
    PAY_WECHAT_PUBLIC_KEY_FILE: '/nonexistent/wechat-public.pem',
    PAY_ALIPAY_PRIVATE_KEY_FILE: '/nonexistent/alipay-private.pem',
    PAY_ALIPAY_PUBLIC_KEY_FILE: '/nonexistent/alipay-public.pem',
    // 证书文件变量也不决定 prod 的模式：只有 PAY_ALIPAY_KEY_MODE 决定。
    PAY_ALIPAY_APP_CERT_FILE: '/nonexistent/app.crt',
    PAY_ALIPAY_KEY_MODE: 'public_key',
  });
  const { set, logs } = await channelSetOf(loadFor(env, 'api'));
  expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
  expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
  expect(secretsRead().toSorted()).toEqual(sortedNames([...WECHAT_SECRETS, ...ALIPAY_SECRETS]));
  expect(logs.join('\n')).not.toContain('/nonexistent');
});

const WECHAT_VARIABLES = [
  'PAY_WECHAT_APPID',
  'PAY_WECHAT_MCHID',
  'PAY_WECHAT_MERCHANT_SERIAL',
  'PAY_WECHAT_PUBLIC_KEY_ID',
];
const ALIPAY_VARIABLES = ['PAY_ALIPAY_APPID', 'PAY_ALIPAY_SELLER_ID'];

it.each(WECHAT_VARIABLES)(
  '[AC-B1-30a#52] prod + KMS 缺 %s：微信 channel_unconfigured，warn 只列变量名，不读微信的密钥；支付宝不受影响',
  async (name) => {
    setPublicKeyModeSecrets();
    const { set, logs } = await channelSetOf(loadFor(withoutVariables(kmsEnv(), name), 'api'));
    expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
    expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
    expect(await set.of('wechat_pay').createOrder(ORDER)).toEqual(UNCONFIGURED);
    const warns = warnsOf(logs, 'wechat_pay');
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain(name);
    for (const value of IDENTITY_VALUES) expect(JSON.stringify(warns[0])).not.toContain(value);
    expect(secretsRead().filter((secret) => secret.includes('/pay/wechat/'))).toEqual([]);
    expectNoSecretIn(logs);
  },
);

it.each(ALIPAY_VARIABLES)(
  '[AC-B1-30a#53] prod + KMS 缺 %s：支付宝 channel_unconfigured，warn 只列变量名，不读支付宝的密钥；微信不受影响',
  async (name) => {
    setPublicKeyModeSecrets();
    const { set, logs } = await channelSetOf(loadFor(withoutVariables(kmsEnv(), name), 'api'));
    expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
    expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
    expect(await set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(UNCONFIGURED);
    const warns = warnsOf(logs, 'alipay');
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns[0])).toContain(name);
    for (const value of IDENTITY_VALUES) expect(JSON.stringify(warns[0])).not.toContain(value);
    expect(secretsRead().filter((secret) => secret.includes('/pay/alipay/'))).toEqual([]);
    expectNoSecretIn(logs);
  },
);

it.each(['PAY_APP_ID', 'PAY_NOTIFY_BASE_URL'])(
  '[AC-B1-30a#54] prod + KMS 缺 %s：两渠道都 channel_unconfigured，不抛异常，不读密钥',
  async (name) => {
    // 正例：同一份密钥配齐时两渠道都是真实类。
    setPublicKeyModeSecrets();
    const good = await channelSetOf(loadFor(kmsEnv(), 'api'));
    expect(good.set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);

    resetSdk();
    setPublicKeyModeSecrets();
    const { set } = await channelSetOf(loadFor(withoutVariables(kmsEnv(), name), 'api'));
    expect(await set.of('wechat_pay').createOrder(ORDER)).toEqual(UNCONFIGURED);
    expect(await set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(UNCONFIGURED);
    expect(sdk.getSecretValue).not.toHaveBeenCalled();
  },
);

function otherChannel(channel: PayChannelCode): PayChannelCode {
  return channel === 'wechat_pay' ? 'alipay' : 'wechat_pay';
}

const REAL_CLASS = { wechat_pay: WechatPayChannel, alipay: AlipayPayChannel } as const;
const ORDER_OF = { wechat_pay: ORDER, alipay: ALIPAY_ORDER } as const;

const PUBLIC_MODE_SECRETS: readonly (readonly [PayChannelCode, KmsSecretName])[] = [
  ['wechat_pay', 'pay/wechat/merchant-private-key'],
  ['wechat_pay', 'pay/wechat/apiv3-key'],
  ['wechat_pay', 'pay/wechat/platform-public-key'],
  ['alipay', 'pay/alipay/app-private-key'],
  ['alipay', 'pay/alipay/public-key'],
];

it.each(PUBLIC_MODE_SECRETS)(
  '[AC-B1-30a#55] %s 的 %s 读不到（SDK 抛错）：该渠道 kms_unavailable，另一渠道是真实类，warn 只有 channel、reason、逻辑名，进程照常',
  async (channel, logical) => {
    setPublicKeyModeSecrets();
    sdk.secrets.delete(secretNameOf(logical));
    const { set, logs } = await channelSetOf(loadFor(kmsEnv(), 'api'));
    expect(set.of(otherChannel(channel))).toBeInstanceOf(REAL_CLASS[otherChannel(channel)]);
    const broken = set.of(channel);
    expect(broken).toBeInstanceOf(UnavailablePayChannel);
    expect(broken).not.toBeInstanceOf(FakePayChannel);
    expect(await broken.createOrder(ORDER_OF[channel])).toEqual(KMS_UNAVAILABLE);
    expect((await broken.verifyNotification({ headers: {}, body: '' })).kind).toBe('rejected');
    expectKmsUnavailableWarn(logs, channel, logical);
  },
);

const BAD_VALUES: readonly (readonly [string, PayChannelCode, KmsSecretName, string])[] = [
  ['商户私钥不是 PEM', 'wechat_pay', 'pay/wechat/merchant-private-key', 'not-a-valid-secret'],
  ['APIv3 密钥不是 32 字节', 'wechat_pay', 'pay/wechat/apiv3-key', 'not-a-valid-secret'],
  ['微信支付公钥不是 PEM', 'wechat_pay', 'pay/wechat/platform-public-key', 'not-a-valid-secret'],
  ['应用私钥不是 PEM', 'alipay', 'pay/alipay/app-private-key', 'not-a-valid-secret'],
  ['支付宝公钥不是 PEM', 'alipay', 'pay/alipay/public-key', 'not-a-valid-secret'],
  // createPublicKey 能从私钥导出公钥：把私钥放进公钥位必须被拒。
  ['微信支付公钥位放了私钥', 'wechat_pay', 'pay/wechat/platform-public-key', OTHER.privateKey],
  ['支付宝公钥位放了私钥', 'alipay', 'pay/alipay/public-key', OTHER.privateKey],
];

it.each(BAD_VALUES)(
  '[AC-B1-30a#56] %s：该渠道 kms_unavailable，另一渠道不受影响，warn 不含值',
  async (_name, channel, logical, value) => {
    setPublicKeyModeSecrets();
    setSecret(logical, text(value));
    const { set, logs } = await channelSetOf(loadFor(kmsEnv(), 'api'));
    expect(set.of(otherChannel(channel))).toBeInstanceOf(REAL_CLASS[otherChannel(channel)]);
    expect(set.of(channel)).toBeInstanceOf(UnavailablePayChannel);
    expect(await set.of(channel).createOrder(ORDER_OF[channel])).toEqual(KMS_UNAVAILABLE);
    expectKmsUnavailableWarn(logs, channel, logical);
  },
);

it('[AC-B1-30a#57] secret 是 binary 类型：该渠道 kms_unavailable（上线清单要求建 text）', async () => {
  setPublicKeyModeSecrets();
  setSecret('pay/alipay/public-key', {
    secretData: ALIPAY_PLATFORM.publicKey,
    secretDataType: 'binary',
  });
  const { set, logs } = await channelSetOf(loadFor(kmsEnv(), 'api'));
  expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
  expect(await set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(KMS_UNAVAILABLE);
  expectKmsUnavailableWarn(logs, 'alipay', 'pay/alipay/public-key');
});

it('[AC-B1-30a#58] PAY_ALIPAY_KEY_MODE=cert：读私钥和三个证书、不读公钥 secret；请求带证书 SN，验签用证书里的公钥，走官方网关', async () => {
  setSecrets(WECHAT_SECRETS);
  setSecrets(CERT_SECRETS);
  const { set, calls, logs } = await channelSetOf(
    loadFor(kmsEnv({ PAY_ALIPAY_KEY_MODE: 'cert' }), 'api'),
    () => aliAnswer(QUERY_NODE, aliTrade(), { certSn: ALIPAY_SN }),
  );
  const alipay = set.of('alipay');
  expect(alipay).toBeInstanceOf(AlipayPayChannel);
  expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
  expect(secretsRead().toSorted()).toEqual(sortedNames([...WECHAT_SECRETS, ...CERT_SECRETS]));
  expect(secretsRead()).not.toContain(secretNameOf('pay/alipay/public-key'));

  okOf(await alipay.query(OUT));
  expect(calls[0]?.url.startsWith(OFFICIAL_GATEWAY)).toBe(true);
  const params = aliParams(calls[0]!);
  expect(params.get('app_cert_sn')).toBe(APP_SN);
  expect(params.get('alipay_root_cert_sn')).toBe(ROOT_SN);
  expectAliSigned(params);
  expect(warnLines(logs)).toEqual([]);
  expectNoSecretIn(logs);
});

const CERT_LOGICAL = CERT_SECRETS.map(([logical]) => logical);

it.each(CERT_LOGICAL)(
  '[AC-B1-30a#59] cert 模式 %s 读不到或内容不对：支付宝 kms_unavailable，微信不受影响，warn 不含值',
  async (logical) => {
    setSecrets(WECHAT_SECRETS);
    setSecrets(CERT_SECRETS);
    sdk.secrets.delete(secretNameOf(logical));
    const missing = await channelSetOf(loadFor(kmsEnv({ PAY_ALIPAY_KEY_MODE: 'cert' }), 'api'));
    expect(missing.set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
    expect(await missing.set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(KMS_UNAVAILABLE);
    expectKmsUnavailableWarn(missing.logs, 'alipay', logical);

    setSecret(logical, text('not-a-valid-secret'));
    const bad = await channelSetOf(loadFor(kmsEnv({ PAY_ALIPAY_KEY_MODE: 'cert' }), 'api'));
    expect(bad.set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
    expect(await bad.set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(KMS_UNAVAILABLE);
    expectKmsUnavailableWarn(bad.logs, 'alipay', logical);
  },
);

it('[AC-B1-30a#60] cert 模式不要公钥 secret：只配了公钥模式的 secret 时支付宝不可用，不退回公钥模式', async () => {
  setPublicKeyModeSecrets();
  const { set } = await channelSetOf(loadFor(kmsEnv({ PAY_ALIPAY_KEY_MODE: 'cert' }), 'api'));
  expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
  expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
  expect(await set.of('alipay').createOrder(ALIPAY_ORDER)).toEqual(KMS_UNAVAILABLE);
});

it.each(['stream', 'payout'] as const)(
  '[AC-B1-30a#61] %s 入口（BR-PAY-08 ①）：同一份环境也不调 readSecret、不建客户端，两渠道都不可用',
  async (entry) => {
    setPublicKeyModeSecrets();
    // 正例：同一份环境在 api 入口上真的读到了。
    const api = await channelSetOf(loadFor(kmsEnv(), 'api'));
    expect(api.set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);

    resetSdk();
    setPublicKeyModeSecrets();
    const { set } = await channelSetOf(loadFor(kmsEnv(), entry));
    expect(set.of('wechat_pay')).toBeInstanceOf(UnavailablePayChannel);
    expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
    expect(sdk.created).toEqual([]);
    expect(sdk.getSecretValue).not.toHaveBeenCalled();
  },
);

it('[AC-B1-30a#62] staging 配了 KMS：还按文件变量走沙箱网关，不调 SDK；PAY_ALIPAY_KEY_MODE 只 prod 用', async () => {
  // prod 的正例先站住。
  setPublicKeyModeSecrets();
  const prod = await channelSetOf(loadFor(kmsEnv(), 'api'));
  expect(prod.set.of('alipay')).toBeInstanceOf(AlipayPayChannel);

  resetSdk();
  await withKeyDir(async (dir) => {
    const env = { ...stagingEnv(dir), ...KMS_ENV, PAY_ALIPAY_KEY_MODE: 'cert' };
    const { set, calls } = await channelSetOf(loadFor(env, 'api'), ANSWER_QUERIES);
    expect(set.of('wechat_pay')).toBeInstanceOf(WechatPayChannel);
    expect(set.of('alipay')).toBeInstanceOf(AlipayPayChannel);
    okOf(await set.of('alipay').query(OUT));
    expect(calls[0]?.url.startsWith(SANDBOX_GATEWAY)).toBe(true);
    expect(sdk.created).toEqual([]);
    expect(sdk.getSecretValue).not.toHaveBeenCalled();
  });
});
