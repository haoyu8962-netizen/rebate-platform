import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  openStagingTestPhones,
  readStagingTestPhoneConfig,
  type StagingTestPhoneConfig,
  type StagingTestPhones,
} from '../../../../apps/api/src/modules/platform/config/index.ts';
import { CODE_FILE_ENV, FIXED, PHONES_ENV, distinctPhones, testPhone } from './kit.ts';

type Env = Record<string, string>;

/** Absolute path of the node file (never opened by loadConfig). */
const CODE_FILE = '/run/couli-staging-b1-02zza/test-sms-code';
const NOT_STAGING = ['local', 'test', 'prod'] as const;

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b1-02zza-'));
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

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

/** The problems of the two variables (others, such as staging's keyring, are not this task's). */
function testPhoneProblems(env: Env): readonly string[] {
  return problemsOf(env).filter(
    (problem) => problem.startsWith(`${PHONES_ENV}:`) || problem.startsWith(`${CODE_FILE_ENV}:`),
  );
}

/** The configuration is refused, by loadConfig and by the reader, without echoing a value. */
function expectRefused(appEnv: (typeof NOT_STAGING)[number] | 'staging', vars: Env): void {
  const problems = testPhoneProblems({ APP_ENV: appEnv, ...vars });
  expect(problems.length, JSON.stringify(vars)).toBeGreaterThan(0);
  const read = readStagingTestPhoneConfig(appEnv, vars);
  expect(read.stagingTestPhones).toBeNull();
  expect(read.problems.length).toBeGreaterThan(0);
  for (const problem of read.problems) {
    expect(
      problem.startsWith(`${PHONES_ENV}:`) || problem.startsWith(`${CODE_FILE_ENV}:`),
      problem,
    ).toBe(true);
  }
  const text = JSON.stringify([...problems, ...read.problems]);
  for (const item of (vars[PHONES_ENV] ?? '').split(',')) {
    if (/^[0-9]{6,}$/.test(item)) expect(text).not.toContain(item);
  }
  if ((vars[CODE_FILE_ENV] ?? '') !== '') expect(text).not.toContain(vars[CODE_FILE_ENV]);
}

/** Opens the code file; a synchronous throw counts like a rejection. */
async function opened(
  config: StagingTestPhoneConfig,
): Promise<{ readonly value?: StagingTestPhones; readonly error?: unknown }> {
  try {
    return { value: await openStagingTestPhones(config) };
  } catch (error) {
    return { error };
  }
}

it('[AC-B1-02zza#1] 两个变量都未设或为空串时，任何环境都是 null、没有问题项', () => {
  for (const appEnv of [...NOT_STAGING, 'staging'] as const) {
    for (const env of [{}, { [PHONES_ENV]: '', [CODE_FILE_ENV]: '' }]) {
      expect(readStagingTestPhoneConfig(appEnv, env)).toEqual({
        stagingTestPhones: null,
        problems: [],
      });
      expect(testPhoneProblems({ APP_ENV: appEnv, ...env })).toEqual([]);
    }
  }
});

it('[AC-B1-02zza#2] local / test / prod 设了 STAGING_TEST_PHONES 或 STAGING_TEST_SMS_CODE_FILE 任何一个即拒绝启动，问题项不回显取值', () => {
  const phone = testPhone();
  for (const appEnv of NOT_STAGING) {
    expectRefused(appEnv, { [PHONES_ENV]: phone });
    expectRefused(appEnv, { [CODE_FILE_ENV]: CODE_FILE });
    expectRefused(appEnv, { [PHONES_ENV]: phone, [CODE_FILE_ENV]: CODE_FILE });
  }
});

it('[AC-B1-02zza#3] staging 只设其中一个（另一个未设或为空串）拒绝启动', () => {
  const phone = testPhone();
  expectRefused('staging', { [PHONES_ENV]: phone });
  expectRefused('staging', { [PHONES_ENV]: phone, [CODE_FILE_ENV]: '' });
  expectRefused('staging', { [CODE_FILE_ENV]: CODE_FILE });
  expectRefused('staging', { [PHONES_ENV]: '', [CODE_FILE_ENV]: CODE_FILE });
});

it('[AC-B1-02zza#4] staging 名单有非法号、重复、超过 10 个、空项时拒绝启动', () => {
  const [a, b] = distinctPhones(2) as [string, string];
  const lists = [
    'not-a-phone',
    `${a},12${b.slice(2)}`,
    `${a},${b.slice(0, 10)}`,
    `${a},${b}0`,
    `${a},${a}`,
    `${a},${b},${a}`,
    distinctPhones(11).join(','),
    `${a},,${b}`,
    `${a},`,
    `,${a}`,
    ',',
  ];
  for (const list of lists) {
    expectRefused('staging', { [PHONES_ENV]: list, [CODE_FILE_ENV]: CODE_FILE });
  }
});

it('[AC-B1-02zza#5] staging 两个都设且名单合法（1 到 10 个）时按原顺序保留号码与码文件路径，没有问题项', () => {
  for (const phones of [distinctPhones(1), distinctPhones(10)]) {
    const env = { [PHONES_ENV]: phones.join(','), [CODE_FILE_ENV]: CODE_FILE };
    expect(readStagingTestPhoneConfig('staging', env)).toEqual({
      stagingTestPhones: { phones, codeFile: CODE_FILE },
      problems: [],
    });
    expect(testPhoneProblems({ APP_ENV: 'staging', ...env })).toEqual([]);
  }
});

it('[AC-B1-02zza#6] 码文件是正好 6 位数字（可带一个结尾换行）的普通文件时，启动读出固定码', async () => {
  const phones = distinctPhones(2);
  for (const [name, content] of [
    ['plain', FIXED],
    ['newline', `${FIXED}\n`],
  ] as const) {
    const codeFile = join(dir, `valid-${name}`);
    writeFileSync(codeFile, content);
    const result = await opened({ phones, codeFile });
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ phones, code: FIXED });
  }
});

it('[AC-B1-02zza#7] 码文件不是正好 6 位数字、读不到或不是普通文件时启动拒绝，报错不带路径、内容与码', async () => {
  const phones = distinctPhones(1);
  const contents = [
    '',
    '\n',
    FIXED.slice(0, 5),
    `${FIXED}7`,
    'abcdef',
    ` ${FIXED}`,
    `${FIXED} `,
    `${FIXED}\n\n`,
    `${FIXED.slice(0, 5)}x`,
    '２４６８１３',
  ];
  const cases: { readonly codeFile: string; readonly content?: string }[] = contents.map(
    (content, index) => {
      const codeFile = join(dir, `invalid-${String(index)}`);
      writeFileSync(codeFile, content);
      return { codeFile, content };
    },
  );
  cases.push({ codeFile: join(dir, 'missing-code-file') });
  const directory = join(dir, 'a-directory');
  mkdirSync(directory);
  cases.push({ codeFile: directory });
  for (const { codeFile, content } of cases) {
    const result = await opened({ phones, codeFile });
    expect(result.value, JSON.stringify(content ?? codeFile)).toBeUndefined();
    expect(result.error).toBeInstanceOf(Error);
    const text = `${String(result.error)} ${(result.error as Error).message}`;
    expect(text).toContain(CODE_FILE_ENV);
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(new RegExp(`(?<!\\d)${FIXED}(?!\\d)`));
    expect(text).not.toContain(phones[0]);
    const shown = content?.trim() ?? '';
    if (shown !== '') expect(text).not.toContain(shown);
  }
});
