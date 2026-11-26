// [AC-QA-13d#6] The DSN is read only from the environment (through loadConfig) and never written to
// the logs: starting crash reporting, reporting, failed sends (unreachable server, error status),
// flushing and closing leave neither the DSN nor its public key in any log line, at any level, on
// every entry (payout with an internal DSN, the others with a public one). The logger records every
// level (trace and up). Reports go to a fake fetch; nothing reaches the network.
//
// [AC-QA-13d#4] logger.error-level errors are reported (task: 未处理异常、未处理拒绝与 logger.error 级
// 的错误上报): once crash reporting started, an error line carrying an Error — on the real pino root
// logger handed to startCrashReporting and on a child logger made from it afterwards — sends one
// event of that Error, with the personal data in its message removed. When sending then fails
// (unreachable, throwing fetch, no answer) the log call still returns at once without throwing, its
// line is still written, and nothing ends up as an unhandled rejection.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  DSN_VAR,
  ENTRIES,
  FakeProcess,
  INTERNAL_DSN,
  PUBLIC_DSN,
  PUBLIC_KEY,
  configOf,
  failureText,
  fakeFetch,
  memoryLogger,
  sentEvents,
  sentText,
  settle,
  sleep,
  type Entry,
  type FetchMode,
} from './kit.ts';

const PHONE = '13912345678';

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', recordUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
});

const MODES = ['ok', 'fail', 'error'] as const;

function casesOf(entry: Entry): (readonly [Entry, FetchMode])[] {
  return MODES.map((mode) => [entry, mode] as const);
}

const CASES = ENTRIES.flatMap(casesOf);

it.each(CASES)(
  '[AC-QA-13d#6] %s with fetch mode %s: no log line holds the DSN or its public key',
  async (entry: Entry, mode: FetchMode) => {
    const dsn = entry === 'payout' ? INTERNAL_DSN : PUBLIC_DSN;
    const { logger, lines } = memoryLogger(entry);
    const transport = fakeFetch(mode);
    const reporter = await startCrashReporting({
      entry,
      config: configOf({ [DSN_VAR]: dsn }),
      logger,
      fetch: transport.fetch,
      process: new FakeProcess(),
    });
    try {
      expect(reporter.enabled).toBe(true);
      reporter.captureException(new Error(`qa13d-logs ${entry} ${mode}`));
      await reporter.flush(1_000);
    } finally {
      await reporter.close(1_000);
    }
    expect(transport.requests.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    expect(text).not.toContain(dsn);
    expect(text).not.toContain(PUBLIC_KEY);
  },
);

it.each([['root'], ['child']] as const)(
  '[AC-QA-13d#4] an error line with an Error on the %s logger is reported scrubbed; a failing send leaves the log call alone',
  async (which: 'root' | 'child') => {
    const { logger, lines } = memoryLogger('worker');
    const transport = fakeFetch('ok', undefined, { dsn: PUBLIC_DSN });
    const reporter = await startCrashReporting({
      entry: 'worker',
      config: configOf({ [DSN_VAR]: PUBLIC_DSN }),
      logger,
      fetch: transport.fetch,
      process: new FakeProcess(),
    });
    const failed: string[] = [];
    try {
      expect(reporter.enabled).toBe(true);
      const target: RootLogger = which === 'root' ? logger : logger.child({ module: 'payout' });
      const marker = `qa13d-log-${which}`;
      const err = new Error(`${marker} shutdown of payee phone ${PHONE} failed`);
      const logged = await settle(() => target.error({ err }, 'shutdown_failed'));
      expect(failureText(logged)).toBe('returned');
      await reporter.flush(2_000);
      const events = await sentEvents(transport.requests);
      const values = events.flatMap((event) => event.exception?.values ?? []);
      expect(values.filter((value) => (value.value ?? '').includes(marker))).toHaveLength(1);
      expect(await sentText(transport.requests)).not.toContain(PHONE);
      expect(transport.requests.every((request) => request.status === 200)).toBe(true);
      // Sending fails from now on: the log call is unaffected.
      for (const mode of ['fail', 'throw', 'hang'] as const) {
        transport.mode = mode;
        const before = lines.length;
        const again = `${marker}-${mode}`;
        const began = performance.now();
        const outcome = await settle(() => target.error({ err: new Error(again) }, 'job_failed'));
        if (failureText(outcome) !== 'returned') failed.push(`${mode}: ${failureText(outcome)}`);
        if (performance.now() - began >= 250) failed.push(`${mode}: the log call waited`);
        if (!lines.slice(before).some((line) => line.includes(again))) {
          failed.push(`${mode}: no log line`);
        }
      }
      await settle(() => reporter.flush(300));
    } finally {
      await reporter.close(300);
    }
    expect(failed).toEqual([]);
    await sleep(50);
    expect(unhandled).toEqual([]);
  },
  15_000,
);
