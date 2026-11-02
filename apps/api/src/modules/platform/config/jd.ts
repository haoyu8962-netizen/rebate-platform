// Jingdong live adapter credentials (B1-04ze; same rules as ./taobao.ts of B1-04k; approvals #28 ②;
// 规划/11 §8「真实密钥被本地栈加载」). Pure: only looks at the given object, reads no file, never
// echoes a value.
//
// - local / test: setting either variable is refused by startupViolations (./credential-env.ts
//   lists both names), so nothing is read here.
// - staging: both variables set → `{ appKey, secretFile }`; only one set → problem (names only);
//   none → null. The secret file is opened once by the union module's startup factory, never here:
//   AppConfig holds the path, never the secret.
// - prod: the file source is refused (prod only accepts KMS); JD_APP_KEY alone is not kept.
//   With KMS configured (B1-30a, ./kms.ts) the public id is kept; the secret comes from KMS.
//
// JD_SITE_ID (D10-500 ①) is a server setting, not a credential: not listed in ./credential-env.ts,
// optional in every environment, kept as text (an id may exceed the safe integer range). Link
// conversion uses it (B1-04zd).
import type { AppEnv } from './app-env.ts';
import { kmsVariablesSet } from './kms.ts';

export const JD_SITE_ID_ENV = 'JD_SITE_ID';

/** A positive decimal integer as text: ASCII digits only, no sign, no leading zero. */
const SITE_ID = /^[1-9][0-9]*$/;

export interface JdAppConfig {
  readonly appKey: string;
  /** Path of the node file whose content is app_secret (staging only). */
  readonly secretFile: string;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  (env[name] ?? '') !== '';

export function readJdConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly jd: JdAppConfig | null; readonly problems: readonly string[] } {
  const hasKey = set(env, 'JD_APP_KEY');
  const hasFile = set(env, 'JD_APP_SECRET_FILE');
  if (appEnv === 'local' || appEnv === 'test') return { jd: null, problems: [] };
  if (appEnv === 'prod') {
    return hasFile
      ? {
          jd: null,
          problems: [
            'JD_APP_SECRET_FILE: must not be set when APP_ENV=prod (prod reads the Jingdong app secret from KMS only)',
          ],
        }
      : hasKey && kmsVariablesSet(env)
        ? {
            jd: Object.freeze({ appKey: env['JD_APP_KEY']!, secretFile: '' }),
            problems: [],
          }
        : { jd: null, problems: [] };
  }
  if (hasKey && hasFile) {
    return {
      jd: Object.freeze({
        appKey: env['JD_APP_KEY']!,
        secretFile: env['JD_APP_SECRET_FILE']!,
      }),
      problems: [],
    };
  }
  if (hasKey || hasFile) {
    return {
      jd: null,
      problems: ['JD_APP_KEY, JD_APP_SECRET_FILE: must be set together when APP_ENV=staging'],
    };
  }
  return { jd: null, problems: [] };
}

export function readJdSiteConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly jdSiteId: string | null;
  readonly problems: readonly string[];
} {
  const value = env[JD_SITE_ID_ENV];
  if (value === undefined || value === '') return { jdSiteId: null, problems: [] };
  return SITE_ID.test(value)
    ? { jdSiteId: value, problems: [] }
    : { jdSiteId: null, problems: [`${JD_SITE_ID_ENV}: must be a positive decimal integer`] };
}
