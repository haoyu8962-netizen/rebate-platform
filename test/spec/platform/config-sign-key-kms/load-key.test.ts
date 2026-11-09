// B1-01zzt loadConfigSignKey 的 KMS 来源（claude-independent，SPEC_REF deaba4fb）：编排 D10-1155 ④、
// prod-wiring-gaps 第 23 项、规划/02 §12.6「配置签名私钥只 api 用、生产走 KMS」。
// KMS 一律是满足 KmsAccess 的替身（kit.ts fakeKms），密钥是测试内现生成的合成 P-256；文件只写 <repo>/.tmp。
// 调用口径：loadConfigSignKey(appEnv, <loadConfig 给的 configSignKey>, <KmsAccess | null>)。顶层 it。
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KMS_SECRETS, KmsError } from '../../../../apps/api/src/modules/platform/kms/index.ts';
import {
  CONFIG_KID,
  KMS_ENV,
  LOGICAL,
  cloudEnv,
  codeOf,
  expectSignsFor,
  fakeKms,
  fakeKmsWith,
  kmsSourcedKeyConfig,
  kmsText,
  loadKey,
  loadedConfig,
  makeDir,
  pemBody,
  refusalProblems,
  removeDir,
  settled,
  syntheticP256,
  writeKeyFile,
  type FakeKms,
} from './kit.ts';

/** 合成的 SDK 原文标记：不得出现在错误对象里。 */
const SDK_MARKER = 'sdk-raw-text-marker-b1-01zzt';

let dir: string;

beforeEach(() => {
  dir = makeDir('load-key');
});
afterEach(() => {
  removeDir(dir);
});

/** KMS 来源的正例：替身被读一次、读的是 config/sign-private-key、加载成功。 */
async function expectKmsLoads(appEnv: 'staging' | 'prod'): Promise<void> {
  const keyConfig = kmsSourcedKeyConfig(appEnv);
  const key = syntheticP256();
  const kms = fakeKmsWith(kmsText(key.pem));
  const outcome = await settled(() => loadKey(appEnv, keyConfig, kms.access));
  expect(outcome.ok ? 'loaded' : codeOf(outcome)).toBe('loaded');
  expect(kms.calls.map((call) => call.name)).toEqual([LOGICAL]);
}

function leaves(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [value];
  return Object.values(value).flatMap(leaves);
}

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#4] %s：来源 KMS 时从 KMS 读 config/sign-private-key 一次，kid 为 CONFIG_SIGN_KEY_ID，私钥能签、公钥能验同一签名',
  async (appEnv) => {
    const keyConfig = kmsSourcedKeyConfig(appEnv);
    const key = syntheticP256();
    const kms = fakeKmsWith(kmsText(key.pem));
    const outcome = await settled(() => loadKey(appEnv, keyConfig, kms.access));
    expect(outcome.ok ? 'loaded' : codeOf(outcome)).toBe('loaded');
    const loaded = (outcome as { readonly value: Awaited<ReturnType<typeof loadKey>> }).value;

    expect(kms.calls.map((call) => call.name)).toEqual([LOGICAL]);
    const [call] = kms.calls;
    // 上限由实现定，但得装得下一把 P-256 PKCS#8 PEM。
    expect(Number.isSafeInteger(call?.maxBytes)).toBe(true);
    expect(call?.maxBytes).toBeGreaterThanOrEqual(Buffer.byteLength(key.pem, 'utf8'));

    expect(loaded.kid).toBe(CONFIG_KID);
    expectSignsFor(loaded, key.publicKey);
    // 加载之后不再回头读 KMS。
    expect(kms.calls).toHaveLength(1);
  },
);

it('[AC-B1-01zzt#5] KMS_SECRETS 登记了配置签名私钥 config/sign-private-key', () => {
  expect(leaves(KMS_SECRETS)).toContain(LOGICAL);
});

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#6] %s：KMS 读失败（KmsError kms_read_failed，或带 SDK 原文的错误）→ ConfigSignKeyError 拒绝启动，不是 key_invalid，不带 SDK 原文、密钥内容与 cause',
  async (appEnv) => {
    const keyConfig = kmsSourcedKeyConfig(appEnv);
    const key = syntheticP256();
    const mustNotContain = [SDK_MARKER, ...pemBody(key.pem), '-----BEGIN'];
    for (const failure of [
      new KmsError('kms_read_failed'),
      new Error(`${SDK_MARKER}: ${key.pem}`),
    ]) {
      const kms = fakeKms(() => {
        throw failure;
      });
      const outcome = await settled(() => loadKey(appEnv, keyConfig, kms.access));
      expect(refusalProblems(outcome, mustNotContain), failure.message).toEqual([]);
      expect(['key_invalid', 'key_missing']).not.toContain(codeOf(outcome));
      expect(kms.calls.map((call) => call.name)).toEqual([LOGICAL]);
    }
  },
);

