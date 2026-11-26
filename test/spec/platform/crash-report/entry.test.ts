// [AC-QA-13d#1] All five processes start through runEntry (apps/api/src/entry.ts), and runEntry
// starts crash reporting once per process, at start-up — before the application / worker context
// is built, so a failing start-up can be reported — with the entry's name and its loaded
// configuration. With CRASH_REPORT_DSN unset the real startCrashReporting runs (spied, not
// replaced) and start-up is unaffected: `started` is logged and the exit code stays as it was.
// As in test/spec/platform/metrics/entry.test.ts, the configuration, database handles and Nest
// application / worker context are stand-ins (COULI_EXIT_AFTER_INIT=1); nothing listens and no
// database is reached. Dynamic imports keep Nest decorators out of the spec project's compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as crashReport from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/index.ts';
import { ROOT } from '../tracing/kit.ts';
import { ENTRIES, configOf, memoryLogger, type Entry } from './kit.ts';

interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

async function fixture(entry: Entry) {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  // Everything real is computed before the spies are installed.
  const config = configOf({ COULI_EXIT_AFTER_INIT: '1' });
  const connections = platform.loadConnectionConfig('worker', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
  });
  const { logger, records } = memoryLogger(entry);
  vi.spyOn(platform, 'loadConfig').mockReturnValue(config);
  vi.spyOn(platform, 'loadConnectionConfig').mockReturnValue(connections);
  vi.spyOn(platform, 'loadMaintConnectionConfig').mockReturnValue(null);
  vi.spyOn(platform, 'createRootLogger').mockReturnValue(logger);
  const handles: DbHandles = {
    db: {} as DbHandles['db'],
    dbRead: null,
    close: async () => undefined,
  };
  vi.spyOn(platform, 'createDbHandles').mockReturnValue(handles);
  // Spied on the platform surface and on the module, whichever the entry imports; both call through.
  const viaPlatform = vi.spyOn(platform, 'startCrashReporting');
  const viaModule = vi.spyOn(crashReport, 'startCrashReporting');
  const calls = (): unknown[][] => [...viaPlatform.mock.calls, ...viaModule.mock.calls];
  const atBuild: number[] = [];
  const queue = { start: async () => undefined, stop: async () => undefined };
  const standIn = {
    init: async () => undefined,
    listen: async () => undefined,
    close: async () => undefined,
    get: (token: unknown) => (token === platform.JOB_QUEUE ? queue : null),
  };
  const build = async (): Promise<unknown> => {
    atBuild.push(calls().length);
    return standIn;
  };
  vi.spyOn(boot, 'createHttpApp').mockImplementation(build);
  vi.spyOn(boot, 'createWorkerContext').mockImplementation(build);
  return { runEntry, config, records, calls, atBuild };
}

it.each(ENTRIES.map((entry) => [entry]))(
  '[AC-QA-13d#1] runEntry(%s) starts crash reporting once, before the build; an unset DSN leaves start-up unaffected',
  async (entry: Entry) => {
    expect(typeof platform.startCrashReporting).toBe('function');
    const f = await fixture(entry);
    await f.runEntry(entry);
    expect(f.calls()).toHaveLength(1);
    expect(f.calls()[0]?.[0]).toMatchObject({ entry, config: f.config });
    expect(f.atBuild).toEqual([1]);
    expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
    expect(f.records().map((record) => record.msg)).toContain('started');
  },
  30_000,
);
