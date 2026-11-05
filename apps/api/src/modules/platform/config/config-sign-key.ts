// The configuration signing key of the api entry (F1-02zzzb; D10-610; 规划/02 §12.6: 配置签名私钥只
// api 用): signs /v1/config's bridge_origins whitelist (ES256). Separate from the JWT signing key.
//
// - CONFIG_SIGN_KEY_FILE / CONFIG_SIGN_KEY_ID: set together or not at all (loadConfig refuses one
//   alone, naming only the variables). The file holds one unencrypted PKCS#8 PEM P-256 private key;
//   AppConfig keeps only the path and the kid.
// - local / test without them: a fresh key pair per process (kid `ephemeral-<random>`).
// - staging / prod without them: refused (no ephemeral fallback).
//   TODO(规划/11 §4.5): prod 改走 KMS — blocked on 负责人开通 KMS（本单不做，prod 只认文件或拒绝）。
// - The file is read once at startup through readStartupSecretFile (regular file only, bounded,
//   strict UTF-8); a file that is not a P-256 private key is refused. Errors carry a fixed text that
//   names the variables only: never the path, the content or the underlying error (no `cause`).
//   Nothing is logged here.
import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import type { AppEnv } from './app-env.ts';
import { isJwtKeyId, parseP256PrivateKeyPem } from './jwt.ts';
import { readStartupSecretFile } from './startup-secret-file.ts';

export const CONFIG_SIGN_KEY_ENV_NAMES = ['CONFIG_SIGN_KEY_FILE', 'CONFIG_SIGN_KEY_ID'] as const;

/** Largest key file accepted (a P-256 PKCS#8 PEM is about 240 bytes). */
export const CONFIG_SIGN_KEY_FILE_MAX_BYTES = 4096;

export interface ConfigSignKeyConfig {
  readonly file: string;
  readonly kid: string;
}

export interface ConfigSignKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export type ConfigSignKeyErrorCode = 'key_missing' | 'key_unreadable' | 'key_invalid';

export const CONFIG_SIGN_KEY_MESSAGES: Readonly<Record<ConfigSignKeyErrorCode, string>> =
  Object.freeze({
    key_missing:
      'CONFIG_SIGN_KEY_FILE and CONFIG_SIGN_KEY_ID are required when APP_ENV is staging or prod',
    key_unreadable: 'CONFIG_SIGN_KEY_FILE cannot be read as a regular file',
    key_invalid: 'CONFIG_SIGN_KEY_FILE is not an unencrypted PKCS#8 PEM P-256 private key',
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

/** The loadConfig part: both variables or none; the kid has the JWT kid syntax. */
export function readConfigSignKeyConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly configSignKey: ConfigSignKeyConfig | null;
  readonly problems: readonly string[];
} {
  const file = env['CONFIG_SIGN_KEY_FILE'] ?? '';
  const kid = env['CONFIG_SIGN_KEY_ID'] ?? '';
  if (file === '' && kid === '') return { configSignKey: null, problems: [] };
  if (file === '' || kid === '') {
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
  return { configSignKey: Object.freeze({ file, kid }), problems: [] };
}

/**
 * The signing key of `appEnv`: read from the configured file, or (local / test, unconfigured) a
 * fresh pair. Rejects with ConfigSignKeyError otherwise.
 */
export async function loadConfigSignKey(
  appEnv: AppEnv,
  config: ConfigSignKeyConfig | null,
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
  const pem = await readStartupSecretFile(
    config.file,
    CONFIG_SIGN_KEY_FILE_MAX_BYTES,
    (reason) =>
      new ConfigSignKeyError(reason === 'secret_invalid' ? 'key_invalid' : 'key_unreadable'),
  );
  const privateKey = parseP256PrivateKeyPem(pem);
  if (privateKey === null) throw new ConfigSignKeyError('key_invalid');
  return Object.freeze({ kid: config.kid, privateKey, publicKey: createPublicKey(privateKey) });
}
