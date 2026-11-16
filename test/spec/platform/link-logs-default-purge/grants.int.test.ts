// Rule test e (CT-13l; contract: header of ./kit.ts): only couli_maint executes the DEFAULT purge.
// Basis: db/AGENTS.md 迁移规则 4 (授权写在创建对象的同一个迁移里；业务角色只拿用得到的权限); ADR-0001 §4.2
// #4, #8 (couli_maint 以 SECURITY DEFINER 函数做分区与留存维护); D10-1693.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { insertLog, withWorld } from '../../linking/link-log-evidence/kit.ts';
import { NOW, placement, purgeDefault, requireFunction, SIGNATURE } from './kit.ts';

/** EXECUTE on the function, per business role. */
interface Privileges {
  readonly app: boolean;
  readonly readonly: boolean;
  readonly payout: boolean;
  readonly maint: boolean;
}

it('[db/AGENTS.md 迁移规则 4; ADR-0001 §4.2 #4、#8; CT-13l e] 只有 couli_maint 能执行 purge_expired_link_logs_default；couli_app、couli_readonly、couli_payout 执行得 42501，过期行不动', async () => {
  await withWorld(createTestDatabase, async ({ maint, app, readonly, payout }) => {
    await requireFunction(maint);
    const id = await insertLog(app, '2026-01-01T00:00:00.000+08:00');
    expect(await placement(app)).toEqual([{ id, part: 'link_logs_default' }]);

    expect(await purgeDefault(app, NOW)).toBe('failed 42501');
    expect(await purgeDefault(readonly, NOW)).toBe('failed 42501');
    expect(await purgeDefault(payout, NOW)).toBe('failed 42501');
    expect(await placement(app)).toEqual([{ id, part: 'link_logs_default' }]);

    const result = await sql<Privileges>`
      SELECT has_function_privilege('couli_app'::name, p.oid, 'EXECUTE') AS app,
             has_function_privilege('couli_readonly'::name, p.oid, 'EXECUTE') AS readonly,
             has_function_privilege('couli_payout'::name, p.oid, 'EXECUTE') AS payout,
             has_function_privilege('couli_maint'::name, p.oid, 'EXECUTE') AS maint
      FROM pg_proc p
      WHERE p.oid = to_regprocedure(${SIGNATURE}::text)
    `.execute(readonly);
    expect(result.rows).toEqual([{ app: false, readonly: false, payout: false, maint: true }]);

    expect(await purgeDefault(maint, NOW)).toBe(1n);
    expect(await placement(app)).toEqual([]);
  });
}, 60_000);
