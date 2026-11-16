// Rule tests of the worker's maintenance with link_logs day partitions on and the link_logs DEFAULT
// exemption removed (task B1-01w), against a real PostgreSQL. Basis: ADR-0001 §4.2 第 4 项 (worker
// 里的定时任务以 couli_maint 建和删分区; 按日的表预建未来 14 天; 每张分区表设 DEFAULT 分区兜底，其中有数据即
// 告警，且须先把数据迁出才能建对应区间的分区), 第 5 项 (link_logs 按日), 第 8 项 (couli_maint); 规划/02
// §15.1 PG 一行 (分区的预建与删除由 worker 定时任务以专用角色执行); BR-ID-30 ② (link_logs 90 天，按日分区
// 删除; 每日 04:00（+08:00）删除任务). This header is the contract addendum of B1-01w to the header of
// apps/api/src/modules/platform/maintenance/worker.ts (that file is the implementation and is not
// edited by the rule-test author); the unit part is checked in ./worker-day-options.test.ts, the real
// entry in ./worker-entry.int.test.ts. Values no document fixes are marked 待编排会话确认.
//
// worker 契约 8 (B1-01w) — supersedes sections 1 and 2 of worker.ts and the link_logs remark of its
// section 4; sections 3–6 (start / stop order, entry wiring, the quietDefaultTables option of
// createPartitionMaintenance with its rule tests) stay valid unchanged.
//
// 8.1 `WORKER_QUIET_DEFAULT_TABLES` is removed: worker.ts no longer has an export of that name
//     (decision of the rule-test author, as allowed by the orchestrator: removing the export rather
//     than keeping a frozen empty array). Its other exports (createWorkerMaintenance,
//     startWorkerServices and the types) stay.
//
// 8.2 `createWorkerMaintenance(options)` = createPartitionMaintenance({ ...options, dayPartitions: true })
//     - The accepted keys are unchanged: exactly db, logger, clock (required) and intervalMs
//       (optional); any other own key — quietDefaultTables and dayPartitions included, whatever its
//       value — → MaintenanceError('invalid_option') synchronously, without calling
//       createPartitionMaintenance. Missing keys and bad values are refused by
//       createPartitionMaintenance (section B of ./index.ts) as before.
//     - Otherwise it calls createPartitionMaintenance of ./index.ts exactly once, synchronously, with
//       one plain object whose own keys are exactly the keys of `options` plus `dayPartitions`, with
//       the same values (the same db, logger and clock objects; intervalMs only when given) and
//       dayPartitions exactly true; no quietDefaultTables key. It returns the object
//       createPartitionMaintenance returned (the same object). Opens no connection, reads no time,
//       logs nothing.
//
// 8.3 What follows for every run of the worker's instance (section I2 of ./index.ts with
//     dayPartitions true): after the 8 month partitions it pre-creates the link_logs partitions of
//     dayPartitionDays(now) (15 days, +08:00); from 04:00:00.000 +08:00 on, the drop step also drops
//     the expired link_logs day partitions (90 days); the DEFAULT check logs every row with
//     row_count > 0 as warn `partition_default_has_rows` { table, partition, rows } — link_logs
//     included, exactly like event_log and orders. The worker's instance never writes
//     `partition_default_rows_expected`.
//
// 8.4 Rows already in link_logs_default are NOT moved out (decision of the orchestrator: no live data
//     in this phase, no data migration in this task):
//     - DEFAULT partitions are never dropped, so such rows stay there however old they are, and the
//       warn line repeats on every run while they stay — this is ADR-0001 §4.2 #4 "其中有数据即告警";
//       moving them out is an operations task.
//     - A DEFAULT row whose +08:00 day is one of dayPartitionDays(now) makes the creation of that
//       day's partition fail with 23514 on every run (`partition_ensure_failed` error
//       { table: 'link_logs', day: 'YYYY-MM-DD', sqlstate: '23514' }, failed += 1; the other days are
//       created), until that day has left the window (the day has passed); from then on nothing fails
//       for it and only the warn line remains.
//
// 8.5 Real worker entry (with DATABASE_MAINT_URL; section 4 of worker.ts otherwise unchanged): the
//     first run, which settles before `started`, now also creates the 15 link_logs day partitions;
//     with CLOCK_NOW 2026-11-20T03:04:05Z on a fresh clone holding one event_log row and one
//     link_logs row (2026-11-19 +08:00) in their DEFAULT partitions, its partition lines are exactly
//     warn event_log, warn link_logs, then done { ensured: 23, dropped: 0, failed: 0 }.
//
// One clone of the migrated template per test; the module connects as couli_maint, rows are written
// as couli_app. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type {
  MaintenanceReport,
  PartitionMaintenance,
  PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import {
  dayNames,
  dayRange,
  ensureDays,
  insertLinkLog,
  linkLogRows,
} from '../../db/partitions/day-kit.ts';
import {
  done,
  line,
  memoryLogger,
  monthRange,
  reduceLine,
  settableClock,
  ALL_ENSURED,
  monthNames,
} from './kit.ts';

