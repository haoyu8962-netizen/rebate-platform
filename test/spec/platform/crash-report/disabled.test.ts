// [AC-QA-13d#1] CRASH_REPORT_DSN unset (or empty): startCrashReporting creates nothing — no
// @sentry/core client is bound, no process hook is installed (neither on the injected process nor
// on the real one), captureException sends nothing — and it neither throws nor logs a warning or
// an error, on every one of the five entries. Only loadConfig counts: the variable in process.env
// alone enables nothing (apps/api AGENTS.md hard rule 6). Its own file, so no other test of this
// file has bound a client before.
import { expect, it } from 'vitest';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  ENTRIES,
  FakeProcess,
  INTERNAL_DSN,
  PUBLIC_DSN,
  WARN,
  configOf,
  failureText,
  fakeFetch,
  memoryLogger,
  realHookCounts,
  sentryClient,
  settle,
} from './kit.ts';

it.each(ENTRIES.map((entry) => [entry]))(
  '[AC-QA-13d#1] %s without CRASH_REPORT_DSN: disabled, no client, no hook, nothing sent, no error',
  async (entry) => {
    const { logger, records } = memoryLogger(entry);
    const transport = fakeFetch();
    const fake = new FakeProcess();
    const clientBefore = sentryClient();
    const hooksBefore = realHookCounts();
    const options = { entry, config: configOf(), logger, fetch: transport.fetch, process: fake };
    const outcome = await settle(() => startCrashReporting(options));
    expect(failureText(outcome)).toBe('returned');
    if (!outcome.ok) return;
    const reporter = outcome.value;
    expect(reporter.enabled).toBe(false);
    expect(sentryClient()).toBe(clientBefore);
    expect(fake.hookCount()).toBe(0);
    expect(realHookCounts()).toEqual(hooksBefore);
    const capture = () => reporter.captureException(new Error('qa13d disabled capture'));
    const captured = await settle(capture);
    expect(failureText(captured)).toBe('returned');
    expect(captured.ok ? captured.value : 'threw').toBeUndefined();
    await reporter.flush(200);
    await reporter.close(200);
    expect(transport.requests).toEqual([]);
    expect(records().filter((record) => record.level >= WARN)).toEqual([]);
  },
);

it.each(ENTRIES.map((entry) => [entry]))(
  '[AC-QA-13d#1] %s with an empty CRASH_REPORT_DSN counts as unset',
  async (entry) => {
    const { logger, records } = memoryLogger(entry);
    const transport = fakeFetch();
    const fake = new FakeProcess();
    const reporter = await startCrashReporting({
      entry,
      config: configOf({ [DSN_VAR]: '' }),
      logger,
      fetch: transport.fetch,
      process: fake,
    });
    expect(reporter.enabled).toBe(false);
    expect(fake.hookCount()).toBe(0);
    reporter.captureException(new Error('qa13d empty dsn capture'));
    await reporter.flush(200);
    await reporter.close(200);
    expect(transport.requests).toEqual([]);
    expect(records().filter((record) => record.level >= WARN)).toEqual([]);
  },
);

it('[AC-QA-13d#1] CRASH_REPORT_DSN in process.env alone enables nothing (only loadConfig counts)', async () => {
  const saved = process.env[DSN_VAR];
  process.env[DSN_VAR] = INTERNAL_DSN;
  process.env['SENTRY_DSN'] = PUBLIC_DSN;
  try {
    const { logger } = memoryLogger('api');
    const transport = fakeFetch();
    const fake = new FakeProcess();
    const clientBefore = sentryClient();
    // The configuration was loaded without it (as from an environment that lacks it).
    const reporter = await startCrashReporting({
      entry: 'api',
      config: configOf(),
      logger,
      fetch: transport.fetch,
      process: fake,
    });
    expect(reporter.enabled).toBe(false);
    expect(sentryClient()).toBe(clientBefore);
    expect(fake.hookCount()).toBe(0);
    reporter.captureException(new Error('qa13d env-only capture'));
    await reporter.flush(200);
    expect(transport.requests).toEqual([]);
    await reporter.close(200);
  } finally {
    if (saved === undefined) delete process.env[DSN_VAR];
    else process.env[DSN_VAR] = saved;
    delete process.env['SENTRY_DSN'];
  }
});
