// [AC-QA-13d#4] A failing report (server unreachable, no answer, an error status, a fetch that
// throws) never affects the business call: captureException returns at once without throwing, the
// caller's own result is unchanged, flush and close are bounded and never reject, nothing ends up
// as an unhandled rejection, and a later report still goes out. The process hooks (on an injected
// stand-in process; the real process is left alone) report an uncaught exception before they end
// the process with exit code 1 — Node's own exit behaviour — and end it within a bounded time even
// when the report hangs or fails. The real exit behaviour, including unhandled rejections, is
// checked in a child process (exit.test.ts).
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  startCrashReporting,
  type CrashReporter,
} from '../../../../apps/api/src/modules/platform/crash-report/index.ts';
import {
  DSN_VAR,
  FakeProcess,
  configOf,
  dsnFor,
  failureText,
  fakeFetch,
  memoryLogger,
  realHookCounts,
  sentEvents,
  sentText,
  settle,
  sleep,
  waitFor,
  type FakeFetch,
  type FetchMode,
} from './kit.ts';

const DSN = dsnFor('glitchtip.example.test');
/** The longest a hook may hold the process before it exits (task: 有超时上限). */
const HOOK_EXIT_LIMIT_MS = 5_000;

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown): void => void unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', recordUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', recordUnhandled);
});

async function start(
  transport: FakeFetch,
  fake: FakeProcess = new FakeProcess(),
): Promise<CrashReporter> {
  const { logger } = memoryLogger('api');
  return startCrashReporting({
    entry: 'api',
    config: configOf({ [DSN_VAR]: DSN }),
    logger,
    fetch: transport.fetch,
    process: fake,
  });
}

/** A business call that reports the error it handles and answers with its own result. */
function handleRequest(reporter: CrashReporter): { status: number; body: string } {
  try {
    throw new Error('qa13d-business failure');
  } catch (error) {
    reporter.captureException(error);
    return { status: 502, body: 'upstream_unavailable' };
  }
}

/** Emits an uncaught exception on the stand-in process (a hook that rethrows it is tolerated). */
async function crash(fake: FakeProcess, message: string): Promise<void> {
  const error = new Error(message);
  await settle(() => fake.emit('uncaughtException', error, 'uncaughtException'));
}

it.each(['fail', 'hang', 'error', 'throw'] as const)(
  '[AC-QA-13d#4] with fetch mode %s the business call keeps its result and nothing waits or rejects',
  async (mode: FetchMode) => {
    const transport = fakeFetch(mode);
    const reporter = await start(transport);
    try {
      expect(reporter.enabled).toBe(true);
      const began = performance.now();
      const outcome = await settle(() => handleRequest(reporter));
      expect(performance.now() - began).toBeLessThan(250);
      expect(failureText(outcome)).toBe('returned');
      expect(outcome.ok ? outcome.value : undefined).toEqual({
        status: 502,
        body: 'upstream_unavailable',
      });
      const flushStarted = performance.now();
      const flushed = await settle(() => reporter.flush(300));
      expect(failureText(flushed)).toBe('returned');
      expect(performance.now() - flushStarted).toBeLessThan(2_000);
      expect(transport.requests.length).toBeGreaterThan(0);
    } finally {
      const closed = await settle(() => reporter.close(300));
      expect(failureText(closed)).toBe('returned');
    }
    await sleep(50);
    expect(unhandled).toEqual([]);
  },
  15_000,
);

it('[AC-QA-13d#4] after failed reports a later report still goes out', async () => {
  const transport = fakeFetch('fail');
  const reporter = await start(transport);
  try {
    reporter.captureException(new Error('qa13d-first while unreachable'));
    await reporter.flush(500);
    transport.mode = 'ok';
    reporter.captureException(new Error('qa13d-second once reachable'));
    await reporter.flush(2_000);
  } finally {
    await reporter.close(500);
  }
  expect(await sentText(transport.requests)).toContain('qa13d-second once reachable');
  expect(unhandled).toEqual([]);
});

it('[AC-QA-13d#4] an uncaught exception is reported first, then the process exits with code 1', async () => {
  const log: string[] = [];
  const transport = fakeFetch('ok', log);
  const fake = new FakeProcess(log);
  const hooksBefore = realHookCounts();
  const reporter = await start(transport, fake);
  try {
    expect(reporter.enabled).toBe(true);
    expect(realHookCounts()).toEqual(hooksBefore);
    await crash(fake, 'qa13d-uncaught');
    expect(await waitFor(() => fake.exits.length > 0, HOOK_EXIT_LIMIT_MS + 1_000)).toBe(true);
    await sleep(100);
    expect(fake.exits).toEqual([1]);
    expect(log.indexOf('fetch')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('fetch')).toBeLessThan(log.indexOf('exit:1'));
    const events = await sentEvents(transport.requests);
    const values = events.flatMap((event) => event.exception?.values ?? []);
    expect(values.some((value) => (value.value ?? '').includes('qa13d-uncaught'))).toBe(true);
  } finally {
    await reporter.close(300);
  }
}, 15_000);

it.each(['hang', 'fail'] as const)(
  '[AC-QA-13d#4] with fetch mode %s an uncaught exception still exits with code 1 within the limit',
  async (mode: FetchMode) => {
    const transport = fakeFetch(mode);
    const fake = new FakeProcess();
    const reporter = await start(transport, fake);
    try {
      expect(reporter.enabled).toBe(true);
      const began = performance.now();
      await crash(fake, 'qa13d-hook-stuck');
      expect(await waitFor(() => fake.exits.length > 0, HOOK_EXIT_LIMIT_MS + 1_000)).toBe(true);
      expect(performance.now() - began).toBeLessThan(HOOK_EXIT_LIMIT_MS);
      await sleep(100);
      expect(fake.exits).toEqual([1]);
      expect(transport.requests.length).toBeGreaterThan(0);
    } finally {
      await reporter.close(300);
    }
  },
  15_000,
);
