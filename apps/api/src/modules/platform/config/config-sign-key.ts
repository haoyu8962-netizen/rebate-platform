// The configuration signing key of the api entry (F1-02zzzb; D10-610; 规划/02 §12.6: 配置签名私钥只
// api 用、生产走 KMS): signs /v1/config's bridge_origins whitelist (ES256). Separate from the JWT
// signing key.
//
// Where the key comes from (B1-01zzt):
// - CONFIG_SIGN_KEY_FILE / CONFIG_SIGN_KEY_ID together: the file (an explicit mount wins, in every
//   environment; KMS is not called even when it is configured). The file holds one unencrypted
//   PKCS#8 PEM P-256 private key; AppConfig keeps only `{ file, kid }`.
// - CONFIG_SIGN_KEY_ID alone, with all four KMS_* variables set (./kms.ts; only staging / prod may
//   set them): the KMS secret couli/<appEnv>/config/sign-private-key (KMS_SECRETS.config
//   .signPrivateKey), same key format; AppConfig keeps only `{ source: 'kms', kid }`. The code is
//   wired; real reads wait for the owner to open KMS (until then prod mounts the file).
// - CONFIG_SIGN_KEY_FILE alone, or the ID alone without KMS: loadConfig refuses, naming only the
//   variables.
// - local / test without them: a fresh key pair per process (kid `ephemeral-<random>`), KMS unused.
// - staging / prod without them: refused (no ephemeral fallback, KMS unused).
// The key is read once at startup (file: readStartupSecretFile — regular file only, bounded, strict
// UTF-8; KMS: readStartupKmsSecret); anything that is not a P-256 private key is refused. Errors carry
// a fixed text that names the variables only: never the path, the content, the SDK's text or the
// underlying error (no `cause`). Nothing is logged here.
import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { KMS_SECRETS, readStartupKmsSecret, type KmsAccess } from '../kms/index.ts';
import type { AppEnv } from './app-env.ts';
import { isJwtKeyId, parseP256PrivateKeyPem } from './jwt.ts';
import { kmsVariablesSet } from './kms.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';

export const CONFIG_SIGN_KEY_ENV_NAMES = ['CONFIG_SIGN_KEY_FILE', 'CONFIG_SIGN_KEY_ID'] as const;

/** Largest key file or KMS secret accepted (a P-256 PKCS#8 PEM is about 240 bytes). */
export const CONFIG_SIGN_KEY_FILE_MAX_BYTES = 4096;

/** The key is in a mounted file. */
export interface ConfigSignKeyFileConfig {
  readonly file: string;
  readonly kid: string;
}

/** The key is the KMS secret config/sign-private-key of this environment. */
export interface ConfigSignKeyKmsConfig {
  readonly source: 'kms';
  readonly kid: string;
}

export type ConfigSignKeyConfig = ConfigSignKeyFileConfig | ConfigSignKeyKmsConfig;

export interface ConfigSignKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export type ConfigSignKeyErrorCode =
  'key_missing' | 'key_unreadable' | 'key_kms_unavailable' | 'key_invalid';

export const CONFIG_SIGN_KEY_MESSAGES: Readonly<Record<ConfigSignKeyErrorCode, string>> =
  Object.freeze({
    key_missing:
      'CONFIG_SIGN_KEY_FILE and CONFIG_SIGN_KEY_ID (or CONFIG_SIGN_KEY_ID with KMS_*) are required when APP_ENV is staging or prod',
    key_unreadable: 'CONFIG_SIGN_KEY_FILE cannot be read as a regular file',
    key_kms_unavailable:
      'the configuration signing key of CONFIG_SIGN_KEY_ID cannot be read from KMS (KMS_*)',
    key_invalid:
      'the configuration signing key (CONFIG_SIGN_KEY_FILE, or KMS for CONFIG_SIGN_KEY_ID) is not an unencrypted PKCS#8 PEM P-256 private key',
  });

/** Every refusal of the configuration signing key; nothing else attached (no cause, no values). */
export class ConfigSignKeyError extends Error {
  readonly code: ConfigSignKeyErrorCode;

  constructor(code: ConfigSignKeyErrorCode) {
    super(CONFIG_SIGN_KEY_MESSAGES[code]);
    this.name = 'ConfigSignKeyError';
    this.code = code;
  }
}

/**
 * The loadConfig part: both variables, or the ID alone when all four KMS_* variables are set (the
 * KMS configuration itself, and KMS_* in local / test, are judged by ./kms.ts); the kid has the JWT
 * kid syntax. Problems name the variables only.
 */
export function readConfigSignKeyConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly configSignKey: ConfigSignKeyConfig | null;
  readonly problems: readonly string[];
} {
  const file = env['CONFIG_SIGN_KEY_FILE'] ?? '';
  const kid = env['CONFIG_SIGN_KEY_ID'] ?? '';
  if (file === '' && kid === '') return { configSignKey: null, problems: [] };
  const fromKms = file === '' && kmsVariablesSet(env);
  if ((file === '' || kid === '') && !fromKms) {
    return {
      configSignKey: null,
      problems: ['CONFIG_SIGN_KEY_FILE, CONFIG_SIGN_KEY_ID: must be set together'],
    };
  }
  if (!isJwtKeyId(kid)) {
    return {
      configSignKey: null,
      problems: ['CONFIG_SIGN_KEY_ID: must be 1 to 64 characters of A-Z a-z 0-9 . _ ~ -'],
    };
  }
  return {
    configSignKey: fromKms ? Object.freeze({ source: 'kms', kid }) : Object.freeze({ file, kid }),
    problems: [],
  };
}

function freezeKey(kid: string, privateKey: KeyObject): ConfigSignKey {
  return Object.freeze({ kid, privateKey, publicKey: createPublicKey(privateKey) });
}

/**
 * The signing key of `appEnv`: read from the configured file or from KMS (`kms`: platform's KMS
 * access, null without KMS), or (local / test, unconfigured) a fresh pair. Rejects with
 * ConfigSignKeyError otherwise.
 */
export async function loadConfigSignKey(
  appEnv: AppEnv,
  config: ConfigSignKeyConfig | null,
  kms?: KmsAccess | null,
): Promise<ConfigSignKey> {
  if (config === null) {
    if (appEnv !== 'local' && appEnv !== 'test') throw new ConfigSignKeyError('key_missing');
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return Object.freeze({
      kid: `ephemeral-${randomBytes(6).toString('hex')}`,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    });
  }
  let pem: string;
  if ('file' in config) {
    pem = await readStartupSecretFile(
      config.file,
      CONFIG_SIGN_KEY_FILE_MAX_BYTES,
      (reason) =>
        new ConfigSignKeyError(reason === 'secret_invalid' ? 'key_invalid' : 'key_unreadable'),
    );
  } else {
    // KMS exists only in staging / prod (./kms.ts); a KMS source without the access is refused.
    if (appEnv === 'local' || appEnv === 'test' || kms === null || kms === undefined) {
      throw new ConfigSignKeyError('key_kms_unavailable');
    }
    pem = await readStartupKmsSecret(
      kms,
      KMS_SECRETS.config.signPrivateKey,
      CONFIG_SIGN_KEY_FILE_MAX_BYTES,
      (code) =>
        new ConfigSignKeyError(code === 'secret_invalid' ? 'key_invalid' : 'key_kms_unavailable'),
    );
  }
  const privateKey = parseP256PrivateKeyPem(pem);
  if (privateKey === null) throw new ConfigSignKeyError('key_invalid');
  return freezeKey(config.kid, privateKey);
}
