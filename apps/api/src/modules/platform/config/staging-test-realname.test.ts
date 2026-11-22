// Implementer unit tests of B1-13n's configuration (the rule tests are under
// test/spec/identity/staging-test-realname): every branch of loadConfig refuses an invalid
// STAGING_TEST_REALNAME_USER_IDS on a staging node that otherwise starts, never echoing a value.
// Synthetic user_ids only.
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';
import { readStagingTestRealnameConfig } from './staging-test-realname.ts';

const VAR = 'STAGING_TEST_REALNAME_USER_IDS';
/** A staging node loadConfig(env, 'api') accepts (local field keyrings by absolute paths). */
const STAGING_NODE: Readonly<Record<string, string>> = {
  APP_ENV: 'staging',
  FIELD_KEY_PROVIDER: 'local',
  FIELD_KEYRING_FILE: '/srv/couli/keys/keyring.json',
  FIELD_MASTER_KEY_FILE: '/srv/couli/keys/master.hex',
  PRIOR_IDENTITY_KEY_PROVIDER: 'local',
  PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/keys/prior-identity-keyring.json',
  PRIOR_IDENTITY_MASTER_KEY_FILE: '/srv/couli/keys/prior-identity-master.hex',
};

/** Synthetic lowercase UUIDs, distinct, recognisable by their index. */
function ids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `0199b13a-${String(1000 + i)}-7000-8000-${String(i).padStart(12, '0')}`,
  );
}

function problemsOf(env: Record<string, string>, entry?: 'api'): readonly string[] {
  try {
    loadConfig(env, entry);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

const TEN = ids(10);
const INVALID_LISTS: readonly (readonly [string, string])[] = [
  ['empty item', `${TEN[0]!},,${TEN[1]!}`],
  ['trailing empty item', `${TEN[0]!},`],
  ['only a comma', ','],
  ['invalid user_id', `${TEN[0]!},not-a-user-id`],
  ['uppercase user_id', TEN[0]!.toUpperCase()],
  ['11 items', ids(11).join(',')],
  ['11 items with one duplicate', [...TEN, TEN[4]!].join(',')],
  ['duplicate within 10', `${TEN[0]!},${TEN[0]!}`],
];

it('[AC-B1-13n#u1] 一份 loadConfig(env, "api") 可通过的 staging 节点配置（含有效字段密钥环）上逐个加入非法名单，都拒绝启动；问题项只说变量名与原因', () => {
  expect(problemsOf(STAGING_NODE, 'api')).toEqual([]);
  expect(problemsOf({ ...STAGING_NODE, [VAR]: TEN.join(',') }, 'api')).toEqual([]);
  for (const [label, list] of INVALID_LISTS) {
    for (const entry of ['api', undefined] as const) {
      const problems = problemsOf({ ...STAGING_NODE, [VAR]: list }, entry);
      // Only this variable is wrong: the refusal is exactly its own problem.
      expect(problems, `${label} ${String(entry)}`).toHaveLength(1);
      expect(problems[0]!.startsWith(`${VAR}: `), label).toBe(true);
      for (const item of list.split(',')) {
        if (item !== '') expect(problems[0]!.includes(item), label).toBe(false);
      }
    }
  }
});

it('[AC-B1-13n#u2] 别的变量已让环境 schema 校验失败的那一支，也并进名单的问题项', () => {
  for (const [label, list] of INVALID_LISTS) {
    const problems = problemsOf({ ...STAGING_NODE, API_PORT: 'not-a-port', [VAR]: list }, 'api');
    expect(
      problems.filter((problem) => problem.startsWith(`${VAR}: `)),
      label,
    ).toHaveLength(1);
  }
  const prod = problemsOf({ APP_ENV: 'prod', API_PORT: 'not-a-port', [VAR]: TEN[0]! });
  expect(prod.filter((problem) => problem.startsWith(`${VAR}: `))).toHaveLength(1);
});

it('[AC-B1-13n#u3] staging 以外设了名单即是问题项；合法名单原样冻结进 AppConfig，未设或空串时 AppConfig 不带该字段', () => {
  for (const appEnv of ['local', 'test', 'prod'] as const) {
    const read = readStagingTestRealnameConfig(appEnv, { [VAR]: TEN[0]! });
    expect(read.stagingTestRealnameUserIds).toBeNull();
    expect(read.problems).toEqual([
      `${VAR}: must only be set when APP_ENV=staging (test identities are hard off elsewhere)`,
    ]);
  }
  const config = loadConfig({ ...STAGING_NODE, [VAR]: TEN.join(',') }, 'api');
  expect(config.stagingTestRealnameUserIds).toEqual(TEN);
  expect(Object.isFrozen(config.stagingTestRealnameUserIds)).toBe(true);
  for (const value of [undefined, '']) {
    const env = value === undefined ? STAGING_NODE : { ...STAGING_NODE, [VAR]: value };
    expect('stagingTestRealnameUserIds' in loadConfig(env, 'api')).toBe(false);
  }
});
