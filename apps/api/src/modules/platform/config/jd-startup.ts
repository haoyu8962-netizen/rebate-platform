// Starting the real Jingdong adapter (B1-04ze; same discipline as ./taobao-startup.ts of B1-04k;
// approvals #28 ②; 规划/11 §8; 规划/02 §12.6). Called by the union module's async startup factory,
// once, while Nest creates the providers: the staging app_secret file is read here and the
// credentials are handed out from memory afterwards (changing or deleting the file later changes
// nothing). Errors carry a fixed text per code, never the path, the file content, the app key or
// the underlying error (no `cause`); nothing is logged here; no process.env.
import type { AppEnv } from './app-env.ts';
import type { JdAppConfig } from './jd.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';
import { KMS_SECRETS, readStartupKmsSecret, type KmsAccess } from '../kms/index.ts';

/** Largest app_secret file accepted. */
export const JD_SECRET_FILE_MAX_BYTES = 4096;

export type JdStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export const JD_STARTUP_MESSAGES: Readonly<Record<JdStartupErrorCode, string>> = Object.freeze({
  live_in_local:
    'the Jingdong live adapter must not start when APP_ENV is local or test (fake adapters only)',
  kms_unavailable:
    'the Jingdong live adapter needs the KMS credential source when APP_ENV is prod, which is not available yet',
  credentials_missing:
    'the Jingdong live adapter needs JD_APP_KEY and JD_APP_SECRET_FILE when APP_ENV is staging',
  secret_unreadable: 'the Jingdong app secret file cannot be read',
  secret_invalid: 'the Jingdong app secret file is empty or not a valid secret',
});

/** Every startup refusal of the jd live adapter; nothing else attached (no cause, no values). */
export class JdStartupError extends Error {
  readonly code: JdStartupErrorCode;

  constructor(code: JdStartupErrorCode) {
    super(JD_STARTUP_MESSAGES[code]);
    this.name = 'JdStartupError';
    this.code = code;
  }
}

export interface JdAppCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Decides whether the jd live adapter may start in `appEnv` and, in staging, reads the secret file
 * once. Resolves with a provider that hands out the credentials read now.
 * - local / test: refused (规划/11 §8; probing runs only in the owner's terminal scripts).
 * - prod: KMS only (B1-30a); without KMS configured refused, without reading anything.
 *   TODO(规划/11 §4.5): 真连 KMS 验证 — blocked on 负责人开通 KMS（B1-30a 只打桩）
 * - staging: both variables required (the union module does not call this when neither is set);
 *   the file must be a regular, non-empty UTF-8 file.
 */
export async function openJdCredentials(
  appEnv: AppEnv,
  jd: JdAppConfig | null | undefined,
  kms?: KmsAccess | null,
): Promise<() => Promise<JdAppCredentials>> {
  if (appEnv === 'local' || appEnv === 'test') throw new JdStartupError('live_in_local');
  if (appEnv !== 'staging') {
    if (kms === null || kms === undefined) throw new JdStartupError('kms_unavailable');
    if (jd === null || jd === undefined || jd.appKey === '') {
      throw new JdStartupError('credentials_missing');
    }
    const appSecret = await readStartupKmsSecret(
      kms,
      KMS_SECRETS.union.jdAppSecret,
      JD_SECRET_FILE_MAX_BYTES,
      (code) => new JdStartupError(code),
    );
    const credentials: JdAppCredentials = Object.freeze({ appKey: jd.appKey, appSecret });
    return async () => credentials;
  }
  if (jd === null || jd === undefined || jd.appKey === '' || jd.secretFile === '') {
    throw new JdStartupError('credentials_missing');
  }
  const appSecret = await readStartupSecretFile(
    jd.secretFile,
    JD_SECRET_FILE_MAX_BYTES,
    (reason) => new JdStartupError(reason),
  );
  const credentials: JdAppCredentials = Object.freeze({ appKey: jd.appKey, appSecret });
  return async () => credentials;
}
