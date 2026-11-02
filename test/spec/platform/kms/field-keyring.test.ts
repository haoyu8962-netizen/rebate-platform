// B1-30a 字段 keyring 全链路（claude-independent，SPEC_REF deb521c2）：任务书第 9 节「接入」；规划/02 §12.6
// 「数据加密主密钥 | KMS | 通过信封加密间接使用」；config/keyring-startup.ts、keyring-prior-identity.ts。
// createWrappedKeyring + 文件 + openConfiguredFieldCrypto / openPriorIdentityFieldCrypto，SDK 打桩。
// 可选参数在骨架阶段还不存在，这里用局部类型调用。错误对象的形状用两组既有规则测试的检查函数。顶层 it。
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../../apps/api/src/modules/platform/config/app-env.ts';
import {
  openPriorIdentityFieldCrypto,
  type PriorIdentityKeyringConfig,
  type PriorIdentityKeyringErrorCode,
} from '../../../../apps/api/src/modules/platform/config/keyring-prior-identity.ts';
import {
  openConfiguredFieldCrypto,
  type KeyringStartupErrorCode,
} from '../../../../apps/api/src/modules/platform/config/keyring-startup.ts';
import type { KeyringConfig } from '../../../../apps/api/src/modules/platform/config/keyring.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  type FieldCrypto,
  type WrappedKeyring,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import type { KmsAccess } from '../../../../apps/api/src/modules/platform/kms/index.ts';
import { startupErrorProblems } from '../crypto/wiring-kit.ts';
import { priorErrorProblems } from '../prior-identity-keyring/kit.ts';
import { KMS, accessOf, makeDir, removeDir, settled, visible, type Settled } from './kit.ts';
import { SDK_MARKER, resetSdk, sdk } from './sdk-stub.ts';

vi.mock('../../../../apps/api/src/modules/platform/kms/sdk.ts', async () => {
  const stub = await import('./sdk-stub.ts');
  stub.sdk.moduleLoads += 1;
  return { createKmsSdkClient: stub.createKmsSdkClient };
});

type OpenMain = (
  appEnv: AppEnv,
  keyring: KeyringConfig,
  kms?: KmsAccess | null,
) => Promise<FieldCrypto>;
type OpenPrior = (
  appEnv: AppEnv,
  prior: PriorIdentityKeyringConfig | null,
  keyring: KeyringConfig | null,
  kms?: KmsAccess | null,
) => Promise<FieldCrypto>;

const openMain = openConfiguredFieldCrypto as unknown as OpenMain;
const openPrior = openPriorIdentityFieldCrypto as unknown as OpenPrior;

const CONTEXT = 'users.id_no';
const PRIOR_CONTEXT = 'prior_identity.id_no';
const SAMPLE = 'synthetic-field-value-b1-30a';

let dir: string;

beforeEach(() => {
  resetSdk();
  dir = makeDir('keyring');
});
afterEach(() => {
  removeDir(dir);
});

