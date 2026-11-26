// [AC-QA-13d#6] The DSN is read only from the environment (through loadConfig) and never written to
// the logs: starting crash reporting, reporting, failed sends (unreachable server, error status),
// flushing and closing leave neither the DSN nor its public key in any log line, at any level, on
// every entry (payout with an internal DSN, the others with a public one). The logger records every
// level (trace and up). Reports go to a fake fetch; nothing reaches the network.
import { expect, it } from 'vitest';
import { startCrashReporting } from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  ENTRIES,
  FakeProcess,
  INTERNAL_DSN,
  PUBLIC_DSN,
  PUBLIC_KEY,
  configOf,
  fakeFetch,
  memoryLogger,
  type Entry,
  type FetchMode,
} from './kit.ts';

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
