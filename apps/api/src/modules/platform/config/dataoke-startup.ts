// Opening the 大淘客 credentials of the Taobao order source (B1-04e, D10-486 ①; same discipline as
// ./taobao-startup.ts of B1-04k). Called by the union module's async startup factory, once, while
// Nest creates the providers, only when taobao is live and AppConfig.dataoke is set: the staging
// appSecret file is read here through ./startup-secret-file.ts (one trailing newline removed) and
// the credentials are handed out from memory afterwards (changing or deleting the file later
// changes nothing). Errors carry a fixed text per code, never the path, the file content, the app
// key or the underlying error (no `cause`); nothing is logged here; no process.env.
//
// - local / test: refused, code `live_in_local`, without reading the file.
// - prod: refused until the KMS source exists, code `kms_unavailable`, without reading the file.
//   TODO(规划/11 §4.5): KMS 取用 — blocked on 云 KMS 选型
// - staging: both values required (`credentials_missing` otherwise); the file must be a regular,
//   non-empty UTF-8 file (`secret_unreadable` / `secret_invalid`).
import type { AppEnv } from './app-env.ts';
import type { DataokeAppConfig } from './dataoke.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';
import { KMS_SECRETS, readStartupKmsSecret, type KmsAccess } from '../kms/index.ts';

/** Largest appSecret file accepted. */
export const DATAOKE_SECRET_FILE_MAX_BYTES = 4096;

export type DataokeStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export const DATAOKE_STARTUP_MESSAGES: Readonly<Record<DataokeStartupErrorCode, string>> =
  Object.freeze({
    live_in_local:
      'the 大淘客 order source must not start when APP_ENV is local or test (fake adapters only)',
    kms_unavailable:
      'the 大淘客 order source needs the KMS credential source when APP_ENV is prod, which is not available yet',
    credentials_missing:
      'the 大淘客 order source needs DATAOKE_APP_KEY and DATAOKE_APP_SECRET_FILE when APP_ENV is staging',
    secret_unreadable: 'the 大淘客 app secret file cannot be read',
    secret_invalid: 'the 大淘客 app secret file is empty or not a valid secret',
  });

/** Every startup refusal of the 大淘客 order source; nothing else attached (no cause, no values). */
export class DataokeStartupError extends Error {
  readonly code: DataokeStartupErrorCode;

  constructor(code: DataokeStartupErrorCode) {
    super(DATAOKE_STARTUP_MESSAGES[code]);
    this.name = 'DataokeStartupError';
    this.code = code;
  }
}

export interface DataokeAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Decides whether the 大淘客 order source may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 */
export async function openDataokeCredentials(
  appEnv: AppEnv,
  dataoke: DataokeAppConfig | null | undefined,
  kms?: KmsAccess | null,
): Promise<() => Promise<DataokeAppCredentials>> {
  if (appEnv === 'local' || appEnv === 'test') throw new DataokeStartupError('live_in_local');
  if (appEnv !== 'staging') {
    if (kms === null || kms === undefined) throw new DataokeStartupError('kms_unavailable');
    if (dataoke === null || dataoke === undefined || dataoke.appKey === '') {
      throw new DataokeStartupError('credentials_missing');
    }
    const appSecret = await readStartupKmsSecret(
      kms,
      KMS_SECRETS.union.dataokeAppSecret,
      DATAOKE_SECRET_FILE_MAX_BYTES,
      (code) => new DataokeStartupError(code),
    );
    const credentials: DataokeAppCredentials = Object.freeze({ appKey: dataoke.appKey, appSecret });
    return async () => credentials;
  }
  if (
    dataoke === null ||
    dataoke === undefined ||
    dataoke.appKey === '' ||
    dataoke.secretFile === ''
  ) {
    throw new DataokeStartupError('credentials_missing');
  }
  const appSecret = await readStartupSecretFile(
    dataoke.secretFile,
    DATAOKE_SECRET_FILE_MAX_BYTES,
    (reason) => new DataokeStartupError(reason),
  );
  const credentials: DataokeAppCredentials = Object.freeze({ appKey: dataoke.appKey, appSecret });
  return async () => credentials;
}
