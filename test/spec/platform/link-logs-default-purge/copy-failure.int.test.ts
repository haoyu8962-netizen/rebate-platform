// Rule test c, failure half (CT-13l; contract: header of ./kit.ts): a failing copy fails the call and
// deletes no DEFAULT row. Basis: BR-ATTR-14 默认值（被工单引用的记录在分区删除前复制到
// link_log_evidence）; D10-1624 / D10-1625 (同一事务复制，复制失败则不删); D10-1693.
//
// How the copy is made to fail with business roles only (the way of the CT-13m copy-failure test):
// the evidence table holds one row per link_logs id. A day partition is dropped with its referenced
// row X copied into evidence; a new link_logs row with the same id X (OVERRIDING SYSTEM VALUE) then
// lands in DEFAULT, still referenced. A purge of the evidence row X stays uncommitted while the
// DEFAULT purge has to copy X again: the copy cannot insert X before that purge ends, so it waits
// into the 5 s lock timeout (55P03) and the call fails — every DEFAULT row must still be there. (A
// copy that skipped X because the old evidence row was still visible would lose it once the
// evidence purge commits.) Afterwards the same call copies both referenced rows and deletes all
// three expired ones.
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
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from '../../linking/link-log-evidence/kit.ts';
import { defaultRows, NOW, purgeDefault, requireFunction } from './kit.ts';

// 2026-04-07 04:00 (+08:00): cutoff 2026-01-07 00:00 (+08:00), p20260105 is past it.
const DROP_NOW = '2026-04-07T04:00:00+08:00';
const CREATED = '2026-01-05T09:30:00.000+08:00';
// 2100-01-01 (+08:00) − 180 days is far past the item's 2020 decision.
const FAR = '2100-01-01T00:00:00.000Z';

it('[BR-ATTR-14 复制失败则不删; D10-1624; CT-13l c] 复制失败时 purge_expired_link_logs_default 抛错、DEFAULT 一行不删、证据表不变；失败原因消失后同一调用复制被引用的行并删除全部过期行', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, database }) => {
    await requireFunction(maint);
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const id = await insertLog(app, CREATED, { scene: 'search' });
    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [id], '2020-01-01T00:00:00.000Z');
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([id]);

    // The same key again, now in DEFAULT (the day has no partition any more), still referenced.
    expect(await insertLogWithId(app, id, CREATED, 'second-copy')).toBe('app.link_logs_default');
    await insertLog(app, '2026-01-06T10:00:00.000+08:00');
    const other = await insertLog(app, '2026-01-06T11:00:00.000+08:00', { scene: 'home' });
    await seedItem(app, claim, [other], null);
    const second = await linkLogRow(app, id);
    expect(second).toMatchObject({ raw_item_id: 'second-copy', scene: 'share' });
    const otherRow = await linkLogRow(app, other);
    const before = await defaultRows(app);
    expect(before).toHaveLength(3);

    const purging = holder(database, 'couli_maint', async (trx) => {
      await sql`SELECT app.purge_expired_link_log_evidence(${FAR}::timestamptz)`.execute(trx);
    });
    try {
      expect(await purging.ready).toBe('ok');
      expect(await purgeDefault(maint, NOW)).toBe('failed 55P03');
      expect(await defaultRows(app)).toEqual(before);
      // The evidence purge has not committed: the old evidence row is still what others see.
      expect(await evidenceIds(maint)).toEqual([id]);
    } finally {
      purging.release();
      await purging.done;
    }

    expect(await evidenceIds(maint)).toEqual([]);
    expect(await purgeDefault(maint, NOW)).toBe(3n);
    expect(await defaultRows(app)).toEqual([]);
    expect(asLinkLogs(await evidenceRows(maint), second)).toEqual([second, otherRow]);
  });
}, 60_000);
