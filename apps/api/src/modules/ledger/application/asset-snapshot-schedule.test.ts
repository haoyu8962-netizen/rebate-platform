import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { timedOutEventId } from '../infra/asset-snapshot-run-store.ts';
import {
  newestDueDay,
  nominalRunAtOf,
  planAssetSnapshotApp,
  tickAssetSnapshots,
  windowDaysOf,
  type AssetSnapshotWindow,
} from './asset-snapshot-schedule.ts';
import { confirmSnapshotDay, type SnapshotWriteStore } from './asset-snapshot-write.ts';

const at = (iso: string) => new FixedClock(iso).now();
/** 2032-06-17 00:05 +08:00: the newest due day is 2032-06-16. */
const NOW = at('2032-06-16T16:05:00.000Z');
const DAYS = windowDaysOf('2032-06-16', NOW);
const db = {} as Kysely<DB>;

function row(day: string, waitingComparable = true) {
  return { day, waitingComparable };
}

function stored(
  rows: AssetSnapshotWindow['rows'],
  newestBefore: string | null = null,
): AssetSnapshotWindow {
  return { rows, newestBefore };
}

function harness(
  apps: Readonly<Record<string, AssetSnapshotWindow>>,
  options: { readonly alerted?: readonly string[]; readonly failOn?: string } = {},
) {
  const runs: [string, string][] = [];
  const logger = { warn: vi.fn(), error: vi.fn() };
  const timedOutDays = vi.fn(() => Promise.resolve(new Set(options.alerted ?? [])));
  const tick = tickAssetSnapshots({
    db,
    clock: new FixedClock(NOW),
    logger,
    runner: {
      run(_db, input) {
        // D is due exactly at its nominal time.
        const day = newestDueDay(input.nominalRunAt);
        if (`${input.appId}:${day}` === options.failOn) {
          return Promise.reject(new Error('synthetic-private-detail'));
        }
        runs.push([input.appId, day]);
        return Promise.resolve({ snapshotId: 'id', accountingDate: day });
      },
    },
    runs: {
      listApps: () => Promise.resolve(Object.keys(apps)),
      snapshotWindow: (appId) => Promise.resolve(apps[appId] ?? stored([])),
      timedOutDays,
    },
    isStopped: () => false,
  });
  return { tick, runs, logger, timedOutDays };
}

describe('到期日与名义时刻', () => {
  it('[AC-B2-04zo#u1] D+1 00:00:59.999 最新到期的是 D−1，00:01:00 是 D', () => {
    expect(newestDueDay(at('2032-06-15T16:00:59.999Z'))).toBe('2032-06-14');
    expect(newestDueDay(at('2032-06-15T16:01:00.000Z'))).toBe('2032-06-15');
  });

  it('[AC-B2-04zo#u2] 名义时刻是 D+1 00:01 +08:00，迟到也不随时钟变', () => {
    expect(nominalRunAtOf('2032-06-15', NOW).toISOString()).toBe('2032-06-15T16:01:00.000Z');
  });

  it('[AC-B2-04zo#u3] 窗口 7 天，由旧到新，跨闰日按日历走', () => {
    expect(DAYS).toEqual([
      '2032-06-10',
      '2032-06-11',
      '2032-06-12',
      '2032-06-13',
      '2032-06-14',
      '2032-06-15',
      '2032-06-16',
    ]);
    expect(windowDaysOf('2032-03-01', NOW).slice(4)).toEqual([
      '2032-02-28',
      '2032-02-29',
      '2032-03-01',
    ]);
  });
});

