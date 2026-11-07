// B1-01zzr (orchestrator brief w1-search-linking; D10-747 / D10-765 / D10-766 A): a rescan cursor
// (query_kind 'rescan') is a scan position, not a watermark, so couli_sync_watermark_lag_seconds
// leaves out the streams of the exclusion table (rescan / rights / manual) and every other
// query_kind still counts; couli_sync_rescan_position_seconds{app_id, platform, query_kind} gives
// now − min(cursor_at) of each rescan stream group instead, only on the worker, from the same
// registry and the same collect as the business gauges. Asserted only through
// collectWorkerMetrics(db, clock) and the rendered text of createMetricsRegistry, on a session
// whose every transaction is READ ONLY; "now" is the injected clock (years after the database's).
import { readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  collectWorkerMetrics,
  createMetricsRegistry,
} from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { cursorSnapshot, readOnlyUrl } from '../metrics/kit.ts';
import {
  EXCLUDED_KINDS,
  LAG_METRIC,
  NOW,
  OTHER_ENTRIES,
  RESCAN_METRIC,
  ROOT,
  at,
  insertAccount,
  insertStream,
  lagSeries,
  namesRescan,
  rescanKey,
  rescanSeries,
  seedStreams,
  typeOf,
} from './kit.ts';

async function open() {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  const readOnly = createDb({ connectionString: readOnlyUrl(database), max: 2 });
  return {
    db,
    readOnly,
    async close() {
      await destroyDb(readOnly);
      await destroyDb(db);
      await database.drop();
    },
  };
}

it('[AC-B1-01zzr#1] collectWorkerMetrics：水位滞后按平台取同步流最老游标（取整），排除 rescan / rights / manual，其余 query_kind（含 updated_at）照常计入；只剩被排除流的平台没有序列；跟注入时钟、不写库', async () => {
  const t = await open();
  try {
    const expected = await seedStreams(t.db);
    const before = await cursorSnapshot(t.db);
    const clock = new FixedClock(NOW);

    const snapshot = await collectWorkerMetrics(t.readOnly, clock);
    // taobao 250 (not its rescan's 90 000), jd 500 (not rights / manual / rescan), pdd absent.
    expect(snapshot.syncWatermarkLagSeconds).toEqual(expected.lag);
    expect(Object.hasOwn(snapshot.syncWatermarkLagSeconds, 'pdd'), 'pdd has no series').toBe(false);

    clock.advanceMs(60_000);
    const later = await collectWorkerMetrics(t.readOnly, clock);
    expect(later.syncWatermarkLagSeconds).toEqual(expected.lagLater);

    expect(await cursorSnapshot(t.db)).toEqual(before);
  } finally {
    await t.close();
  }
}, 60_000);

it.each(EXCLUDED_KINDS)(
  '[AC-B1-01zzr#2] 排除表逐项（%s）：该 query_kind 的流再老也不进水位滞后；平台只剩该类流时没有水位序列（快照与渲染文本一致）',
  async (kind) => {
    const t = await open();
    try {
      const taobao = await insertAccount(t.db, 'taobao');
      const jd = await insertAccount(t.db, 'jd');
      await insertStream(t.db, {
        platform: 'taobao',
        accountId: taobao,
        queryKind: 'increment',
        cursorAt: at(-40),
      });
      await insertStream(t.db, {
        platform: 'taobao',
        accountId: taobao,
        queryKind: kind,
        cursorAt: at(-9000),
      });
      await insertStream(t.db, {
        platform: 'jd',
        accountId: jd,
        queryKind: kind,
        cursorAt: at(-9000),
      });
      const clock = new FixedClock(NOW);

      const snapshot = await collectWorkerMetrics(t.readOnly, clock);
      expect(snapshot.syncWatermarkLagSeconds, kind).toEqual({ taobao: 40 });

      const text = await createMetricsRegistry({
        entry: 'worker',
        collect: () => collectWorkerMetrics(t.readOnly, clock),
      }).render();
      expect(lagSeries(text), kind).toEqual({ taobao: 40 });
      expect(text).not.toMatch(new RegExp(`^${LAG_METRIC}\\{[^}]*platform="jd"`, 'm'));
    } finally {
      await t.close();
    }
  },
  60_000,
);

