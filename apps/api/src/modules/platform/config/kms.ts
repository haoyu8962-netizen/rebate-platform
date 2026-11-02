// B1-30a (FU-KMS-ADAPTER): where the Aliyun KMS adapter is configured (规划/02 §12.6, BR-PAY-08 ②;
// endpoint format: docs-mirror/aliyun-kms/pages/endpoint.txt). Rule tests:
// test/spec/platform/kms/config.test.ts. Pure: looks only at the given object, reads no file, and a
// problem never quotes a value.
//
// Variables: KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID, KMS_RAM_ROLE; '' counts as unset.
// - local / test: any of them set → `KMS_*: must not be set when APP_ENV=<appEnv> (local and test
//   never load real keys)`, kms null.
// - staging / prod: none → kms null, no problem; some → `KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID,
//   KMS_RAM_ROLE: must be set together`, kms null.
// - KMS_ENDPOINT is a host name only (no scheme, path or port) ending in .aliyuncs.com, otherwise
//   `KMS_ENDPOINT: must be a host name ending in .aliyuncs.com`.
// loadConfig: `AppConfig.kms` is optional and the key is absent when kms is null; these problems
// come before the keyring problems.
import type { AppEnv } from './app-env.ts';

export interface KmsConfig {
  readonly regionId: string;
  readonly endpoint: string;
  readonly keyId: string;
  readonly ramRole: string;
}

const NAMES = ['KMS_REGION_ID', 'KMS_ENDPOINT', 'KMS_KEY_ID', 'KMS_RAM_ROLE'] as const;

// Whole labels only, so nothing can sit in front of the suffix (`x#.aliyuncs.com` reaches x).
const ENDPOINT = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+aliyuncs\.com$/i;

const value = (env: Readonly<Record<string, string | undefined>>, name: string): string =>
  env[name] ?? '';

/** All four variables are set: prod then keeps the public ids of the union credentials. */
export function kmsVariablesSet(env: Readonly<Record<string, string | undefined>>): boolean {
  return NAMES.every((name) => value(env, name) !== '');
}

export function readKmsConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly kms: KmsConfig | null; readonly problems: readonly string[] } {
  const anySet = NAMES.some((name) => value(env, name) !== '');
  if (!anySet) return { kms: null, problems: [] };
  if (appEnv === 'local' || appEnv === 'test') {
    return {
      kms: null,
      problems: [
        `KMS_*: must not be set when APP_ENV=${appEnv} (local and test never load real keys)`,
      ],
    };
  }
  if (!kmsVariablesSet(env)) {
    return { kms: null, problems: [`${NAMES.join(', ')}: must be set together`] };
  }
  const endpoint = value(env, 'KMS_ENDPOINT');
  if (!ENDPOINT.test(endpoint)) {
    return { kms: null, problems: ['KMS_ENDPOINT: must be a host name ending in .aliyuncs.com'] };
  }
  return {
    kms: Object.freeze({
      regionId: value(env, 'KMS_REGION_ID'),
      endpoint,
      keyId: value(env, 'KMS_KEY_ID'),
      ramRole: value(env, 'KMS_RAM_ROLE'),
    }),
    problems: [],
  };
}
