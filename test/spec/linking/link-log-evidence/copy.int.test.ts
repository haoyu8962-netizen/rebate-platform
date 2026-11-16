// Rule tests for the copy into app.link_log_evidence (CT-13m; contract: header of ./kit.ts). Basis:
// BR-ATTR-14 默认值「被工单引用的记录在分区删除前复制到 link_log_evidence」; 规划/04 第 438 行 (link_logs /
// link_log_evidence 同一组字段); D10-1625 (引用 link_logs 的工单只有认领：claim_items.evidence_link_log_ids，
// 按 id 引用；link_logs 的日分区由 app.drop_expired_day_partitions 删除). Every test clones its own database.
//
// 2026-04-07 04:00 (+08:00): cutoff 2026-01-07 00:00 (+08:00) (90 days, I1b), so p20260105 and
// p20260106 are dropped and p20260107 stays.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  asLinkLogs,
  columnsOf,
  dropDays,
  ensureDays,
  evidenceIds,
  evidenceRows,
  holder,
  insertFullLog,
  insertLog,
  linkLogIds,
  linkLogRow,
  maintWaits,
  partitionNames,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from './kit.ts';

const DROP_NOW = '2026-04-07T04:00:00+08:00';
const DAYS = ['2026-01-05', '2026-01-06', '2026-01-07'];
const PARTS = ['link_logs_p20260105', 'link_logs_p20260106', 'link_logs_p20260107'];

it('[规划/04 link_logs / link_log_evidence 同一组字段; CT-13m 1] link_log_evidence 有 link_logs 的每一列，类型相同', async () => {
  await withWorld(createTestDatabase, async ({ readonly }) => {
    const logs = await columnsOf(readonly, 'link_logs');
    expect(logs.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'scene', 'created_at']));
    const evidence = await columnsOf(readonly, 'link_log_evidence');
    const byName = new Map(evidence.map((c) => [c.name, c.type]));
    const matched = logs.map((c) => ({ name: c.name, type: byName.get(c.name) ?? 'missing' }));
    expect(matched).toEqual(logs);
  });
});

it('[BR-ATTR-14 默认值; CT-13m 1] 日分区过期被删时，被认领子项引用的行（子项待审或已结案、一个或多个子项、与未知 id 同列）逐列原样进证据表、每个 id 一行；未被引用的行与未过期分区里被引用的行都不进；删除结果同 I1b', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    expect(await ensureDays(maint, DAYS)).toEqual(PARTS);
    const user = await seedUser(app);
    const opener = await seedUser(app);
    const full = await insertFullLog(app, '2026-01-05T10:00:00.123+08:00', {
      userId: user,
      openerId: opener,
    });
    const bare = await insertLog(app, '2026-01-06T23:59:59.999+08:00');
    const loose = await insertLog(app, '2026-01-05T11:00:00+08:00');
    const fresh = await insertLog(app, '2026-01-07T00:00:00.000+08:00', { scene: 'search' });
    const before = [await linkLogRow(app, full), await linkLogRow(app, bare)];
    expect(before.every((row) => row !== undefined)).toBe(true);
    expect(before[0]).toMatchObject({ user_id: user, opener_user_id: opener, cache_hit: true });

    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [full, bare], null);
    await seedItem(app, claim, [full], '2026-02-01T00:00:00.000Z');
    await seedItem(app, claim, [fresh, '987654321'], null);
    await seedItem(app, claim, [], '2026-02-01T00:00:00.000Z');
    expect(await linkLogIds(app)).toEqual([full, bare, loose, fresh]);

    expect(await dropDays(maint, DROP_NOW)).toEqual(PARTS.slice(0, 2));
    expect(await partitionNames(maint)).toEqual(['link_logs_default', PARTS[2]]);
    expect(await linkLogIds(app)).toEqual([fresh]);
    expect(await evidenceIds(maint)).toEqual([full, bare]);
    expect(asLinkLogs(await evidenceRows(maint), before[0])).toEqual(before);
  });
});

it('[BR-ATTR-14 默认值; CT-13m 1] 一次删多个分区时各分区被引用的行都复制；再删一次（没有可删的分区）不重复复制、不报错', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    expect(await ensureDays(maint, DAYS)).toEqual(PARTS);
    const user = await seedUser(app);
    const a = await insertLog(app, '2026-01-05T00:00:00.000+08:00', { scene: 'home' });
    const b = await insertLog(app, '2026-01-06T12:00:00.000+08:00', { scene: 'detail' });
    const claim = await seedClaim(app, user);
    await seedItem(app, claim, [b, a], '2026-03-01T00:00:00.000Z');
    const before = [await linkLogRow(app, a), await linkLogRow(app, b)];

    expect(await dropDays(maint, DROP_NOW)).toEqual(PARTS.slice(0, 2));
    expect(await dropDays(maint, DROP_NOW)).toEqual([]);
    expect(await evidenceIds(maint)).toEqual([a, b]);
    expect(asLinkLogs(await evidenceRows(maint), before[0])).toEqual(before);
  });
});

it('[BR-ATTR-14 默认值; ADR-0001 §4.2 #4 并发; CT-13m 1] 删除等表锁期间另一事务提交了对该行的引用：删除在锁等待结束后照常完成，该行进证据表', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, readonly, database }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const late = await insertLog(app, '2026-01-05T08:00:00.000+08:00', { scene: 'search' });
    const claim = await seedClaim(app, user);
    const before = await linkLogRow(app, late);

    // The writer reads the record (as the claim matcher does) and references it in one transaction.
    const writer = holder(database, 'couli_app', async (trx) => {
      await sql`SELECT id FROM app.link_logs WHERE id = ${late}::bigint`.execute(trx);
      await seedItem(trx, claim, [late], null);
    });
    let dropping: Promise<string[] | string> = Promise.resolve('not started');
    try {
      expect(await writer.ready).toBe('ok');
      dropping = dropDays(maint, DROP_NOW);
      expect(await maintWaits(readonly)).toBe(true);
    } finally {
      writer.release();
      await writer.done;
    }
    expect(await dropping).toEqual(['link_logs_p20260105']);
    expect(await evidenceIds(maint)).toEqual([late]);
    expect(asLinkLogs(await evidenceRows(maint), before)).toEqual([before]);
  });
});
