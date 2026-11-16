// Rule test b (CT-13l; contract: header of ./kit.ts): the DEFAULT purge deletes the expired DEFAULT
// rows of every app and nothing else. Basis: BR-ID-30 正文（删除条件 created_at < 运行当日 00:00
// （+08:00）− 留存天数）and ② (link_logs 90 天，按日分区删除); ADR-0001 §4.2 #4 (按日的表预建未来 14 天；DEFAULT
// 分区兜底); D10-1693 (未来日期进 DEFAULT 的行不动).
//
// NOW 2026-10-09 04:00 (+08:00), cutoff 2026-07-11 00:00 (+08:00). The days a run pre-creates
// (10-09 … 10-23) and one expired day (06-01, not dropped: only this function is called) have day
// partitions; every other row lands in DEFAULT — the last instant before the cutoff, the cutoff
// itself, the day before today, the first instant after the pre-created range, next year and
// 2099.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  ensureDays,
  insertLog,
  partitionNames,
  withWorld,
} from '../../linking/link-log-evidence/kit.ts';
import {
  allLinkLogs,
  CUTOFF,
  dayPartition,
  labelsOf,
  NOW,
  placement,
  purgeDefault,
  requireFunction,
} from './kit.ts';

/** 'YYYY-MM-DD' of the i-th day after 2026-10-09. */
function octoberDay(i: number): string {
  return `2026-10-${String(9 + i).padStart(2, '0')}`;
}

/** Today (+08:00) and the 14 days a run pre-creates after it (ADR-0001 §4.2 #4). */
const PRE_CREATED = Array.from({ length: 15 }, (_, i) => octoberDay(i));
const EXPIRED_DAY = '2026-06-01';

interface Row {
  readonly label: string;
  readonly at: string;
  readonly appId?: string;
  /** The partition the row lands in. */
  readonly part: string;
  readonly deleted: boolean;
}

const ROWS: readonly Row[] = [
  {
    label: 'expired',
    at: '2026-07-10T15:59:59.999Z',
    part: 'link_logs_default',
    deleted: true,
  },
  {
    label: 'expired other app',
    at: '2026-01-01T00:00:00.000+08:00',
    appId: 'other-app',
    part: 'link_logs_default',
    deleted: true,
  },
  { label: 'cutoff', at: CUTOFF, part: 'link_logs_default', deleted: false },
  {
    label: 'day before today',
    at: '2026-10-08T23:59:59.999+08:00',
    part: 'link_logs_default',
    deleted: false,
  },
  {
    label: 'after pre-created range',
    at: '2026-10-24T00:00:00.000+08:00',
    part: 'link_logs_default',
    deleted: false,
  },
  {
    label: 'next year other app',
    at: '2027-06-30T12:00:00.000+08:00',
    appId: 'other-app',
    part: 'link_logs_default',
    deleted: false,
  },
  {
    label: '2099',
    at: '2099-12-31T23:59:59.999+08:00',
    part: 'link_logs_default',
    deleted: false,
  },
  {
    label: 'expired day partition',
    at: '2026-06-01T12:00:00.000+08:00',
    part: dayPartition(EXPIRED_DAY),
    deleted: false,
  },
  { label: 'today', at: NOW, part: dayPartition('2026-10-09'), deleted: false },
  {
    label: 'last pre-created day',
    at: '2026-10-23T23:59:59.999+08:00',
    part: dayPartition('2026-10-23'),
    deleted: false,
  },
];

it('[BR-ID-30 删除条件; ② link_logs 90 天; CT-13l b] DEFAULT 里早于截断的行（各 app）被删、返回删除行数；截断当刻及以后的行（含预建范围之后的未来日期与 2099 年）原样保留；日分区里的行（含未删的过期日分区）与分区本身都不动；再调一次删 0 行', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    await requireFunction(maint);
    const days = [EXPIRED_DAY, ...PRE_CREATED];
    expect(await ensureDays(maint, days)).toEqual(days.map((day) => dayPartition(day)));
    const ids: Record<string, string> = {};
    for (const row of ROWS) {
      const options = row.appId === undefined ? {} : { appId: row.appId };
      ids[row.label] = await insertLog(app, row.at, options);
    }
    const where = await placement(app);
    const found = where.map((r) => ({ label: labelsOf([r.id], ids)[0], part: r.part }));
    expect(found).toEqual(ROWS.map((row) => ({ label: row.label, part: row.part })));
    const before = await allLinkLogs(app);
    const parts = await partitionNames(maint);

    expect(await purgeDefault(maint, NOW)).toBe(2n);

    const kept = new Set(ROWS.filter((row) => !row.deleted).map((row) => ids[row.label]));
    expect(await allLinkLogs(app)).toEqual(before.filter((row) => kept.has(String(row.id))));
    expect(await partitionNames(maint)).toEqual(parts);
    expect(await purgeDefault(maint, NOW)).toBe(0n);
    expect(
      labelsOf(
        (await placement(app)).map((r) => r.id),
        ids,
      ),
    ).toEqual(ROWS.filter((row) => !row.deleted).map((row) => row.label));
  });
}, 60_000);
