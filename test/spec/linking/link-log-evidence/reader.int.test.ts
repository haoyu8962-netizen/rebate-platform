// Rule test for linking's link_logs moment reader over the evidence table (CT-13m; contract: header
// of ./kit.ts). Basis: BR-ATTR-14 默认值（被工单引用的记录在分区删除前复制到 link_log_evidence）; D10-1625
// (后台审核先查 link_logs 再查证据；只剩在证据表里的 id 也能返回，两边都没有的 id 才略过); B1-10j (the reader
// answers each record's time and scene, scoped by app_id; ids of another app or unknown ids are absent).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import { createLinkLogMomentReader } from '../../../../apps/api/src/modules/linking/index.ts';

import {
  dropDays,
  ensureDays,
  evidenceIds,
  insertLog,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from './kit.ts';

const DROP_NOW = '2026-04-07T04:00:00+08:00';
const OTHER_APP = 'evidence-other-app';

/** The reader's answer as plain data: id → { at (ISO), scene }. */
function plain(
  moments: ReadonlyMap<string, { readonly at: Date; readonly scene: string | null }>,
): Record<string, { at: string; scene: string | null }> {
  return Object.fromEntries(
    [...moments].map(([id, m]) => [id, { at: m.at.toISOString(), scene: m.scene }]),
  );
}

it('[BR-ATTR-14; D10-1625 先查 link_logs 再查证据; B1-10j; CT-13m 5] createLinkLogMomentReader 对只剩在证据表里的 id 也返回原时间与场景；还在 link_logs 的照常返回；两边都没有的 id、另一 App 的证据都略过', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const otherUser = await seedUser(app, OTHER_APP);
    const archived = await insertLog(app, '2026-01-05T10:00:00.250+08:00', { scene: 'search' });
    const gone = await insertLog(app, '2026-01-05T11:00:00.000+08:00', { scene: 'home' });
    const foreign = await insertLog(app, '2026-01-05T12:00:00.000+08:00', {
      appId: OTHER_APP,
      scene: 'detail',
    });
    // No day partition for March: the row stays in DEFAULT, never dropped.
    const live = await insertLog(app, '2026-03-01T09:00:00.000+08:00');
    await seedItem(app, await seedClaim(app, user), [archived, live], null);
    await seedItem(app, await seedClaim(app, otherUser, OTHER_APP), [foreign], null);
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([archived, foreign]);

    const reader = createLinkLogMomentReader(app);
    const ids = [archived, gone, foreign, live, '987654321', archived].map((id) => BigInt(id));
    expect(plain(await reader.moments('couli', ids))).toEqual({
      [archived]: { at: '2026-01-05T02:00:00.250Z', scene: 'search' },
      [live]: { at: '2026-03-01T01:00:00.000Z', scene: null },
    });
    expect(plain(await reader.moments(OTHER_APP, ids))).toEqual({
      [foreign]: { at: '2026-01-05T04:00:00.000Z', scene: 'detail' },
    });
  });
});
