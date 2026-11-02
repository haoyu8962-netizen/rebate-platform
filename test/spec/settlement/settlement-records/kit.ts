// B2-04zj rule-test kit (claude-independent, D10-583, FU-PROD-WIRING 第 13 项; BR-FUND-01 P4 / P5 / P12,
// BR-FUND-02, BR-FUND-09). The gap under test came from tests that seeded order_settlements or
// injected their own ports, so nothing here does either on the path under test: every report goes
// through the pipeline of a real AppModule.forEntry({ entry: 'worker' }) (keyedWorker, the B1-09n
// assembly over a real field keyring), and the bill and the batch run on the settle handler that
// assembly registered. Only the job queue is a stub: the bus still writes event_log.
// Every order is pdd, the one platform whose status map has a settled code (5): jd.csv has none
// (D10-529). settle_commission_fen in a report is synthetic: the pdd adapter gives null until
// CAP-PDD-07, so these tests start at the normalized UnionOrder.
// The fee is 0 and the settlement equals the estimate where a test goes through the bill: the bill
// compares b_settle with the snapshot's base, the fee is FU-PDD-NET-N's and the version B2-03s's.
// Expected amounts are written by hand in the tests. The rule version is the commission fixture's:
// reserve 0, own share 50 %, so N = 1000 gives 500.
// STATEMENT and order_rights rows are fixtures of what other tasks write. Integration tests pass the
// database in: this file never imports @couli/db/testing.
// creditPeriod() reads the figures the way app.module assembles them for the api entry: the worker
// entry has no such reader, and that read is B1-09p's, not under test here. What it reads was
// written by the pipeline above.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createLedger,
  readOrderFiguresLedger,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  EventBus,
  JobHandler,
  JobPayload,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createOrderAppealReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createOrderFiguresReader,
  type OrderFiguresDependencies,
} from '../../../../apps/api/src/modules/settlement/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, PAID, level } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { capture, order as unionOrder } from '../../orders/attribution/kit.ts';
import { keyedWorker } from '../../orders/rebate-wiring/kit.ts';
import { runtime } from '../../orders/wiring/context-kit.ts';
import { account, at, pid, user } from '../../orders/wiring/db-kit.ts';

export { capture } from '../../orders/attribution/kit.ts';

export const TIMEOUT = 120_000;
/** The worker's Clock at start: after the receipt and the settlement below. */
export const SYNCED = '2026-10-22T03:00:00.000Z';
/** A receipt after PAID: settle_period 2026-10, bill month of the 2026-11 bill day. */
export const RECEIVED_AT = at('2026-10-21T02:00:00.000Z');
/** The union's settlement time as reported; never the Clock. */
export const SETTLED_AT = at('2026-10-21T08:00:00.000Z');
export const SETTLED_LATER = at('2026-10-21T09:30:00.000Z');
/** The default settle.bill_day of November 2026; the bill month is 2026-10. */
export const BILL_DAY = '2026-11-24';
/** BILL_DAY 10:00 +08:00: the snapshot of the day before is past its deadline, so timed_out. */
export const BILL_AT = '2026-11-24T02:00:00.000Z';
const ATTR_CODE = 'abcd1234';
const UNKNOWN_CODE = 'zzzz9999';
/** specs/order-status-map/pdd.csv. */
export const PDD_PAID = '0';
export const PDD_RECEIVED = '2';
export const PDD_SETTLED = '5';
/** A code outside specs/order-status-map/pdd.csv. */
export const PDD_UNMAPPED = 'synthetic-unmapped';

type Patch = Partial<UnionOrder>;

/** The same order with only the mtime moved: its content hash changes, its settlement does not. */
export function touched(minute: number): Patch {
  const minutes = String(minute).padStart(2, '0');
  return { modified_at: at(`2026-10-21T10:${minutes}:00.000Z`) };
}

/** A receipt report. */
export function received(patch: Patch = {}): Patch {
  return { raw_status: PDD_RECEIVED, received_at: RECEIVED_AT, ...patch };
}

/** A settled report with the union's settlement commission; null reports none. */
export function settled(commissionFen: bigint | null, patch: Patch = {}): Patch {
  return {
    raw_status: PDD_SETTLED,
    received_at: RECEIVED_AT,
    settled_at: SETTLED_AT,
    settle_commission_fen: commissionFen,
    ...patch,
  };
}

/** An attribution code no user of the app has: the order imports unattributed. */
export function unattributed(): Patch {
  return {
    attr_params: {
      relation_id: null,
      sub_union_id: null,
      custom_parameters: JSON.stringify({ app: 'n', uid: UNKNOWN_CODE }),
    },
  };
}

/** seq, source and amount of each record, seq ascending. */
export function brief(
  rows: readonly {
    readonly seq: number;
    readonly source: string;
    readonly settle_commission_fen: bigint;
  }[],
): [number, string, bigint][] {
  return rows.map((row) => [row.seq, row.source, row.settle_commission_fen]);
}