function fileOf(name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function keyringFile(name: string, document: WrappedKeyring | object): string {
  return fileOf(name, JSON.stringify(document));
}

function kmsKeyring(keyringPath: string): KeyringConfig {
  return { provider: 'kms', keyringFile: keyringPath };
}

function mainProblems(outcome: Settled<unknown>, code: KeyringStartupErrorCode): string[] {
  if (outcome.ok) return ['opened'];
  const problems = startupErrorProblems(outcome.error, code);
  if (visible(outcome.error).includes(SDK_MARKER)) problems.push('leaks the SDK text');
  return problems;
}

function priorProblems(outcome: Settled<unknown>, code: PriorIdentityKeyringErrorCode): string[] {
  if (outcome.ok) return ['opened'];
  const problems = priorErrorProblems(outcome.error, code);
  if (visible(outcome.error).includes(SDK_MARKER)) problems.push('leaks the SDK text');
  return problems;
}

it('[AC-B1-30a#30] 字段 keyring：createWrappedKeyring + openConfiguredFieldCrypto(prod, kms, access) 能加解密，换一个实例重开还解得开', async () => {
  const access = accessOf();
  const document = await createWrappedKeyring(access.keyProvider);
  expect(document.key_id).toBe(KMS.keyId);
  expect(document.data_keys[0]?.wrapped.startsWith('kms1.')).toBe(true);
  expect(document.blind_index_key.startsWith('kms1.')).toBe(true);
  const file = keyringFile('keyring.json', document);

  const crypto = await openMain('prod', kmsKeyring(file), access);
  const cipher = crypto.encrypt(SAMPLE, CONTEXT);
  expect(crypto.decrypt(cipher, CONTEXT)).toBe(SAMPLE);
  expect(crypto.currentKeyVersion).toBe(1);

  // 新进程：只有 KMS、keyring 文件和密文。数据密钥与盲索引密钥各解一次。
  sdk.decrypt.mockClear();
  const again = await openMain('prod', kmsKeyring(file), accessOf());
  expect(again.decrypt(cipher, CONTEXT)).toBe(SAMPLE);
  expect(again.blindIndex(SAMPLE, CONTEXT)).toBe(crypto.blindIndex(SAMPLE, CONTEXT));
  expect(sdk.decrypt).toHaveBeenCalledTimes(2);

  // staging 选 kms 且给了 access 也走 KMS（只有联盟是 prod 才走 KMS）。
  expect(
    (await openMain('staging', kmsKeyring(file), accessOf('staging'))).decrypt(cipher, CONTEXT),
  ).toBe(SAMPLE);
});

it('[AC-B1-30a#31] 字段 keyring 失败：KMS 不可达或密文不对 unwrap_failed；key_id 不符、形状不对、非 JSON、超大 keyring_invalid；读不到 keyring_unreadable；错误不带 SDK 原文', async () => {
  const access = accessOf();
  const document = await createWrappedKeyring(access.keyProvider);
  const file = keyringFile('keyring.json', document);
  const open = (path: string) => settled(() => openMain('prod', kmsKeyring(path), access));

  sdk.decrypt.mockRejectedValueOnce(new Error(SDK_MARKER));
  expect(mainProblems(await open(file), 'unwrap_failed')).toEqual([]);

  const localWrapped = { ...document, data_keys: [{ version: 1, wrapped: 'lk1.abcd' }] };
  expect(mainProblems(await open(keyringFile('lk.json', localWrapped)), 'unwrap_failed')).toEqual(
    [],
  );

  sdk.decrypt.mockClear();
  const otherKey = keyringFile('other-key.json', { ...document, key_id: 'another-key' });
  expect(mainProblems(await open(otherKey), 'keyring_invalid')).toEqual([]);
  const badShape = keyringFile('bad-shape.json', { ...document, current_version: 9 });
  expect(mainProblems(await open(badShape), 'keyring_invalid')).toEqual([]);
  expect(mainProblems(await open(fileOf('no-json.json', '{not json')), 'keyring_invalid')).toEqual(
    [],
  );
  const large = fileOf('large.json', Buffer.alloc(1_048_577, 0x20));
  expect(mainProblems(await open(large), 'keyring_invalid')).toEqual([]);
  // 形状不对就不去问 KMS。
  expect(sdk.decrypt).not.toHaveBeenCalled();

  rmSync(file);
  expect(mainProblems(await open(file), 'keyring_unreadable')).toEqual([]);
});

it('[AC-B1-30a#32] 字段 keyring 选择：没有 access 还是 kms_unavailable 且不读文件；prod 选 local 还是 local_in_cloud；staging 选 local 不碰 KMS', async () => {
  const access = accessOf();
  const file = keyringFile('keyring.json', await createWrappedKeyring(access.keyProvider));
  sdk.decrypt.mockClear();
  const missing = join(dir, 'does-not-exist.json');

  for (const kms of [undefined, null]) {
    const outcome = await settled(() => openMain('prod', kmsKeyring(missing), kms));
    expect(mainProblems(outcome, 'kms_unavailable')).toEqual([]);
  }
  const local: KeyringConfig = {
    provider: 'local',
    keyringFile: file,
    masterKeyFile: join(dir, 'master.hex'),
  };
  expect(
    mainProblems(await settled(() => openMain('prod', local, access)), 'local_in_cloud'),
  ).toEqual([]);
  expect(sdk.decrypt).not.toHaveBeenCalled();

  const master = randomBytes(32);
  const localFile = keyringFile(
    'local.json',
    await createWrappedKeyring(new LocalKeyProvider(master)),
  );
  fileOf('master.hex', `${master.toString('hex')}\n`);
  const opened = await openMain(
    'staging',
    { provider: 'local', keyringFile: localFile, masterKeyFile: join(dir, 'master.hex') },
    accessOf('staging'),
  );
  expect(opened.decrypt(opened.encrypt(SAMPLE, CONTEXT), CONTEXT)).toBe(SAMPLE);
  expect(sdk.decrypt).not.toHaveBeenCalled();
});

it('[AC-B1-30a#33] prior identity keyring：prod + kms + access 能加解密，数据密钥与主 keyring 各是各的', async () => {
  const access = accessOf();
  const mainFile = keyringFile('main.json', await createWrappedKeyring(access.keyProvider));
  const priorFile = keyringFile('prior.json', await createWrappedKeyring(access.keyProvider));
  const main = kmsKeyring(mainFile);

  const prior = await openPrior('prod', kmsKeyring(priorFile), main, access);
  const cipher = prior.encrypt(SAMPLE, PRIOR_CONTEXT);
  expect(prior.decrypt(cipher, PRIOR_CONTEXT)).toBe(SAMPLE);

  const opened = await openMain('prod', main, access);
  expect((await settled(() => opened.decrypt(cipher, PRIOR_CONTEXT))).ok).toBe(false);
});

it('[AC-B1-30a#34] prior identity 失败：unwrap_failed、keyring_invalid、keyring_unreadable 用它自己的错误码表；没有 access 还是 kms_unavailable 且不读文件；错误不带 SDK 原文', async () => {
  const access = accessOf();
  const document = await createWrappedKeyring(access.keyProvider);
  const file = keyringFile('prior.json', document);
  const open = (path: string) => settled(() => openPrior('prod', kmsKeyring(path), null, access));

  sdk.decrypt.mockRejectedValueOnce(new Error(SDK_MARKER));
  expect(priorProblems(await open(file), 'unwrap_failed')).toEqual([]);

  sdk.decrypt.mockClear();
  const otherKey = keyringFile('other-key.json', { ...document, key_id: 'another-key' });
  expect(priorProblems(await open(otherKey), 'keyring_invalid')).toEqual([]);
  expect(priorProblems(await open(fileOf('no-json.json', '{not json')), 'keyring_invalid')).toEqual(
    [],
  );
  const large = fileOf('large.json', Buffer.alloc(1_048_577, 0x20));
  expect(priorProblems(await open(large), 'keyring_invalid')).toEqual([]);
  expect(sdk.decrypt).not.toHaveBeenCalled();

  const missing = join(dir, 'does-not-exist.json');
  expect(priorProblems(await open(missing), 'keyring_unreadable')).toEqual([]);
  expect(
    priorProblems(
      await settled(() => openPrior('prod', kmsKeyring(missing), null)),
      'kms_unavailable',
    ),
  ).toEqual([]);
  expect(
    priorProblems(
      await settled(() => openPrior('prod', kmsKeyring(missing), null, null)),
      'kms_unavailable',
    ),
  ).toEqual([]);
  expect(
    priorProblems(await settled(() => openPrior('prod', null, null, access)), 'not_configured'),
  ).toEqual([]);
});
