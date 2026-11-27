// [AC-QA-13d#1] CRASH_REPORT_DSN goes through loadConfig (apps/api AGENTS.md hard rule 6), shaped
// like OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: an optional http(s) GlitchTip DSN
// (`<scheme>://<public key>@<host>/<numeric project id>`); anything else refuses to start with a
// ConfigError naming the variable and never quoting the value (DSN 不进日志). A valid DSN loads and
// enables crash reporting on api. Reports go to a fake fetch; nothing reaches the network.
import { expect, it } from 'vitest';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  PUBLIC_KEY,
  configOf,
  dsnFor,
  fakeFetch,
  memoryLogger,
} from './kit.ts';

function failureOf(env: Record<string, string>): unknown {
  try {
    configOf(env);
  } catch (error) {
    return error;
  }
  return 'loadConfig accepted it';
}

it.each([
  ['ftp scheme', `ftp://${PUBLIC_KEY}@qa13d-m1.example.test/3`, 'qa13d-m1'],
  ['file scheme', `file://${PUBLIC_KEY}@qa13d-m2/3`, 'qa13d-m2'],
  ['no scheme', `${PUBLIC_KEY}@qa13d-m3.example.test/3`, 'qa13d-m3'],
  ['not a URL', 'not a dsn qa13d-m4', 'qa13d-m4'],
  ['no public key', 'https://qa13d-m5.example.test/3', 'qa13d-m5'],
  ['no project id', `https://${PUBLIC_KEY}@qa13d-m6.example.test/`, 'qa13d-m6'],
  ['no path', `https://${PUBLIC_KEY}@qa13d-m7.example.test`, 'qa13d-m7'],
  ['a non-numeric project id', `https://${PUBLIC_KEY}@qa13d-m8.example.test/abc`, 'qa13d-m8'],
] as const)(
  '[AC-QA-13d#1] CRASH_REPORT_DSN with %s is refused without quoting it',
  (_case, value, marker) => {
    const failure = failureOf({ [DSN_VAR]: value });
    expect(failure).toBeInstanceOf(ConfigError);
    const error = failure as ConfigError;
    expect(error.problems.some((problem) => problem.startsWith(`${DSN_VAR}:`))).toBe(true);
    const text = `${error.message}\n${error.problems.join('\n')}`;
    expect(text).not.toContain(marker);
    expect(text).not.toContain(PUBLIC_KEY);
  },
);

it('[AC-QA-13d#1] DSN problems are reported together with the other configuration problems', () => {
  const failure = failureOf({
    API_PORT: 'bad-port',
    [DSN_VAR]: `ftp://${PUBLIC_KEY}@qa13d-m9.example.test/3`,
  });
  expect(failure).toBeInstanceOf(ConfigError);
  const error = failure as ConfigError;
  expect(error.problems.some((problem) => problem.startsWith('API_PORT:'))).toBe(true);
  expect(error.problems.some((problem) => problem.startsWith(`${DSN_VAR}:`))).toBe(true);
  expect(error.message).not.toContain('qa13d-m9');
  expect(error.message).not.toContain(PUBLIC_KEY);
});

it.each([
  dsnFor('glitchtip.example.test'),
  dsnFor('172.20.0.5:8000', 'http'),
  dsnFor('10.1.2.3', 'http', '12'),
  dsnFor('glitchtip.internal:8443', 'https', '7'),
])(
  '[AC-QA-13d#1] CRASH_REPORT_DSN=%s loads, and with it crash reporting is enabled on the api entry',
  async (dsn) => {
    const config = configOf({ [DSN_VAR]: dsn });
    const { logger } = memoryLogger('api');
    const reporter = await startCrashReporting({
      entry: 'api',
      config,
      logger,
      fetch: fakeFetch().fetch,
      process: new FakeProcess(),
    });
    try {
      expect(reporter.enabled).toBe(true);
    } finally {
      await reporter.close(1_000);
    }
  },
);
