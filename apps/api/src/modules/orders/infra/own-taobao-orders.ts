// B1-04zzu（D10-796 ② 甲）：淘宝维权归档只存凑狸已入库订单的行。union 的淘宝适配器经 UnionModule 的选项
// （app.module 注入）问本模块：一页维权记录里读得出的 tb_trade_id 中，哪些是本 app 已入库的淘宝订单。
// 只读 app.orders（同 app_id、platform = 'taobao'，sub_order_id 或 parent_order_id 与之原样相等）；
// 不加锁、不写任何表、不打日志。
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

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
  const rows = await db
    .withSchema('app')
    .selectFrom('orders')
    .select(['sub_order_id', 'parent_order_id'])
    .where('app_id', '=', appId)
    .where('platform', '=', 'taobao')
    .where((eb) => eb.or([eb('sub_order_id', 'in', asked), eb('parent_order_id', 'in', asked)]))
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
