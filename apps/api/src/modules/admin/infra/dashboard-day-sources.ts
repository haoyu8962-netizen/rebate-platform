// B1-34q (01 F-ADM-26 ②; D10-1401, D10-1403): the production sources of the four figures of the
// workbench's yesterday overview, each read through its owning module's index.ts (admin never reads
// another module's tables):
// - links: linking's event=convert link_logs of the day;
// - orders: orders' sub-orders whose paid_at falls in the day;
// - new_users: identity's users rows created in the day;
// - est_rebate_fen: settlement's PendingEarningsSource, the wallet's own pricing (BR-CALC-02:
//   effective union commission, less the open rights deduction, the snapshot's reserve_bp and
//   tlj_deduct_fen, each role's ratio, forfeited shares to the platform), over the sub-orders paid in
//   the day that are still ESTIMATED and not DEPOSIT_PAID (BR-TEXT-21 ESTIMATED; D10-1403 Q1). Its
//   ports are wired as app.module wires the wallet's: commission's readCommissionSnapshot and
//   readTljDeductFen (an absent split throws, never a default 0), content's configuration reader.
// Every read runs on the snapshot transaction the aggregation hands in (one REPEATABLE READ
// read-only transaction per row, admin/application/dashboard-days.ts), never on a handle of its
// own, so the four figures are of one instant. `db` is not used for the reads.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { readCommissionSnapshot, readTljDeductFen } from '../../commission/index.ts';
import { createContentReader } from '../../content/index.ts';
import { countRegisteredUsers } from '../../identity/index.ts';
import { countConvertLinkLogs } from '../../linking/index.ts';
import { countPaidOrders } from '../../orders/index.ts';
import type { Clock } from '../../platform/index.ts';
import { createPendingEarningsSource } from '../../settlement/index.ts';
import type { DashboardDaySources } from '../application/dashboard-days.ts';

export function createDashboardDaySources(deps: {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}): DashboardDaySources {
  const { clock } = deps;
  const pricing = (trx: Transaction<DB>) =>
    createPendingEarningsSource({
      clock,
      config: {
        get: async (appId, key) =>
          (await createContentReader({ db: trx, clock }).configValue(appId, key))?.value,
      },
      readSnapshot: readCommissionSnapshot,
      readTljDeductFen,
    });
  return {
    countLinks: (trx, appId, range) =>
      countConvertLinkLogs(trx, { appId, start: range.start, end: range.end }),
    countPaidOrders: (trx, appId, range) =>
      countPaidOrders(trx, { appId, start: range.start, end: range.end }),
    countNewUsers: (trx, appId, range) =>
      countRegisteredUsers(trx, { appId, start: range.start, end: range.end }),
    sumEstimatedRebateFen: (trx, appId, range) =>
      pricing(trx).estimatedForPaidRange(trx, { appId, start: range.start, end: range.end }),
  };
}
