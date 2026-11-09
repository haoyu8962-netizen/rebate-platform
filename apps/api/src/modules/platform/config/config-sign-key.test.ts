// Unit tests of ./config-sign-key.ts (B1-01zzt): synthetic keys made in the test, a stand-in KMS
// access, files only under <repo>/.tmp. No database, no network, no real key.
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KmsError, type KmsAccess, type KmsSecretName } from '../kms/index.ts';
import {
  ConfigSignKeyError,
  loadConfigSignKey,
  readConfigSignKeyConfig,
} from './config-sign-key.ts';

const KMS_ENV = {
  KMS_REGION_ID: 'cn-hangzhou',
  KMS_ENDPOINT: 'kms.cn-hangzhou.aliyuncs.com',
  KMS_KEY_ID: 'key-unit',
  KMS_RAM_ROLE: 'role-unit',
};

function p256Pem(): { pem: string; publicKey: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey,
  };
}

function standIn(answer: () => string): { access: KmsAccess; names: KmsSecretName[] } {
  const names: KmsSecretName[] = [];
  return {
    names,
    access: {
      keyProvider: {
        keyId: 'unit',
        wrapKey: () => Promise.reject(new Error('unused')),
        unwrapKey: () => Promise.reject(new Error('unused')),
      },
      readSecret: async (name) => {
        names.push(name);
        return answer();
      },
    },
  };
}

async function refusal(run: () => Promise<unknown>): Promise<ConfigSignKeyError> {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConfigSignKeyError);
  expect(error).not.toHaveProperty('cause');
  return error as ConfigSignKeyError;
}

let dir: string;
beforeEach(() => {
  const base = fileURLToPath(new URL('../../../../../../.tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'unit-config-sign-key-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('[AC-B1-01zzt-U#1] the ID alone with all KMS_* set is a KMS source; the pair stays {file, kid}', () => {
  expect(readConfigSignKeyConfig({ ...KMS_ENV, CONFIG_SIGN_KEY_ID: 'kid-1' })).toEqual({
    configSignKey: { source: 'kms', kid: 'kid-1' },
    problems: [],
  });
  expect(
    readConfigSignKeyConfig({
      ...KMS_ENV,
      CONFIG_SIGN_KEY_FILE: '/k.pem',
      CONFIG_SIGN_KEY_ID: 'k',
    }),
  ).toEqual({ configSignKey: { file: '/k.pem', kid: 'k' }, problems: [] });
  expect(readConfigSignKeyConfig({})).toEqual({ configSignKey: null, problems: [] });
});

it('[AC-B1-01zzt-U#2] the ID without full KMS, the FILE alone and a bad kid are refused by name only', () => {
  const together = ['CONFIG_SIGN_KEY_FILE, CONFIG_SIGN_KEY_ID: must be set together'];
  expect(readConfigSignKeyConfig({ CONFIG_SIGN_KEY_ID: 'kid-1' }).problems).toEqual(together);
  expect(
    readConfigSignKeyConfig({ KMS_KEY_ID: 'key-unit', CONFIG_SIGN_KEY_ID: 'kid-1' }).problems,
  ).toEqual(together);
  expect(
    readConfigSignKeyConfig({ ...KMS_ENV, CONFIG_SIGN_KEY_FILE: '/hidden.pem' }).problems,
  ).toEqual(together);
  const bad = readConfigSignKeyConfig({ ...KMS_ENV, CONFIG_SIGN_KEY_ID: 'bad kid' });
  expect(bad.configSignKey).toBeNull();
  expect(bad.problems).toEqual([
    'CONFIG_SIGN_KEY_ID: must be 1 to 64 characters of A-Z a-z 0-9 . _ ~ -',
  ]);
});

it('[AC-B1-01zzt-U#3] a KMS source reads config/sign-private-key once and keeps the configured kid', async () => {
  const key = p256Pem();
  const kms = standIn(() => key.pem.trimEnd());
  const loaded = await loadConfigSignKey('prod', { source: 'kms', kid: 'kid-1' }, kms.access);
  expect(kms.names).toEqual(['config/sign-private-key']);
  expect(loaded.kid).toBe('kid-1');
  const data = Buffer.from('unit');
  const signature = sign('sha256', data, loaded.privateKey);
  expect(verify('sha256', data, key.publicKey, signature)).toBe(true);
});

it('[AC-B1-01zzt-U#4] KMS read failures, bad secrets and a missing access are refused without the cause', async () => {
  const config = { source: 'kms', kid: 'kid-1' } as const;
  const failed = await refusal(() =>
    loadConfigSignKey(
      'staging',
      config,
      standIn(() => {
        throw new Error('raw sdk text');
      }).access,
    ),
  );
  expect(failed.code).toBe('key_kms_unavailable');
  expect(String(failed)).not.toContain('raw sdk text');
  const invalid = await refusal(() =>
    loadConfigSignKey(
      'staging',
      config,
      standIn(() => {
        throw new KmsError('secret_invalid');
      }).access,
    ),
  );
  expect(invalid.code).toBe('key_invalid');
  const garbage = await refusal(() =>
    loadConfigSignKey('prod', config, standIn(() => 'not a key').access),
  );
  expect(garbage.code).toBe('key_invalid');
  for (const [appEnv, access] of [
    ['prod', null],
    ['prod', undefined],
    ['local', standIn(() => p256Pem().pem).access],
  ] as const) {
    const missing = await refusal(() => loadConfigSignKey(appEnv, config, access));
    expect(missing.code).toBe('key_kms_unavailable');
  }
});

it('[AC-B1-01zzt-U#5] a file source never calls KMS; no config in staging is key_missing', async () => {
  const key = p256Pem();
  const file = join(dir, 'unit.pem');
  writeFileSync(file, key.pem, { mode: 0o600 });
  const kms = standIn(() => p256Pem().pem);
  const loaded = await loadConfigSignKey('staging', { file, kid: 'file-kid' }, kms.access);
  expect(loaded.kid).toBe('file-kid');
  expect(loaded.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
    key.publicKey.export({ type: 'spki', format: 'der' }),
  );
  const missing = await refusal(() => loadConfigSignKey('staging', null, kms.access));
  expect(missing.code).toBe('key_missing');
  expect(kms.names).toEqual([]);
});
