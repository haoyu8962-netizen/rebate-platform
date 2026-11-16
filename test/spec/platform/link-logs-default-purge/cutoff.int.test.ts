// Rule test a (CT-13l; contract: header of ./kit.ts): the cutoff of the DEFAULT purge is word for
// word the one of app.drop_expired_day_partitions for link_logs. Basis: BR-ID-30 正文（删除条件
// created_at < 运行当日 00:00（+08:00）− 留存天数）and ② (link_logs 90 天，按日分区删除); I1b of
// apps/api/src/modules/platform/maintenance/index.ts; D10-1693.
//
// For one p_now, the same five rows (1 day, 1 ms and 1 µs before the cutoff; at it; 1 ms after it)
// are written once into day partitions (database A) and once into the DEFAULT partition (database
// B, no day partition for those days: a DEFAULT row and a day partition of the same day cannot
// coexist). The latest dropped day partition (its upper bound = cutoff) holds the three earlier
// rows, the earliest kept one the two others; the DEFAULT purge must delete and keep exactly the
// same rows. Cutoffs are counted by hand (same calendar samples as CT-13f: +08:00 day boundary,
// year change, leap day). Each purge runs under a session TimeZone whose calendar date differs from
// the +08:00 one, then again under UTC (nothing more to delete).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { dropDays, ensureDays, insertLog, withWorld } from '../../linking/link-log-evidence/kit.ts';
import { dayPartition, labelsOf, placement, purgeDefault, requireFunction } from './kit.ts';

const CASES = [
  {
    now: '2026-10-08T15:59:59.999Z', // 10-08 23:59:59.999 (+08:00)
    cutoff: '2026-07-09T16:00:00.000Z', // 07-10 00:00 (+08:00)
    lastDropped: '2026-07-09',
    firstKept: '2026-07-10',
    zone: 'Pacific/Kiritimati',
  },
  {
    now: '2026-10-08T16:00:00.000Z', // 10-09 00:00 (+08:00)
    cutoff: '2026-07-10T16:00:00.000Z', // 07-11 00:00 (+08:00)
    lastDropped: '2026-07-10',
    firstKept: '2026-07-11',
    zone: 'America/New_York',
  },
  {
    now: '2026-12-31T16:00:00.000Z', // 2027-01-01 00:00 (+08:00)
    cutoff: '2026-10-02T16:00:00.000Z', // 10-03 00:00 (+08:00)
    lastDropped: '2026-10-02',
    firstKept: '2026-10-03',
    zone: 'UTC',
  },
  {
    now: '2028-02-29T20:00:00.000Z', // 2028-03-01 04:00 (+08:00)
    cutoff: '2027-12-01T16:00:00.000Z', // 2027-12-02 00:00 (+08:00)
    lastDropped: '2027-12-01',
    firstKept: '2027-12-02',
    zone: 'America/Los_Angeles',
  },
] as const;

const DELETED = ['C-1d', 'C-1ms', 'C-1us'];
const KEPT = ['C', 'C+1ms'];

/** The five instants around `cutoff` (a whole UTC 16:00), by label. */
function instants(cutoff: string): Record<string, string> {
  const at = Date.parse(cutoff);
  return {
    'C-1d': new Date(at - 86_400_000).toISOString(),
    'C-1ms': new Date(at - 1).toISOString(),
    // Microseconds stay in the text: PostgreSQL keeps them, a JS Date would round them away.
    'C-1us': `${cutoff.slice(0, 11)}15:59:59.999999Z`,
    C: cutoff,
    'C+1ms': new Date(at + 1).toISOString(),
  };
}

it.each(CASES)(
  '[BR-ID-30 删除条件; ② link_logs 90 天; CT-13l a] p_now $now：DEFAULT 清理与删日分区同一截断——被删的最晚日分区里的行与 DEFAULT 被删的行同在截断前（前 1 天 / 1 毫秒 / 1 微秒），保留的最早日分区与 DEFAULT 保留的行同在截断及以后；不受会话时区影响',
  async ({ now, cutoff, lastDropped, firstKept, zone }) => {
    const rows = instants(cutoff);

    // A: the day partitions, dropped by app.drop_expired_day_partitions.
    let partitionSide: string[] = [];
    await withWorld(createTestDatabase, async ({ maint, app }) => {
      expect(await ensureDays(maint, [lastDropped, firstKept])).toEqual([
        dayPartition(lastDropped),
        dayPartition(firstKept),
      ]);
      const ids: Record<string, string> = {};
      for (const [label, at] of Object.entries(rows)) ids[label] = await insertLog(app, at);
      const before = await placement(app);
      expect(
        labelsOf(
          before.map((r) => r.id),
          ids,
        ),
      ).toEqual([...DELETED, ...KEPT]);
      expect(before.map((r) => r.part)).toEqual([
        ...DELETED.map(() => dayPartition(lastDropped)),
        ...KEPT.map(() => dayPartition(firstKept)),
      ]);
      expect(await dropDays(maint, now)).toEqual([dayPartition(lastDropped)]);
      partitionSide = labelsOf(
        (await placement(app)).map((r) => r.id),
        ids,
      );
    });

    // B: the same rows in the DEFAULT partition, deleted by the function under test.
    let defaultSide: string[] = [];
    await withWorld(createTestDatabase, async ({ maint, app }) => {
      await requireFunction(maint);
      const ids: Record<string, string> = {};
      for (const [label, at] of Object.entries(rows)) ids[label] = await insertLog(app, at);
      const before = await placement(app);
      expect(
        labelsOf(
          before.map((r) => r.id),
          ids,
        ),
      ).toEqual([...DELETED, ...KEPT]);
      const everyDefault = [...DELETED, ...KEPT].map(() => 'link_logs_default');
      expect(before.map((r) => r.part)).toEqual(everyDefault);
      expect(await purgeDefault(maint, now, zone)).toBe(3n);
      expect(await purgeDefault(maint, now, 'UTC')).toBe(0n);
      defaultSide = labelsOf(
        (await placement(app)).map((r) => r.id),
        ids,
      );
    });

    expect({ partitions: partitionSide, default: defaultSide }).toEqual({
      partitions: KEPT,
      default: KEPT,
    });
  },
  120_000,
);
