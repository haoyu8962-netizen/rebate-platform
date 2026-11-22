import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  readStagingTestRealnameConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import { MAX_IDS, USER_IDS_ENV, userId, userIds } from './kit.ts';

type Env = Record<string, string>;

const NOT_STAGING = ['local', 'test', 'prod'] as const;
/** A staging node that loadConfig accepts (B1-01zd: local field keyring by absolute paths). */
const STAGING_NODE: Env = {
  APP_ENV: 'staging',
  FIELD_KEY_PROVIDER: 'local',
  FIELD_KEYRING_FILE: '/srv/couli/keys/keyring.json',
  FIELD_MASTER_KEY_FILE: '/srv/couli/keys/master.hex',
  PRIOR_IDENTITY_KEY_PROVIDER: 'local',
  PRIOR_IDENTITY_KEYRING_FILE: '/srv/couli/keys/prior-identity-keyring.json',
  PRIOR_IDENTITY_MASTER_KEY_FILE: '/srv/couli/keys/prior-identity-master.hex',
};
/** Something shaped like (part of) a user_id: it must not be echoed by a problem. */
const ID_LIKE = /^[0-9a-f-]{8,}$/i;

/** Every problem loadConfig reports for `env` ([] when it starts). */
function problemsOf(env: Env): readonly string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

/** The problems of the variable (others, such as staging's keyring, are not this task's). */
function ownProblems(env: Env): readonly string[] {
  return problemsOf(env).filter((problem) => problem.startsWith(`${USER_IDS_ENV}:`));
}

/** Refused by loadConfig and by the reader, without echoing a value. */
function expectRefused(appEnv: (typeof NOT_STAGING)[number] | 'staging', value: string): void {
  const problems = ownProblems({ APP_ENV: appEnv, [USER_IDS_ENV]: value });
  expect(problems.length, `${appEnv} ${value}`).toBeGreaterThan(0);
  const read = readStagingTestRealnameConfig(appEnv, { [USER_IDS_ENV]: value });
  expect(read.stagingTestRealnameUserIds).toBeNull();
  expect(read.problems.length).toBeGreaterThan(0);
  for (const problem of read.problems) {
    expect(problem.startsWith(`${USER_IDS_ENV}:`), problem).toBe(true);
  }
  const text = JSON.stringify([...problems, ...read.problems]);
  for (const item of value.split(',')) {
    if (ID_LIKE.test(item)) expect(text).not.toContain(item);
  }
}

/** The list loadConfig keeps on AppConfig (null when absent). */
function configured(env: Env): readonly string[] | null {
  let config: Record<string, unknown> | undefined;
  try {
    config = loadConfig(env) as unknown as Record<string, unknown>;
  } catch (error) {
    expect(error instanceof ConfigError ? error.problems : String(error)).toEqual([]);
  }
  return (config?.['stagingTestRealnameUserIds'] ?? null) as readonly string[] | null;
}

function sorted(ids: readonly string[] | null | undefined): string[] | null {
  return ids === null || ids === undefined ? null : [...ids].sort();
}

it('[AC-B1-13n#4] local / test / prod 设了 STAGING_TEST_REALNAME_USER_IDS 即拒绝启动，问题项不回显取值', () => {
  const [a, b] = userIds(2) as [string, string];
  for (const appEnv of NOT_STAGING) {
    expectRefused(appEnv, a);
    expectRefused(appEnv, `${a},${b}`);
    expectRefused(appEnv, 'not-a-user-id');
  }
});

it('[AC-B1-13n#5] staging 名单有非法 user_id、空项或超过 10 项时拒绝启动', () => {
  const [a, b] = userIds(2) as [string, string];
  const lists = [
    'not-a-user-id',
    '19912345678',
    `${a},${b.slice(0, -1)}`,
    `${a},${b}0`,
    `${a},${b.slice(0, -1)}g`,
    `${a},${b.slice(0, 8)}_${b.slice(9)}`,
    userIds(MAX_IDS + 1).join(','),
    `${a},,${b}`,
    `${a},`,
    `,${a}`,
    ',',
  ];
  for (const list of lists) expectRefused('staging', list);
});

it('[AC-B1-13n#6] 未设或为空串时任何环境都是 null、没有问题项；staging 合法名单（1 到 10 项）原样保留并进 AppConfig', () => {
  for (const appEnv of [...NOT_STAGING, 'staging'] as const) {
    for (const env of [{}, { [USER_IDS_ENV]: '' }]) {
      expect(readStagingTestRealnameConfig(appEnv, env)).toEqual({
        stagingTestRealnameUserIds: null,
        problems: [],
      });
      expect(ownProblems({ APP_ENV: appEnv, ...env })).toEqual([]);
    }
  }
  for (const env of [{}, { [USER_IDS_ENV]: '' }]) {
    expect(configured({ APP_ENV: 'test', ...env })).toBeNull();
    expect(configured({ ...STAGING_NODE, ...env })).toBeNull();
  }
  for (const ids of [[userId()], userIds(MAX_IDS)]) {
    const value = ids.join(',');
    const read = readStagingTestRealnameConfig('staging', { [USER_IDS_ENV]: value });
    expect(read.problems).toEqual([]);
    expect(sorted(read.stagingTestRealnameUserIds)).toEqual(sorted(ids));
    expect(ownProblems({ APP_ENV: 'staging', [USER_IDS_ENV]: value })).toEqual([]);
    expect(sorted(configured({ ...STAGING_NODE, [USER_IDS_ENV]: value }))).toEqual(sorted(ids));
  }
});
