// CT-13o / D10-1874；BR-ID-30 正文、②；BR-ATTR-14 被引用的记录先复制再删除。
// 只调用真实 SQL 函数，不创建迁移、触发器或替代实现。保留 CT-13l 单参入口的兼容性。
// 每次调用删除行数不超过 20,000；实现方在此上限内自定批大小并写明理由。
// 20,001 是积压夹具规模；首批必须小于积压，后续均不得超过该满批。
// 截断日期手工计算，和 CT-13l 相同；额外覆盖分批中的边界行、跨 app、提交/回滚及恢复。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import {
  asLinkLogs,
  ensureDays,
  evidenceRows,
  failure,
  insertLog,
  linkLogRow,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from '../../linking/link-log-evidence/kit.ts';
import { CUTOFF, defaultRows, NOW, requireFunction } from '../link-logs-default-purge/kit.ts';

const BACKLOG = 20_001;

/** 批量夹具只 INSERT，经 couli_app 写入真实 DEFAULT 分区。 */
async function seedBacklog(db: Kysely<DB>, cutoff: string, crossApp: boolean): Promise<string[]> {
  const result = await sql<{ id: string; part: string }>`
    INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, scene, created_at)
    SELECT CASE WHEN ${crossApp}::boolean AND n % 2 = 0 THEN 'other-app' ELSE 'couli' END,
           'open', 0, 'batch-fixture-' || n::text, 'share',
           ${cutoff}::timestamptz - CASE WHEN n % 3 = 0 THEN interval '1 microsecond'
             WHEN n % 3 = 1 THEN interval '1 millisecond' ELSE interval '1 day' END
    FROM generate_series(1, ${BACKLOG}::integer) AS s(n)
    RETURNING id::text AS id, tableoid::regclass::text AS part
  `.execute(db);
  expect(result.rows).toHaveLength(BACKLOG);
  expect(new Set(result.rows.map((row) => row.part))).toEqual(new Set(['app.link_logs_default']));
  return result.rows.map((row) => row.id);
}

/** 返回函数的原始结果；SQL 错误作为值交给断言，不能以签名/运行时错误充当先红。 */
async function callBatch(trx: Kysely<DB>, now: string): Promise<bigint | string> {
  const result = await sql<{ deleted: bigint }>`
    SELECT app.purge_expired_link_logs_default(${now}::timestamptz) AS deleted
  `.execute(trx);
  const marker = await sql<{ value: string | null }>`
    SELECT current_setting('couli.link_logs_default_purge_before', true) AS value
  `.execute(trx);
  expect(marker.rows[0]?.value, '每批 DELETE 后仍须复位放行标记').toBe('');
  return result.rows[0]?.deleted ?? 'missing deleted count';
}

async function batch(db: Kysely<DB>, now: string, zone: string): Promise<bigint | string> {
  // 仅捕获 SQL 异常；让 callBatch 的规则断言保持断言失败。
  try {
    return await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
      await sql`SELECT set_config('statement_timeout', '60s', true)`.execute(trx);
      return callBatch(trx, now);
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    return failure(error);
  }
}

function firstBound(deleted: bigint | string): bigint {
  expect(deleted).toBeTypeOf('bigint');
  expect(deleted).toBeGreaterThan(0n);
  expect(deleted, '大积压不能在一次调用中无上限删光').toBeLessThan(BigInt(BACKLOG));
  return deleted as bigint;
}

async function remaining(db: Kysely<DB>, cutoff: string): Promise<bigint> {
  const result = await sql<{ count: bigint }>`
    SELECT count(*) AS count FROM app.link_logs
    WHERE tableoid = 'app.link_logs_default'::regclass
      AND created_at < ${cutoff}::timestamptz
  `.execute(db);
  return result.rows[0]!.count;
}

/** 返回 0 前每批确实减少相同数量，累计不漏删；最后剩余尾批也必须处理。 */
async function drain(
  db: Kysely<DB>,
  readDb: Kysely<DB>,
  now: string,
  cutoff: string,
  zone: string,
  bound: bigint,
  initial: bigint,
): Promise<void> {
  let left = initial;
  // 至多 BACKLOG 个正数批 + 一次空批；无进展会在本轮断言失败，不靠超时。
  for (let round = 0; round <= BACKLOG; round += 1) {
    const deleted = await batch(db, now, zone);
    expect(deleted).toBeTypeOf('bigint');
    expect(deleted).toBeGreaterThanOrEqual(0n);
    expect(deleted).toBeLessThanOrEqual(bound);
    const count = deleted as bigint;
    expect(await remaining(readDb, cutoff)).toBe(left - count);
    if (left === 0n) {
      expect(count).toBe(0n);
      return;
    }
    expect(count, '有可删积压时每批必须推进').toBeGreaterThan(0n);
    left -= count;
  }
  expect(left, '调用预算内必须删净并返回 0').toBe(0n);
}

const CALENDARS = [
  { now: '2026-10-08T15:59:59.999Z', cutoff: '2026-07-09T16:00:00Z', zone: 'Pacific/Kiritimati' },
  { now: NOW, cutoff: CUTOFF, zone: 'America/New_York' },
  { now: '2026-12-31T16:00:00Z', cutoff: '2026-10-02T16:00:00Z', zone: 'UTC' },
  { now: '2028-02-29T20:00:00Z', cutoff: '2027-12-01T16:00:00Z', zone: 'America/Los_Angeles' },
] as const;

