import { expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  readStagingTestRealnameConfig,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import { MAX_IDS, STAGING_NODE, USER_IDS_ENV, listOf, userId, userIds } from './kit.ts';

type Env = Record<string, string>;

const NOT_STAGING = ['local', 'test', 'prod'] as const;
/**
 * How loadConfig is called: without an entry, and as the real api entry does
 * (bootstrap.ts: loadConfig(process.env, 'api')).
 */
const ENTRIES = [undefined, 'api'] as const;
/** Something shaped like (part of) a user_id: it must not be echoed by a problem. */
const ID_LIKE = /^[0-9a-f-]{8,}$/i;

/** Every problem loadConfig reports for `env` read by `entry` ([] when it starts). */
function problemsOf(env: Env, entry: (typeof ENTRIES)[number]): readonly string[] {
  try {
    loadConfig(env, entry);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
}

/** The problems of the variable (others, such as staging's keyring, are not this task's). */
function ownProblems(env: Env, entry: (typeof ENTRIES)[number]): readonly string[] {
  return problemsOf(env, entry).filter((problem) => problem.startsWith(`${USER_IDS_ENV}:`));
}

/** Refused by loadConfig (with and without the api entry) and by the reader, without echoing a value. */
function expectRefused(appEnv: (typeof NOT_STAGING)[number] | 'staging', value: string): void {
  const problems: string[] = [];
  for (const entry of ENTRIES) {
    const own = ownProblems({ APP_ENV: appEnv, [USER_IDS_ENV]: value }, entry);
    expect(own.length, `${appEnv} ${String(entry)} ${value}`).toBeGreaterThan(0);
    problems.push(...own);
  }
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

/** The list loadConfig read by `entry` keeps on AppConfig (null when absent). */
function configured(env: Env, entry: (typeof ENTRIES)[number]): readonly string[] | null {
  let config: unknown;
  try {
    config = loadConfig(env, entry);
  } catch (error) {
    expect(error instanceof ConfigError ? error.problems : String(error)).toEqual([]);
  }
  return listOf(config);
}

function sorted(ids: readonly string[] | null | undefined): string[] | null {
  return ids === null || ids === undefined ? null : [...ids].sort();
}

it('[AC-B1-13n#4] local / test / prod 设了 STAGING_TEST_REALNAME_USER_IDS 即拒绝启动（含 api 入口的 loadConfig），问题项不回显取值', () => {
  const [a, b] = userIds(2) as [string, string];
  for (const appEnv of NOT_STAGING) {
    expectRefused(appEnv, a);
    expectRefused(appEnv, `${a},${b}`);
    expectRefused(appEnv, 'not-a-user-id');
  }
});

it('[AC-B1-13n#5] staging 名单有非法 user_id、空项或超过 10 项（含 11 个合法项里有一项重复）时，解析器与 api 入口的 loadConfig 都拒绝启动', () => {
  const [a, b] = userIds(2) as [string, string];
  const ten = userIds(MAX_IDS);
  const lists = [
    'not-a-user-id',
    '19912345678',
    `${a},${b.slice(0, -1)}`,
    `${a},${b}0`,
    `${a},${b.slice(0, -1)}g`,
    `${a},${b.slice(0, 8)}_${b.slice(9)}`,
    userIds(MAX_IDS + 1).join(','),
    // 11 non-empty valid items, one of them twice: over the limit before any de-duplication.
    [...ten, ten[3]!].join(','),
    `${a},,${b}`,
    `${a},`,
    `,${a}`,
    ',',
  ];
  for (const list of lists) expectRefused('staging', list);
});

it('[AC-B1-13n#6] 未设或为空串时任何环境都是 null、没有问题项；staging 合法名单（1 到 10 项）原样保留并进 AppConfig（含 api 入口的 loadConfig）', () => {
  for (const appEnv of [...NOT_STAGING, 'staging'] as const) {
    for (const env of [{}, { [USER_IDS_ENV]: '' }]) {
      expect(readStagingTestRealnameConfig(appEnv, env)).toEqual({
        stagingTestRealnameUserIds: null,
        problems: [],
      });
      for (const entry of ENTRIES) {
        expect(ownProblems({ APP_ENV: appEnv, ...env }, entry)).toEqual([]);
      }
    }
  }
  for (const entry of ENTRIES) {
    for (const env of [{}, { [USER_IDS_ENV]: '' }]) {
      expect(configured({ APP_ENV: 'test', ...env }, entry)).toBeNull();
      expect(configured({ ...STAGING_NODE, ...env }, entry)).toBeNull();
    }
  }
  for (const ids of [[userId()], userIds(MAX_IDS)]) {
    const value = ids.join(',');
    const read = readStagingTestRealnameConfig('staging', { [USER_IDS_ENV]: value });
    expect(read.problems).toEqual([]);
    expect(sorted(read.stagingTestRealnameUserIds)).toEqual(sorted(ids));
    for (const entry of ENTRIES) {
      expect(ownProblems({ APP_ENV: 'staging', [USER_IDS_ENV]: value }, entry)).toEqual([]);
      expect(sorted(configured({ ...STAGING_NODE, [USER_IDS_ENV]: value }, entry))).toEqual(
        sorted(ids),
      );
    }
  }
});
