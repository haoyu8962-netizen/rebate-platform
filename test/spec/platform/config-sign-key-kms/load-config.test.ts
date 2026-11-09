// B1-01zzt loadConfig 口径（claude-independent，SPEC_REF deaba4fb）：编排 D10-1155 ④、prod-wiring-gaps 第 23 项、
// 规划/02 §12.6。staging / prod 只配 CONFIG_SIGN_KEY_ID 且 KMS 四项齐 → 可加载、来源 KMS；其余半配照旧拒绝，
// 问题只提变量名（与冻结 [AC-F1-02zzzb#9] 一致）；local / test 设了 KMS_* 照旧被 kms 配置拒绝（不变）。
// 每个用例先让「只配 ID + KMS」的正例站住，后面的拒绝才是因为缺 KMS / 环境不对，而不是这条路根本不存在。顶层 it。
import { expect, it } from 'vitest';
import {
  CONFIG_KID,
  KMS,
  KMS_ENV,
  cloudEnv,
  configProblems,
  kmsOnlyEnv,
  loadedConfig,
} from './kit.ts';

/** 值里都带标记，用来查问题文案有没有回显。 */
const MARKER = 'markerb101zzt';
const MARKED_KID = `kid-${MARKER}`;
const MARKED_FILE = `/synthetic/${MARKER}/config-sign.pem`;

function problemsOf(env: Readonly<Record<string, string>>): readonly string[] {
  const problems = configProblems(env);
  expect(Array.isArray(problems) ? 'refused' : problems).toBe('refused');
  return problems as readonly string[];
}

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#1] %s：只配 CONFIG_SIGN_KEY_ID 且 KMS 四项齐 → loadConfig 通过，configSignKey 来源 KMS、kid 为配置值、没有文件路径',
  (appEnv) => {
    const config = loadedConfig(kmsOnlyEnv(appEnv));
    const keyConfig: unknown = config.configSignKey ?? null;
    expect(keyConfig).toEqual(expect.objectContaining({ kid: CONFIG_KID }));
    const file = (keyConfig as { readonly file?: unknown }).file;
    expect(typeof file === 'string' && file !== '').toBe(false);
    expect(config.kms).toEqual(KMS);
  },
);

it.each(['staging', 'prod'] as const)(
  '[AC-B1-01zzt#2] %s：KMS 没配或没配齐时只配 ID 仍拒绝；只配 FILE（有无 KMS）仍拒绝；ID 不合语法仍拒绝；问题只提变量名不回显值',
  (appEnv) => {
    // 正例：同一个 ID 配齐 KMS 就能加载。
    const ok = loadedConfig({ ...cloudEnv(appEnv), ...KMS_ENV, CONFIG_SIGN_KEY_ID: MARKED_KID });
    expect(ok.configSignKey ?? null).toEqual(expect.objectContaining({ kid: MARKED_KID }));

    const base = cloudEnv(appEnv);
    const signKeyRefusals: readonly Readonly<Record<string, string>>[] = [
      { ...base, CONFIG_SIGN_KEY_ID: MARKED_KID },
      { ...base, CONFIG_SIGN_KEY_FILE: MARKED_FILE },
      { ...base, ...KMS_ENV, CONFIG_SIGN_KEY_FILE: MARKED_FILE },
      { ...base, ...KMS_ENV, CONFIG_SIGN_KEY_ID: `bad kid ${MARKER}` },
      { ...base, ...KMS_ENV, CONFIG_SIGN_KEY_ID: `${MARKER}${'x'.repeat(64)}` },
    ];
    for (const env of signKeyRefusals) {
      const problems = problemsOf(env);
      expect(problems.some((problem) => problem.includes('CONFIG_SIGN_KEY'))).toBe(true);
      expect(problems.join('\n')).not.toContain(MARKER);
    }

    // KMS 只配了一部分：ID 不能借这条路通过（KMS 自己的问题照旧），也不回显值。
    const partial = problemsOf({
      ...base,
      KMS_KEY_ID: `key-${MARKER}`,
      CONFIG_SIGN_KEY_ID: MARKED_KID,
    });
    expect(partial).toContain(
      'KMS_REGION_ID, KMS_ENDPOINT, KMS_KEY_ID, KMS_RAM_ROLE: must be set together',
    );
    expect(partial.join('\n')).not.toContain(MARKER);
  },
);

it('[AC-B1-01zzt#3] local / test：设了 KMS_* 照旧被 kms 配置拒绝，只配 ID 也不放行；FILE / ID 一对照旧收为 {file, kid}', () => {
  // 正例：同样的变量在 staging 能加载，下面的拒绝是因为环境，不是因为这条路不存在。
  loadedConfig(kmsOnlyEnv('staging'));

  for (const appEnv of ['local', 'test'] as const) {
    const withKms = problemsOf({ APP_ENV: appEnv, ...KMS_ENV, CONFIG_SIGN_KEY_ID: CONFIG_KID });
    expect(withKms).toContain(
      `KMS_*: must not be set when APP_ENV=${appEnv} (local and test never load real keys)`,
    );

    const idOnly = problemsOf({ APP_ENV: appEnv, CONFIG_SIGN_KEY_ID: MARKED_KID });
    expect(idOnly.some((problem) => problem.includes('CONFIG_SIGN_KEY'))).toBe(true);
    expect(idOnly.join('\n')).not.toContain(MARKER);

    const pair = loadedConfig({
      APP_ENV: appEnv,
      CONFIG_SIGN_KEY_FILE: '/synthetic/config.pem',
      CONFIG_SIGN_KEY_ID: 'config-kid',
    });
    expect(pair.configSignKey).toStrictEqual({ file: '/synthetic/config.pem', kid: 'config-kid' });
  }
});