async function withWorld(
  scenario: (maint: Kysely<DB>, app: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database: TestDatabase = await createTestDatabase();
  const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 2 });
  const app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  try {
    await scenario(maint, app);
  } finally {
    await Promise.all([maint, app].map((db) => destroyDb(db).catch(() => undefined)));
    await database.drop();
  }
}

/** The worker's instance on `maint` with a settable clock; a rejecting stand-in if creating throws. */
function workerAt(maint: Kysely<DB>, instant: string) {
  const { logger, lines } = memoryLogger();
  const clock = settableClock(instant);
  let maintenance: PartitionMaintenance;
  try {
    maintenance = createWorkerMaintenance({
      db: maint,
      logger,
      clock,
    } as PartitionMaintenanceOptions);
  } catch (error) {
    const fail = async (): Promise<never> => {
      throw error;
    };
    maintenance = { runOnce: fail, start: fail, stop: fail };
  }
  /** The reduced lines written since the last call. */
  let seen = 0;
  const fresh = (): unknown[] => {
    const out = lines.slice(seen).map(reduceLine);
    seen = lines.length;
    return out;
  };
  return { maintenance, clock, lines, fresh };
}

async function report(run: Promise<MaintenanceReport>): Promise<unknown> {
  try {
    return { ...(await run) };
  } catch (error) {
    return { error: String(error) };
  }
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

/** One event_log row of a long-past month (it lands in event_log_default). */
async function insertOldEvent(app: Kysely<DB>): Promise<string> {
  const result = await sql<{ part: string }>`
    INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
    VALUES ('couli', '00000000-0000-7000-8000-00000000d101'::uuid, 'user.updated',
            '{"order_id":"d"}'::jsonb, '2020-03-01T00:00:00Z'::timestamptz)
    RETURNING tableoid::regclass::text AS part
  `.execute(app);
  return result.rows[0]?.part ?? '';
}

const MONTH_NAMES_NOV = (() => {
  const months = monthRange('2026-11', '2027-02');
  return monthNames(months);
})();
const warnRows = (table: string, rows: number): Record<string, unknown> =>
  line('warn', 'partition_default_has_rows', { table, partition: `${table}_default`, rows });
const dropped = (partition: string): Record<string, unknown> =>
  line('info', 'partition_dropped', { table: 'link_logs', partition });

it('[ADR-0001 §4.2 #4 按日的表预建未来 14 天、DEFAULT 分区有数据即告警、#5; BR-ID-30 ② 每日 04:00（+08:00）删除; worker 契约 8.2、8.3、8.4] worker 的维护实例：每轮在 8 个月分区之后预建 link_logs 2026-11-20 至 12-04 共 15 个日分区；03:59:59.999（+08:00）不删、04:00:00.000 删掉过期的 link_logs_p20260801；link_logs_default 与 event_log_default 有行的每轮都 warn（不记 partition_default_rows_expected），04:00 起 link_logs_default 里过期的旧行被删、未过期的留在 DEFAULT；报告与日志确切、不含行内容', async () => {
  await withWorld(async (maint, app) => {
    expect(await ensureDays(maint, 'link_logs', ['2026-08-01'])).toEqual(['link_logs_p20260801']);
    expect(await insertOldEvent(app)).toBe('app.event_log_default');
    // +08:00 days 2026-06-01 and 2026-11-19: before the window, so their creation is never tried.
    expect([
      await insertLinkLog(app, '2026-06-01T09:00:00+08:00'),
      await insertLinkLog(app, '2026-11-19T18:00:00+08:00'),
    ]).toEqual(['app.link_logs_default', 'app.link_logs_default']);
    // 2026-11-20 03:59:59.999 +08:00.
    const w = workerAt(maint, '2026-11-19T19:59:59.999Z');
    const days = dayNames('link_logs', dayRange('2026-11-20', '2026-12-04'));
    const defaultRows = [
      { table: 'event_log', partition: 'event_log_default', rows: 1 },
      { table: 'link_logs', partition: 'link_logs_default', rows: 2 },
    ];
    // From 04:00 the DEFAULT purge (cutoff 2026-08-22 00:00 +08:00) deletes the 06-01 row only.
    const purgedDefaultRows = [
      { table: 'event_log', partition: 'event_log_default', rows: 1 },
      { table: 'link_logs', partition: 'link_logs_default', rows: 1 },
    ];
    const beforeFour = {
      report: await report(w.maintenance.runOnce()),
      lines: w.fresh(),
      linkLogs: await partitionNames(app, 'link_logs'),
    };
    w.clock.set('2026-11-19T20:00:00.000Z');
    const atFour = {
      report: await report(w.maintenance.runOnce()),
      lines: w.fresh(),
      linkLogs: await partitionNames(app, 'link_logs'),
    };
    const again = { report: await report(w.maintenance.runOnce()), lines: w.fresh() };
    expect({ beforeFour, atFour, again }).toEqual({
      beforeFour: {
        report: { ensured: [...MONTH_NAMES_NOV, ...days], dropped: [], defaultRows, failed: 0 },
        lines: [warnRows('event_log', 1), warnRows('link_logs', 2), done(ALL_ENSURED, 0, 0)],
        linkLogs: ['link_logs_default', 'link_logs_p20260801', ...days],
      },
      atFour: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...days],
          dropped: ['link_logs_p20260801'],
          defaultRows: purgedDefaultRows,
          failed: 0,
        },
        lines: [
          dropped('link_logs_p20260801'),
          line('info', 'retention_purged', { table: 'link_logs_default', rows: 1 }),
          warnRows('event_log', 1),
          warnRows('link_logs', 1),
          done(ALL_ENSURED, 1, 0),
        ],
        linkLogs: ['link_logs_default', ...days],
      },
      again: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...days],
          dropped: [],
          defaultRows: purgedDefaultRows,
          failed: 0,
        },
        lines: [warnRows('event_log', 1), warnRows('link_logs', 1), done(ALL_ENSURED, 0, 0)],
      },
    });
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2026-11-19T10:00:00.000Z' },
    ]);
    expect(w.lines.join('')).not.toMatch(/item-|order_id/);
  });
}, 60_000);