it('[AC-B1-01zzr#3] worker registry 同一次 collect 渲染回扫位置 gauge：每组 rescan 流按 (app_id, platform, query_kind) 出 now − 最老游标（取整、不为负），rights / manual 不出；下次 scrape 跟注入时钟；告警规则不挂它、水位告警表达式不变', async () => {
  const t = await open();
  try {
    const expected = await seedStreams(t.db);
    const clock = new FixedClock(NOW);
    const collect = vi.fn(() => collectWorkerMetrics(t.readOnly, clock));
    const registry = createMetricsRegistry({ entry: 'worker', collect });

    const text = await registry.render();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(typeOf(text, RESCAN_METRIC), `# TYPE of ${RESCAN_METRIC}`).toBe('gauge');
    expect(rescanSeries(text)).toEqual(expected.rescan);
    expect(text).toMatch(
      new RegExp(
        `^${RESCAN_METRIC}\\{(?=[^}]*app_id="couli")(?=[^}]*platform="taobao")(?=[^}]*query_kind="rescan")[^}]*\\} 90000$`,
        'm',
      ),
    );
    // The lag of the same scrape leaves the rescan streams out.
    expect(lagSeries(text)).toEqual(expected.lag);

    // Scrape time, not creation time: the next scrape reads the clock one minute later.
    clock.advanceMs(60_000);
    const next = await registry.render();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(rescanSeries(next)).toEqual(expected.rescanLater);
    expect(lagSeries(next)).toEqual(expected.lagLater);

    // Brief point 3: no alert reads the new gauge, the watermark lag alert keeps its expression.
    const rulesDir = new URL('infra/monitoring/rules/', ROOT);
    for (const file of readdirSync(rulesDir)) {
      expect(readFileSync(new URL(file, rulesDir), 'utf8'), file).not.toContain(RESCAN_METRIC);
    }
    expect(readFileSync(new URL('couli.yaml', rulesDir), 'utf8')).toMatch(
      /- alert: CouliSyncWatermarkLag\n\s+expr: 'couli_sync_watermark_lag_seconds > 1800'\n/,
    );
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzr#4] 没有回扫流就没有回扫序列：回扫流改成别的被排除类后，下一次 scrape 不留旧值，水位滞后不变', async () => {
  const t = await open();
  try {
    const taobao = await insertAccount(t.db, 'taobao');
    const jd = await insertAccount(t.db, 'jd');
    await insertStream(t.db, {
      platform: 'taobao',
      accountId: taobao,
      queryKind: 'increment',
      cursorAt: at(-100),
    });
    await insertStream(t.db, {
      platform: 'taobao',
      accountId: taobao,
      queryKind: 'rescan',
      cursorAt: at(-5000),
    });
    await insertStream(t.db, {
      platform: 'jd',
      accountId: jd,
      queryKind: 'rights',
      cursorAt: at(-6000),
    });
    const clock = new FixedClock(NOW);
    const registry = createMetricsRegistry({
      entry: 'worker',
      collect: () => collectWorkerMetrics(t.readOnly, clock),
    });

    const first = await registry.render();
    expect(rescanSeries(first)).toEqual({ [rescanKey('couli', 'taobao')]: 5000 });
    expect(lagSeries(first)).toEqual({ taobao: 100 });

    // The rescan stream is no rescan stream any more (manual is excluded from the lag as well).
    await sql`UPDATE app.sync_cursors SET query_kind = 'manual' WHERE query_kind = 'rescan'`.execute(
      t.db,
    );
    const second = await registry.render();
    expect(rescanSeries(second)).toEqual({});
    expect(second).not.toMatch(new RegExp(`^${RESCAN_METRIC}[{ ]`, 'm'));
    expect(lagSeries(second)).toEqual({ taobao: 100 });
  } finally {
    await t.close();
  }
}, 60_000);

it('[AC-B1-01zzr#5] 回扫位置 gauge 只在 worker 出：api / stream / admin / payout 给了同一 collect 也不调用、不出该指标名；worker 不给 collect 也没有', async () => {
  const t = await open();
  try {
    await seedStreams(t.db);
    const clock = new FixedClock(NOW);
    const collect = vi.fn(() => collectWorkerMetrics(t.readOnly, clock));

    const worker = await createMetricsRegistry({ entry: 'worker', collect }).render();
    expect(namesRescan(worker), 'worker names the rescan gauge').toBe(true);
    expect(Object.keys(rescanSeries(worker)).length).toBeGreaterThan(0);
    expect(collect).toHaveBeenCalledTimes(1);

    for (const entry of OTHER_ENTRIES) {
      const text = await createMetricsRegistry({ entry, collect }).render();
      expect(namesRescan(text), entry).toBe(false);
    }
    expect(collect).toHaveBeenCalledTimes(1);
    expect(namesRescan(await createMetricsRegistry({ entry: 'worker' }).render())).toBe(false);
  } finally {
    await t.close();
  }
}, 60_000);
