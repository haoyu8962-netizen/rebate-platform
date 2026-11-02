// B2-03r rule-test kit (FU-R7-RIGHTS-ESTIMATE, claude-independent): a partial rights success before
// credit, end to end on real rows. Real pieces: the rights command, createRebatePort,
// createCommissionEstimates, the wallet (createPendingEarningsSource), the order figures
// (createOrderFiguresReader), the earnings board (createEarningsOrdersSource), the bill job with
// its source reader, the credit service and the ledger. Nothing here stands in for commission's
// valuation. The simulated order sync writes what planOrderSyncColumns writes (commission_version
// + 1 only when the estimate changed) and calls rebate.onUpdated on the same transaction. Expected
// amounts are written by hand in the tests. Integration tests pass the database in: this file
// never imports @couli/db/testing.
//
// Default order: est 1000, snapshot N 1000, reserve 1500, self 5000 / direct 1000 / indirect 500.
//   N 1000 → B 850 → 425 / 85 / 42; N 600 → B 510 → 255 / 51 / 25;
//   N  500 → B 425 → 212 / 42 / 21; N 400 → B 340 → 170 / 34 / 17.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { readOrderFiguresLedger } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
  type RightsRecordInput,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createOrderAppealReader } from '../../../../apps/api/src/modules/risk/index.ts';
import { createBillSourceReader } from '../../../../apps/api/src/modules/settlement/bill/index.ts';
import {
  createBillJob,
  type BillJobDependencies,
  type BillValidation,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  createEarningsOrdersSource,
  createOrderFiguresReader,
  createPendingEarningsSource,
  createRightsCommandPort,
  type OrderFiguresDependencies,
  type RebateDependencies,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import {
  SNAPSHOT_AT,
  estimatesOf,
  fixture,
  orderRow,
  rebateOf,
  type PortOrder,
  type SeededPortOrder,
} from '../../commission/estimate-port/kit.ts';
import { harness as clawbackHarness, tracing } from '../clawback/kit.ts';

export { TIMEOUT, databaseFixture } from '../clawback/kit.ts';
export {
  amountsAt,
  moneyRows,
  storedVersions,
  totalsAt,
} from '../../commission/estimate-port/kit.ts';

/** The clock instants of a case, in order; the bill runs on the 24th (BR-FUND-04 ③). */
const SETTLED_AT = '2032-07-01T10:00:00+08:00';
export const T1 = '2032-07-20T10:00:00+08:00';
export const T2 = '2032-07-21T10:00:00+08:00';
export const T3 = '2032-07-22T10:00:00+08:00';
export const T4 = '2032-07-23T10:00:00+08:00';
const BILL_NOW = '2032-07-24T00:10:00+08:00';
const BILL_RUN = '2032-07-24T00:01:00+08:00';
const RECEIVED_AT = '2032-06-10T10:00:00+08:00';
const PERIOD = '2032-06';

/** The patch that puts an order inside the earnings window below: paid_at has no default. */
export const PAID = { paid_at: SNAPSHOT_AT };
const EARNINGS_WINDOW = {
  paidFrom: '2026-10-01T00:00:00+08:00',
  paidTo: '2026-11-01T00:00:00+08:00',
};

// Through the modules' public entries, loaded at run time like the other settlement rule tests:
// the test project's tsc stays out of the Nest decorator graph.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot: OrderFiguresDependencies['readSnapshot'] &
    BillJobDependencies['readSnapshot'];
  readTljDeductFen: OrderFiguresDependencies['readTljDeductFen'] &
    BillJobDependencies['readTljDeductFen'];
};

const ledgerPorts = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as {
  registerReconDiff: BillJobDependencies['registerDiff'];
  readUnionAuthoritativeOrderKeys: Parameters<
    typeof createBillSourceReader
  >[0]['readUnionAuthoritative'];
};

interface RecordSpec {
  readonly deductionFen: bigint | null;
  readonly rightsNo?: string;
  readonly at?: string;
  readonly status?: RightsRecordInput['status'];
}

interface SettlementSpec {
  readonly seq?: number;
  readonly fen?: bigint;
  readonly at?: string;
}

interface UnionSyncSpec {
  readonly at: string;
  /** New est_commission_fen; a different value moves commission_version, as orders' sync does. */
  readonly estAfter?: bigint;
  /** New settle_commission_fen; order_settlements seq `seq` is written on the same transaction. */
  readonly settleAfter?: bigint;
  readonly seq?: number;
}

interface RightsRow {
  readonly status?: 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED';
  readonly type?: 'RIGHTS' | 'PUNISH';
  readonly deductionFen: bigint | null;
  readonly answeredAt?: Date;
}

/** The statements of a read that name app.order_rights. */
function rightsReads<T extends { readonly sql: string }>(queries: readonly T[]): T[] {
  return queries.filter((query) => /\border_rights\b/.test(query.sql));
}

