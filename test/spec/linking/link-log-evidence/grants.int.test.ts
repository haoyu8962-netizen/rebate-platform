// Rule tests for the privileges around app.link_log_evidence (CT-13m; contract: header of ./kit.ts).
// Basis: db/AGENTS.md 迁移规则 4 (授权写在创建对象的同一个迁移里；业务角色只拿用得到的权限；只追加的表不给
// UPDATE / DELETE); ADR-0001 §4.2 #4, #8 (couli_maint 以 SECURITY DEFINER 函数做分区与留存维护);
// D10-1625 (couli_app、couli_readonly 对证据表只读；couli_maint 能执行复制与清理函数，couli_app 不能).
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import type { DB } from '@couli/db';

import {
  dropDays,
  ensureDays,
  evidenceIds,
  insertLog,
  outcome,
  purge,
  seedClaim,
  seedItem,
  seedUser,
  withWorld,
} from './kit.ts';

const DROP_NOW = '2026-04-07T04:00:00+08:00';
const PURGE_NOW = '2027-01-10T04:00:00+08:00';

/** INSERT, UPDATE, DELETE and TRUNCATE of the evidence table as `db`, each `ok` / `failed <code>`. */
async function writes(db: Kysely<DB>): Promise<Record<string, string>> {
  return {
    insert: await outcome(
      sql`
        INSERT INTO app.link_log_evidence (id, app_id, event, result_code, created_at)
        VALUES (1, 'couli', 'open', 0, '2026-01-05T00:00:00Z')
      `.execute(db),
    ),
    update: await outcome(sql`UPDATE app.link_log_evidence SET result_code = 1`.execute(db)),
    delete: await outcome(sql`DELETE FROM app.link_log_evidence`.execute(db)),
    truncate: await outcome(sql`TRUNCATE app.link_log_evidence`.execute(db)),
  };
}

const DENIED = {
  insert: 'failed 42501',
  update: 'failed 42501',
  delete: 'failed 42501',
  truncate: 'failed 42501',
};

it('[db/AGENTS.md 迁移规则 4; D10-1625; CT-13m 4] couli_app、couli_readonly 能读证据表，增、改、删、清空都是 42501；表里的行不受影响', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, readonly }) => {
    expect(await ensureDays(maint, ['2026-01-05'])).toEqual(['link_logs_p20260105']);
    const user = await seedUser(app);
    const id = await insertLog(app, '2026-01-05T10:00:00+08:00');
    await seedItem(app, await seedClaim(app, user), [id], null);
    expect(await dropDays(maint, DROP_NOW)).toEqual(['link_logs_p20260105']);

    expect(await evidenceIds(app)).toEqual([id]);
    expect(await evidenceIds(readonly)).toEqual([id]);
    expect(await writes(app)).toEqual(DENIED);
    expect(await writes(readonly)).toEqual(DENIED);
    expect(await evidenceIds(readonly)).toEqual([id]);
  });
});

it('[ADR-0001 §4.2 #4、#8; D10-1625; CT-13m 4] couli_maint 能执行清理函数与（带复制的）删分区函数；couli_app、couli_readonly、couli_payout 执行它们都是 42501；名字含 link_log_evidence 的函数这三个角色都不能执行', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, readonly, payout }) => {
    for (const db of [app, readonly, payout]) {
      expect(await purge(db, PURGE_NOW)).toBe('failed 42501');
      expect(await dropDays(db, DROP_NOW)).toBe('failed 42501');
    }
    expect(await purge(maint, PURGE_NOW)).toBe('ok');
    expect(await dropDays(maint, DROP_NOW)).toEqual([]);

    const result = await sql<{
      name: string;
      app: boolean;
      readonly: boolean;
      payout: boolean;
      maint: boolean;
    }>`
      SELECT p.proname::text AS name,
             has_function_privilege('couli_app'::name, p.oid, 'EXECUTE') AS app,
             has_function_privilege('couli_readonly'::name, p.oid, 'EXECUTE') AS readonly,
             has_function_privilege('couli_payout'::name, p.oid, 'EXECUTE') AS payout,
             has_function_privilege('couli_maint'::name, p.oid, 'EXECUTE') AS maint
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND strpos(p.proname::text, 'link_log_evidence') > 0
      ORDER BY p.proname COLLATE "C"
    `.execute(readonly);
    expect(result.rows.map((r) => r.name)).toContain('purge_expired_link_log_evidence');
    // Helpers called only inside SECURITY DEFINER functions need no EXECUTE for couli_maint.
    expect(result.rows).toEqual(
      result.rows.map((r) => ({
        name: r.name,
        app: false,
        readonly: false,
        payout: false,
        maint: r.name === 'purge_expired_link_log_evidence' ? true : r.maint,
      })),
    );
  });
});
