// Rule tests of the real worker and payout process entries against a real PostgreSQL (contract
// section 10 of apps/api/src/modules/platform/queue/index.ts: the keep-alive timer of the worker
// entries stays until a job runner keeps the process alive; shutdown on SIGTERM). Gap 4 of
// followups B1-01g: after `started`, an entry that receives no signal does not exit on its own —
// in particular not once its idle database connections have been released (pg's default idle
// timeout is 10 s) — and it still stops cleanly on SIGTERM afterwards.
// The entries run as child processes from apps/api/dist (`node dist/main.<entry>.js`, as
// entries.int.test.ts does); the test first brings that build up to date with `tsc -b apps/api`
// (incremental). Each test gets its own clone of the migrated template and the entry connects as
// its business role. Top-level it() only (规划/11 §4.3).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(ROOT, 'apps/api');

/** How long the entry must stay up after `started` without a signal. */
const QUIET_MS = 20_000;

/** Builds apps/api (incremental); returns '' on success or what went wrong. */
function build(): string {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-b', API_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0)
    return `tsc -b apps/api: ${result.stdout}${result.stderr}`.slice(0, 2000);
  return '';
}

interface Run {
  /** Whether a `started` line appeared. */
  readonly started: boolean;
  /** Whether the child was still running QUIET_MS after `started` (no signal sent before). */
  readonly aliveAfterQuiet: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly messages: string[];
}

/**
 * Runs `node dist/main.<entry>.js` with a minimal environment pointing at `url`; once `started`
 * appeared, waits QUIET_MS without signalling, records whether the child is still running, then
 * sends SIGTERM. Kills the child with SIGKILL after `limitMs`.
 */
async function runEntry(entry: 'worker' | 'payout', url: string, limitMs: number): Promise<Run> {
  const env: Record<string, string> = { APP_ENV: 'test', LOG_LEVEL: 'info', DATABASE_URL: url };
  if (entry === 'worker') env.REDIS_URL = 'redis://127.0.0.1:1/0';
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = spawn(process.execPath, [path.join(API_DIR, 'dist', `main.${entry}.js`)], {
    cwd: API_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let exited = false;
  const started = Promise.withResolvers<boolean>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (/"msg":"started"/.test(stdout)) started.resolve(true);
  });
  child.stderr.on('data', () => undefined);
  const killer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  child.on('exit', () => {
    exited = true;
    started.resolve(false);
  });
  // 'close' fires only after the child exited and its stdio streams ended, so every stdout chunk
  // has been appended before the log is parsed below ('exit' can precede the last 'data').
  const exit = new Promise<[number | null, string | null]>((resolve) => {
    child.on('close', (exitCode, exitSignal) => {
      exited = true;
      started.resolve(false);
      resolve([exitCode, exitSignal]);
    });
  });
  const didStart = await started.promise;
  let aliveAfterQuiet = false;
  if (didStart) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, QUIET_MS);
    });
    aliveAfterQuiet = !exited;
    child.kill('SIGTERM');
  }
  const [code, signal] = await exit;
  clearTimeout(killer);
  const messages = stdout
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => {
      try {
        return String((JSON.parse(text) as { msg?: unknown }).msg);
      } catch {
        return `(not JSON) ${text}`;
      }
    });
  return { started: didStart, aliveAfterQuiet, code, signal, messages };
}

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

for (const entry of ['worker', 'payout'] as const) {
  it(`[AC-B1-01zm#4] 真实 ${entry} 入口连库报告 started 后，未收到信号的 ${QUIET_MS / 1000} 秒内不自行退出（超过空闲连接释放时间）；之后收到 SIGTERM 以 0 退出并有 stopped，无 startup_failed / shutdown_failed`, async () => {
    const built = build();
    const run = await withDatabase(async (database) =>
      runEntry(
        entry,
        database.urlFor(entry === 'payout' ? 'couli_payout' : 'couli_app'),
        QUIET_MS + 40_000,
      ),
    );
    expect({
      built,
      started: run.started,
      aliveAfterQuiet: run.aliveAfterQuiet,
      code: run.code,
      signal: run.signal,
      stopped: run.messages.includes('stopped'),
      failed: run.messages.filter((msg) => msg === 'startup_failed' || msg === 'shutdown_failed'),
    }).toEqual({
      built: '',
      started: true,
      aliveAfterQuiet: true,
      code: 0,
      signal: null,
      stopped: true,
      failed: [],
    });
  }, 180_000);
}
