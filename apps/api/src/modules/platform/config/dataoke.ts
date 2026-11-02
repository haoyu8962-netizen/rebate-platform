// 大淘客 credentials of the Taobao order source (B1-04e, D10-486 ①; same rules as ./taobao.ts of
// B1-04k; approvals #28 ②; 规划/11 §8「真实密钥被本地栈加载」). Pure: only looks at the given object,
// reads no file, never echoes a value.
//
// - local / test: setting either variable is refused by startupViolations (./credential-env.ts
//   lists DATAOKE_APP_KEY and DATAOKE_APP_SECRET_FILE), so nothing is read here.
// - staging: both variables set → `{ appKey, secretFile }`; only one set → problem (names only);
//   none → null. The secret file is opened once by the union module's startup factory
//   (./dataoke-startup.ts), never here: AppConfig holds the path, never the secret.
// - prod: DATAOKE_APP_SECRET_FILE is refused (prod only accepts KMS); DATAOKE_APP_KEY alone is not
//   kept (with taobao live, the union module refuses to start until KMS exists).
//   With KMS configured (B1-30a, ./kms.ts) the public id is kept; the secret comes from KMS.
//
// loadConfig merges the problems in both of its paths (valid and invalid rest of the environment)
// and puts `dataoke` into its result only when configured (AppConfig.dataoke).
import type { AppEnv } from './app-env.ts';
import { kmsVariablesSet } from './kms.ts';

export interface DataokeAppConfig {
  readonly appKey: string;
  /** Path of the node file whose content is the 大淘客 appSecret (staging only). */
  readonly secretFile: string;
}

const set = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  (env[name] ?? '') !== '';

export function readDataokeConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly dataoke: DataokeAppConfig | null; readonly problems: readonly string[] } {
  const hasKey = set(env, 'DATAOKE_APP_KEY');
  const hasFile = set(env, 'DATAOKE_APP_SECRET_FILE');
  if (appEnv === 'local' || appEnv === 'test') return { dataoke: null, problems: [] };
  if (appEnv === 'prod') {
    return hasFile
      ? {
          dataoke: null,
          problems: [
            'DATAOKE_APP_SECRET_FILE: must not be set when APP_ENV=prod (prod reads the 大淘客 app secret from KMS only)',
          ],
        }
      : hasKey && kmsVariablesSet(env)
        ? {
            dataoke: Object.freeze({ appKey: env['DATAOKE_APP_KEY']!, secretFile: '' }),
            problems: [],
          }
        : { dataoke: null, problems: [] };
  }
  if (hasKey && hasFile) {
    return {
      dataoke: Object.freeze({
        appKey: env['DATAOKE_APP_KEY']!,
        secretFile: env['DATAOKE_APP_SECRET_FILE']!,
      }),
      problems: [],
    };
  }
  if (hasKey || hasFile) {
    return {
      dataoke: null,
      problems: [
        'DATAOKE_APP_KEY, DATAOKE_APP_SECRET_FILE: must be set together when APP_ENV=staging',
      ],
    };
  }
  return { dataoke: null, problems: [] };
}
