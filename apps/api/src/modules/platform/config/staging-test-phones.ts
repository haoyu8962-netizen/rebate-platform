// Staging test phone numbers with a fixed SMS code (B1-02zza, FU-STAGING-TEST-PHONE; approvals #48;
// orchestrator ruling D10-611). Only APP_ENV=staging honours them; every other environment is hard
// off. The numbers and the code come from the node, never from the repository.
//
// readStagingTestPhoneConfig (pure, loadConfig's part; never echoes a value):
//   - STAGING_TEST_PHONES: comma-separated normalised mainland numbers (^1[3-9][0-9]{9}$), 1 to 10
//     items, no empty item, no duplicate;
//   - STAGING_TEST_SMS_CODE_FILE: absolute path of the node file that holds the fixed code;
//   - unset or empty string: null, no problem, in every environment;
//   - local / test / prod: either one set → a problem (refused at startup);
//   - staging: both or neither; a list that breaks the rules above → a problem. The file itself is
//     not opened here.
// openStagingTestPhones (the startup factory): reads the code file once through
// readStartupSecretFile (regular file only — a FIFO, a directory or a device is refused —, at most
// CODE_FILE_MAX_BYTES, read buffers zeroed, one trailing newline removed), then requires exactly 6
// ASCII digits. Failures name STAGING_TEST_SMS_CODE_FILE and a reason, never the path, the content
// or the code.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports.
import { posix } from 'node:path';
import type { AppEnv } from './app-env.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';

export const STAGING_TEST_PHONES_ENV = 'STAGING_TEST_PHONES';
export const STAGING_TEST_SMS_CODE_FILE_ENV = 'STAGING_TEST_SMS_CODE_FILE';
/** Most numbers the list may hold (D10-611). */
export const STAGING_TEST_PHONES_MAX = 10;
/** A 6-digit code plus a `\r\n` fits; anything larger is not a code file. */
const CODE_FILE_MAX_BYTES = 64;
const PHONE_FORMAT = /^1[3-9][0-9]{9}$/;
const CODE_FORMAT = /^[0-9]{6}$/;

/** What loadConfig keeps: the numbers and the path of the code file (never the code). */
export interface StagingTestPhoneConfig {
  /** Normalised 11-digit numbers, in the order given, at most 10, no duplicate. */
  readonly phones: readonly string[];
  /** Path of the node file holding the fixed 6-digit code. */
  readonly codeFile: string;
}

export interface StagingTestPhoneConfigResult {
  readonly stagingTestPhones: StagingTestPhoneConfig | null;
  readonly problems: readonly string[];
}

/** The runtime form the SMS code service gets (staging only): the numbers and the fixed code. */
export interface StagingTestPhones {
  readonly phones: readonly string[];
  readonly code: string;
}

function listProblem(items: readonly string[]): string | null {
  if (items.some((item) => item === '')) return 'must not contain an empty item';
  if (items.length > STAGING_TEST_PHONES_MAX) {
    return `must list at most ${String(STAGING_TEST_PHONES_MAX)} numbers`;
  }
  if (items.some((item) => !PHONE_FORMAT.test(item))) {
    return 'every item must be a normalised 11-digit mainland mobile number';
  }
  if (new Set(items).size !== items.length) return 'must not list a number twice';
  return null;
}

export function readStagingTestPhoneConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): StagingTestPhoneConfigResult {
  const phones = env[STAGING_TEST_PHONES_ENV] ?? '';
  const codeFile = env[STAGING_TEST_SMS_CODE_FILE_ENV] ?? '';
  if (phones === '' && codeFile === '') return { stagingTestPhones: null, problems: [] };
  if (appEnv !== 'staging') {
    const problems: string[] = [];
    for (const [name, value] of [
      [STAGING_TEST_PHONES_ENV, phones],
      [STAGING_TEST_SMS_CODE_FILE_ENV, codeFile],
    ] as const) {
      if (value !== '') {
        problems.push(
          `${name}: must only be set when APP_ENV=staging (test phones are hard off elsewhere)`,
        );
      }
    }
    return { stagingTestPhones: null, problems };
  }
  if (phones === '') {
    return {
      stagingTestPhones: null,
      problems: [
        `${STAGING_TEST_PHONES_ENV}: must be set together with ${STAGING_TEST_SMS_CODE_FILE_ENV}`,
      ],
    };
  }
  if (codeFile === '') {
    return {
      stagingTestPhones: null,
      problems: [
        `${STAGING_TEST_SMS_CODE_FILE_ENV}: must be set together with ${STAGING_TEST_PHONES_ENV}`,
      ],
    };
  }
  const problems: string[] = [];
  const items = phones.split(',');
  const problem = listProblem(items);
  if (problem !== null) problems.push(`${STAGING_TEST_PHONES_ENV}: ${problem}`);
  if (!posix.isAbsolute(codeFile)) {
    problems.push(`${STAGING_TEST_SMS_CODE_FILE_ENV}: must be an absolute path`);
  }
  if (problems.length > 0) return { stagingTestPhones: null, problems };
  return {
    stagingTestPhones: Object.freeze({ phones: Object.freeze([...items]), codeFile }),
    problems: [],
  };
}

function codeFileError(reason: string): Error {
  return new Error(`${STAGING_TEST_SMS_CODE_FILE_ENV}: ${reason}`);
}

export async function openStagingTestPhones(
  config: StagingTestPhoneConfig,
): Promise<StagingTestPhones> {
  const text = await readStartupSecretFile(config.codeFile, CODE_FILE_MAX_BYTES, (reason) =>
    codeFileError(
      reason === 'secret_unreadable'
        ? 'the code file cannot be read as a regular file'
        : 'the code file must hold exactly 6 ASCII digits',
    ),
  );
  if (!CODE_FORMAT.test(text)) {
    throw codeFileError('the code file must hold exactly 6 ASCII digits');
  }
  return Object.freeze({ phones: Object.freeze([...config.phones]), code: text });
}
