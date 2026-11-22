import { expect, it } from 'vitest';
import { createRootLogger } from '../../platform/index.ts';
import { maskName } from '../domain/mask-name.ts';
import {
  FAKE_REALNAME_PROVIDER,
  STAGING_TEST_REALNAME_AUDIT_EVENT,
  STAGING_TEST_REALNAME_PROVIDER,
  createFakeRealnameVerifier,
  createRealnameVerifier,
  createStagingTestRealnameVerifier,
} from './fake-realname-verifier.ts';

it('[BR-ID-33] maskName keeps only the last code point', () => {
  expect(maskName('欧阳小明')).toBe('***明');
  expect(maskName('李四')).toBe('*四');
  expect(maskName('王')).toBe('*');
  expect(maskName('')).toBe('');
  expect(maskName('𠀀𠀁')).toBe('*𠀁');
});

it('[BR-ID-25] the fake verifier is local / test only and answers a match', async () => {
  for (const env of ['local', 'test']) {
    await expect(
      createRealnameVerifier(env)!.verify({ app_id: 'a', user_id: 'u', name: 'n', id_no: 'i' }),
    ).resolves.toEqual({ outcome: 'match', provider: FAKE_REALNAME_PROVIDER });
  }
  for (const env of ['staging', 'prod']) {
    expect(createRealnameVerifier(env)).toBeNull();
    expect(() => createFakeRealnameVerifier(env)).toThrow(/local or test/);
  }
});

// B1-13n: synthetic values only — region 990101 does not exist, the name starts with 「测试」.
const LISTED = ['0199b13a-0001-7000-8000-000000000001', '0199b13a-0002-7000-8000-000000000002'];
const OUTSIDER = '0199b13a-0003-7000-8000-000000000003';
const TEST_NAME = '测试单元甲';
const TEST_ID_NO = '990101199001010115';
const TEST_APP = 'b1-13n-unit-app';
/** Fields every pino line carries whatever was logged (pino's own and the root logger's base). */
const META = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v', 'entry', 'env']);

function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

function fieldsOf(line: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(line).filter(([key]) => !META.has(key)));
}

function input(userId: string) {
  return { app_id: TEST_APP, user_id: userId, name: TEST_NAME, id_no: TEST_ID_NO };
}

it('[AC-B1-13n#u4] 启用告警与审计的消息正文是固定文本、不附加业务数据；结构化字段只有 count / event、app_id、user_id、provider', async () => {
  const { logger, lines } = memoryLogger();
  const verifier = createStagingTestRealnameVerifier({
    appEnv: 'staging',
    userIds: LISTED,
    logger,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]!['level']).toBe(40);
  expect(lines[0]!['msg']).toBe('staging_test_realname_enabled');
  expect(fieldsOf(lines[0]!)).toEqual({ count: LISTED.length });

  await expect(verifier!.verify(input(LISTED[1]!))).resolves.toEqual({
    outcome: 'match',
    provider: STAGING_TEST_REALNAME_PROVIDER,
  });
  expect(lines).toHaveLength(2);
  expect(lines[1]!['msg']).toBe('staging_test_realname_verified');
  expect(fieldsOf(lines[1]!)).toEqual({
    event: STAGING_TEST_REALNAME_AUDIT_EVENT,
    app_id: TEST_APP,
    user_id: LISTED[1],
    provider: 'staging-test-identity',
  });

  // An outsider: unavailable (50301, not counted), no line at all.
  await expect(verifier!.verify(input(OUTSIDER))).resolves.toEqual({ outcome: 'unavailable' });
  expect(lines).toHaveLength(2);

  // Neither message carries a listed user_id, the name, any 4-character piece of the ID number or
  // the app_id; the whole output never has the name or the ID number pieces.
  const text = JSON.stringify(lines);
  const pieces = Array.from({ length: TEST_ID_NO.length - 3 }, (_, i) =>
    TEST_ID_NO.slice(i, i + 4),
  );
  for (const line of lines) {
    const msg = String(line['msg']);
    for (const secret of [...LISTED, OUTSIDER, TEST_NAME, TEST_APP, ...pieces]) {
      expect(msg.includes(secret)).toBe(false);
    }
  }
  for (const secret of [TEST_NAME, ...pieces, OUTSIDER, LISTED[0]!]) {
    expect(text.includes(secret)).toBe(false);
  }
});

it('[AC-B1-13n#u5] 名单为空时为 null；staging 以外带名单构造即抛错（不带名单与提交值）；构造后 appEnv 若变为非 staging，每次调用再判、不判一致', async () => {
  const { logger, lines } = memoryLogger();
  for (const appEnv of ['staging', 'prod']) {
    for (const userIds of [null, []]) {
      expect(createStagingTestRealnameVerifier({ appEnv, userIds, logger })).toBeNull();
    }
  }
  for (const appEnv of ['prod', 'local', 'test', 'Staging', ' staging', '']) {
    let message = '';
    try {
      createStagingTestRealnameVerifier({ appEnv, userIds: LISTED, logger });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, appEnv).toMatch(/only when APP_ENV is staging/);
    for (const secret of LISTED) expect(message.includes(secret)).toBe(false);
  }
  expect(lines).toHaveLength(0);

  const options: { appEnv: string; userIds: readonly string[]; logger: typeof logger } = {
    appEnv: 'staging',
    userIds: LISTED,
    logger,
  };
  const verifier = createStagingTestRealnameVerifier(options);
  options.appEnv = 'prod';
  await expect(verifier!.verify(input(LISTED[0]!))).resolves.toEqual({ outcome: 'unavailable' });
  expect(lines.filter((line) => line['event'] === STAGING_TEST_REALNAME_AUDIT_EVENT)).toHaveLength(
    0,
  );
});
