// B1-04zzu（D10-796 ② 甲）：淘宝维权归档只存凑狸已入库订单的行。union 的淘宝适配器经 UnionModule 的选项
// （app.module 注入）问本模块：一页维权记录里读得出的 tb_trade_id 中，哪些是本 app 已入库的淘宝订单。
// 只读 app.orders（同 app_id、platform = 'taobao'，sub_order_id 或 parent_order_id 与之原样相等；B1-09x 起子单号经
// order_keys 驱动、逐行按主键取 orders，父单号逐值 unnest + LATERAL 等值经 orders_parent_order_idx，LATERAL 子查询
// 带 OFFSET 0 防上拉，两路 UNION ALL 一条语句）；
// 不加锁、不写任何表、不打日志。
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/**
 * The members of `orderNos` that name a stored taobao order of `appId` in app.orders: equal,
 * verbatim, to its sub_order_id or its parent_order_id. An empty `orderNos` reads nothing and
 * answers an empty set. Read only (no lock, no write, no log); one statement.
 */
export async function readOwnTaobaoOrderNos(
  db: Kysely<DB>,
  appId: string,
  orderNos: readonly string[],
): Promise<ReadonlySet<string>> {
  const asked = [...new Set(orderNos)];
  if (asked.length === 0) return new Set();
  // B1-09x (D10-853): the old `sub_order_id IN … OR parent_order_id IN …` split in two branches of
  // one UNION ALL statement. Sub numbers: order_keys drives (its key on platform + sub_order_id,
  // with app_id), each hit reads its one app.orders row by PK (order_id, attr_at) in a lateral;
  // no filter on orders beyond the PK, so the planner cannot turn it into a semi join walking the
  // app's orders. order_keys is written in the same transaction as the orders row with the same
  // app_id / platform / sub_order_id, so the answer is the old one. Parent numbers: unnest the
  // asked numbers and, per number, a lateral read of app.orders on app_id + platform + one
  // parent_order_id equality (orders_parent_order_idx, partial on parent_order_id IS NOT NULL,
  // hence the explicit predicate); a multi-value `parent_order_id IN (…)` / ANY
  // let the planner walk the app_id + link_id index instead and filter the app's rows; the lateral
  // ends in OFFSET 0 so it is not pulled up into a join (see below). A row hit by
  // both branches (or by two asked numbers) comes more than once; the set below absorbs it.
  const app = db.withSchema('app');
  const rows = await app
    .selectFrom('order_keys as k')
    .crossJoinLateral((eb) =>
      eb
        .selectFrom('orders as o')
        .select(['o.sub_order_id', 'o.parent_order_id'])
        .whereRef('o.order_id', '=', 'k.order_id')
        .whereRef('o.attr_at', '=', 'k.attr_at')
        .as('o'),
    )
    .select(['o.sub_order_id', 'o.parent_order_id'])
    .where('k.app_id', '=', appId)
    .where('k.platform', '=', 'taobao')
    .where((eb) => eb('k.sub_order_id', '=', eb.fn.any(eb.val(asked))))
    .unionAll(
      app
        .selectFrom(sql<{ asked_no: string }>`unnest(${asked}::text[])`.as<'q'>(sql`q(asked_no)`))
        .crossJoinLateral((eb) =>
          eb
            .selectFrom('orders as o')
            .select(['o.sub_order_id', 'o.parent_order_id'])
            .where('o.app_id', '=', appId)
            .where('o.platform', '=', 'taobao')
            .where('o.parent_order_id', 'is not', null)
            .whereRef('o.parent_order_id', '=', 'q.asked_no')
            // A literal OFFSET 0 keeps this lateral a subquery: without it PostgreSQL pulls the
            // simple subquery up into a plain join, estimates unnest at 100 rows and (no stats)
            // bitmap-scans orders_parent_order_idx on app_id alone, filtering every row of the
            // app. Kept as a subquery it runs once per asked number with app_id AND
            // parent_order_id = q.asked_no as the index condition. Literal, not a parameter.
            .offset(sql.lit(0))
            .as('o'),
        )
        .select(['o.sub_order_id', 'o.parent_order_id']),
    )
    .execute();
  const wanted = new Set(asked);
  const found = new Set<string>();
  for (const row of rows) {
    if (wanted.has(row.sub_order_id)) found.add(row.sub_order_id);
    if (row.parent_order_id !== null && wanted.has(row.parent_order_id)) {
      found.add(row.parent_order_id);
    }
  }
  return found;
}
