// CT-13f / BR-ID-30 ③。仅隔离测试库；缺函数时 requireFunction 的断言先红。
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { sqlState } from '../../db/partitions/kit.ts';
import { inWorld, type World } from '../retention/kit.ts';
import { CUTOFF, dedupIds, NOW, purge, requireFunction, seedDedup, SIGNATURE } from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

// 手工日历样例，不调用被测实现计算期望值；覆盖 +08:00 日界、跨年、闰日。
const CASES = [
  { now: NOW, cutoff: CUTOFF },
  { now: '2026-10-08T15:59:59.999Z', cutoff: '2026-07-09T16:00:00.000Z' },
  { now: '2026-10-08T16:00:00.000Z', cutoff: CUTOFF },
  { now: '2026-12-31T16:00:00.000Z', cutoff: '2026-10-02T16:00:00.000Z' },
  { now: '2028-02-29T20:00:00.000Z', cutoff: '2027-12-01T16:00:00.000Z' },
] as const;

it.each(CASES)(
  '[AC-CT-13f#10] $now：90 天截断点前一微秒删、当刻和后一微秒留；跨 app，返回 bigint 行数，不受会话时区影响',
  async ({ now, cutoff }) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunction(maint);
      for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
        // 固定样例的截断时刻都是整秒；保留 PostgreSQL 的微秒精度，不通过 JS Date 舍入。
        const before = `${cutoff.slice(0, 11)}15:59:59.999999Z`;
        const after = cutoff.replace('.000Z', '.000001Z');
        await seedDedup(app, before);
        await seedDedup(app, before, 'other-app');
        const atId = await seedDedup(app, cutoff);
        const afterId = await seedDedup(app, after, 'other-app');
        await maint.transaction().execute(async (trx) => {
          await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
          expect(await purge(trx, now), zone).toBe(2n);
          expect(await purge(trx, now), `${zone} 重复调用`).toBe(0n);
        });
        expect(await dedupIds(app)).toEqual([atId, afterId].sort());
        // 清掉本轮仍存的边界夹具，下一种会话时区重新播种。
        expect(await purge(maint, '2030-01-01T20:00:00.000Z')).toBe(2n);
        expect(await dedupIds(app)).toEqual([]);
      }
    });
  },
  60_000,
);

it.each([
  { now: null, code: '22004' },
  { now: 'infinity', code: '22023' },
  { now: '-infinity', code: '22023' },
])(
  '[AC-CT-13f#11] p_now=$now 返回 $code，参数错误不删除任何去重记录',
  async ({ now, code }) => {
    await withWorld(async ({ app, maint }) => {
      await requireFunction(maint);
      const id = await seedDedup(app, '2020-01-01T00:00:00.000Z');
      expect(await sqlState(purge(maint, now))).toBe(code);
      expect(await dedupIds(app)).toEqual([id]);
    });
  },
  60_000,
);

it('[AC-CT-13f#12] SECURITY DEFINER、固定设置、只授 couli_maint；couli_app 等角色调用返回 42501', async () => {
  await withWorld(async ({ app, maint, payout, readonly }) => {
    await requireFunction(maint);
    const result = await sql<{
      owner: string;
      definer: boolean;
      result_type: string;
      settings: string[] | null;
      acl: string[] | null;
    }>`
      SELECT pg_get_userbyid(proowner)::text AS owner, prosecdef AS definer,
        pg_get_function_result(oid) AS result_type, proconfig AS settings, proacl::text[] AS acl
      FROM pg_proc WHERE oid = to_regprocedure(${SIGNATURE})
    `.execute(app);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      owner: 'couli_migrator',
      definer: true,
      result_type: 'bigint',
    });
    expect(result.rows[0]?.settings).toEqual(
      expect.arrayContaining([
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'DateStyle=ISO, YMD',
        'TimeZone=UTC',
      ]),
    );
    expect([...(result.rows[0]?.acl ?? [])].sort()).toEqual([
      'couli_maint=X/couli_migrator',
      'couli_migrator=X/couli_migrator',
    ]);
    const overloads = await sql<{ n: bigint }>`
      SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'purge_expired_event_dedup'
    `.execute(app);
    expect(overloads.rows).toEqual([{ n: 1n }]);
    const id = await seedDedup(app, '2020-01-01T00:00:00.000Z');
    for (const denied of [app, payout, readonly]) {
      expect(await sqlState(purge(denied, NOW))).toBe('42501');
    }
    expect(await dedupIds(app)).toEqual([id]);
    expect(await purge(maint, NOW)).toBe(1n);
    expect(await dedupIds(app)).toEqual([]);
  });
}, 60_000);
