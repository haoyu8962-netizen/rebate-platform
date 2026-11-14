// Rule test: a failing copy keeps the partition (CT-13m; contract: header of ./kit.ts). Basis:
// BR-ATTR-14 默认值（被工单引用的记录在分区删除前复制到 link_log_evidence）; D10-1624 / D10-1625（同一事务复制，
// 复制失败则不删）; I1b of apps/api/src/modules/platform/maintenance/index.ts (every wait of the drop is
// bounded by its lock_timeout of 5 s; on expiry the whole statement rolls back).
//
// How the copy is made to fail with business roles only (tests never connect as superuser): the
// evidence table holds one row per copied link_logs row, so it is unique on that row's key. A purge
// that deletes the evidence row of key (X, t) stays uncommitted while the drop has to copy a new
// link_logs row with the same key (X, t) (written with OVERRIDING SYSTEM VALUE into a re-created
// day partition). The copy cannot insert (X, t) before the purge ends, so its wait runs into the
// 5 s lock timeout and the call fails: the partition and its row must still be there. (A copy that
// skipped the row because the old evidence row was still visible would lose it once the purge
// commits.) After the purge has committed, the same call copies the row and drops the partition.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  asLinkLogs,
  dropDays,
  ensureDays,
  evidenceIds,
  evidenceRows,
  holder,
  insertLog,
  insertLogWithId,
  linkLogRow,
  partitionNames,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from './kit.ts';

// 2026-04-07 04:00 (+08:00): cutoff 2026-01-07 00:00 (+08:00), p20260105 is past it.
const DROP_NOW = '2026-04-07T04:00:00+08:00';
const CREATED = '2026-01-05T09:30:00.000+08:00';
// 2100-01-01 (+08:00) − 180 days is far past the item's 2020 decision.
const FAR = '2100-01-01T00:00:00.000Z';

it('[BR-ATTR-14 复制失败则不删; D10-1624; CT-13m 2] 复制失败时 drop_expired_day_partitions 抛错、分区与其中的行都还在、证据表不变；失败原因消失后同一调用复制并删除', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, database }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const id = await insertLog(app, CREATED, { scene: 'search' });
    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [id], '2020-01-01T00:00:00.000Z');
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([id]);

    // The same key again, still referenced by the decided item.
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const landed = await insertLogWithId(app, id, CREATED, 'second-copy');
    expect(landed).toBe('app.link_logs_p20260105');
    const second = await linkLogRow(app, id);
    expect(second).toMatchObject({ raw_item_id: 'second-copy', scene: 'share' });

    const purging = holder(database, 'couli_maint', async (trx) => {
      await sql`SELECT app.purge_expired_link_log_evidence(${FAR}::timestamptz)`.execute(trx);
    });
    try {
      expect(await purging.ready).toBe('ok');
      const blocked = await dropDays(maint, DROP_NOW);
      expect(blocked).toEqual(expect.stringMatching(/^failed [0-9A-Z]{5}$/));
      expect(await partitionNames(maint)).toEqual(['link_logs_default', 'link_logs_p20260105']);
      expect(await linkLogRow(app, id)).toEqual(second);
      // The purge has not committed: the old evidence row is still what others see.
      expect(await evidenceIds(maint)).toEqual([id]);
    } finally {
      purging.release();
      await purging.done;
    }

    expect(await evidenceIds(maint)).toEqual([]);
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await partitionNames(maint)).toEqual(['link_logs_default']);
    expect(asLinkLogs(await evidenceRows(maint), second)).toEqual([second]);
  });
});