describe('一个 app 的决定', () => {
  it('[AC-B2-04zo#u4] 一行都没有：只写最新到期的 D', () => {
    expect(planAssetSnapshotApp(DAYS, stored([]), NOW)).toEqual({
      missing: ['2032-06-16'],
      unconfirmed: [],
      gapAfter: null,
    });
  });

  it('[AC-B2-04zo#u5] 历史从最旧一行起：更早的不补，之间的空洞要补', () => {
    const plan = planAssetSnapshotApp(DAYS, stored([row('2032-06-14'), row('2032-06-16')]), NOW);
    expect(plan.missing).toEqual(['2032-06-15']);
    expect(plan.gapAfter).toBeNull();
  });

  it('[AC-B2-04zo#u6] 窗口前一天有行：缺口正好 7 天，不算窗口外的缺口', () => {
    const plan = planAssetSnapshotApp(DAYS, stored([], '2032-06-09'), NOW);
    expect(plan.missing).toEqual(DAYS);
    expect(plan.gapAfter).toBeNull();
  });

  it('[AC-B2-04zo#u7] 缺口跨出窗口：只在窗口最旧一天还缺时报，写上之后不再报', () => {
    expect(planAssetSnapshotApp(DAYS, stored([], '2032-06-08'), NOW).gapAfter).toBe('2032-06-08');
    const filled = stored(
      DAYS.map((day) => row(day)),
      '2032-06-08',
    );
    expect(planAssetSnapshotApp(DAYS, filled, NOW)).toEqual({
      missing: [],
      unconfirmed: [],
      gapAfter: null,
    });
  });
});

describe('一次 tick', () => {
  it('[AC-B2-04zo#u8] 未确认的行与缺的天合在一起由旧到新；已有超时事件的不碰', async () => {
    const { tick, runs, timedOutDays } = harness(
      {
        a: stored(
          [
            row('2032-06-12', false),
            row('2032-06-13', false),
            row('2032-06-14'),
            row('2032-06-16'),
          ],
          '2032-06-09',
        ),
      },
      { alerted: ['2032-06-12'] },
    );
    await tick;
    expect(timedOutDays).toHaveBeenCalledWith('a', ['2032-06-12', '2032-06-13']);
    expect(runs).toEqual([
      ['a', '2032-06-10'],
      ['a', '2032-06-11'],
      ['a', '2032-06-13'],
      ['a', '2032-06-15'],
    ]);
  });

  it('[AC-B2-04zo#u9] 00:30 前的未确认行不查事件，直接重放', async () => {
    const { tick, runs, timedOutDays } = harness({
      a: stored(
        [...DAYS.slice(0, 6).map((day) => row(day)), row('2032-06-16', false)],
        '2032-06-09',
      ),
    });
    await tick;
    expect(timedOutDays).not.toHaveBeenCalled();
    expect(runs).toEqual([['a', '2032-06-16']]);
  });

  it('[AC-B2-04zo#u10] 一天失败：该 app 更新的天本 tick 不写，别的 app 照写，日志不含报错文本', async () => {
    const { tick, runs, logger } = harness(
      { a: stored([], '2032-06-09'), b: stored([]) },
      { failOn: 'a:2032-06-11' },
    );
    await tick;
    expect(runs).toEqual([
      ['a', '2032-06-10'],
      ['b', '2032-06-16'],
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({ app_id: 'a', error_name: 'Error' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('synthetic-private-detail');
  });

  it('[AC-B2-04zo#u11] 窗口外的缺口写一条 error，字段里有 app', async () => {
    const { tick, logger } = harness({ a: stored([], '2032-06-01') });
    await tick;
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]).toEqual([
      { app_id: 'a', newest_before_gap: '2032-06-01', oldest_written_back: '2032-06-10' },
      'ledger_asset_snapshot_gap_beyond_window',
    ]);
  });

  it('[AC-B2-04zo#u12] 销毁中：不再开始新的一天', async () => {
    const run = vi.fn();
    await tickAssetSnapshots({
      db,
      clock: new FixedClock(NOW),
      logger: { warn: vi.fn(), error: vi.fn() },
      runner: { run },
      runs: {
        listApps: () => Promise.resolve(['a']),
        snapshotWindow: () => Promise.resolve(stored([])),
        timedOutDays: () => Promise.resolve(new Set()),
      },
      isStopped: () => true,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

it('[AC-B2-04zo#u13] 查事件用的 id 与 runner 发超时事件的 id 相同', async () => {
  const store = {
    lockSnapshot: () => Promise.resolve({ id: 's', waiting_comparable: false }),
  } as unknown as SnapshotWriteStore;
  const { alerts } = await confirmSnapshotDay(
    (work) => work({} as never),
    { store, clock: new FixedClock(NOW) },
    { appId: 'a', day: '2032-06-12', snapshotId: 's' },
  );
  expect(alerts.map((alert) => alert.eventId)).toEqual([timedOutEventId('a', '2032-06-12')]);
});