/** KMS 交回的不是一把未加密 PKCS#8 PEM P-256 私钥。 */
function invalidSecrets(): readonly (readonly [string, string])[] {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const p256 = syntheticP256();
  return [
    ['空串', ''],
    ['垃圾', `synthetic-garbage-${SDK_MARKER}`],
    ['RSA 私钥', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    ['P-384 私钥', p384.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()],
    [
      '加密 PEM',
      p256.privateKey
        .export({
          type: 'pkcs8',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase: 'synthetic-passphrase-b1-01zzt',
        })
        .toString(),
    ],
    ['只有公钥', p256.publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    ['SEC1 私钥', p256.privateKey.export({ type: 'sec1', format: 'pem' }).toString()],
  ];
}

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#7] %s：KMS 交回的不是 P-256 PKCS#8 PEM（空串、垃圾、RSA、P-384、加密 PEM、公钥、SEC1）或 KmsError secret_invalid → key_invalid，错误不回显内容',
  async (appEnv) => {
    const keyConfig = kmsSourcedKeyConfig(appEnv);
    for (const [label, secret] of invalidSecrets()) {
      const kms = fakeKmsWith(secret);
      const outcome = await settled(() => loadKey(appEnv, keyConfig, kms.access));
      const mustNotContain = [SDK_MARKER, ...pemBody(secret), '-----BEGIN'];
      expect(refusalProblems(outcome, mustNotContain), label).toEqual([]);
      expect(codeOf(outcome), label).toBe('key_invalid');
      expect(kms.calls).toHaveLength(1);
    }
    const invalid = fakeKms(() => {
      throw new KmsError('secret_invalid');
    });
    const outcome = await settled(() => loadKey(appEnv, keyConfig, invalid.access));
    expect(refusalProblems(outcome, [SDK_MARKER])).toEqual([]);
    expect(codeOf(outcome)).toBe('key_invalid');
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#8] %s：FILE / ID 一对时即使 KMS 已配置也读文件、不调 KMS；只配 KMS 没配签名钥变量时拒绝且不调 KMS',
  async (appEnv) => {
    // 正例先站住：同样的替身在 KMS 来源时会被读，下面的「零调用」才有意义。
    await expectKmsLoads(appEnv);

    const fileKey = syntheticP256();
    const kmsKey = syntheticP256();
    const file = writeKeyFile(dir, fileKey.pem);
    const config = loadedConfig({
      ...cloudEnv(appEnv),
      ...KMS_ENV,
      CONFIG_SIGN_KEY_FILE: file,
      CONFIG_SIGN_KEY_ID: 'file-kid',
    });
    expect(config.configSignKey).toStrictEqual({ file, kid: 'file-kid' });
    const kms: FakeKms = fakeKmsWith(kmsText(kmsKey.pem));
    const outcome = await settled(() => loadKey(appEnv, config.configSignKey ?? null, kms.access));
    expect(outcome.ok ? 'loaded' : codeOf(outcome)).toBe('loaded');
    const loaded = (outcome as { readonly value: Awaited<ReturnType<typeof loadKey>> }).value;
    expect(loaded.kid).toBe('file-kid');
    expectSignsFor(loaded, fileKey.publicKey);
    expect(kms.calls).toEqual([]);

    const bare = loadedConfig({ ...cloudEnv(appEnv), ...KMS_ENV });
    expect(bare.configSignKey ?? null).toBeNull();
    const untouched = fakeKmsWith(kmsText(kmsKey.pem));
    const refused = await settled(() => loadKey(appEnv, null, untouched.access));
    expect(refusalProblems(refused, pemBody(kmsKey.pem))).toEqual([]);
    expect(codeOf(refused)).toBe('key_missing');
    expect(String(refused.ok ? '' : refused.error)).toMatch(/CONFIG_SIGN_KEY/);
    expect(untouched.calls).toEqual([]);
  },
);

it('[AC-B1-01zzt#9] 回归：FILE / ID 一对照旧读文件（无 KMS）；local / test 未配是临时钥（kid ephemeral-）且不调 KMS；staging / prod 什么都没配拒绝', async () => {
  // 正例先站住：KMS 来源这条路存在，下面的回归都不许借道它。
  await expectKmsLoads('prod');

  const fileKey = syntheticP256();
  const file = writeKeyFile(dir, fileKey.pem);
  for (const appEnv of ['staging', 'prod'] as const) {
    const config = loadedConfig({
      ...cloudEnv(appEnv),
      CONFIG_SIGN_KEY_FILE: file,
      CONFIG_SIGN_KEY_ID: `${appEnv}-file-kid`,
    });
    const outcome = await settled(() => loadKey(appEnv, config.configSignKey ?? null, null));
    expect(outcome.ok ? 'loaded' : codeOf(outcome), appEnv).toBe('loaded');
    const loaded = (outcome as { readonly value: Awaited<ReturnType<typeof loadKey>> }).value;
    expect(loaded.kid).toBe(`${appEnv}-file-kid`);
    expectSignsFor(loaded, fileKey.publicKey);

    const refused = await settled(() => loadKey(appEnv, null, null));
    expect(refusalProblems(refused, [])).toEqual([]);
    expect(codeOf(refused)).toBe('key_missing');
    expect(String(refused.ok ? '' : refused.error)).toMatch(/CONFIG_SIGN_KEY/);
  }

  for (const appEnv of ['local', 'test'] as const) {
    const kms = fakeKmsWith(kmsText(syntheticP256().pem));
    const kids: string[] = [];
    for (const access of [null, kms.access]) {
      const outcome = await settled(() => loadKey(appEnv, null, access));
      expect(outcome.ok ? 'loaded' : codeOf(outcome), appEnv).toBe('loaded');
      const loaded = (outcome as { readonly value: Awaited<ReturnType<typeof loadKey>> }).value;
      expect(loaded.kid).toMatch(/^ephemeral-/);
      expectSignsFor(loaded, loaded.publicKey);
      kids.push(loaded.kid);
    }
    expect(new Set(kids).size).toBe(2);
    expect(kms.calls).toEqual([]);
  }
});
