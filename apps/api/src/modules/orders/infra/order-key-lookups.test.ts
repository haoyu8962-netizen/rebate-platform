// B1-09x 源码旁单元测试（FU-ORDERS-OWN-LOOKUP-INDEX，D10-853）：按单号查订单的语句形状。不连库：Kysely 用无连接
// 驱动编译真实 SQL、记下语句、答空行。淘宝 / 京东子单号等值经 order_keys 取 (order_id, attr_at) 再读 orders；父单号
// 走等值（orders_parent_order_idx）；后台搜索拆成两路 UNION ALL 且两路不相交；拼多多去横线照旧。真库取值见
// test/spec/orders/own-lookup-index。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
  type Transaction,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createAdminOrderReads } from './admin-order-reads.ts';
import { findClaimOrders } from './claim-store.ts';
import { readOrderByKey, selectDueSubOrders } from './snapshot-retry-store.ts';

function recording() {
  const statements: CompiledQuery[] = [];
  class Driver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
          statements.push(query);
          return Promise.resolve({ rows: [{ n: 0 }] as unknown as R[] });
        },
        streamQuery() {
          throw new Error('unexpected stream query');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  // The functions under test only compile and execute statements on the handle.
  return { db, trx: db as unknown as Transaction<DB>, statements };
}

const KEYED = (n: number, platform: boolean) =>
  `("order_id", "attr_at") in (select "k"."order_id", "k"."attr_at" from "app"."order_keys" as "k" where "k"."app_id" = $${n}${platform ? ` and "k"."platform" = $${n + 1}` : ''} and "k"."sub_order_id" = $${n + (platform ? 2 : 1)})`;

it('[AC-B1-09x-UNIT#2] 后台订单搜索带 q：count 与 page 读同一个两路 UNION ALL（子单号经 order_keys、父单号等值且排除子单号同为 q 的行），不再有 or；不带 platform 时 order_keys 子查询也不限平台', async () => {
  const { db, statements } = recording();
  const reads = createAdminOrderReads(db);
  await reads.count({ appId: 'A', q: 'Q', platform: 'jd' });
  await reads.page({ appId: 'A', q: 'Q' }, 4, 2);
  expect(statements).toHaveLength(2);
  const [count, page] = statements as [CompiledQuery, CompiledQuery];
  for (const statement of statements) {
    expect(statement.sql).not.toMatch(/\bor\b/i);
    expect(statement.sql).toMatch(/ union all /);
    expect(statement.sql).toMatch(/"sub_order_id" <> \$\d+\) as "o"/);
  }
  expect(count.sql).toMatch(/^select count\(\*\)::int as "n" from \(select /);
  expect(count.sql).toContain(KEYED(3, true));
  expect(count.sql).toContain(
    '"parent_order_id" is not null and "parent_order_id" = $8 and "sub_order_id" <> $9',
  );
  expect(count.parameters).toEqual(['A', 'jd', 'A', 'jd', 'Q', 'A', 'jd', 'Q', 'Q']);
  expect(page.sql).toContain(KEYED(2, false));
  expect(page.sql).toMatch(
    /\) as "o" order by "paid_at" desc nulls last, "order_id" desc limit \$7 offset \$8$/,
  );
  expect(page.parameters).toEqual(['A', 'A', 'Q', 'A', 'Q', 'Q', 2, 4]);
});

it('[AC-B1-09x-UNIT#3] 后台订单列表不带 q：仍是单表一条语句，不读 order_keys、不拆两路', async () => {
  const { db, statements } = recording();
  const reads = createAdminOrderReads(db);
  await reads.count({ appId: 'A', platform: 'taobao' });
  await reads.page({ appId: 'A' }, 0, 20);
  for (const statement of statements) {
    expect(statement.sql).not.toContain('order_keys');
    expect(statement.sql).not.toMatch(/ union /);
  }
  expect(statements[0]!.parameters).toEqual(['A', 'taobao']);
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-09x-UNIT#4] 找回 %s：按子单号经 order_keys（同 app、同平台）；按父单号是父单号等值，不读 order_keys',
  async (platform) => {
    const { trx, statements } = recording();
    await findClaimOrders(trx, 'A', platform, 'V', 'sub');
    await findClaimOrders(trx, 'A', platform, 'V', 'parent');
    const [bySub, byParent] = statements as [CompiledQuery, CompiledQuery];
    expect(bySub.sql).toContain(KEYED(3, true));
    expect(bySub.sql).not.toContain('replace(');
    expect(bySub.parameters).toEqual(['A', platform, 'A', platform, 'V']);
    expect(byParent.sql).not.toContain('order_keys');
    expect(byParent.sql).toContain('"parent_order_id" is not null and "parent_order_id" = $3');
    expect(byParent.parameters).toEqual(['A', platform, 'V']);
  },
);

it.each(['sub', 'parent'] as const)(
  '[AC-B1-09x-UNIT#5] 找回拼多多按 %s 照旧去横线比较，不读 order_keys',
  async (by) => {
    const { trx, statements } = recording();
    await findClaimOrders(trx, 'A', 'pdd', 'V', by);
    const column = by === 'sub' ? 'sub_order_id' : 'parent_order_id';
    expect(statements[0]!.sql).toContain(`replace("${column}", '-', '') = $3`);
    expect(statements[0]!.sql).not.toContain('order_keys');
  },
);

it('[AC-B1-09x-UNIT#6] 快照重试：readOrderByKey 经 order_keys 读整行；selectDueSubOrders 经 order_keys 连到 orders 主键，不按 orders.sub_order_id 连', async () => {
  const { db, trx, statements } = recording();
  await readOrderByKey(trx, { app_id: 'A', platform: 'jd', sub_order_id: 'S' });
  await selectDueSubOrders(db, 'A', new FixedClock('2026-11-08T12:00:00.000Z').now(), 5);
  const [byKey, due] = statements as [CompiledQuery, CompiledQuery];
  expect(byKey.sql).toMatch(/^select \* from "app"."orders" where /);
  expect(byKey.sql).toContain(KEYED(3, true));
  expect(byKey.parameters).toEqual(['A', 'jd', 'A', 'jd', 'S']);
  expect(due.sql).toContain(
    'inner join "app"."order_keys" as "k" on "k"."platform" = "p"."platform" and "k"."sub_order_id" = "p"."sub_order_id" and "k"."app_id" = "p"."app_id"',
  );
  expect(due.sql).toContain(
    'inner join "app"."orders" as "o" on "o"."order_id" = "k"."order_id" and "o"."attr_at" = "k"."attr_at" and "o"."app_id" = "k"."app_id"',
  );
  expect(due.sql).not.toContain('"o"."sub_order_id"');
});
