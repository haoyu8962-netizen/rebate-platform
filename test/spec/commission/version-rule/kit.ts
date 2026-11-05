// B2-03s rule-test kit (claude-independent; FU-COMMISSION-VERSION-RULE, D10-578, D10-583; BR-CALC-02,
// BR-CALC-15, BR-CALC-23 (a), BR-CALC-27, BR-FUND-03). Two entries, both over real rows:
// - withRule: the production worker of ../../settlement/settlement-records/kit.ts. Every report goes
//   through the real pipeline, update step, rebate port, commission estimates, bill and credit.
//   Nothing is stood in for; the only addition is a pass-through spy on the rebate port's onUpdated,
//   the one place commission_moved can be read.
// - portHarness: the real rebate port over the real estimates, with a change the test writes itself,
//   for what no report can reach (the same B with a different N needs a reserve the worker's rule
//   version does not have) and to prove rebate reads commission_moved instead of comparing estimates.
// OrderUpdateChange has no commission_moved until this task is implemented. It is read and written
// through VersionChange, so the kit compiles before and after. Every order goes through
// settlement-records' fixture: pdd, fee 0, reserve 0, own share 50 %, so N = 800 gives B 800 and 400.
// A report repeats the order's base fields: a test that moved the estimate says so in every later
// report. Expected amounts are written by hand in the tests. Integration tests pass the database in:
// this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { readOrderFiguresLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import * as updateStep from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createOrderAppealReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createOrderFiguresReader,
  createPendingEarningsSource,
  createRebatePort,
  type OrderFiguresDependencies,
  type RebateDependencies,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import {
  BILL_AT,
  received,
  settled,
  withWorker,
  type App,
  type Worker,
} from '../../settlement/settlement-records/kit.ts';
import {
  amountsAt,
  fixture,
  portOrderOf,
  storedVersions,
  totalsAt,
  type PortOrder,
} from '../estimate-port/kit.ts';

export { amountsAt, databaseFixture, fixture, moneyRows } from '../estimate-port/kit.ts';
export { orderRow, storedVersions, totalsAt, tracing } from '../estimate-port/kit.ts';
export {
  BILL_AT,
  TIMEOUT,
  brief,
  capture,
  received,
  settled,
  touched,
} from '../../settlement/settlement-records/kit.ts';

type PendingDependencies = Parameters<typeof createPendingEarningsSource>[0];

// Commission's public entry, loaded at run time like the other rule tests: the test project's tsc
// stays out of the Nest decorator graph.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot: OrderFiguresDependencies['readSnapshot'] &
    PendingDependencies['readSnapshot'];
  readTljDeductFen: OrderFiguresDependencies['readTljDeductFen'] &
    PendingDependencies['readTljDeductFen'];
};

/** The change as this task defines it: commission_moved comes from the column plan. */
type VersionChange = OrderUpdateChange & { readonly commission_moved?: boolean };

function ruleOf(db: Kysely<DB>, worker: Worker, rebate: OrderUpdateDeps['rebate']) {
  const updates = vi.spyOn(rebate, 'onUpdated');
  const config = { get: async () => undefined };
  const pending = createPendingEarningsSource({
    clock: worker.clock,
    config,
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
  });
  const figures = createOrderFiguresReader({
    db,
    clock: worker.clock,
    config,
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
    ledger: readOrderFiguresLedger,
    appeals: createOrderAppealReader(db),
  });

  /** commission_moved of every update the sync handed to settlement, oldest first. */
  function moves(): (boolean | undefined)[] {
    return updates.mock.calls.map(([, change]) => (change as VersionChange).commission_moved);
  }

  /** The app's recon diffs: a bill that disagrees with the current base leaves one here. */
  function diffs(target: App) {
    return db.selectFrom('recon_diffs').selectAll().where('app_id', '=', target.appId).execute();
  }

  function order(target: App, patch?: Parameters<Worker['order']>[1]) {
    const o = worker.order(target, patch);
    const stored = async () => portOrderOf(await o.row());

    return {
      ...o,
      /** [base_fen, amount_fen] of one version: the fixture's order has one beneficiary. */
      async amounts(version: number) {
        const rows = await amountsAt(db, await stored(), version);
        return rows.map(([, base, amount]) => [base, amount]);
      },
      /** The four amounts (BR-CALC-27) of one version, undefined when it has none. */
      async fourAmounts(version: number) {
        return totalsAt(db, await stored(), version);
      },
      /** The versions that have amount rows and totals. */
      async versions() {
        return storedVersions(db, await stored());
      },
      /** The member's pending earnings, as /v1/wallet/summary reads them. */
      wallet() {
        return db
          .transaction()
          .setAccessMode('read only')
          .execute((trx) => pending.forUser(trx, { appId: target.appId, userId: target.userId }));
      },
      /** The order page's figures for the member. */
      async figure() {
        const { order_id: orderId } = await o.row();
        const found = await figures.forOrders({ app_id: target.appId, user_id: target.userId }, [
          orderId,
        ]);
        return found.get(orderId);
      },
    };
  }

  /** Paid, received, settled at 1000, billed and credited for real: booked 1000, member 500. */
  async function credited(target: App) {
    await worker.setConfig(target, 'credit.enabled.pdd', true);
    const o = order(target);
    await o.sync();
    await o.sync(received());
    await o.sync(settled(1000n));
    worker.clock.set(BILL_AT);
    await worker.bill(target);
    await worker.confirmAndExecute(target);
    expect(await o.row()).toMatchObject({
      rebate_status: 'CREDITED',
      booked_base_fen: 1000n,
      booked_n_fen: 1000n,
      commission_version: 1,
    });
    expect(await worker.available(target)).toBe(500n);
    return o;
  }

  return { ...worker, order, credited, moves, diffs };
}