/** The statements of a write that update app.orders. */
function orderUpdates<T extends { readonly sql: string }>(queries: readonly T[]): T[] {
  return queries.filter((query) => /^update\s+(?:"app"\.)?"orders"/i.test(query.sql));
}

export async function harness(db: Kysely<DB>) {
  const h = await clawbackHarness(db);
  const appId = h.appId;
  const clock = h.clock;
  const f = await fixture(db, appId);
  // The figures read as the orders kit builds it: the schema bound once.
  const plain = db.withoutPlugins().withSchema('app');

  // The real port; the spy records what settlement called it with and forwards every argument.
  const real = estimatesOf(clock);
  const refresh = vi.fn<RebateDependencies['estimates']['refresh']>((...args) =>
    real.refresh(...args),
  );
  const rebate = rebateOf(
    clock,
    { bases: (trx, input) => real.bases(trx, input), refresh },
    { publish: h.publish },
  );
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    { write: () => undefined },
  );
  const rights = createRightsCommandPort({
    clock,
    logger,
    events: { publish: h.publish },
    clawback: h.boot(),
    rebate,
  });
  const config = { get: async () => undefined };
  const pending = createPendingEarningsSource({
    clock,
    config,
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
  });
  const earnings = createEarningsOrdersSource({
    readSnapshot: commission.readCommissionSnapshot,
    readTljDeductFen: commission.readTljDeductFen,
  });

  /** The value argument of every estimates.refresh call so far, in order. */
  function refreshValues() {
    return refresh.mock.calls.map((call) => call[2]);
  }

  /** The port's reference of an order. */
  function ref(o: PortOrder) {
    return { appId: o.appId, orderId: o.orderId, attrAt: o.attrAt };
  }

  // ---- seeding ---------------------------------------------------------------------------------
  type OrderSpec = NonNullable<Parameters<typeof f.order>[0]>;

  /** One beneficiary, the shared viewer of the order reads: self 5000 bp. */
  function ownedBy(userId: string): NonNullable<OrderSpec['people']> {
    return [{ role: 'self', ratioBp: 5000, userId }];
  }

  async function settlementOn(executor: Kysely<DB>, o: PortOrder, spec: SettlementSpec = {}) {
    const at = new Date(spec.at ?? SETTLED_AT);
    await executor
      .insertInto('order_settlements')
      .values({
        app_id: appId,
        order_id: o.orderId,
        seq: spec.seq ?? 1,
        source: 'STATEMENT',
        settle_commission_fen: spec.fen ?? 1000n,
        settled_at: at,
        content_hash: randomUUID(),
        created_at: at,
      })
      .execute();
  }

  /** ESTIMATED, platform PAID, no settlement record. */
  function estimated(spec: OrderSpec = {}): Promise<SeededPortOrder> {
    return f.order({ estFen: 1000n, ...spec });
  }

  /** WAITING, platform RECEIVED, no settlement record, settle period of the bill. */
  function waiting(spec: OrderSpec = {}): Promise<SeededPortOrder> {
    return f.order({
      estFen: 1000n,
      rebateStatus: 'WAITING',
      platformStatus: 'RECEIVED',
      ...spec,
      patch: { received_at: new Date(RECEIVED_AT), settle_period: PERIOD, ...spec.patch },
    });
  }

  /** WAITING, platform SETTLED, settlement record seq 1 and the column both at `settleFen`. */
  async function settled(spec: OrderSpec = {}): Promise<SeededPortOrder> {
    const settleFen = spec.settleFen ?? 1000n;
    const o = await waiting({ settleFen, platformStatus: 'SETTLED', ...spec });
    await settlementOn(db, o, { fen: settleFen });
    return o;
  }

  /** CREDITED at N 600: booked 510 / 600. */
  function credited(spec: OrderSpec = {}): Promise<SeededPortOrder> {
    return f.order({
      estFen: 1000n,
      settleFen: 600n,
      rebateStatus: 'CREDITED',
      platformStatus: 'SETTLED',
      ...spec,
      patch: {
        received_at: new Date(RECEIVED_AT),
        settle_period: PERIOD,
        booked_base_fen: 510n,
        booked_n_fen: 600n,
        ...spec.patch,
      },
    });
  }

  /** A stored order_rights row, for the states the rights command cannot reach with a deduction. */
  async function rightsRow(o: PortOrder, spec: RightsRow): Promise<void> {
    await db
      .insertInto('order_rights')
      .values({
        id: randomUUID(),
        app_id: appId,
        order_id: o.orderId,
        source: 'API',
        type: spec.type ?? 'RIGHTS',
        status: spec.status ?? 'SUCCEEDED',
        amount_fen: null,
        deduction_commission_fen: spec.deductionFen,
        occurred_at: clock.now(),
        platform_rights_no: `rights-${randomUUID()}`,
        answered_at: spec.answeredAt ?? null,
      })
      .execute();
  }

  /** An open first_credit obligation: the viewer's share of a CREDITED order is held. */
  async function heldShare(o: PortOrder, userId: string): Promise<void> {
    await db
      .insertInto('beneficiary_credits')
      .values({
        beneficiary_credit_id: randomUUID(),
        app_id: appId,
        order_id: o.orderId,
        user_id: userId,
        role: 'self',
        kind: 'first_credit',
        opened_by: 'R5',
        opened_ref: `batch-item-${o.orderId}`,
        origin_ledger_type: null,
        origin_sub_type: null,
        split_ref: 'commission_version:1',
        status: 'open',
        closed_by: null,
        closed_ref: null,
        voucher_id: null,
        opened_at: clock.now(),
        closed_at: null,
      })
      .execute();
  }

  // ---- the writes under test -------------------------------------------------------------------
  /** One rights.record as orders runs it: lockOrderKey, the row FOR UPDATE, on one transaction. */
  async function record(o: PortOrder, spec: RecordSpec, via: Kysely<DB> = db) {
    const at = spec.at ?? T1;
    clock.set(at);
    return via.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .forUpdate()
        .executeTakeFirstOrThrow();
      return rights.record(trx, {
        before,
        order_id: o.orderId,
        source: 'IMPORT',
        type: 'RIGHTS',
        status: spec.status ?? 'SUCCEEDED',
        amount_fen: null,
        deduction_commission_fen: spec.deductionFen,
        occurred_at: new Date(at),
        platform_rights_no: spec.rightsNo ?? 'rights-1',
        now: clock.now(),
      });
    });
  }

  /** A successful partial rights result with a deduction, on its own clock instant. */
  async function deduct(
    o: PortOrder,
    deductionFen: bigint,
    rightsNo = 'rights-1',
    at = T1,
  ): Promise<void> {
    expect(await record(o, { deductionFen, rightsNo, at })).toEqual({ kind: 'applied' });
  }

  /** One deduction on a traced transaction; returns every statement that updated app.orders. */
  async function tracedDeduct(o: PortOrder, deductionFen: bigint) {
    const traced = tracing(db);
    expect(await record(o, { deductionFen }, traced.db)).toEqual({ kind: 'applied' });
    return orderUpdates(traced.queries);
  }

  /** One order sync: what orders writes, the settlement record, then rebate.onUpdated. */
  async function unionSync(o: PortOrder, spec: UnionSyncSpec): Promise<void> {
    clock.set(spec.at);
    await db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const estAfter = spec.estAfter ?? before.est_commission_fen;
      const settleAfter = spec.settleAfter ?? before.settle_commission_fen;
      const to = spec.settleAfter === undefined ? before.platform_status : 'SETTLED';
      if (spec.settleAfter !== undefined) {
        await settlementOn(trx, o, { seq: spec.seq ?? 1, fen: spec.settleAfter, at: spec.at });
      }
      await trx
        .updateTable('orders')
        .set({
          platform_status: to,
          est_commission_fen: estAfter,
          settle_commission_fen: settleAfter,
          commission_version:
            estAfter === before.est_commission_fen
              ? before.commission_version
              : before.commission_version + 1,
          row_version: before.row_version + 1,
          updated_at: clock.now(),
        })
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .where('attr_at', '=', o.attrAt)
        .execute();
      const change: OrderUpdateChange = {
        app_id: appId,
        order_id: o.orderId,
        attr_at: before.attr_at,
        from_status: before.platform_status,
        to_status: to,
        rule: null,
        received_at: before.received_at,
        est_before: before.est_commission_fen,
        est_after: estAfter,
        settle_commission_fen: settleAfter,
        attributed_now: false,
      };
      const source: OrderStatusSource = {
        event: to === 'SETTLED' ? 'PLATFORM_SETTLED' : 'PLATFORM_PAID',
        raw_status: 'synthetic',
      };
      await rebate.onUpdated(trx, change, source);
    });
  }

  /** The month's bill through the real job and source reader, on the order's platform. */
  async function runBill(o: PortOrder) {
    clock.set(BILL_NOW);
    const validations: BillValidation[] = [];
    const job = createBillJob({
      clock,
      config: {
        get: async (_app, key) => (key.startsWith('credit.enabled.') ? 'on' : undefined),
      },
      readSource: createBillSourceReader({
        readUnionAuthoritative: ledgerPorts.readUnionAuthoritativeOrderKeys,
      }),
      readSnapshot: commission.readCommissionSnapshot,
      readTljDeductFen: commission.readTljDeductFen,
      snapshotStatus: async () => ({
        state: 'complete',
        snapshotId: null,
        waitingComparable: true,
      }),
      registerDiff: ledgerPorts.registerReconDiff,
      saveValidations: async (_trx, _input, rows) => {
        validations.push(...rows);
      },
    });
    const outcome = await job.run(db, {
      appId,
      platform: o.platform,
      runAt: new Date(BILL_RUN),
    });
    expect(outcome.outcome).toBe('generated');
    const items = await db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    const diffs = await db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();
    return { validations, items, diffs };
  }

  /** The monthly credit (R5) of one order against settlement record `seq`. */
  function credit(o: PortOrder, seq = 1) {
    const service = h.creditBoot();
    return db.transaction().execute((trx) =>
      service.credit(trx, {
        appId,
        orderId: o.orderId,
        expectedSettleSeq: seq,
        openedRef: `batch-item-${o.orderId}`,
      }),
    );
  }

  // ---- the reads under test --------------------------------------------------------------------
  function walletOf(userId: string, via: Kysely<DB> = db) {
    return via
      .transaction()
      .setAccessMode('read only')
      .execute((trx) => pending.forUser(trx, { appId, userId }));
  }

  function appTotals(via: Kysely<DB> = db) {
    return via
      .transaction()
      .setAccessMode('read only')
      .execute((trx) => pending.forApp(trx, { appId }));
  }

  function figuresOf(userId: string, orders: readonly PortOrder[], via: Kysely<DB> = plain) {
    const reader = createOrderFiguresReader({
      db: via,
      clock,
      config,
      readSnapshot: commission.readCommissionSnapshot,
      readTljDeductFen: commission.readTljDeductFen,
      ledger: readOrderFiguresLedger,
      appeals: createOrderAppealReader(via),
    });
    return reader.forOrders(
      { app_id: appId, user_id: userId },
      orders.map((o) => o.orderId),
    );
  }

  /** One order's figures for the viewer. */
  async function figureOf(userId: string, o: PortOrder) {
    return (await figuresOf(userId, [o])).get(o.orderId);
  }

  /** The earnings board's order facts of a user, all platforms, the window of PAID. */
  function earningsOf(
    userId: string,
    options: { readonly referral?: boolean; readonly via?: Kysely<DB> } = {},
  ) {
    return (options.via ?? db)
      .transaction()
      .setAccessMode('read only')
      .execute((trx) =>
        earnings.read(trx, {
          appId,
          userId,
          platform: null,
          ...EARNINGS_WINDOW,
          referral: options.referral ?? true,
        }),
      );
  }

  /** The board with and without the referral column, and what each spent on app.order_rights. */
  async function tracedEarnings(userId: string) {
    const ownOnly = tracing(db);
    const { own } = await earningsOf(userId, { referral: false, via: ownOnly.db });
    const both = tracing(db);
    await earningsOf(userId, { via: both.db });
    return {
      own,
      ownReads: rightsReads(ownOnly.queries),
      bothReads: rightsReads(both.queries),
    };
  }

  /** The owner's wallet and order page, with the statements each spent on app.order_rights. */
  async function tracedReads(userId: string, orders: readonly PortOrder[]) {
    const forUser = tracing(db);
    const wallet = await walletOf(userId, forUser.db);
    const forApp = tracing(db);
    const totals = await appTotals(forApp.db);
    const forOrders = tracing(plain);
    const figures = await figuresOf(userId, orders, forOrders.db);
    return {
      wallet,
      totals,
      figures,
      walletReads: rightsReads(forUser.queries),
      totalsReads: rightsReads(forApp.queries),
      figuresReads: rightsReads(forOrders.queries),
    };
  }

  function read(o: PortOrder) {
    return orderRow(db, o);
  }

  function rightsRows(o: PortOrder) {
    return db
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('created_at')
      .orderBy('platform_rights_no')
      .execute();
  }

  function rebateHistory(o: PortOrder) {
    return db
      .selectFrom('order_status_history')
      .select(['event', 'from_status', 'to_status'])
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('field', '=', 'rebate')
      .orderBy('id')
      .execute();
  }

  /** Names of the events the order flows published. */
  async function eventNames(): Promise<string[]> {
    return (await h.published()).map((row) => row.name);
  }

  return {
    appId,
    clock,
    db,
    user: f.user,
    real,
    refresh,
    refreshValues,
    ref,
    ownedBy,
    estimated,
    waiting,
    settled,
    credited,
    settlement: (o: PortOrder, spec?: SettlementSpec) => settlementOn(db, o, spec),
    rightsRow,
    heldShare,
    record,
    deduct,
    tracedDeduct,
    unionSync,
    runBill,
    credit,
    walletOf,
    appTotals,
    figureOf,
    figuresOf,
    earningsOf,
    tracedEarnings,
    tracedReads,
    read,
    rightsRows,
    rebateHistory,
    eventNames,
    balance: h.balance,
  };
}
