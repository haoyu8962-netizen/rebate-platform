// [AC-QA-13d#4] In a real process (child.ts, plain `node`): with crash reporting started, an
// uncaught exception and an unhandled rejection still end the process with exit status 1 — what
// Node does without any hook (no existing handler in apps/api) — after the hook attempted the
// report, and within a bounded time even when the report hangs or fails (D10-3244 ②: 只在其前上报、
// 有超时上限；上报失败不得影响进程退出逻辑). A report that completes after a delay completes before
// the process exits (its `sent` line comes before `exit 1`), and the event the child's fake fetch
// decoded is the very error that escaped (for the unhandled rejection too). Without
// CRASH_REPORT_DSN nothing is installed and the exit is Node's own. The fake fetch lives in the
// child; nothing reaches the network.
//
// A child that could not load its modules or start crash reporting is not an exit-behaviour
// result: its original error (type, message, code, child stack) is rethrown here as it was, so a
// NotImplemented skeleton reads as NotImplemented and a missing module or TypeError as what it is.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ChildCrash, ChildException, ChildFailure, ChildTransport } from './child.ts';
import { INTERNAL_DSN } from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
/** The longest a hook may hold the process after the error escaped (task: 有超时上限). */
const HOOK_EXIT_LIMIT_MS = 5_000;

interface ChildRun {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lines: readonly string[];
  /** From the `crash-at` line to the end of the process; null without that line. */
  readonly afterCrashMs: number | null;
}

const ERROR_TYPES: Readonly<Record<string, new (message: string) => Error>> = {
  TypeError,
  SyntaxError,
  RangeError,
  ReferenceError,
};

/** The child's own error, rebuilt with its type, message and code. */
function rebuilt(failure: ChildFailure): Error {
  const Type = ERROR_TYPES[failure.name] ?? Error;
  const error = new Type(failure.message);
  if (error.name !== failure.name) error.name = failure.name;
  if (failure.code !== undefined) Object.assign(error, { code: failure.code });
  const where = `[in child.ts, ${failure.stage}]`;
  error.stack = `${error.name}: ${failure.message}\n    ${where}\n${failure.stack}`;
  return error;
}

/** Rethrows what kept the child from arming (load or start failure), keeping its type. */
function rethrowSetupFailure(run: ChildRun): void {
  const line = run.lines.find(
    (candidate) => candidate.startsWith('load-failed ') || candidate.startsWith('setup-failed '),
  );
  if (line !== undefined) {
    throw rebuilt(JSON.parse(line.slice(line.indexOf(' ') + 1)) as ChildFailure);
  }
  if (run.lines.some((candidate) => candidate.startsWith('armed '))) return;
  // The child did not even reach its own report (child.ts itself failed to load): Node's report.
  const nodeReport = /^(\w*Error)(?: \[(\w+)\])?: (.*)$/m.exec(run.stderr);
  const unarmed = `child ended (status ${String(run.status)}) unarmed: ${run.stderr}`;
  throw rebuilt({
    stage: 'load',
    name: nodeReport?.[1] ?? 'Error',
    message: nodeReport?.[3] ?? unarmed,
    ...(nodeReport?.[2] === undefined ? {} : { code: nodeReport[2] }),
    stack: run.stderr,
  });
}

function runChild(crash: ChildCrash, transport: ChildTransport, dsn: string): ChildRun {
  const spawned = spawnSync(process.execPath, [CHILD, crash, transport, dsn], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ended = Date.now();
  const crashAt = /^crash-at (\d+)$/m.exec(spawned.stdout)?.[1];
  const run: ChildRun = {
    status: spawned.status,
    signal: spawned.signal,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    lines: spawned.stdout.split('\n').filter((line) => line !== ''),
    afterCrashMs: crashAt === undefined ? null : ended - Number(crashAt),
  };
  rethrowSetupFailure(run);
  return run;
}

/** The exceptions of every event the child's fake fetch decoded. */
function reported(lines: readonly string[]): ChildException[] {
  return lines
    .filter((line) => line.startsWith('event '))
    .flatMap((line) => JSON.parse(line.slice('event '.length)) as ChildException[]);
}

function messageOf(crash: ChildCrash): string {
  return crash === 'rejection' ? 'qa13d-child-rejection' : 'qa13d-child-uncaught';
}

it.each([
  ['uncaught', 'ok'],
  ['uncaught', 'fail'],
  ['uncaught', 'hang'],
  ['rejection', 'ok'],
  ['rejection', 'fail'],
  ['rejection', 'hang'],
] as const)(
  '[AC-QA-13d#4] %s with fetch %s: reported first, exit status 1, within the limit',
  (crash: ChildCrash, transport: ChildTransport) => {
    const run = runChild(crash, transport, INTERNAL_DSN);
    expect(run.stdout).toContain('armed enabled=true');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    const crashLine = run.lines.findIndex((line) => line.startsWith('crash-at '));
    expect(crashLine).toBeGreaterThanOrEqual(0);
    expect(run.lines.slice(crashLine + 1)).toContain('fetch');
    expect(run.afterCrashMs).not.toBeNull();
    expect(run.afterCrashMs ?? Infinity).toBeLessThan(HOOK_EXIT_LIMIT_MS);
  },
  40_000,
);

it.each(['uncaught', 'rejection'] as const)(
  '[AC-QA-13d#4] %s with a report answered after a delay: the escaped error is reported and the send completes before the exit',
  (crash: ChildCrash) => {
    const run = runChild(crash, 'slow', INTERNAL_DSN);
    expect(run.stdout).toContain('armed enabled=true');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    const after = run.lines.slice(run.lines.findIndex((line) => line.startsWith('crash-at ')));
    expect(after[0] ?? 'no crash-at line').toMatch(/^crash-at /);
    // fetch called, then its answer handed back (`sent`), then the process exits.
    const order = ['fetch', 'sent', 'exit 1'].map((line) => after.indexOf(line));
    expect(order.map((index) => index >= 0)).toEqual([true, true, true]);
    expect(order[0] ?? -1).toBeLessThan(order[1] ?? -1);
    expect(order[1] ?? -1).toBeLessThan(order[2] ?? -1);
    const values = reported(after).map((exception) => exception.value ?? '');
    expect(values.filter((value) => value.includes(messageOf(crash)))).toHaveLength(1);
    expect(run.afterCrashMs ?? Infinity).toBeLessThan(HOOK_EXIT_LIMIT_MS);
  },
  40_000,
);

it.each(['uncaught', 'rejection'] as const)(
  '[AC-QA-13d#1] %s without CRASH_REPORT_DSN: nothing installed, Node exits with status 1 at once',
  (crash: ChildCrash) => {
    const run = runChild(crash, 'ok', '');
    expect(run.stdout).toContain('armed enabled=false');
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    expect(run.lines).not.toContain('fetch');
    expect(run.afterCrashMs ?? Infinity).toBeLessThan(HOOK_EXIT_LIMIT_MS);
  },
  40_000,
);
