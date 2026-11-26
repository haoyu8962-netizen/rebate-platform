// B1-08zza 源码旁单元测试：readOrderAttributionLink 的查询形状。不连库：DummyDriver 只编译语句并记录。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { readOrderAttributionLink } from './order-link-reader.ts';

function recordingDb(seen: { sql: string; parameters: readonly unknown[] }[]): Kysely<DB> {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      seen.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
}

it('[AC-B1-08zza#U11] 按 (app_id, lk) 查 app.links 一次，不按平台过滤；无行为 null', async () => {
  const seen: { sql: string; parameters: readonly unknown[] }[] = [];
  const result = await readOrderAttributionLink(recordingDb(seen), {
    appId: 'app-1',
    lk: 'q7w2e9',
  });
  expect(result).toBeNull();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.sql).toMatch(/from "app"\."links" where "app_id" = \$1 and "lk" = \$2/);
  expect(seen[0]!.sql).not.toContain('"platform" =');
  expect(seen[0]!.parameters).toEqual(['app-1', 'q7w2e9']);
});

it('[AC-B1-08zza#U12] 不合法的 lk 不查库，直接 null', async () => {
  const seen: { sql: string; parameters: readonly unknown[] }[] = [];
  for (const lk of ['', 'UPPER', 'a'.repeat(17), 'a-b']) {
    expect(await readOrderAttributionLink(recordingDb(seen), { appId: 'app-1', lk })).toBeNull();
  }
  expect(seen).toEqual([]);
});
