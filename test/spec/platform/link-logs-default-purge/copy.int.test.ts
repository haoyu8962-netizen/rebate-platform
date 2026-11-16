// Rule test c (CT-13l; contract: header of ./kit.ts): expired DEFAULT rows referenced by a claim
// item are copied into app.link_log_evidence before they are deleted. Basis: BR-ATTR-14 默认值（被工单
// 引用的记录在分区删除前复制到 link_log_evidence）; 规划/04 第 438 行 (link_logs / link_log_evidence 同一组字段);
// D10-1625 (引用 link_logs 的工单只有认领：claim_items.evidence_link_log_ids，按 id 引用); D10-1693.
//
// NOW 2026-10-09 04:00 (+08:00), cutoff 2026-07-11 00:00 (+08:00); no day partition exists, so
// every row is in DEFAULT.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  asLinkLogs,
  evidenceIds,
  evidenceRows,
  insertFullLog,
  insertLog,
  linkLogIds,
  linkLogRow,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from '../../linking/link-log-evidence/kit.ts';
import { CUTOFF, NOW, placement, purgeDefault, requireFunction } from './kit.ts';

it('[BR-ATTR-14 默认值; CT-13l c] DEFAULT 里过期且被认领子项引用的行（子项待审或已结案、一个或多个子项、与未知 id 同列）逐列原样进证据表、每个 id 一行，然后被删；未被引用的过期行直接删、不进证据表；截断当刻被引用的行不复制也不删；再调一次不重复复制', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    await requireFunction(maint);
    const user = await seedUser(app);
    const opener = await seedUser(app);
    const full = await insertFullLog(app, '2026-07-10T23:59:59.999+08:00', {
      userId: user,
      openerId: opener,
    });
    const bare = await insertLog(app, '2026-04-01T08:00:00.000+08:00');
    // closed: referenced ONLY by the decided (已结案) item below, so an implementation that copies
    // just the rows referenced by pending items fails here.
    const closed = await insertLog(app, '2026-06-15T12:30:00.000+08:00', { scene: 'share' });
    const loose = await insertLog(app, '2026-05-01T08:00:00.000+08:00', { scene: 'search' });
    const fresh = await insertLog(app, CUTOFF, { scene: 'detail' });
    const parts = (await placement(app)).map((r) => r.part);
    expect(parts).toEqual([full, bare, closed, loose, fresh].map(() => 'link_logs_default'));
    const before = [
      await linkLogRow(app, full),
      await linkLogRow(app, bare),
      await linkLogRow(app, closed),
    ];
    expect(before.every((row) => row !== undefined)).toBe(true);
    expect(before[0]).toMatchObject({ user_id: user, opener_user_id: opener, cache_hit: true });
    expect(before[2]).toMatchObject({ scene: 'share' });

    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [full, bare], null);
    await seedItem(app, claim, [bare, closed], '2026-08-01T00:00:00.000Z');
    await seedItem(app, claim, [fresh, '987654321'], null);
    await seedItem(app, claim, [], '2026-08-01T00:00:00.000Z');
    expect(await linkLogIds(app)).toEqual([full, bare, closed, loose, fresh]);

    expect(await purgeDefault(maint, NOW)).toBe(4n);
    expect(await linkLogIds(app)).toEqual([fresh]);
    expect(await evidenceIds(maint)).toEqual([full, bare, closed]);
    expect(asLinkLogs(await evidenceRows(maint), before[0])).toEqual(before);

    expect(await purgeDefault(maint, NOW)).toBe(0n);
    expect(await evidenceIds(maint)).toEqual([full, bare, closed]);
  });
}, 60_000);
