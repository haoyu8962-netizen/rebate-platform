// Rule tests of the real worker and payout process entries against a real PostgreSQL
// (ADR-0001 §4.2 第 14 项「进程一律 migrate:false；库版本与 schema 版本不一致时拒绝启动」; contract
// section 10 of apps/api/src/modules/platform/queue/index.ts: the entries start the queue runtime
// before they report `started`, and a failed start is `startup_failed` with exit code 1).
// The entries run as child processes from apps/api/dist (`node dist/main.<entry>.js`, as
// apps/api/scripts/smoke-entries.ts does); the test first brings that build up to date with
// `tsc -b apps/api` (incremental). Each test gets its own clone of the migrated template and the
// entry connects as its business role. Top-level it() only (规划/11 §4.3).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { leaksIn } from '../db/kit.ts';
import { closeObserver, observerOn } from './int-kit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(ROOT, 'apps/api');

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
  readonly code: number | null;
  readonly signal: string | null;
  readonly messages: string[];
  readonly entries: string[];
  readonly text: string;
}

/**
 * Runs `node dist/main.<entry>.js` with a minimal environment pointing at `url`. With
 * `stopAfterStarted`, sends SIGTERM once a `started` line appeared. Kills the child after
 * `limitMs` (signal SIGKILL in the result).
 */
async function runEntry(
  entry: 'worker' | 'payout',
  url: string,
  stopAfterStarted: boolean,
  limitMs = 15_000,
): Promise<Run> {
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
  let stderr = '';
  let signalled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stopAfterStarted && !signalled && /"msg":"started"/.test(stdout)) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  // 'close' fires only after the child exited and its stdio streams ended, so every stdout chunk
  // has been appended before the log is parsed below ('exit' can precede the last 'data').
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.on('close', (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal]);
    });
  });
  clearTimeout(timer);
  const records = stdout
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => {
      try {
        return JSON.parse(text) as { msg?: unknown; entry?: unknown };
      } catch {
        return { msg: `(not JSON) ${text}`, entry: null };
      }
    });
  return {
    code,
    signal,
    messages: records.map((record) => String(record.msg)),
    entries: [...new Set(records.map((record) => String(record.entry)))],
    text: `${stdout}\n${stderr}`,
  };
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
  it(`[ADR-0001 §4.2 #14 库版本与 schema 版本不一致时拒绝启动; contract §10] 真实 ${entry} 入口：pgboss.version 为 41 时以退出码 1 结束，有 startup_failed、没有 started，输出不含口令；版本 42 时报告 started、收到 SIGTERM 后以 0 退出并有 stopped`, async () => {
    const built = build();
    const seen = await withDatabase(async (database) => {
      const observer = observerOn(database);
      try {
        const url = database.urlFor(entry === 'payout' ? 'couli_payout' : 'couli_app');
        const phrase = decodeURIComponent(new URL(url).password);
        await sql`UPDATE pgboss.version SET version = 41`.execute(observer);
        const refused = await runEntry(entry, url, true);
        await sql`UPDATE pgboss.version SET version = 42`.execute(observer);
        const accepted = await runEntry(entry, url, true);
        return {
          built,
          dist: existsSync(path.join(API_DIR, 'dist', `main.${entry}.js`)),
          refused: {
            code: refused.code,
            signal: refused.signal,
            startupFailed: refused.messages.includes('startup_failed'),
            started: refused.messages.includes('started'),
            entries: refused.entries,
            leaks:
              phrase === '' ? ['no password in the test URL'] : leaksIn(refused.text, [phrase]),
          },
          accepted: {
            code: accepted.code,
            signal: accepted.signal,
            started: accepted.messages.includes('started'),
            stopped: accepted.messages.includes('stopped'),
            startupFailed: accepted.messages.includes('startup_failed'),
          },
        };
      } finally {
        await closeObserver(observer);
      }
    });
    expect(seen).toEqual({
      built: '',
      dist: true,
      refused: {
        code: 1,
        signal: null,
        startupFailed: true,
        started: false,
        entries: [entry],
        leaks: [],
      },
      accepted: { code: 0, signal: null, started: true, stopped: true, startupFailed: false },
    });
  }, 180_000);
}