it('[ADR-0001 §4.2 #4 DEFAULT 有数据须先迁出才能建对应区间的分区; worker 契约 8.4 不做迁出] link_logs_default 里有 2026-11-22（+08:00）的 1 行：worker 每轮建 11-22 都失败 23514（partition_ensure_failed { table, day, sqlstate }，failed 1，其余 14 天照建）并 warn；时钟走到 11-23 04:00（+08:00）后 11-22 已出窗口，不再失败，warn 照旧，行仍在 DEFAULT', async () => {
  await withWorld(async (maint, app) => {
    expect(await insertLinkLog(app, '2026-11-22T12:00:00+08:00')).toBe('app.link_logs_default');
    const w = workerAt(maint, '2026-11-20T03:04:05Z');
    const window = dayRange('2026-11-20', '2026-12-04');
    const created = dayNames(
      'link_logs',
      window.filter((d) => d !== '2026-11-22'),
    );
    const defaultRows = [{ table: 'link_logs', partition: 'link_logs_default', rows: 1 }];
    const failing = {
      report: { ensured: [...MONTH_NAMES_NOV, ...created], dropped: [], defaultRows, failed: 1 },
      lines: [
        line('error', 'partition_ensure_failed', {
          table: 'link_logs',
          day: '2026-11-22',
          sqlstate: '23514',
        }),
        warnRows('link_logs', 1),
        done(ALL_ENSURED - 1, 0, 1),
      ],
    };
    const first = { report: await report(w.maintenance.runOnce()), lines: w.fresh() };
    const second = { report: await report(w.maintenance.runOnce()), lines: w.fresh() };
    // 2026-11-23 04:00:00 +08:00: the window is 2026-11-23 … 2026-12-07.
    w.clock.set('2026-11-22T20:00:00.000Z');
    const later = { report: await report(w.maintenance.runOnce()), lines: w.fresh() };
    const laterDays = dayNames('link_logs', dayRange('2026-11-23', '2026-12-07'));
    expect({ first, second, later }).toEqual({
      first: failing,
      second: failing,
      later: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...laterDays],
          dropped: [],
          defaultRows,
          failed: 0,
        },
        lines: [warnRows('link_logs', 1), done(ALL_ENSURED, 0, 0)],
      },
    });
    expect(await partitionNames(app, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', [
        '2026-11-20',
        '2026-11-21',
        ...dayRange('2026-11-23', '2026-12-07'),
      ]),
    ]);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2026-11-22T04:00:00.000Z' },
    ]);
    expect(w.lines.join('')).not.toMatch(/item-/);
  });
}, 60_000);

