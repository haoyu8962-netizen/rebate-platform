// Rule test of the production wiring through the real process entries against a real PostgreSQL
// (B1-15za; contract section 3 of apps/api/src/modules/platform/queue/idempotency-purge.ts). The
// entries run as child processes from apps/api/dist (`node dist/main.<entry>.js`, as
// test/spec/platform/queue/entries.int.test.ts does) after `tsc -b apps/api`, so nothing of the
// assembly is replaced: only a tick the worker's own entry wired can purge here. CLOCK_NOW is the
// entry's own clock source; it runs on from NOW, so kit.ts's expiries a day ahead stay ahead.
// Top-level it() only (规划/11 §4.3).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { waitFor } from '../queue/kit.ts';
import {
  NOW,
  PURGED,
  RESPONSE_MARKER,
  SCHEDULE_ROW,
  deliverTick,
  leftKeys,
  purgeQueues,
  purgeSchedules,
  purgedLine,
  seedKeys,
} from './kit.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const API = path.join(ROOT, 'apps/api');

type Entry = 'api' | 'stream' | 'admin' | 'payout' | 'worker';
type LogRecord = Record<string, unknown>;

/** Builds apps/api (incremental); returns '' on success or what went wrong. */
function build(): string {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-b', API], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0)
    return `tsc -b apps/api: ${result.stdout}${result.stderr}`.slice(0, 2000);
  return '';
}

/** A loopback port that was free a moment ago. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Running {
  /** The complete log lines so far; a line that is not JSON keeps its text as `msg`. */
  records(): LogRecord[];
  text(): string;
  /** SIGTERM, then SIGKILL after 15 s; resolves with [exit code, signal]. */
  stop(): Promise<[number | null, string | null]>;
  kill(): Promise<void>;
}

function launch(entry: Entry, database: TestDatabase, port: number): Running {
  const env: Record<string, string> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    CLOCK_NOW: NOW,
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    STREAM_PORT: String(port),
    ADMIN_PORT: String(port),
    DATABASE_URL: database.urlFor(entry === 'payout' ? 'couli_payout' : 'couli_app'),
    ...(entry === 'admin' ? { DATABASE_READ_URL: database.urlFor('couli_readonly') } : {}),
    ...(entry === 'payout' ? {} : { REDIS_URL: 'redis://127.0.0.1:1/0' }),
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = spawn(process.execPath, [path.join(API, 'dist', `main.${entry}.js`)], {
    cwd: API,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', () => undefined);
  // 'close' fires after the child exited and its stdio ended: every stdout chunk has arrived.
  const closed = new Promise<[number | null, string | null]>((resolve) => {
    child.on('close', (code, signal) => resolve([code, signal]));
  });
  return {
    records: () =>
      stdout
        .split('\n')
        .slice(0, -1)
        .filter((text) => text.trim() !== '')
        .map((text) => {
          try {
            return JSON.parse(text) as LogRecord;
          } catch {
            return { msg: text };
          }
        }),
    text: () => stdout,
    async stop() {
      const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.kill('SIGTERM');
      const end = await closed;
      clearTimeout(killer);
      return end;
    },
    async kill() {
      child.kill('SIGKILL');
      await closed;
    },
  };
}

function started(run: Running): boolean {
  return run.records().some((record) => record['msg'] === 'started');
}

/** A record without the per-process fields, as queue/kit.ts reduceLine reduces a line. */
function reduced(record: LogRecord): LogRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([name]) => name !== 'time' && name !== 'pid'),
  );
}

it('[AC-B1-15za#7] 真实入口：api、stream、admin、payout 不登记；worker 入口登记后，定时任务按入口自己的时钟清掉到期的行、保留其余，日志只记删除行数，收 SIGTERM 正常退出', async () => {
  expect(build()).toBe('');
  const database = await createTestDatabase();
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  let running: Running | undefined;
  try {
    for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
      const run = launch(entry, database, await freePort());
      running = run;
      expect(await waitFor(() => started(run), 30_000)).toBe(true);
      expect(await purgeSchedules(observer)).toEqual([]);
      expect(await purgeQueues(observer)).toEqual([]);
      await run.stop();
    }

    const { gone, kept } = await seedKeys(observer, NOW);
    const worker = launch('worker', database, await freePort());
    running = worker;
    expect(await waitFor(() => started(worker), 30_000)).toBe(true);
    expect(await purgeSchedules(observer)).toEqual([SCHEDULE_ROW]);
    expect(await deliverTick(observer)).toHaveLength(1);
    const purged = () => worker.records().filter((record) => record['msg'] === PURGED);
    expect(await waitFor(() => purged().length > 0, 20_000)).toBe(true);
    expect(purged().map(reduced)).toEqual([purgedLine(gone.length)]);
    expect(await leftKeys(observer)).toEqual([...kept].sort());
    expect(await worker.stop()).toEqual([0, null]);
    const logged = worker.text();
    for (const key of [...gone, ...kept]) expect(logged).not.toContain(key);
    expect(logged).not.toContain(RESPONSE_MARKER);
  } finally {
    await running?.kill();
    await destroyDb(observer);
    await database.drop();
  }
}, 180_000);
