// B1-30a keyProvider（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「适配器」；Encrypt 的明文与
// Decrypt 的返回都是 base64，EncryptionContext 两边必须相同：docs-mirror/aliyun-kms/pages/encrypt.txt、
// decrypt.txt。桩是可逆变换，context 不一致解不开（sdk-stub.ts）。失败一律抛，crypto/index.ts 会转成
// key_provider_failed，这里只看抛不抛。顶层 it。
import { randomBytes } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { KeyProvider } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { KMS, accessOf, settled } from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

const CONTEXT = { couli_key_id: KMS.keyId };

function provider(): KeyProvider {
  return accessOf().keyProvider;
}

beforeEach(() => {
  resetSdk();
});

it('[AC-B1-30a#20] 往返：keyId 是 KMS_KEY_ID；wrapKey 传 base64 明文与 context，返回 kms1.<blob>；unwrapKey 用同一 context 解回原字节', async () => {
  const keys = provider();
  expect(keys.keyId).toBe(KMS.keyId);
  const plain = randomBytes(32);

  const wrapped = await keys.wrapKey(plain);
  expect(wrapped.startsWith('kms1.')).toBe(true);
  const blob = wrapped.slice('kms1.'.length);
  expect(blob).not.toBe('');
  expect(sdk.encrypt.mock.calls.map(([request]) => request)).toEqual([
    { keyId: KMS.keyId, plaintext: plain.toString('base64'), encryptionContext: CONTEXT },
  ]);

  const unwrapped = await keys.unwrapKey(wrapped);
  expect(unwrapped).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(unwrapped).equals(plain)).toBe(true);
  expect(sdk.decrypt.mock.calls.map(([request]) => request)).toEqual([
    { ciphertextBlob: blob, encryptionContext: CONTEXT },
  ]);
  expect(sdk.created).toEqual([KMS]);
});

it.each([
  ['空串', ''],
  ['没有前缀', 'blob'],
  ['只有前缀，后面为空', 'kms1.'],
  ['本地密钥格式', 'lk1.abcd'],
  ['前缀大小写不符', 'KMS1.abcd'],
  ['前缀没有点', 'kms1abcd'],
])('[AC-B1-30a#21] unwrapKey 的文本不合格（%s）：抛错，不调 SDK', async (_name, wrapped) => {
  const keys = provider();
  const outcome = await settled(() => keys.unwrapKey(wrapped));
  expect(outcome.ok).toBe(false);
  expect(sdk.decrypt).not.toHaveBeenCalled();
});

it.each([
  ['空串', { plaintext: '' }],
  ['缺 plaintext', {}],
  ['非 base64 字符', { plaintext: '***' }],
  ['缺填充', { plaintext: 'YWJ' }],
  ['中间有空格', { plaintext: 'YW Jj' }],
  ['末尾有换行', { plaintext: 'YWJj\n' }],
  ['base64url 字母表', { plaintext: 'YW-_' }],
  ['只有填充', { plaintext: '====' }],
])('[AC-B1-30a#22] Decrypt 的明文不合格（%s）：抛错，不返回残缺的字节', async (_name, answer) => {
  const keys = provider();
  const wrapped = await keys.wrapKey(randomBytes(32));
  sdk.decrypt.mockResolvedValueOnce(answer);
  const outcome = await settled(() => keys.unwrapKey(wrapped));
  expect(outcome.ok).toBe(false);
  expect(sdk.decrypt).toHaveBeenCalledTimes(1);
});

it.each([
  ['空串', { ciphertextBlob: '' }],
  ['缺 ciphertextBlob', {}],
])(
  '[AC-B1-30a#23] Encrypt 的密文为空（%s）：wrapKey 抛错，不返回只有前缀的文本',
  async (_name, answer) => {
    const keys = provider();
    sdk.encrypt.mockResolvedValueOnce(answer);
    const outcome = await settled(() => keys.wrapKey(randomBytes(32)));
    expect(outcome.ok).toBe(false);
    expect(sdk.encrypt).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-30a#24] SDK 抛错：wrapKey、unwrapKey 都抛；context 不一致（别的主密钥写的）解不开', async () => {
  const keys = provider();
  const wrapped = await keys.wrapKey(randomBytes(32));

  sdk.encrypt.mockRejectedValueOnce(new Error(SDK_MARKER));
  expect((await settled(() => keys.wrapKey(randomBytes(32)))).ok).toBe(false);
  sdk.decrypt.mockRejectedValueOnce(new Error(SDK_MARKER));
  expect((await settled(() => keys.unwrapKey(wrapped))).ok).toBe(false);

  // 桩按 context 校验：这份密文是用别的 couli_key_id 写的。
  const foreign = Buffer.from(
    JSON.stringify({ plaintext: 'YWJj', context: { couli_key_id: 'another-key' } }),
    'utf8',
  ).toString('base64');
  expect((await settled(() => keys.unwrapKey(`kms1.${foreign}`))).ok).toBe(false);
  // 同一实例之后还能用。
  expect((await settled(() => keys.unwrapKey(wrapped))).ok).toBe(true);
});

it('[AC-B1-30a#25] wrapKey、unwrapKey 单次调用超过 10 秒都抛错；10 秒之内不判失败', async () => {
  const keys = provider();
  // 先用真定时器走一次：动态 import 和建客户端不能占假定时器的时间。
  const wrapped = await keys.wrapKey(randomBytes(32));
  sdk.encrypt.mockImplementationOnce(() => new Promise(() => undefined));
  sdk.decrypt.mockImplementationOnce(() => new Promise(() => undefined));

  vi.useFakeTimers();
  try {
    const finished = { wrap: false, unwrap: false };
    const wrapping = settled(() => keys.wrapKey(randomBytes(32))).then((outcome) => {
      finished.wrap = true;
      return outcome;
    });
    const unwrapping = settled(() => keys.unwrapKey(wrapped)).then((outcome) => {
      finished.unwrap = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(finished).toEqual({ wrap: false, unwrap: false });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(finished).toEqual({ wrap: true, unwrap: true });
    expect((await wrapping).ok).toBe(false);
    expect((await unwrapping).ok).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
