import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPriorIdentityFieldCrypto } from '../config/keyring-prior-identity.ts';
import { openFieldCrypto } from '../crypto/index.ts';
import { kmsAccessOf, type KmsAccess } from './index.ts';
import { writeKmsKeyring } from './keyring-init.ts';

// A reversible stub: enough to wrap and unwrap, nothing of the real SDK.
vi.mock('./sdk.ts', () => ({
  createKmsSdkClient: async () => ({
    encrypt: async (request: { plaintext: string }) => ({
      ciphertextBlob: Buffer.from(request.plaintext).toString('base64'),
    }),
    decrypt: async (request: { ciphertextBlob: string }) => ({
      plaintext: Buffer.from(request.ciphertextBlob, 'base64').toString('utf8'),
    }),
  }),
}));

let directory: string;
let kms: KmsAccess;
beforeEach(() => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(join(root, 'kms-keyring-'));
  kms = kmsAccessOf({
    appEnv: 'prod',
    kms: {
      regionId: 'cn-hangzhou',
      endpoint: 'kms-vpc.cn-hangzhou.aliyuncs.com',
      keyId: 'key-unit',
      ramRole: 'role-unit',
    },
  })!;
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it('[AC-B1-30a-U#2] writeKmsKeyring writes 0600 keys that open with the provider, and never overwrites', async () => {
  const output = join(directory, 'keyring.json');
  await writeKmsKeyring(kms, output);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  const document = JSON.parse(readFileSync(output, 'utf8'));
  expect(document.key_id).toBe('key-unit');
  const crypto = await openFieldCrypto(document, kms.keyProvider);
  expect(crypto.decrypt(crypto.encrypt('value', 'users.phone'), 'users.phone')).toBe('value');

  const before = readFileSync(output, 'utf8');
  await expect(writeKmsKeyring(kms, output)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(readFileSync(output, 'utf8')).toBe(before);
});

it('[AC-B1-30a-U#3] the prior identity keyring may not share a data key with a KMS main keyring', async () => {
  const main = join(directory, 'main.json');
  const other = join(directory, 'other.json');
  await writeKmsKeyring(kms, main);
  await writeKmsKeyring(kms, other);
  const keyring = { provider: 'kms', keyringFile: main } as const;

  const independent = await openPriorIdentityFieldCrypto(
    'prod',
    { provider: 'kms', keyringFile: other },
    keyring,
    kms,
  );
  expect(independent.currentKeyVersion).toBe(1);

  const copy = join(directory, 'copy.json');
  writeFileSync(copy, readFileSync(main));
  await expect(
    openPriorIdentityFieldCrypto('prod', { provider: 'kms', keyringFile: copy }, keyring, kms),
  ).rejects.toMatchObject({ code: 'shares_main_data_key' });
});
