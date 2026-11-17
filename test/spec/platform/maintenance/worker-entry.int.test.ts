// Rule tests of the real process entries with partition maintenance wired in (task B1-01n;
// contract section 4 of apps/api/src/modules/platform/maintenance/worker.ts and section 1 of
// apps/api/src/modules/platform/db/maint.ts). Basis: ADR-0001 §4.2 第 4 项 (worker 里的定时任务以
// couli_maint 建和删分区; 按月的表预建未来 3 个月; DEFAULT 分区有数据即告警), 第 8 项 (couli_maint), 第 11
// 项 (连接池), 第 14 项 (库版本不一致时拒绝启动), 第 20 项 (payout 只连 PG、不做别的); 规划/02 §15.1 PG
// 一行 (分区的预建与删除由 worker 定时任务以专用角色执行), §3.1 (worker 组跑 worker). The entries run
// as child processes from apps/api/dist (`node dist/main.<entry>.js`, as
// test/spec/platform/queue/entries.int.test.ts does); the build is brought up to date first with
// `tsc -b apps/api` (incremental; `pnpm verify` builds before the integration tests, so it is a
// no-op there). Children are kept few: one test runs five entries in sequence against one clone of
// the migrated template, the other runs seven short-lived ones without a database.
// Top-level it() only (规划/11 §4.3).
// B1-01w (worker 契约 8, written in ./worker-day-partitions.int.test.ts): the worker's first run now
// also pre-creates the 15 link_logs day partitions and alerts (warn) on link_logs_default rows like
// on any other DEFAULT partition; the first test expects that, and checks link_logs' partitions in
// every scenario. Nothing else here changed.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { leaksIn, phraseOf } from '../db/kit.ts';
import { ALL_ENSURED, MONTH_TABLES } from './kit.ts';
import { lockApiBuild, unlockApiBuild, reportApiBuild } from '../_shared/api-build-lock.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(ROOT, 'apps/api');
const CLOCK_NOW = '2026-11-20T03:04:05Z';
const MAINT_MISSING = 'DATABASE_MAINT_URL: must be set for the worker entry';
const MAINT_MALFORMED =
  'DATABASE_MAINT_URL: must be a postgres:// or postgresql:// URL with a user, a host and a database name';
const MAINT_ROLE = 'DATABASE_MAINT_URL: must connect as couli_maint';

/** Builds apps/api (incremental); returns '' on success or what went wrong. */
function build(): string {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  lockApiBuild();
  const result = spawnSync(process.execPath, [tsc, '-b', API_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  unlockApiBuild();
  reportApiBuild(result);
  if (result.status !== 0) {
    return `tsc -b apps/api: ${result.stdout}${result.stderr}`.slice(0, 2000);
  }
  return '';
}

type Entry = 'api' | 'worker' | 'payout';

/** A minimal environment: only what is given, plus PATH, HOME and TMPDIR. */
function childEnv(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { LOG_LEVEL: 'info', ...vars };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface LogRecord {
  readonly [key: string]: unknown;
}

interface Run {
  /** Milliseconds from SIGTERM to exit (runUntilStopped only; null when no SIGTERM was sent). */
  readonly stopMs: number | null;
  readonly code: number | null;
  readonly signal: string | null;
  readonly records: LogRecord[];
  readonly messages: string[];
  readonly stderr: string;
  readonly text: string;
}

function parse(stdout: string): LogRecord[] {
  return stdout
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => {
      try {
        return JSON.parse(text) as LogRecord;
      } catch {
        return { msg: `(not JSON) ${text}` };
      }
    });
}

function runOf(
  code: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
  stopMs: number | null = null,
): Run {
  const records = parse(stdout);
  return {
    stopMs,
    code,
    signal,
    records,
    messages: records.map((record) => String(record.msg)),
    stderr,
    text: `${stdout}\n${stderr}`,
  };
}

/** Runs the built entry until it exits; sends SIGTERM once a `started` line appeared. */
async function runUntilStopped(
  entry: Entry,
  vars: Record<string, string>,
  limitMs = 20_000,
): Promise<Run> {
  const child = spawn(process.execPath, [path.join(API_DIR, 'dist', `main.${entry}.js`)], {
    cwd: API_DIR,
    env: childEnv(vars),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalled = false;
  let signalledAt = 0;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!signalled && /"msg":"started"/.test(stdout)) {
      signalled = true;
      signalledAt = performance.now();
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  // 'close' comes after the process exited AND its stdout / stderr were read to the end, so the
  // last lines (`stopped`) are never cut off.
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
    child.on('close', (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal]);
    });
  });
  clearTimeout(timer);
  return runOf(code, signal, stdout, stderr, signalled ? performance.now() - signalledAt : null);
}