/** Runs `test` on a production worker over `db`, with commission_moved readable. */
export async function withRule(
  db: Kysely<DB>,
  test: (w: ReturnType<typeof ruleOf>) => Promise<void>,
): Promise<void> {
  const made = vi.spyOn(updateStep, 'createOrderUpdateStep');
  try {
    await withWorker(db, async (worker) => {
      expect(made, 'the update step of the worker entry').toHaveBeenCalledTimes(1);
      await test(ruleOf(db, worker, made.mock.calls[0]![0].rebate));
    });
  } finally {
    made.mockRestore();
  }
}

/** Every statement that writes commission_version on app.orders, the way orders' CAS spells it. */
export function versionWrites<T extends { readonly sql: string }>(queries: readonly T[]): T[] {
  return queries.filter((query) => {
    if (!/^update\s+(?:"app"\.)?"orders"/i.test(query.sql)) return false;
    const [written = ''] = query.sql.split(/\swhere\s/i);
    return /"commission_version" = /.test(written);
  });
}

interface ColumnsSpec {
  readonly estAfter?: bigint;
  readonly settleAfter?: bigint;
  /** What the column plan decided: commission_version moves with it, on the same write. */
  readonly moved: boolean;
}

/**
 * The orders side of one sync, written by hand so the test decides commission_moved: the order lock,
 * the commission columns and the version on one write. The change is what update-step hands over.
 */
async function writeColumns(trx: Transaction<DB>, o: PortOrder, spec: ColumnsSpec) {
  await lockOrderKey(trx, o.platform, o.subOrderId);
  const before = await trx
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .executeTakeFirstOrThrow();
  const estAfter = spec.estAfter ?? before.est_commission_fen;
  const settleAfter = spec.settleAfter ?? before.settle_commission_fen;
  await trx
    .updateTable('orders')
    .set({
      est_commission_fen: estAfter,
      settle_commission_fen: settleAfter,
      commission_version: before.commission_version + (spec.moved ? 1 : 0),
      row_version: before.row_version + 1,
    })
    .where('app_id', '=', o.appId)
    .where('order_id', '=', o.orderId)
    .execute();
  const base: Omit<OrderUpdateChange, 'commission_moved'> = {
    app_id: o.appId,
    order_id: o.orderId,
    attr_at: before.attr_at,
    from_status: before.platform_status,
    to_status: before.platform_status,
    rule: null,
    received_at: before.received_at,
    est_before: before.est_commission_fen,
    est_after: estAfter,
    settle_commission_fen: settleAfter,
    attributed_now: false,
  };
  const change: OrderUpdateChange = Object.assign(base, { commission_moved: spec.moved });
  const source: OrderStatusSource = { event: 'PLATFORM_SETTLED', raw_status: 'synthetic' };
  return { change, source };
}

/** The real rebate port over the real estimates; the spy forwards, the logger is readable. */
export async function portHarness(db: Kysely<DB>) {
  const f = await fixture(db);
  const refresh = vi.fn<RebateDependencies['estimates']['refresh']>((...args) =>
    f.estimates.refresh(...args),
  );
  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  const rebate = createRebatePort({
    clock: f.clock,
    logger,
    events: { publish: async () => ({ eventId: randomUUID(), duplicate: false }) },
    config: { get: async () => undefined },
    estimates: { bases: (trx, input) => f.estimates.bases(trx, input), refresh },
    audit: {
      append: async () => {
        throw new Error('version-rule kit: no hold audit expected');
      },
    },
  });

  /** One sync on one transaction; returns that transaction. */
  async function sync(o: PortOrder, spec: ColumnsSpec) {
    const seen: Transaction<DB>[] = [];
    await db.transaction().execute(async (trx) => {
      seen.push(trx);
      const { change, source } = await writeColumns(trx, o, spec);
      await rebate.onUpdated(trx, change, source);
    });
    return seen[0];
  }

  /** How many log lines of the rebate port carry this outcome. */
  function outcomes(outcome: string): number {
    return logs.filter((line) => line['outcome'] === outcome).length;
  }

  return { ...f, refresh, sync, outcomes };
}
