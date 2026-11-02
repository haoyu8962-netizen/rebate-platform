// Starting the real Taobao adapter (B1-04k; same discipline as ./pdd-startup.ts of B1-04t;
// approvals #28 ②; 规划/11 §8; 规划/02 §12.6). Called by the union module's async startup factory,
// once, while Nest creates the providers: the staging app_secret file is read here and the
// credentials are handed out from memory afterwards (changing or deleting the file later changes
// nothing). Errors carry a fixed text per code, never the path, the file content, the app key or
// the underlying error (no `cause`); nothing is logged here; no process.env.
import type { AppEnv } from './app-env.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';
import { KMS_SECRETS, readStartupKmsSecret, type KmsAccess } from '../kms/index.ts';
import type { TaobaoAppConfig } from './taobao.ts';

/** Largest app_secret file accepted. */
export const TAOBAO_SECRET_FILE_MAX_BYTES = 4096;

export type TaobaoStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export const TAOBAO_STARTUP_MESSAGES: Readonly<Record<TaobaoStartupErrorCode, string>> =
  Object.freeze({
    live_in_local:
      'the Taobao live adapter must not start when APP_ENV is local or test (fake adapters only)',
    kms_unavailable:
      'the Taobao live adapter needs the KMS credential source when APP_ENV is prod, which is not available yet',
    credentials_missing:
      'the Taobao live adapter needs TAOBAO_APP_KEY and TAOBAO_APP_SECRET_FILE when APP_ENV is staging',
    secret_unreadable: 'the Taobao app secret file cannot be read',
    secret_invalid: 'the Taobao app secret file is empty or not a valid secret',
  });

/** Every startup refusal of the taobao live adapter; nothing else attached (no cause, no values). */
export class TaobaoStartupError extends Error {
  readonly code: TaobaoStartupErrorCode;

  constructor(code: TaobaoStartupErrorCode) {
    super(TAOBAO_STARTUP_MESSAGES[code]);
    this.name = 'TaobaoStartupError';
    this.code = code;
  }
}

export interface TaobaoAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Decides whether the taobao live adapter may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 * - local / test: refused (规划/11 §8; probing runs only in the owner's terminal scripts).
 * - prod: KMS only (B1-30a); without KMS configured refused, without reading anything.
 * - staging: both variables required (the union module does not call this when neither is set);
 *   the file must be a regular, non-empty UTF-8 file.
 */
export async function openTaobaoCredentials(
  appEnv: AppEnv,
  taobao: TaobaoAppConfig | null | undefined,
  kms?: KmsAccess | null,
): Promise<() => Promise<TaobaoAppCredentials>> {
  if (appEnv === 'local' || appEnv === 'test') throw new TaobaoStartupError('live_in_local');
  if (appEnv !== 'staging') {
    if (kms === null || kms === undefined) throw new TaobaoStartupError('kms_unavailable');
    if (taobao === null || taobao === undefined || taobao.appKey === '') {
      throw new TaobaoStartupError('credentials_missing');
    }
    const appSecret = await readStartupKmsSecret(
      kms,
      KMS_SECRETS.union.taobaoAppSecret,
      TAOBAO_SECRET_FILE_MAX_BYTES,
      (code) => new TaobaoStartupError(code),
    );
    const credentials: TaobaoAppCredentials = Object.freeze({ appKey: taobao.appKey, appSecret });
    return async () => credentials;
  }
  if (taobao === null || taobao === undefined || taobao.appKey === '' || taobao.secretFile === '') {
    throw new TaobaoStartupError('credentials_missing');
  }
  const appSecret = await readStartupSecretFile(
    taobao.secretFile,
    TAOBAO_SECRET_FILE_MAX_BYTES,
    (reason) => new TaobaoStartupError(reason),
  );
  const credentials: TaobaoAppCredentials = Object.freeze({ appKey: taobao.appKey, appSecret });
  return async () => credentials;
}
