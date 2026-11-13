// B1-34q (01 F-ADM-26 ② 成交订单数): the number of sub-orders of one app paid in one accounting day —
// orders rows (one per sub-order) whose paid_at lies in [start, end), whatever their platform or
// rebate status is now (a later VOID, CLAWED_BACK or UNATTRIBUTED order still counts: 「不扣除之后
// 作废」). An order without paid_at is not counted. Read only; the admin workbench's daily
// aggregation is the caller (through this module's index.ts).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface PaidOrderCountRange {
  readonly appId: string;
  /** Inclusive start instant, ISO 8601 with offset (as @couli/domain chinaDayRange). */
  readonly start: string;
  /** Exclusive end instant. */
  readonly end: string;
}

/** Sub-orders of the app whose paid_at lies in [start, end). */
export async function countPaidOrders(db: Kysely<DB>, input: PaidOrderCountRange): Promise<bigint> {
  const row = await db
    .withSchema('app')
    .selectFrom('orders')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('app_id', '=', input.appId)
    .where('paid_at', '>=', sql<Date>`${input.start}::timestamptz`)
    .where('paid_at', '<', sql<Date>`${input.end}::timestamptz`)
    .executeTakeFirstOrThrow();
  return BigInt(row.total);
}
