// Implementer unit tests of B1-02zza's configuration (the rule tests are under
// test/spec/identity/staging-test-phone): loadConfig keeps the two variables in AppConfig, and the
// code file is read only as a regular file (a FIFO or a directory is refused, never waited on).
// Synthetic numbers and codes only.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { openStagingTestPhones } from './staging-test-phones.ts';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const PHONES = ['19900000001', '19900000002'];

const STAGING = {
  APP_ENV: 'staging',
  FIELD_KEY_PROVIDER: 'kms',
  FIELD_KEYRING_FILE: '/srv/couli/keyring.json',
  PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
  PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/prior-identity-keyring.json',
  DATABASE_URL: 'postgres://couli_app@127.0.0.1:54329/couli',
  REDIS_URL: 'redis://127.0.0.1:63790',
};

it('[AC-B1-02zza#u8] loadConfig keeps STAGING_TEST_PHONES and STAGING_TEST_SMS_CODE_FILE in AppConfig on staging, and nothing when unset', () => {
  const config = loadConfig({
    ...STAGING,
    STAGING_TEST_PHONES: PHONES.join(','),
    STAGING_TEST_SMS_CODE_FILE: '/run/couli-staging-test/sms-code',
  });
  expect(config.stagingTestPhones).toEqual({
    phones: PHONES,
    codeFile: '/run/couli-staging-test/sms-code',
  });
  expect(loadConfig(STAGING).stagingTestPhones ?? null).toBeNull();
  expect(() =>
    loadConfig({
      ...STAGING,
      STAGING_TEST_PHONES: PHONES.join(','),
      STAGING_TEST_SMS_CODE_FILE: 'relative/sms-code',
    }),
  ).toThrow(/STAGING_TEST_SMS_CODE_FILE: must be an absolute path/);
});

it('[AC-B1-02zza#u9] the code file must be a regular file: a FIFO and a directory are refused without waiting or echoing the path', async () => {
  const parent = join(root, '.tmp/b1-02zza-staging-test-phones');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    const valid = join(directory, 'code');
    await writeFile(valid, '864213\r\n', 'utf8');
    await expect(openStagingTestPhones({ phones: PHONES, codeFile: valid })).resolves.toEqual({
      phones: PHONES,
      code: '864213',
    });
    const fifo = join(directory, 'fifo');
    execFileSync('mkfifo', [fifo]);
    for (const codeFile of [fifo, directory]) {
      const error = await openStagingTestPhones({ phones: PHONES, codeFile }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('STAGING_TEST_SMS_CODE_FILE');
      expect(String(error)).toContain('regular file');
      expect(String(error)).not.toContain(directory);
    }
    await writeFile(valid, 'x'.repeat(65), 'utf8');
    await expect(openStagingTestPhones({ phones: PHONES, codeFile: valid })).rejects.toThrow(
      /exactly 6 ASCII digits/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
