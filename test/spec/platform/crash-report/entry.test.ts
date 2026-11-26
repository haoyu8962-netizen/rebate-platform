// [AC-QA-13d#1] All five processes start through runEntry (apps/api/src/entry.ts), and runEntry
// starts crash reporting once per process, at start-up — before the application / worker context
// is built, so a failing start-up can be reported — with the entry's name and its loaded
// configuration. With CRASH_REPORT_DSN unset the real startCrashReporting runs (spied, not
// replaced) and start-up is unaffected: `started` is logged and the exit code stays as it was.
// With CRASH_REPORT_DSN set (payout: an internal host; the others: a public one) runEntry still
// starts it exactly once, with the configuration holding that DSN; the real startCrashReporting
// then runs with only its fetch and process swapped for a fake fetch and a stand-in process (never
// the network, never the Vitest worker's own process), it is enabled, and an error captured during
// start-up reaches the fake fetch as one event, sent with POST to the DSN's envelope endpoint — so
// a runEntry that calls it but drops or clears the DSN fails.
// As in test/spec/platform/metrics/entry.test.ts, the configuration, database handles and Nest
// application / worker context are stand-ins (COULI_EXIT_AFTER_INIT=1); nothing listens and no
// database is reached. Dynamic imports keep Nest decorators out of the spec project's compilation.
import { afterEach, expect, it, vi } from 'vitest';
import * as crashReport from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import type {
  CrashReporter,
  CrashReportOptions,
} from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import * as platform from '../../../../apps/api/src/modules/platform/index.ts';
import type { DbHandles } from '../../../../apps/api/src/modules/platform/index.ts';
import { ROOT } from '../tracing/kit.ts';
import {
  DSN_VAR,
  ENTRIES,
  FakeProcess,
  INTERNAL_DSN,
  PUBLIC_DSN,
  configOf,
  endpointOf,
  fakeFetch,
  memoryLogger,
  sentEvents,
  type Entry,
} from './kit.ts';

interface Boot {
  createHttpApp(...args: unknown[]): Promise<unknown>;
  createWorkerContext(...args: unknown[]): Promise<unknown>;
}

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

/** The real startCrashReporting, taken before any spy is installed. */
const realStart = crashReport.startCrashReporting;

function probeOf(entry: Entry): string {
  return `qa13d-entry-${entry} start-up probe`;
}

async function fixture(entry: Entry, dsn?: string) {
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as Boot;
  const { runEntry } = (await import(new URL('apps/api/src/entry.ts', ROOT).href)) as {
    runEntry(entry: Entry): Promise<void>;
  };
  // Everything real is computed before the spies are installed.
  const config = configOf({
    COULI_EXIT_AFTER_INIT: '1',
    ...(dsn === undefined ? {} : { [DSN_VAR]: dsn }),
  });
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
  const transport = fakeFetch('ok', undefined, dsn === undefined ? {} : { dsn });
  const fake = new FakeProcess();
  const started: Promise<CrashReporter>[] = [];
  // Spied on the platform surface and on the module, whichever the entry imports; both call through.
  const viaPlatform = vi.spyOn(platform, 'startCrashReporting');
  const viaModule = vi.spyOn(crashReport, 'startCrashReporting');
  if (dsn !== undefined) {
    // Everything runEntry passes is kept; only the transport's fetch and the hooked process change.
    const swapped = (options: CrashReportOptions): Promise<CrashReporter> => {
      const reporter = realStart({ ...options, fetch: transport.fetch, process: fake });
      started.push(reporter);
      return reporter;
    };
    viaPlatform.mockImplementation(swapped);
    viaModule.mockImplementation(swapped);
  }
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
    // With a DSN: an error captured while the process starts (the reporter is surely open here).
    const reporter = await started[0];
    if (reporter !== undefined) {
      reporter.captureException(new Error(probeOf(entry)));
      await reporter.flush(2_000);
    }
    return standIn;
  };
  vi.spyOn(boot, 'createHttpApp').mockImplementation(build);
  vi.spyOn(boot, 'createWorkerContext').mockImplementation(build);
  return { runEntry, config, records, calls, atBuild, transport, started };
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

it.each(ENTRIES.map((entry) => [entry]))(
  '[AC-QA-13d#1] runEntry(%s) with CRASH_REPORT_DSN set initialises once with that DSN, and the process reports',
  async (entry: Entry) => {
    const dsn = entry === 'payout' ? INTERNAL_DSN : PUBLIC_DSN;
    const f = await fixture(entry, dsn);
    try {
      await f.runEntry(entry);
      expect(f.calls()).toHaveLength(1);
      expect(f.calls()[0]?.[0]).toMatchObject({ entry, config: f.config });
      expect(f.started).toHaveLength(1);
      expect(f.atBuild).toEqual([1]);
      expect(process.exitCode, `${entry} failed to start`).toBe(originalExitCode);
      expect(f.records().map((record) => record.msg)).toContain('started');
      const reporter = await f.started[0];
      expect(reporter?.enabled).toBe(true);
      const events = await sentEvents(f.transport.requests);
      const values = events.flatMap((event) => event.exception?.values ?? []);
      expect(values.map((value) => value.value)).toEqual([probeOf(entry)]);
      // Hand-written endpoints: <scheme>://<host>/api/<project id>/envelope/ of the two DSNs.
      const endpoint =
        entry === 'payout'
          ? 'http://172.20.0.5:8000/api/3/envelope/'
          : 'https://glitchtip.example.com/api/3/envelope/';
      const sent = f.transport.requests.map((request) => ({
        method: request.method,
        endpoint: endpointOf(request.url),
        status: request.status,
      }));
      expect(sent).toEqual(sent.map(() => ({ method: 'POST', endpoint, status: 200 })));
    } finally {
      const reporter = await f.started[0]?.catch(() => undefined);
      await reporter?.close(1_000);
    }
  },
  30_000,
);
