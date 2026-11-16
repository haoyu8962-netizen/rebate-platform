// Rule tests for app.purge_expired_link_log_evidence(p_now) (CT-13m; contract: header of ./kit.ts).
// Basis: BR-ID-30 正文（每日 04:00（+08:00）删除任务；删除条件按运行当日 00:00（+08:00）截断）and ②
// (link_log_evidence 工单关闭后 180 天); D10-1625 (子项结案时刻是 claim_items.decided_at，claims 没有
// closed_at；引用它的子项全部结案、最晚 decided_at 满 180 天后删；没有任何引用的下一次删). Evidence rows are
// made the way production makes them: drop_expired_day_partitions copies them. Every test clones its
// own database.
//
// Cutoffs (00:00 (+08:00) of p_now's +08:00 day − 180 days):
//   P_BEFORE 2027-01-09T15:59:59.999Z = 2027-01-09 23:59:59.999 (+08:00) → 2026-07-13 00:00 (+08:00)
//            = 2026-07-12T16:00:00Z
//   P        2027-01-09T16:00:00.000Z = 2027-01-10 00:00 (+08:00)          → 2026-07-13T16:00:00Z
//   P_NEXT   2027-01-10T16:00:00.000Z = 2027-01-11 00:00 (+08:00)          → 2026-07-14T16:00:00Z
//   FAR      2100-01-01T00:00:00.000Z = 2100-01-01 08:00 (+08:00)          → 2099-07-04T16:00:00Z
//   FAR_NEXT 2100-01-01T16:00:00.000Z = 2100-01-02 00:00 (+08:00)          → 2099-07-05T16:00:00Z
// A row goes when the latest decided_at < cutoff; equal to the cutoff (1 ms later) it stays.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  decideItem,
  dropDays,
  ensureDays,
  evidenceIds,
  insertLog,
  linkLogIds,
  purge,
  purgeInZone,
  seedClaim,
  seedItem,
  seedUser,
  unreferenceItem,
  withWorld,
} from './kit.ts';

// 2026-04-07 04:00 (+08:00): drops p20260105 (cutoff 2026-01-07 00:00 +08:00, I1b).
const DROP_NOW = '2026-04-07T04:00:00+08:00';
const P_BEFORE = '2027-01-09T15:59:59.999Z';
const P = '2027-01-09T16:00:00.000Z';
const P_NEXT = '2027-01-10T16:00:00.000Z';
const FAR = '2100-01-01T00:00:00.000Z';
const FAR_NEXT = '2100-01-01T16:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

/** `count` link_logs rows in p20260105, in id order. */
async function logs(app: Parameters<typeof insertLog>[0], count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = `2026-01-05T10:00:0${String(i)}.000+08:00`;
    ids.push(await insertLog(app, at, { scene: 'search' }));
  }
  return ids;
}

it('[BR-ID-30 ② 工单关闭后 180 天、运行当日 00:00（+08:00）; CT-13m 3] 最晚 decided_at 早于截止即删、等于截止（差 1 毫秒）留；p_now 跨过 +08:00 的午夜截止前移一天；会话时区 Pacific/Kiritimati 不改变结果；没有任何引用的行第一次运行就删；重复运行不再删', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const [a = '', b = '', c = '', d = '', g = ''] = await logs(app, 5);
    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [a], '2026-07-12T15:59:59.999Z');
    await seedItem(app, claim, [b], '2026-07-12T16:00:00.000Z');
    await seedItem(app, claim, [c], '2026-07-13T15:59:59.999Z');
    await seedItem(app, claim, [d], '2026-07-13T16:00:00.000Z');
    const gItem = await seedItem(app, claim, [g], null);
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([a, b, c, d, g]);
    await unreferenceItem(app, gItem);

    expect(await purgeInZone(maint, 'Pacific/Kiritimati', P_BEFORE)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([b, c, d]);
    expect(await purge(maint, P_BEFORE)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([b, c, d]);
    expect(await purge(maint, P)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([d]);
    expect(await purge(maint, P_NEXT)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([]);
    expect(await purge(maint, P_NEXT)).toBe('ok');
    expect(await linkLogIds(app)).toEqual([]);
  });
});

it('[BR-ID-30 ② 工单关闭后; D10-1625 全部结案、最晚 decided_at; CT-13m 3] 引用它的子项有一项未结案就不删（多远的 p_now 都不删）；全部结案后按最晚的 decided_at 算，不按最早的', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const [e = '', f = '', h = '', i = ''] = await logs(app, 4);
    const first = await seedClaim(app, user);
    const second = await seedClaim(app, user);
    // e: one item decided long ago, another (of another claim) still pending.
    await seedItem(app, first, [e], LONG_AGO);
    const ePending = await seedItem(app, second, [e, f], null);
    // f: also decided long ago in the first claim; pending through ePending.
    await seedItem(app, first, [f], LONG_AGO);
    // h: only a pending item.
    const hPending = await seedItem(app, first, [h], null);
    // i: decided long ago and at P's cutoff.
    await seedItem(app, first, [i], LONG_AGO);
    await seedItem(app, second, [i], '2026-07-13T16:00:00.000Z');
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([e, f, h, i]);

    expect(await purge(maint, P)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([e, f, h, i]);
    expect(await purge(maint, FAR)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([e, f, h]);

    // e and f: the latest decision is now exactly P's cutoff; h's is exactly FAR's cutoff.
    await decideItem(app, ePending, '2026-07-13T16:00:00.000Z');
    await decideItem(app, hPending, '2099-07-04T16:00:00.000Z');
    expect(await purge(maint, P)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([e, f, h]);
    expect(await purge(maint, P_NEXT)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([h]);
    expect(await purge(maint, FAR)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([h]);
    expect(await purge(maint, FAR_NEXT)).toBe('ok');
    expect(await evidenceIds(maint)).toEqual([]);
  });
});