it('[AC-CT-13l#8; BR-ID-30 ② link_logs 90 天、每日 04:00（+08:00）删除; worker 契约 8.3] worker 的维护实例清理 link_logs_default 的截断边界：2026-11-20 04:00（+08:00）那轮截断 08-22 00:00（+08:00），早 1 毫秒的行被删（retention_purged rows 1）、恰在截断时刻的行与预建范围之后 12-10 的未来行留下；11-21 03:59:59.999 不删；11-21 04:00 截断后移一天，恰在旧截断时刻的那行被删、未来行仍不动', async () => {
  await withWorld(async (maint, app) => {
    // Cutoff of 2026-11-20 04:00 (+08:00): 2026-08-22 00:00 (+08:00) = 2026-08-21T16:00:00.000Z.
    expect([
      await insertLinkLog(app, '2026-08-21T15:59:59.999Z'),
      await insertLinkLog(app, '2026-08-21T16:00:00.000Z'),
      // +08:00 day 2026-12-10: after every pre-created window below, so its creation is never tried.
      await insertLinkLog(app, '2026-12-10T12:00:00+08:00'),
    ]).toEqual(['app.link_logs_default', 'app.link_logs_default', 'app.link_logs_default']);
    const purgedLine = line('info', 'retention_purged', { table: 'link_logs_default', rows: 1 });
    const daysOf20 = dayNames('link_logs', dayRange('2026-11-20', '2026-12-04'));
    const daysOf21 = dayNames('link_logs', dayRange('2026-11-21', '2026-12-05'));
    const linkDefault = (rows: number): Array<Record<string, unknown>> => [
      { table: 'link_logs', partition: 'link_logs_default', rows },
    ];
    // 2026-11-20 04:00:00.000 +08:00.
    const w = workerAt(maint, '2026-11-19T20:00:00.000Z');
    const atFour = {
      report: await report(w.maintenance.runOnce()),
      lines: w.fresh(),
      rows: await linkLogRows(app),
    };
    // 2026-11-21 03:59:59.999 +08:00: a new day, but before its 04:00.
    w.clock.set('2026-11-20T19:59:59.999Z');
    const nextBeforeFour = {
      report: await report(w.maintenance.runOnce()),
      lines: w.fresh(),
      rows: await linkLogRows(app),
    };
    // 2026-11-21 04:00:00.000 +08:00: cutoff 2026-08-23 00:00 (+08:00) = 2026-08-22T16:00:00.000Z.
    w.clock.set('2026-11-20T20:00:00.000Z');
    const nextAtFour = {
      report: await report(w.maintenance.runOnce()),
      lines: w.fresh(),
      rows: await linkLogRows(app),
    };
    expect({ atFour, nextBeforeFour, nextAtFour }).toEqual({
      atFour: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...daysOf20],
          dropped: [],
          defaultRows: linkDefault(2),
          failed: 0,
        },
        lines: [purgedLine, warnRows('link_logs', 2), done(ALL_ENSURED, 0, 0)],
        rows: [
          { part: 'app.link_logs_default', at: '2026-08-21T16:00:00.000Z' },
          { part: 'app.link_logs_default', at: '2026-12-10T04:00:00.000Z' },
        ],
      },
      nextBeforeFour: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...daysOf21],
          dropped: [],
          defaultRows: linkDefault(2),
          failed: 0,
        },
        lines: [warnRows('link_logs', 2), done(ALL_ENSURED, 0, 0)],
        rows: [
          { part: 'app.link_logs_default', at: '2026-08-21T16:00:00.000Z' },
          { part: 'app.link_logs_default', at: '2026-12-10T04:00:00.000Z' },
        ],
      },
      nextAtFour: {
        report: {
          ensured: [...MONTH_NAMES_NOV, ...daysOf21],
          dropped: [],
          defaultRows: linkDefault(1),
          failed: 0,
        },
        lines: [purgedLine, warnRows('link_logs', 1), done(ALL_ENSURED, 0, 0)],
        rows: [{ part: 'app.link_logs_default', at: '2026-12-10T04:00:00.000Z' }],
      },
    });
    expect(w.lines.join('')).not.toMatch(/item-/);
  });
}, 60_000);
