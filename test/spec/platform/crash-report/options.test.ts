// [AC-QA-13d#5] The initialisation parameters, locked by explicit values (01 F-OBS-01「CI 用快照测试
// 检查初始化参数」; not a snapshot file, which would pass on its first run): the client bound by
// initAndBind has the configured DSN, environment = APP_ENV, release = COULI_DEPLOY_VERSION when it
// is set and none otherwise, sendDefaultPii false, no performance tracing, profiling or session
// replay, a beforeSend filter, a transport and a Node stack parser (which reads Node stack lines),
// the dedupe and linked-errors integrations and none for tracing / profiling / replay / sessions.
// Crash reporting is built on @sentry/core only (no @sentry/node, no OpenTelemetry), and starting it
// takes nothing over from tracing: the OpenTelemetry footprint is unchanged.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  dsnFor,
  fakeFetch,
  memoryLogger,
  sentryClient,
  tracingFootprint,
  type StackFrame,
} from './kit.ts';

const DSN = dsnFor('glitchtip.example.test');
const RELEASE = 'qa13d-build.7';
const MODULE_DIR = fileURLToPath(
  new URL('../../../../apps/api/src/modules/platform/crash-report/', import.meta.url),
);
const PACKAGE_JSON = new URL('../../../../apps/api/package.json', import.meta.url);
/** Node stack lines: a named frame, an async frame with a file URL, an anonymous frame. */
const STACK = [
  'Error: qa13d parse',
  '    at handle (/srv/couli/dist/modules/orders/handler.js:42:13)',
  '    at async run (file:///srv/couli/dist/entry.js:7:5)',
  '    at /srv/couli/dist/main.js:3:9',
].join('\n');

/** The parameters this test locks, read from the client's options. */
function lockedOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    dsn: options['dsn'],
    environment: options['environment'],
    release: options['release'],
    sendDefaultPii: options['sendDefaultPii'],
    tracesSampleRate: options['tracesSampleRate'],
    tracesSampler: options['tracesSampler'],
    profilesSampleRate: options['profilesSampleRate'],
    profilesSampler: options['profilesSampler'],
    profileSessionSampleRate: options['profileSessionSampleRate'],
    replaysSessionSampleRate: options['replaysSessionSampleRate'],
    replaysOnErrorSampleRate: options['replaysOnErrorSampleRate'],
    beforeSend: typeof options['beforeSend'],
    transport: typeof options['transport'],
    stackParser: typeof options['stackParser'],
  };
}

function integrationNames(options: Readonly<Record<string, unknown>>): string[] {
  const integrations = (options['integrations'] ?? []) as readonly { name?: unknown }[];
  return integrations.map((integration) => String(integration.name));
}

/** Every module source of crash-report (unit tests excluded). */
function moduleSources(): string {
  return readdirSync(MODULE_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => readFileSync(`${MODULE_DIR}/${name}`, 'utf8'))
    .join('\n');
}

it.each([
  ['test', RELEASE],
  ['local', undefined],
  ['test', undefined],
] as const)(
  '[AC-QA-13d#5] APP_ENV=%s, COULI_DEPLOY_VERSION=%s: the locked initialisation parameters',
  async (appEnv, release) => {
    const env = {
      APP_ENV: appEnv,
      [DSN_VAR]: DSN,
      ...(release === undefined ? {} : { COULI_DEPLOY_VERSION: release }),
    };
    const { logger } = memoryLogger('worker');
    const footprint = tracingFootprint();
    const reporter = await startCrashReporting({
      entry: 'worker',
      config: loadConfig(env),
      logger,
      fetch: fakeFetch().fetch,
      process: new FakeProcess(),
    });
    try {
      expect(reporter.enabled).toBe(true);
      const options = sentryClient()?.getOptions() ?? {};
      expect(lockedOptions(options)).toEqual({
        dsn: DSN,
        environment: appEnv,
        release,
        sendDefaultPii: false,
        tracesSampleRate: undefined,
        tracesSampler: undefined,
        profilesSampleRate: undefined,
        profilesSampler: undefined,
        profileSessionSampleRate: undefined,
        replaysSessionSampleRate: undefined,
        replaysOnErrorSampleRate: undefined,
        beforeSend: 'function',
        transport: 'function',
        stackParser: 'function',
      });
      const names = integrationNames(options);
      expect(names).toEqual(expect.arrayContaining(['Dedupe', 'LinkedErrors']));
      const forbidden = /trac|otel|telemetry|profil|replay|session/i;
      expect(names.filter((name) => forbidden.test(name))).toEqual([]);
      expect(tracingFootprint()).toEqual(footprint);
    } finally {
      await reporter.close(1_000);
    }
  },
);

it('[AC-QA-13d#5] the stack parser reads Node stack lines (file, function, line, column)', async () => {
  const { logger } = memoryLogger('api');
  const reporter = await startCrashReporting({
    entry: 'api',
    config: loadConfig({ APP_ENV: 'test', [DSN_VAR]: DSN }),
    logger,
    fetch: fakeFetch().fetch,
    process: new FakeProcess(),
  });
  try {
    expect(reporter.enabled).toBe(true);
    const parse = sentryClient()?.getOptions()['stackParser'] as (stack: string) => StackFrame[];
    expect(typeof parse).toBe('function');
    const frames = parse(STACK);
    const handle = frames.find((frame) => frame.lineno === 42);
    expect(handle).toMatchObject({
      filename: '/srv/couli/dist/modules/orders/handler.js',
      function: 'handle',
      colno: 13,
    });
    const run = frames.find((frame) => frame.lineno === 7);
    expect(run?.colno).toBe(5);
    expect(run?.filename ?? '').toMatch(/\/srv\/couli\/dist\/entry\.js$/);
    const main = frames.find((frame) => frame.lineno === 3);
    expect(main).toMatchObject({ filename: '/srv/couli/dist/main.js', colno: 9 });
  } finally {
    await reporter.close(1_000);
  }
});

it('[AC-QA-13d#5] crash reporting is built on @sentry/core only: no @sentry/node, no OpenTelemetry', async () => {
  const { logger } = memoryLogger('api');
  const reporter = await startCrashReporting({
    entry: 'api',
    config: loadConfig({ APP_ENV: 'test', [DSN_VAR]: DSN }),
    logger,
    fetch: fakeFetch().fetch,
    process: new FakeProcess(),
  });
  try {
    expect(reporter.enabled).toBe(true);
    const sources = moduleSources();
    expect(sources).toMatch(/from '@sentry\/core'/);
    expect(sources).not.toMatch(/@sentry\/node|@sentry\/opentelemetry|@opentelemetry\//);
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { dependencies?: object };
    const dependencies = Object.keys(pkg.dependencies ?? {});
    expect(dependencies.filter((name) => name.startsWith('@sentry/'))).toEqual(['@sentry/core']);
  } finally {
    await reporter.close(1_000);
  }
});
