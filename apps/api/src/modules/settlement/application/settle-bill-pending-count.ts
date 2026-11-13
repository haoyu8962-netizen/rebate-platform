// B2-09zm: the workbench card settle_bill_pending (CT-24zzj AdminDashboardTodo; 编排裁定 D10-1402,
// D10-1409). The count is the total of GET /admin/v1/settle-bills?awaiting_confirm=true of the same
// app: every bill of the app, no page, each judged by settleBillAwaitingConfirm, the decision the
// list's filter and the derived status share. Read only (nothing written, locked or audited) and
// independent of the clock.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { readSettleRoundBatches, settleBillAwaitingConfirm } from './admin-settle-bills.ts';

/** Same-app awaiting_confirm=true list total, read only and independent of time. */
export async function countSettleBillPending(db: Kysely<DB>, appId: string): Promise<number> {
  const bills = await db
    .withSchema('app')
    .selectFrom('settle_bills')
    .select(['bill_id', 'generated_at'])
    .where('app_id', '=', appId)
    .execute();
  const byBill = await readSettleRoundBatches(db, appId);
  let count = 0;
  for (const bill of bills) {
    if (settleBillAwaitingConfirm(bill.generated_at, byBill.get(bill.bill_id) ?? [])) count += 1;
  }
  return count;
}