export interface App {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly slot: string;
}

/** The worker's queue stub (keyedWorker): the handlers the assembly registered. */
interface QueueStub {
  readonly register: { readonly mock: { readonly calls: [string, JobHandler][] } };
}

async function startWorker(db: Kysely<DB>) {
  const worker = await keyedWorker(db);
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(SYNCED);
    const events = worker.context.get(worker.platform.EVENT_BUS, { strict: false }) as EventBus;
    const queue = worker.context.get(worker.platform.JOB_QUEUE, { strict: false }) as QueueStub;
    let sequence = 0;
    // URL import: commission's public entry, as ../../orders/figures/kit.ts loads it.
    const commission = (await import(
      new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
    )) as {
      readCommissionAttribution: OrderFiguresDependencies['readSnapshot'];
      readTljDeductFen: OrderFiguresDependencies['readTljDeductFen'];
    };
    const figures = createOrderFiguresReader({
      db,
      clock,
      config: {
        get: async (appId, key) =>
          (await createContentReader({ db, clock }).configValue(appId, key))?.value,
      },
      readSnapshot: commission.readCommissionAttribution,
      readTljDeductFen: commission.readTljDeductFen,
      ledger: readOrderFiguresLedger,
      appeals: createOrderAppealReader(db),
    });

    /** A new app with its union account, promotion slot, published rule version and one member. */
    async function app(): Promise<App> {
      const a = await account(db, { platform: 'pdd' });
      const owner = await user(db, a.app_id, { attr_code: ATTR_CODE });
      const slot = `slot-${randomUUID()}`;
      await pid(db, a, { pid: slot });
      await level(db, a.app_id, owner.id, 'L1', BEFORE);
      await seedVersion(db, a.app_id, version());
      return { appId: a.app_id, userId: owner.id, accountId: a.id, slot };
    }

    async function setConfig(target: App, key: string, value: unknown): Promise<void> {
      await db
        .insertInto('config_items')
        .values({
          app_id: target.appId,
          key,
          value: JSON.stringify(value),
          version: 1,
          updated_by: 'fixture',
        })
        .execute();
    }

    /** One sub-order of the app's member: paid, commission 1000, fee 0, until a report says else. */
    function order(target: App, patch: Patch = {}) {
      const subOrderId = patch.sub_order_id ?? randomUUID();
      const incoming = unionOrder({
        platform: 'pdd',
        order_id: subOrderId,
        sub_order_id: subOrderId,
        promotion_slot: target.slot,
        raw_status: PDD_PAID,
        attr_params: {
          relation_id: null,
          sub_union_id: null,
          custom_parameters: JSON.stringify({ app: 'n', uid: ATTR_CODE }),
        },
        commission_fen: 1000n,
        est_commission_fen: 1000n,
        service_fee_fen: 0n,
        paid_at: PAID,
        modified_at: at('2026-10-20T03:00:00.000Z'),
        ...patch,
      });

      /** One report through the production pipeline, one minute after the last. */
      async function report(next: Patch = {}) {
        sequence += 1;
        clock.advanceMs(60_000);
        return r.pipeline.process(
          { ...incoming, ...next, raw_payload_id: `${100 + sequence}` },
          {
            app_id: target.appId,
            platform: 'pdd',
            union_account_id: target.accountId,
            query_kind: 'increment',
            scene: '-',
            window_start: '2026-10-01T02:03:04.000Z',
            window_end: clock.now().toISOString(),
            requestId: randomUUID(),
          },
        );
      }

      /** report() that must go through. */
      async function sync(next: Patch = {}): Promise<void> {
        const result = await capture(() => report(next));
        expect(result).toMatchObject({ ok: true });
      }

      const rowsOf = () =>
        db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', target.appId)
          .where('sub_order_id', '=', subOrderId)
          .execute();

      async function row() {
        const rows = await rowsOf();
        expect(rows, 'the order row').toHaveLength(1);
        return rows[0]!;
      }

      /** The order's settlement records, seq ascending; none when it has no row. */
      async function records() {
        const [current] = await rowsOf();
        if (current === undefined) return [];
        return db
          .selectFrom('order_settlements')
          .selectAll()
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .orderBy('seq')
          .execute();
      }

      /** A record another task's import wrote (source STATEMENT). */
      async function statement(seq: number, fen: bigint, createdAt: Date = clock.now()) {
        const current = await row();
        await db
          .insertInto('order_settlements')
          .values({
            app_id: target.appId,
            order_id: current.order_id,
            seq,
            source: 'STATEMENT',
            settle_commission_fen: fen,
            settled_at: SETTLED_AT,
            content_hash: randomUUID(),
            created_at: createdAt,
          })
          .execute();
      }

      /** A RIGHTS record received now (the clock), as the rights command leaves it. */
      async function rights(status: 'SUCCEEDED' | 'WAIT_COMMISSION', deductionFen: bigint | null) {
        const current = await row();
        const id = randomUUID();
        const now = clock.now();
        await db
          .insertInto('order_rights')
          .values({
            id,
            app_id: target.appId,
            order_id: current.order_id,
            source: 'API',
            type: 'RIGHTS',
            status,
            deduction_commission_fen: deductionFen,
            occurred_at: now,
            platform_rights_no: `synthetic-${id}`,
            created_at: now,
            updated_at: now,
          })
          .execute();
        return id;
      }

      /** rights_pending as the rights command leaves it with a WAIT_COMMISSION record open. */
      async function markRightsPending(): Promise<void> {
        const current = await row();
        await db
          .updateTable('orders')
          .set({ rights_pending: true, row_version: current.row_version + 1 })
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .execute();
      }

      /** Status and answered_at of a rights record by id. */
      async function rightsRow(id: string) {
        const rows = await db
          .selectFrom('order_rights')
          .select(['status', 'answered_at'])
          .where('app_id', '=', target.appId)
          .where('id', '=', id)
          .execute();
        expect(rows, 'the rights record').toHaveLength(1);
        return rows[0]!;
      }

      /** The commission totals of every stored version. */
      async function totals() {
        const current = await row();
        return db
          .selectFrom('commission_split_totals')
          .select(['commission_version', 'base_fen'])
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .orderBy('commission_version')
          .execute();
      }

      /** expected_credit_period as the member reads it (BR-FUND-04 ⑪). */
      async function creditPeriod() {
        const current = await row();
        const found = await figures.forOrders({ app_id: target.appId, user_id: target.userId }, [
          current.order_id,
        ]);
        const value = found.get(current.order_id);
        expect(value, 'the order figures').toBeDefined();
        return value?.expected_credit_period;
      }

      return {
        subOrderId,
        report,
        sync,
        row,
        rowsOf,
        records,
        statement,
        rights,
        markRightsPending,
        rightsRow,
        totals,
        creditPeriod,
      };
    }

    /** One delivery of queue settle to the handler the worker assembly registered. */
    async function settleJob(name: 'bill' | 'batch_execute', payload: JobPayload): Promise<void> {
      const handlers = queue.register.mock.calls.filter(([queueName]) => queueName === 'settle');
      expect(handlers, 'the settle handler of the worker entry').toHaveLength(1);
      const handler = handlers[0]![1];
      await handler({ id: randomUUID(), queue: 'settle', name, payload, attempt: 1 });
    }

    function bill(target: App): Promise<void> {
      return settleJob('bill', {
        app_id: target.appId,
        platform: 'pdd',
        accounting_date: BILL_DAY,
      });
    }

    const batches = (target: App) =>
      db
        .selectFrom('settle_batches')
        .select(['batch_id', 'status'])
        .where('app_id', '=', target.appId)
        .orderBy('batch_id')
        .execute();

    const items = (target: App) =>
      db
        .selectFrom('settle_batch_items')
        .select([
          'batch_id',
          'item_type',
          'order_id',
          'settle_seq',
          'b_settle_fen',
          'result',
          'skip_reason',
        ])
        .where('app_id', '=', target.appId)
        .execute();

    /**
     * The app's DRAFT batches confirmed, as finance leaves them (the console command is B2-09f's and
     * not under test), then executed once each by the settle handler.
     */
    async function confirmAndExecute(target: App): Promise<void> {
      const adminId = randomUUID();
      await db
        .insertInto('admin_users')
        .values({
          id: adminId,
          app_id: target.appId,
          login_name: `settlement-records-${adminId}`,
          password_hash: 'test-only',
          is_super: true,
          status: 'active',
        })
        .execute();
      await db
        .updateTable('settle_batches')
        .set({ status: 'CONFIRMED', confirmed_by: adminId, confirmed_at: clock.now() })
        .where('app_id', '=', target.appId)
        .where('status', '=', 'DRAFT')
        .execute();
      for (const { batch_id: batchId } of await batches(target)) {
        await settleJob('batch_execute', { app_id: target.appId, batch_id: batchId });
      }
    }

    /** The member's available balance; 0 until the wallet exists. */
    async function available(target: App): Promise<bigint> {
      const rows = await createLedger({ clock }).getBalances(db, {
        appId: target.appId,
        userIds: [target.userId],
      });
      return rows[0]?.available_fen ?? 0n;
    }

    return {
      clock,
      events,
      app,
      setConfig,
      order,
      bill,
      batches,
      items,
      confirmAndExecute,
      available,
      close: worker.close,
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

export type Worker = Awaited<ReturnType<typeof startWorker>>;

/** Runs `test` on a production worker over `db` and always closes it. */
export async function withWorker(
  db: Kysely<DB>,
  test: (worker: Worker) => Promise<void>,
): Promise<void> {
  const worker = await startWorker(db);
  try {
    await test(worker);
  } finally {
    await worker.close();
  }
}
