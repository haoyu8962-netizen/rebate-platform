// B3-09m (D10-2864 S1-1): the cross-app read of one configuration key (every app, undefined
// when it lacks the key). The real SQL compiler and
// row mapping run against a scripted connection; nothing connects to a database.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { configValuesByKey } from './config-values-by-key.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fixture(answer: (query: CompiledQuery) => unknown[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: answer(query) as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries };
}

it('[AC-B3-09m#u6] 按键列出各 app 的当前值：一条只读 SELECT，缺这个键的 app 值为 undefined', async () => {
  const f = await fixture(() => [
    { app_id: 'app-a', value: 7, has_key: true },
    { app_id: 'app-b', value: { m: { in_mfen_per_m: 1 } }, has_key: true },
    { app_id: 'app-c', value: null, has_key: false },
  ]);
  expect(await configValuesByKey(f.db, 'agent.daily_budget_fen')).toEqual([
    { appId: 'app-a', value: 7 },
    { appId: 'app-b', value: { m: { in_mfen_per_m: 1 } } },
    { appId: 'app-c', value: undefined },
  ]);
  expect(f.queries).toHaveLength(1);
  const [query] = f.queries;
  expect(query?.sql).toMatch(/^\s*SELECT /);
  expect(query?.sql).toContain('FROM (SELECT DISTINCT app_id FROM app.config_items) AS apps');
  expect(query?.sql).toContain('LEFT JOIN app.config_items AS item');
  expect(query?.sql).toContain('item.key = $1');
  expect(query?.parameters).toEqual(['agent.daily_budget_fen']);
});

it('[AC-B3-09m#u7] 一个 app 都没有时返回空列表', async () => {
  const f = await fixture(() => []);
  expect(await configValuesByKey(f.db, 'agent.models')).toEqual([]);
});

it('[AC-B3-09m#u8] 读取失败时拒绝，不吞掉错误', async () => {
  const f = await fixture(() => {
    throw new Error('合成读取失败');
  });
  await expect(configValuesByKey(f.db, 'agent.models')).rejects.toThrow('合成读取失败');
});
