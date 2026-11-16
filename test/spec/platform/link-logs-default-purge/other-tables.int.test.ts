// Rule test d (CT-13l; contract: header of ./kit.ts): the DEFAULT purge changes no other table.
// Basis: BR-ID-30 ② (打开尝试记录 link_open_attempts 与 link_logs 同期、按 open 成功时刻删除，由它自己的清理
// 函数负责; link_log_evidence 工单关闭后 180 天，由 CT-13m 的清理函数负责); D10-1693 (其他表不动).
//
// Around it: link_open_attempts rows on both sides of the cutoff (expired ones are another
// function's job), the link and the claim with its items, and an evidence row that no item
// references any more (purgeable by app.purge_expired_link_log_evidence, not by this function).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  dropDays,
  ensureDays,
  evidenceIds,
  insertLog,
  seedClaim,
  seedItem,
  seedUser,
  unreferenceItem,
  withWorld,
} from '../../linking/link-log-evidence/kit.ts';
import {
  CUTOFF,
  NOW,
  purgeDefault,
  requireFunction,
  seedAttempt,
  seedLink,
  tableRows,
  type OtherTable,
} from './kit.ts';

const OTHER_TABLES: readonly OtherTable[] = [
  'link_open_attempts',
  'links',
  'claims',
  'claim_items',
];

/** 2026-04-07 04:00 (+08:00): cutoff 2026-01-07 00:00 (+08:00), so p20260105 is dropped. */
const DROP_NOW = '2026-04-07T04:00:00+08:00';

it('[BR-ID-30 ②; D10-1693; CT-13l d] DEFAULT 清理前后 link_open_attempts、links、claims、claim_items 逐行不变（含已过期的打开尝试）；证据表里已有的行（含已无引用、可被证据清理删掉的行）原样保留', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    await requireFunction(maint);
    const user = await seedUser(app);
    const link = await seedLink(app);
    for (const at of ['2026-01-01T00:00:00.000Z', '2026-07-10T15:59:59.999Z', CUTOFF, NOW]) {
      await seedAttempt(app, link, at);
    }

    // An evidence row through the partition drop of CT-13m, then no longer referenced.
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const old = await insertLog(app, '2026-01-05T10:00:00.000+08:00', { scene: 'search' });
    const claim = await seedClaim(app, user);
    const dropped = await seedItem(app, claim, [old], '2026-02-01T00:00:00.000Z');
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    await unreferenceItem(app, dropped);
    expect(await evidenceIds(maint)).toEqual([old]);

    // DEFAULT rows: expired and referenced, expired and unreferenced, at the cutoff.
    const referenced = await insertLog(app, '2026-07-01T09:00:00.000+08:00', { scene: 'home' });
    await insertLog(app, '2026-07-02T09:00:00.000+08:00');
    await insertLog(app, CUTOFF);
    await seedItem(app, claim, [referenced], null);

    const before: Record<string, unknown> = {};
    for (const table of OTHER_TABLES) before[table] = await tableRows(app, table);
    const evidenceBefore = await tableRows(maint, 'link_log_evidence');
    expect(evidenceBefore).toHaveLength(1);

    expect(await purgeDefault(maint, NOW)).toBe(2n);

    const after: Record<string, unknown> = {};
    for (const table of OTHER_TABLES) after[table] = await tableRows(app, table);
    expect(after).toEqual(before);
    expect(await evidenceIds(maint)).toEqual([old, referenced]);
    const kept = Array.isArray(evidenceBefore) ? evidenceBefore : [];
    expect(await tableRows(maint, 'link_log_evidence')).toEqual(expect.arrayContaining(kept));
  });
}, 60_000);