it.each(CALENDARS)(
  '[AC-CT-13o#4] $now / $zone：积压逐批减少且每批有界；+08:00 截断前才删、跨 app 同口径、日分区和未到期行原样保留',
  async ({ now, cutoff, zone }) => {
    await withWorld(createTestDatabase, async ({ maint, app }) => {
      await requireFunction(maint);
      // 独立的过期日分区应原样保留，由日分区删除入口负责。
      expect(await ensureDays(maint, ['2026-01-02'])).toEqual(['link_logs_p20260102']);
      const partitionId = await insertLog(app, '2026-01-02T04:00:00+08:00');
      const dayRow = await linkLogRow(app, partitionId);
      await seedBacklog(app, cutoff, true);
      const kept = [
        await insertLog(app, cutoff),
        await insertLog(app, cutoff, { appId: 'other-app' }),
        await insertLog(app, new Date(Date.parse(cutoff) + 1).toISOString()),
        await insertLog(app, '2099-01-01T00:00:00Z'),
      ];
      const originals = await Promise.all(kept.map((id) => linkLogRow(app, id)));
      const first = firstBound(await batch(maint, now, zone));
      const left = BigInt(BACKLOG) - first;
      expect(await remaining(app, cutoff)).toBe(left);
      await drain(maint, app, now, cutoff, zone, first, left);
      expect(await defaultRows(app)).toEqual(originals);
      expect(await linkLogRow(app, partitionId)).toEqual(dayRow);
      expect(await evidenceRows(maint)).toEqual([]);
    });
  },
  120_000,
);

it('[AC-CT-13o#6] 同一 id 在不同 created_at 有多行时，删除仍按行限批，不能因只按 id 匹配而放大一批', async () => {
  await withWorld(createTestDatabase, async ({ maint, app }) => {
    await requireFunction(maint);
    // link_logs 的主键为 (id, created_at)，不能假定 id 单列唯一；模拟历史回放。
    await sql`
      INSERT INTO app.link_logs (id, app_id, event, result_code, created_at)
      OVERRIDING SYSTEM VALUE
      SELECT 9000000000000000000::bigint, 'couli', 'open', 0,
             ${CUTOFF}::timestamptz - n * interval '1 microsecond'
      FROM generate_series(1, ${BACKLOG}::integer) AS s(n)
    `.execute(app);
    expect(await remaining(app, CUTOFF)).toBe(BigInt(BACKLOG));
    const first = firstBound(await batch(maint, NOW, 'UTC'));
    const left = BigInt(BACKLOG) - first;
    expect(await remaining(app, CUTOFF)).toBe(left);
    await drain(maint, app, NOW, CUTOFF, 'UTC', first, left);
    expect(await defaultRows(app)).toEqual([]);
  });
}, 120_000);

it('[AC-CT-13o#5] 首批提交即已有完整引用证据；下一批事务中断只回滚该批，重连续清后证据不丢失、不重复', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, database }) => {
    await requireFunction(maint);
    const ids = await seedBacklog(app, CUTOFF, false);
    const originals = await defaultRows(app);
    const claim = await seedClaim(app, await seedUser(app));
    // 无论哪一批、哪一种决定状态，引用的行都必须先复制；不约束 DELETE 的排序。
    await seedItem(
      app,
      claim,
      ids.filter((_, index) => index % 2 === 0),
      null,
    );
    await seedItem(
      app,
      claim,
      ids.filter((_, index) => index % 2 !== 0),
      '2026-08-01T00:00:00Z',
    );
    const first = firstBound(await batch(maint, NOW, 'UTC'));
    const afterFirst = await defaultRows(app);
    const firstEvidence = await evidenceRows(maint);
    const retainedIds = new Set(afterFirst.map((row) => String(row['id'])));
    const removed = originals.filter((row) => !retainedIds.has(String(row['id'])));
    expect(BigInt(removed.length)).toBe(first);
    const copied = asLinkLogs(firstEvidence, originals[0]);
    expect(Array.isArray(copied)).toBe(true);
    const byId = new Map(
      (copied as Array<Record<string, unknown>>).map((row) => [String(row['id']), row]),
    );
    expect(removed.map((row) => byId.get(String(row['id'])))).toEqual(removed);
    expect(await remaining(app, CUTOFF)).toBe(BigInt(BACKLOG) - first);

    const interruption = new Error('synthetic transaction interruption after second batch');
    await expect(
      maint.transaction().execute(async (trx) => {
        await sql`SELECT set_config('statement_timeout', '60s', true)`.execute(trx);
        const deleted = await callBatch(trx, NOW);
        expect(deleted).toBeGreaterThan(0n);
        expect(deleted).toBeLessThanOrEqual(first);
        throw interruption;
      }),
    ).rejects.toBe(interruption);
    expect(await defaultRows(app)).toEqual(afterFirst);
    expect(await evidenceRows(maint)).toEqual(firstEvidence);

    // 新连接模拟维护进程中断后的恢复，无进程内游标；已提交的首批不重新出现。
    const resumed = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
    try {
      await drain(resumed, app, NOW, CUTOFF, 'UTC', first, BigInt(BACKLOG) - first);
    } finally {
      await destroyDb(resumed);
    }
    expect(await defaultRows(app)).toEqual([]);
    expect(asLinkLogs(await evidenceRows(maint), originals[0])).toEqual(originals);
    expect(await batch(maint, NOW, 'UTC')).toBe(0n);
    expect(asLinkLogs(await evidenceRows(maint), originals[0])).toEqual(originals);
  });
}, 120_000);