/** Runs the built entry to completion (for configuration failures and COULI_EXIT_AFTER_INIT=1). */
function runToEnd(entry: Entry, vars: Record<string, string>): Run {
  const result = spawnSync(process.execPath, [path.join(API_DIR, 'dist', `main.${entry}.js`)], {
    cwd: API_DIR,
    env: childEnv(vars),
    encoding: 'utf8',
    timeout: 15_000,
  });
  return runOf(result.status, result.signal, result.stdout, result.stderr);
}

/** A partition line or a lifecycle line (Nest's own start-up lines are not). */
function isKey(msg: string): boolean {
  return (
    msg.startsWith('partition_') ||
    msg.startsWith('(not JSON)') ||
    ['started', 'stopping', 'stopped', 'startup_failed', 'config_invalid'].includes(msg)
  );
}

/** The partition lines and lifecycle lines of a run, in order. */
function keyMessages(run: Run): string[] {
  return run.messages.filter(isKey);
}

/** The records of `msg`, without time and pid. */
function linesOf(run: Run, msg: string): LogRecord[] {
  return run.records
    .filter((record) => record.msg === msg)
    .map((record) => {
      const rest: Record<string, unknown> = { ...record };
      delete rest.time;
      delete rest.pid;
      return rest;
    });
}

/** Children of app.<table>, by name. */
async function partitionNames(app: Kysely<DB>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT c.relname::text AS name
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'app' AND p.relname = ${table}
    ORDER BY c.relname COLLATE "C"
  `.execute(app);
  return rows.rows.map((row) => row.name);
}

const MONTHS = ['202611', '202612', '202701', '202702'];
/** Every month table and the day table link_logs (each with its DEFAULT partition). */
const PARTITIONED = [...MONTH_TABLES, 'link_logs'];
/** +08:00 days 2026-11-20 … 2026-12-04 (CLOCK_NOW is 2026-11-20 11:04:05 at +08:00). */
const DAYS = Array.from({ length: 15 }, (_, i) =>
  new Date(Date.UTC(2026, 10, 20 + i)).toISOString().slice(0, 10).replaceAll('-', ''),
);

it('[ADR-0001 §4.2 #4、#8、#14、#20; 规划/02 §15.1; worker 契约 4] 真实入口（dist 子进程）：worker 带 DATABASE_MAINT_URL 时在 pgboss 版本不对（41）时 startup_failed、退出码 1、一个分区都不建（维护在队列之后启动）；payout 设了它也不维护；COULI_EXIT_AFTER_INIT=1 的 worker 不跑维护；APP_ENV=test 的 worker 不设它时记 partition_maintenance_disabled、不维护；worker 带它时 started 之前跑完一轮——预建 event_log 与 orders 各 4 个月、link_logs 2026-11-20 至 12-04 共 15 个日分区（worker 契约 8），event_log_default 与 link_logs_default 的行都告警（warn）——SIGTERM 后 stopping、stopped、5 秒内以退出码 0 结束（维护池也已关闭，不靠空闲超时）；输出不含任何口令', async () => {
  const built = build();
  const database = await createTestDatabase();
  const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let seen: unknown;
  try {
    const appUrl = database.urlFor('couli_app');
    const maintUrl = database.urlFor('couli_maint');
    const payoutUrl = database.urlFor('couli_payout');
    const phrases = [appUrl, maintUrl, payoutUrl].map((url) =>
      decodeURIComponent(new URL(url).password),
    );
    const worker = {
      APP_ENV: 'test',
      CLOCK_NOW,
      DATABASE_URL: appUrl,
      REDIS_URL: 'redis://127.0.0.1:1/0',
    };
    await sql`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
      VALUES ('couli', '00000000-0000-7000-8000-00000000e001'::uuid, 'user.updated',
              '{"order_id":"w"}'::jsonb, '2020-03-01T00:00:00Z'::timestamptz)
    `.execute(app);
    await sql`
      INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, created_at)
      VALUES ('couli', 'convert', 0, 'item-13912345678', '2026-11-19T10:00:00Z')
    `.execute(app);
    const partitions = async (): Promise<unknown> => {
      const out: Record<string, string[]> = {};
      for (const table of PARTITIONED) out[table] = await partitionNames(app, table);
      return out;
    };

    await sql`UPDATE pgboss.version SET version = 41`.execute(app);
    const refused = await runUntilStopped('worker', { ...worker, DATABASE_MAINT_URL: maintUrl });
    const afterRefused = await partitions();
    await sql`UPDATE pgboss.version SET version = 42`.execute(app);
    const payout = await runUntilStopped('payout', {
      APP_ENV: 'test',
      CLOCK_NOW,
      DATABASE_URL: payoutUrl,
      DATABASE_MAINT_URL: maintUrl,
    });
    const exitAfterInit = runToEnd('worker', {
      ...worker,
      DATABASE_MAINT_URL: maintUrl,
      COULI_EXIT_AFTER_INIT: '1',
    });
    const afterExitAfterInit = await partitions();
    const disabled = await runUntilStopped('worker', worker);
    const afterNoMaintenance = await partitions();
    const wired = await runUntilStopped('worker', { ...worker, DATABASE_MAINT_URL: maintUrl });
    const afterWired = await partitions();
    const runs = [refused, payout, exitAfterInit, disabled, wired];
    seen = {
      built,
      refused: {
        code: refused.code,
        signal: refused.signal,
        key: keyMessages(refused),
        partitions: afterRefused,
      },
      payout: { code: payout.code, signal: payout.signal, key: keyMessages(payout) },
      exitAfterInit: {
        code: exitAfterInit.code,
        signal: exitAfterInit.signal,
        key: keyMessages(exitAfterInit),
        partitions: afterExitAfterInit,
      },
      disabled: {
        code: disabled.code,
        signal: disabled.signal,
        key: keyMessages(disabled),
        line: linesOf(disabled, 'partition_maintenance_disabled'),
        partitions: afterNoMaintenance,
      },
      wired: {
        code: wired.code,
        signal: wired.signal,
        key: keyMessages(wired),
        alerts: [
          ...linesOf(wired, 'partition_default_has_rows'),
          ...linesOf(wired, 'partition_default_rows_expected'),
          ...linesOf(wired, 'partition_maintenance_done'),
        ],
        partitions: afterWired,
        exitsPromptly: wired.stopMs !== null && wired.stopMs < 5000,
      },
      stderr: runs.map((run) => run.stderr),
      leaks: runs.flatMap((run) => leaksIn(run.text, phrases)),
      rowContent: runs.some((run) => /13912345678|item-/.test(run.text)),
    };
  } catch (error) {
    seen = { error: String(error) };
  } finally {
    await destroyDb(app).catch(() => undefined);
    await database.drop();
  }
  const onlyDefault = Object.fromEntries(PARTITIONED.map((table) => [table, [`${table}_default`]]));
  expect(seen).toEqual({
    built: '',
    refused: { code: 1, signal: null, key: ['startup_failed'], partitions: onlyDefault },
    payout: { code: 0, signal: null, key: ['started', 'stopping', 'stopped'] },
    exitAfterInit: { code: 0, signal: null, key: ['started'], partitions: onlyDefault },
    disabled: {
      code: 0,
      signal: null,
      key: ['partition_maintenance_disabled', 'started', 'stopping', 'stopped'],
      line: [
        {
          level: 30,
          entry: 'worker',
          env: 'test',
          variable: 'DATABASE_MAINT_URL',
          msg: 'partition_maintenance_disabled',
        },
      ],
      partitions: onlyDefault,
    },
    wired: {
      code: 0,
      signal: null,
      key: [
        'partition_default_has_rows',
        'partition_default_has_rows',
        'partition_maintenance_done',
        'started',
        'stopping',
        'stopped',
      ],
      alerts: [
        {
          level: 40,
          entry: 'worker',
          env: 'test',
          table: 'event_log',
          partition: 'event_log_default',
          rows: 1,
          msg: 'partition_default_has_rows',
        },
        {
          level: 40,
          entry: 'worker',
          env: 'test',
          table: 'link_logs',
          partition: 'link_logs_default',
          rows: 1,
          msg: 'partition_default_has_rows',
        },
        {
          level: 30,
          entry: 'worker',
          env: 'test',
          ensured: ALL_ENSURED,
          dropped: 0,
          failed: 0,
          msg: 'partition_maintenance_done',
        },
      ],
      partitions: {
        ...Object.fromEntries(
          MONTH_TABLES.map((table) => [
            table,
            [`${table}_default`, ...MONTHS.map((m) => `${table}_p${m}`)],
          ]),
        ),
        link_logs: ['link_logs_default', ...DAYS.map((d) => `link_logs_p${d}`)],
      },
      exitsPromptly: true,
    },
    stderr: ['', '', '', '', ''],
    leaks: [],
    rowContent: false,
  });
}, 240_000);

it('[ADR-0001 §4.2 #4、#8、#11; 规划/02 §3.1、§12.6; worker 契约 4] 真实入口的配置校验（dist 子进程，不连库）：worker 在 local 缺 DATABASE_MAINT_URL、在 test 设了坏值、在 staging 指向别的角色、在 prod 设了带口令的坏值都以一行 config_invalid（问题依次列出，维护连接排在 loadConfig 与主连接之后）、退出码 1 结束，不回显口令；带合法维护连接、COULI_EXIT_AFTER_INIT=1 的 worker 照常 started 且不跑维护；api 与 payout 不读它（坏值也照常 started）', () => {
  const built = build();
  const base = {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/couli',
    REDIS_URL: 'redis://127.0.0.1:1/0',
    COULI_EXIT_AFTER_INIT: '1',
  };
  const phrase = phraseOf('worker-entry.malformed');
  const pw = encodeURIComponent(phrase);
  const valid = `postgres://couli_maint:${encodeURIComponent(phraseOf('worker-entry.valid'))}@127.0.0.1:1/couli`;
  const runs = {
    localMissing: runToEnd('worker', { ...base, APP_ENV: 'local' }),
    localBothMissing: runToEnd('worker', { REDIS_URL: base.REDIS_URL, APP_ENV: 'local' }),
    testMalformed: runToEnd('worker', {
      ...base,
      APP_ENV: 'test',
      DATABASE_MAINT_URL: 'not a url',
    }),
    stagingRole: runToEnd('worker', {
      ...base,
      APP_ENV: 'staging',
      DATABASE_MAINT_URL: `postgres://couli_app:${pw}@127.0.0.1:1/couli`,
    }),
    prodMalformed: runToEnd('worker', {
      ...base,
      APP_ENV: 'prod',
      AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-worker-entry',
      DATABASE_MAINT_URL: `mysql://couli_maint:${pw}@127.0.0.1:1/couli`,
    }),
    localValid: runToEnd('worker', { ...base, APP_ENV: 'local', DATABASE_MAINT_URL: valid }),
    api: runToEnd('api', { ...base, APP_ENV: 'local', DATABASE_MAINT_URL: 'not a url' }),
    payout: runToEnd('payout', {
      DATABASE_URL: 'postgres://couli_payout@127.0.0.1:1/couli',
      COULI_EXIT_AFTER_INIT: '1',
      APP_ENV: 'local',
      DATABASE_MAINT_URL: 'not a url',
    }),
  };
  const view = (run: Run): unknown => ({
    code: run.code,
    signal: run.signal,
    lines: run.records
      .filter((record) => isKey(String(record.msg)))
      .map((record) =>
        record.msg === 'config_invalid'
          ? { msg: record.msg, entry: record.entry, problems: record.problems }
          : { msg: record.msg, entry: record.entry, listening: record.listening },
      ),
    stderr: run.stderr,
  });
  const invalid = (entry: Entry, problems: string[]): unknown => ({
    code: 1,
    signal: null,
    lines: [{ msg: 'config_invalid', entry, problems }],
    stderr: '',
  });
  const started = (entry: Entry): unknown => ({
    code: 0,
    signal: null,
    lines: [{ msg: 'started', entry, listening: false }],
    stderr: '',
  });
  expect({
    built,
    views: Object.fromEntries(Object.entries(runs).map(([label, run]) => [label, view(run)])),
    leaks: Object.values(runs).flatMap((run) => leaksIn(run.text, [phrase])),
  }).toEqual({
    built: '',
    views: {
      localMissing: invalid('worker', [MAINT_MISSING]),
      localBothMissing: invalid('worker', [
        'DATABASE_URL: must be set for the worker entry',
        MAINT_MISSING,
      ]),
      testMalformed: invalid('worker', [MAINT_MALFORMED]),
      stagingRole: invalid('worker', [
        'FIELD_KEY_PROVIDER: must be set when APP_ENV=staging',
        MAINT_ROLE,
      ]),
      prodMalformed: invalid('worker', [
        'FIELD_KEY_PROVIDER: must be set when APP_ENV=prod',
        MAINT_MALFORMED,
      ]),
      localValid: started('worker'),
      api: started('api'),
      payout: started('payout'),
    },
    leaks: [],
  });
}, 180_000);
