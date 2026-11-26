// [AC-QA-13d#4] In a real process (child.ts, plain `node`): with crash reporting started, an
// uncaught exception and an unhandled rejection still end the process with exit status 1 — what
// Node does without any hook (no existing handler in apps/api) — after the hook attempted the
// report, and within a bounded time even when the report hangs or fails (D10-3244 ②: 只在其前上报、
// 有超时上限；上报失败不得影响进程退出逻辑). Without CRASH_REPORT_DSN nothing is installed and the
// exit is Node's own. The fake fetch lives in the child; nothing reaches the network.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ChildCrash, ChildTransport } from './child.ts';
import { INTERNAL_DSN } from './kit.ts';

const CHILD = fileURLToPath(new URL('./child.ts', import.meta.url));
/** The longest a hook may hold the process after the error escaped (task: 有超时上限). */
const HOOK_EXIT_LIMIT_MS = 5_000;

interface ChildRun {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly lines: readonly string[];
  /** From the `crash-at` line to the end of the process; null without that line. */
  readonly afterCrashMs: number | null;
}

function runChild(crash: ChildCrash, transport: ChildTransport, dsn: string): ChildRun {
  const run = spawnSync(process.execPath, [CHILD, crash, transport, dsn], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ended = Date.now();
  const crashAt = /^crash-at (\d+)$/m.exec(run.stdout)?.[1];
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    lines: run.stdout.split('\n').filter((line) => line !== ''),
    afterCrashMs: crashAt === undefined ? null : ended - Number(crashAt),
  };
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
