// Starting the real Pinduoduo adapter (B1-04t; approvals #28 ②; 规划/11 §8; 规划/02 §12.6).
// Called by the union module's async startup factory, once, while Nest creates the providers:
// the staging client_secret file is read here and the credentials are handed out from memory
// afterwards (changing or deleting the file later changes nothing). Same discipline as
// ./keyring-startup.ts: errors carry a fixed text per code, never the path, the file content,
// the client id or the underlying error (no `cause`); nothing is logged here; no process.env.
import type { AppEnv } from './app-env.ts';
import type { PddClientConfig } from './pdd.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';
import { KMS_SECRETS, readStartupKmsSecret, type KmsAccess } from '../kms/index.ts';

/** Largest client_secret file accepted. */
export const PDD_SECRET_FILE_MAX_BYTES = 4096;

export type PddStartupErrorCode =
  | 'live_in_local'
  | 'kms_unavailable'
  | 'credentials_missing'
  | 'secret_unreadable'
  | 'secret_invalid';

export const PDD_STARTUP_MESSAGES: Readonly<Record<PddStartupErrorCode, string>> = Object.freeze({
  live_in_local:
    'the Pinduoduo live adapter must not start when APP_ENV is local or test (fake adapters only)',
  kms_unavailable:
    'the Pinduoduo live adapter needs the KMS credential source when APP_ENV is prod, which is not available yet',
  credentials_missing:
    'the Pinduoduo live adapter needs PDD_CLIENT_ID and PDD_CLIENT_SECRET_FILE when APP_ENV is staging',
  secret_unreadable: 'the Pinduoduo client secret file cannot be read',
  secret_invalid: 'the Pinduoduo client secret file is empty or not a valid secret',
});

/** Every startup refusal of the pdd live adapter; nothing else attached (no cause, no values). */
export class PddStartupError extends Error {
  readonly code: PddStartupErrorCode;

  constructor(code: PddStartupErrorCode) {
    super(PDD_STARTUP_MESSAGES[code]);
    this.name = 'PddStartupError';
    this.code = code;
  }
}

export interface PddClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Decides whether the pdd live adapter may start in `appEnv` and, in staging, reads the secret
 * file once. Resolves with a provider that hands out the credentials read now.
 * - local / test: refused (规划/11 §8; probing runs only in the owner's terminal scripts).
 * - prod: KMS only (B1-30a); without KMS configured refused, without reading anything.
 * - staging: both variables required; the file must be a regular, non-empty UTF-8 file.
 */
export async function openPddCredentials(
  appEnv: AppEnv,
  pdd: PddClientConfig | null | undefined,
  kms?: KmsAccess | null,
): Promise<() => Promise<PddClientCredentials>> {
  if (appEnv === 'local' || appEnv === 'test') throw new PddStartupError('live_in_local');
  if (appEnv !== 'staging') {
    if (kms === null || kms === undefined) throw new PddStartupError('kms_unavailable');
    if (pdd === null || pdd === undefined || pdd.clientId === '') {
      throw new PddStartupError('credentials_missing');
    }
    const clientSecret = await readStartupKmsSecret(
      kms,
      KMS_SECRETS.union.pddClientSecret,
      PDD_SECRET_FILE_MAX_BYTES,
      (code) => new PddStartupError(code),
    );
    const credentials: PddClientCredentials = Object.freeze({
      clientId: pdd.clientId,
      clientSecret,
    });
    return async () => credentials;
  }
  if (pdd === null || pdd === undefined || pdd.clientId === '' || pdd.secretFile === '') {
    throw new PddStartupError('credentials_missing');
  }
  const clientSecret = await readStartupSecretFile(
    pdd.secretFile,
    PDD_SECRET_FILE_MAX_BYTES,
    (reason) => new PddStartupError(reason),
  );
  const credentials: PddClientCredentials = Object.freeze({
    clientId: pdd.clientId,
    clientSecret,
  });
  return async () => credentials;
}
