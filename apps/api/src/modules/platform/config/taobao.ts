// Taobao live adapter credentials (B1-04k; same rules as ./pdd.ts of B1-04t; approvals #28 ②;
// 规划/11 §8「真实密钥被本地栈加载」). Pure: only looks at the given object, reads no file, never
// echoes a value.
//
// - local / test: setting either variable is refused by startupViolations (./credential-env.ts
//   lists both names), so nothing is read here.
// - staging: both variables set → `{ appKey, secretFile }`; only one set → problem (names only);
//   none → null. The secret file is opened once by the union module's startup factory, never here:
//   AppConfig holds the path, never the secret.
// - prod: the file source is refused (prod only accepts KMS); TAOBAO_APP_KEY alone is not kept.
//   With KMS configured (B1-30a, ./kms.ts) the public id is kept; the secret comes from KMS.
import type { AppEnv } from './app-env.ts';
import { kmsVariablesSet } from './kms.ts';

export interface TaobaoAppConfig {
  readonly appKey: string;
  /** Path of the node file whose content is app_secret (staging only). */
  readonly secretFile: string;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  (env[name] ?? '') !== '';

export function readTaobaoConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly taobao: TaobaoAppConfig | null; readonly problems: readonly string[] } {
  const hasKey = set(env, 'TAOBAO_APP_KEY');
  const hasFile = set(env, 'TAOBAO_APP_SECRET_FILE');
  if (appEnv === 'local' || appEnv === 'test') return { taobao: null, problems: [] };
  if (appEnv === 'prod') {
    return hasFile
      ? {
          taobao: null,
          problems: [
            'TAOBAO_APP_SECRET_FILE: must not be set when APP_ENV=prod (prod reads the Taobao app secret from KMS only)',
          ],
        }
      : hasKey && kmsVariablesSet(env)
        ? {
            taobao: Object.freeze({ appKey: env['TAOBAO_APP_KEY']!, secretFile: '' }),
            problems: [],
          }
        : { taobao: null, problems: [] };
  }
  if (hasKey && hasFile) {
    return {
      taobao: Object.freeze({
        appKey: env['TAOBAO_APP_KEY']!,
        secretFile: env['TAOBAO_APP_SECRET_FILE']!,
      }),
      problems: [],
    };
  }
  if (hasKey || hasFile) {
    return {
      taobao: null,
      problems: [
        'TAOBAO_APP_KEY, TAOBAO_APP_SECRET_FILE: must be set together when APP_ENV=staging',
      ],
    };
  }
  return { taobao: null, problems: [] };
}
