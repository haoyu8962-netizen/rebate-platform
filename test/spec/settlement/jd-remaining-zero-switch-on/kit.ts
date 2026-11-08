// B2-04zzh rule-test kit (claude-independent; FU-JD-REMAINING-ZERO-SWITCH-ON, D10-923 / D10-930;
// 08 BR-CALC-15「剩余数量为 0 … 入账前 R6 → VOID」, BR-FUND-07, BR-FUND-01 R5 / R6, BR-FUND-04 ⑦ ⑨).
// The gap under test: a jd order whose items were all refunded while the switch
// orders.jd.refunded_quantity_r9_enabled was off stays WAITING (B2-04zzg only alerts then); once the
// switch is on and the union report does not change any more, nothing re-evaluates it before the
// monthly credit. Two observable paths close it:
// - the credit (R5) of the worker's own settle handler: the production AppModule.forEntry({ entry:
//   'worker' }) over a real field keyring (../../orders/rebate-wiring/kit.ts keyedWorker), the same
//   worker that synced the order; the job batch_execute is handed to the handler the worker
//   registered on queue `settle` (only the job queue is a stub, the bus still writes event_log);
// - the one-shot CLI apps/api/scripts/jd-remaining-zero-reevaluate.ts, called through run(argv,
//   deps) like ../../union/pids-cli (never a child process).
// Synthetic, written here as the other owners would have left them: the statement's settlement
// record of each order (order_settlements seq n + 1 and orders.settle_commission_fen, as the jd
// statement import writes them: jd.csv has no settled code), the bill month, an admin who confirmed
// the batch, and the CONFIRMED batch with its items. Orders, attribution, commission snapshots and
// the rebate states come from the production sync (reports start at the normalized UnionOrder; the
// counts are synthetic, B1-08zi owns jd's mapping).
// Conventions fixed by these tests (task brief §9.2):
// - the credit-time void leaves the batch item result 'skipped', skip_reason 'jd_remaining_zero_void';
// - the credit-time warn with the switch off reuses alert jd_remaining_zero_r6_disabled with app_id,
//   order_id, platform, quantity, refunded_quantity and an outcome other than the sync's
//   'status_kept';
// - CLI: run(argv, { reevaluation, terminal }) resolves { exitCode, candidates, voided, skipped };
//   reevaluation = createJdRemainingZeroReevaluation({ db, clock, logger, events, config, audit })
//   (settlement), audit = admin's createAuditWriter on the order's transaction; --actor is the
//   operator's admin id (audit_logs.admin_id); the list names orders by order_id only; exit codes 0
//   success, 2 invalid arguments, 1 other failure.
// Every content- or switch-cache is passed (the clock moves 10 minutes) before a batch or the CLI
// runs, so a value written just before is the one read.
// Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, KyselyPlugin } from 'kysely';
import { expect, vi } from 'vitest';
import {
  run as reevaluate,
  type JdRemainingZeroReevaluateDeps,
  type JdRemainingZeroReevaluateResult,
} from '../../../../apps/api/scripts/jd-remaining-zero-reevaluate.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  createRootLogger,
  type EventBus,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createJdRemainingZeroReevaluation } from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, PAID, level } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { capture, order as unionOrder } from '../../orders/attribution/kit.ts';
import { keyedWorker } from '../../orders/rebate-wiring/kit.ts';
import { runtime } from '../../orders/wiring/context-kit.ts';
import { account, at, pid, user } from '../../orders/wiring/db-kit.ts';
import * as workerPorts from '../../risk/freeze-expiry/kit.ts';
import { ALERT, counts, touched } from '../jd-remaining-zero/kit.ts';
import { capturedPorts } from '../worker/kit.ts';

export { capture } from '../../orders/attribution/kit.ts';
export { databaseFixture } from '../credit/kit.ts';
export { ALERT, JD_INVALID, SWITCH, counts, touched } from '../jd-remaining-zero/kit.ts';

export const TIMEOUT = 180_000;
/** The skip reason of a batch item whose order the credit voided (task brief §9.2 第 1 条). */
export const SKIP_REASON = 'jd_remaining_zero_void';
/** The outcome of the sync-time alert (B2-04zzg); the credit-time one names the credit instead. */
export const SYNC_OUTCOME = 'status_kept';
/** union-pids' exit layering (task brief §9.2 第 3 条). */
export const EXIT_OK = 0;
export const EXIT_INVALID = 2;
/** What the statement import recorded as the settlement commission of every order here. */
export const SETTLED_FEN = 1000n;
/** The worker's Clock at start: after PAID and the receipt below (2026-10-22 11:00 +08:00). */
const SYNCED = '2026-10-22T03:00:00.000Z';
const ATTR_CODE = 'abcd1234';
const UNKNOWN_CODE = 'zzzz9999';
/** A receipt after PAID: settle_period 2026-10. */
const RECEIVED_AT = at('2026-10-21T02:00:00.000Z');
/** The bill month of the orders' receipt. */
const BILL = '2026-10';
/** Longer than any content or switch cache (60 s / 5 s), well inside the same accounting day. */
const CACHE_PASS_MS = 10 * 60_000;
const FAULT_MESSAGE = 'synthetic failure while appending order.invalidated';

export type Platform = 'jd' | 'pdd';
type Patch = Partial<UnionOrder>;
type Handle = (job: ReceivedJob) => Promise<void>;

/** specs/order-status-map/jd.csv and pdd.csv. */
const CODES: Record<Platform, { readonly paid: string; readonly received: string }> = {
  jd: { paid: '16', received: '17' },
  pdd: { paid: '0', received: '2' },
};

/** Each platform's own attribution field (BR-ATTR-06). */
function attrParams(platform: Platform, code: string): NonNullable<UnionOrder['attr_params']> {
  if (platform === 'jd') {
    return { relation_id: null, sub_union_id: `n_${code}`, custom_parameters: null };
  }
  const custom = JSON.stringify({ app: 'n', uid: code });
  return { relation_id: null, sub_union_id: null, custom_parameters: custom };
}

export interface App {
  readonly appId: string;
  readonly userId: string;
  /** The admin who confirmed the app's batches; the operator of the CLI (--actor). */
  readonly adminId: string;
  readonly accounts: Readonly<Record<Platform, string>>;
}

export interface EventRow {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export interface Batch {
  readonly appId: string;
  readonly batchId: string;
  /** settle_batch_items.id by order_id. */
  readonly items: ReadonlyMap<string, string>;
}

/**
 * A one-shot fault on the worker's database handle: while armed, the INSERT of an event_log row named
 * order.invalidated fails (once; the transaction around it is then in error and rolls back).
 */
export interface InvalidatedFault {
  armed: boolean;
  hits: number;
  readonly plugin: KyselyPlugin;
}

function invalidatedFault(): InvalidatedFault {
  const fault: InvalidatedFault = {
    armed: false,
    hits: 0,
    plugin: {
      transformQuery({ node }) {
        if (fault.armed && node.kind === 'InsertQueryNode') {
          const text = JSON.stringify(node, (_name, item: unknown) =>
            typeof item === 'bigint' ? item.toString() : item,
          );
          if (text.includes('"event_log"') && text.includes('"order.invalidated"')) {
            fault.armed = false;
            fault.hits += 1;
            throw new Error(FAULT_MESSAGE);
          }
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    },
  };
  return fault;
}

/** What a batch needs of a synced order. */
interface BatchOrder {
  row(): Promise<{ readonly order_id: string }>;
  settled(): Promise<number>;
}

interface QueueStub {
  readonly register: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } };
}

async function startWorker(db: Kysely<DB>) {
  const fault = invalidatedFault();
  const worker = await keyedWorker(db.withPlugin(fault.plugin));
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(SYNCED);
    const events = worker.context.get(worker.platform.EVENT_BUS, { strict: false }) as EventBus;
    const queue = worker.context.get(worker.platform.JOB_QUEUE, { strict: false }) as QueueStub;
    let sequence = 0;

    /** The one handler the worker registered on queue `settle`. */
    function settleHandler(): Handle {
      const handlers = queue.register.mock.calls.filter((call) => call[0] === 'settle');
      expect(handlers, 'settle handlers registered by the worker').toHaveLength(1);
      return handlers[0]![1] as Handle;
    }

    /**
     * A new app: a jd and a pdd union account with a slot each, one member, one rule version, the
     * bill month and the admin who confirms its batches.
     */
    async function app(): Promise<App> {
      const jd = await account(db, { platform: 'jd' });
      const pdd = await account(db, { platform: 'pdd', app_id: jd.app_id });
      const owner = await user(db, jd.app_id, { attr_code: ATTR_CODE });
      await pid(db, jd);
      await pid(db, pdd);
      await level(db, jd.app_id, owner.id, 'L1', BEFORE);
      await seedVersion(db, jd.app_id, version());
      const adminId = randomUUID();
      await db
        .insertInto('admin_users')
        .values({
          id: adminId,
          app_id: jd.app_id,
          login_name: `jdz-ops-${adminId}`,
          password_hash: 'test-only',
          is_super: true,
          status: 'active',
        })
        .execute();
      const opened = clock.now();
      await db
        .insertInto('settle_bills')
        .values({
          app_id: jd.app_id,
          bill_id: BILL,
          generation_started_at: opened,
          generated_at: opened,
          created_at: opened,
        })
        .execute();
      return {
        appId: jd.app_id,
        userId: owner.id,
        adminId,
        accounts: { jd: jd.id, pdd: pdd.id },
      };
    }

    /** Upsert of one config_items row of the app (the value as JSON). */
    async function setConfig(target: App, name: string, value: unknown): Promise<void> {
      await db
        .insertInto('config_items')
        .values({
          app_id: target.appId,
          key: name,
          value: JSON.stringify(value),
          version: 1,
          updated_by: 'fixture',
        })
        .onConflict((oc) =>
          oc.columns(['app_id', 'key']).doUpdateSet((eb) => ({
            value: JSON.stringify(value),
            version: eb('config_items.version', '+', 1),
            updated_by: 'fixture',
          })),
        )
        .execute();
    }

    /** Every event_log row of the app, oldest first, with its business payload (`data`). */
    async function eventsOf(target: App): Promise<EventRow[]> {
      const rows = await db
        .selectFrom('event_log')
        .select(['name', 'payload'])
        .where('app_id', '=', target.appId)
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        name: row.name,
        payload: (row.payload as { readonly data: Record<string, unknown> }).data,
      }));
    }

    /** Every voucher, entry and balance row of the app: what any money effect would change. */
    async function ledgerOf(target: App) {
      return {
        vouchers: await db
          .selectFrom('ledger_vouchers')
          .selectAll()
          .where('app_id', '=', target.appId)
          .orderBy('uniq_key')
          .execute(),
        entries: await db
          .selectFrom('ledger_entries')
          .selectAll()
          .where('app_id', '=', target.appId)
          .orderBy('id')
          .execute(),
        balances: await db
          .selectFrom('account_balances')
          .selectAll()
          .where('app_id', '=', target.appId)
          .orderBy('account_id')
          .execute(),
      };
    }

    /** The app's audit_logs rows, oldest first. */
    async function auditsOf(target: App) {
      return db
        .selectFrom('audit_logs')
        .select(['admin_id', 'system_actor', 'action', 'target', 'before', 'after'])
        .where('app_id', '=', target.appId)
        .orderBy('id')
        .execute();
    }

    /** Everything the credit guard or the CLI may write for the app. */
    async function stateOf(target: App) {
      return {
        orders: await db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', target.appId)
          .orderBy('order_id')
          .execute(),
        history: await db
          .selectFrom('order_status_history')
          .selectAll()
          .where('app_id', '=', target.appId)
          .orderBy('id')
          .execute(),
        events: await eventsOf(target),
        audits: await auditsOf(target),
        ledger: await ledgerOf(target),
      };
    }

    /**
     * One sub-order of the app's member on `platform`: paid, commission 1000 (pdd fee 0), until a
     * report says else. `unattributed` reports an attribution code no member has.
     */
    function order(
      target: App,
      platform: Platform,
      patch: Patch = {},
      options: { readonly unattributed?: boolean } = {},
    ) {
      const subOrderId = randomUUID();
      const incoming = unionOrder({
        platform,
        order_id: subOrderId,
        sub_order_id: subOrderId,
        raw_status: CODES[platform].paid,
        attr_params: attrParams(platform, options.unattributed === true ? UNKNOWN_CODE : ATTR_CODE),
        commission_fen: 1000n,
        est_commission_fen: 1000n,
        ...(platform === 'pdd' ? { service_fee_fen: 0n } : {}),
        paid_at: PAID,
        modified_at: at('2026-10-20T03:00:00.000Z'),
        ...patch,
      });

      /** The union keeps reporting what it reported last, so a later report never steps back. */
      let reported: Patch = {};

      /** One report through the production pipeline, one minute after the last. */
      async function report(next: Patch = {}) {
        sequence += 1;
        clock.advanceMs(60_000);
        const result = await r.pipeline.process(
          { ...incoming, ...reported, ...next, raw_payload_id: `${100 + sequence}` },
          {
            app_id: target.appId,
            platform,
            union_account_id: target.accounts[platform],
            query_kind: 'increment',
            scene: '-',
            window_start: '2026-10-01T02:03:04.000Z',
            window_end: clock.now().toISOString(),
            requestId: randomUUID(),
          },
        );
        reported = { ...reported, ...next };
        return result;
      }

      /** report() that must go through and be written (not parked as pending by orders). */
      async function sync(next: Patch = {}): Promise<void> {
        const result = await capture(() => report(next));
        expect(result).toMatchObject({ ok: true });
        if (result.ok) {
          expect(result.value, 'a report orders parks').not.toMatchObject({ kind: 'pending' });
        }
      }

      /** A receipt report of this platform (R4 on an attributed ESTIMATED order). */
      function receipt(minute: number, next: Patch = {}): Patch {
        return touched(minute, {
          raw_status: CODES[platform].received,
          received_at: RECEIVED_AT,
          ...next,
        });
      }

      async function row() {
        const rows = await db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', target.appId)
          .where('sub_order_id', '=', subOrderId)
          .execute();
        expect(rows, 'the order row').toHaveLength(1);
        return rows[0]!;
      }

      /** The order's rebate history rows, oldest first. */
      async function history() {
        const current = await row();
        return db
          .selectFrom('order_status_history')
          .select(['from_status', 'event', 'to_status', 'source'])
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .where('field', '=', 'rebate')
          .orderBy('id')
          .execute();
      }

      /** The rebate history rows that end in VOID. */
      async function voids() {
        return (await history()).filter((h) => h.to_status === 'VOID');
      }

      /** The R5 rows (each credit writes exactly one). */
      async function credits() {
        return (await history()).filter((h) => h.to_status === 'CREDITED');
      }

      /** The app's events of `name` naming this order. */
      async function eventsNamed(name: string): Promise<EventRow[]> {
        const current = await row();
        return (await eventsOf(target)).filter(
          (e) => e.name === name && e.payload['order_id'] === current.order_id,
        );
      }

      /** The vouchers booked on this order (their order_key carries the sub-order id). */
      async function vouchers() {
        return (await ledgerOf(target)).vouchers.filter((v) =>
          (v.order_key ?? '').includes(subOrderId),
        );
      }

      /** Warn lines (level 40) carrying ALERT for this order. */
      async function alerts(logs: readonly Record<string, unknown>[]) {
        const current = await row();
        return logs.filter(
          (line) =>
            line['level'] === 40 &&
            line['alert'] === ALERT &&
            line['order_id'] === current.order_id,
        );
      }

      /**
       * Fixture: the statement import's settlement record (seq n + 1, SETTLED_FEN) and the column
       * it decides (orders.settle_commission_fen); returns the seq a batch item is validated on.
       */
      async function settled(): Promise<number> {
        const current = await row();
        const latest = await db
          .selectFrom('order_settlements')
          .select('seq')
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .orderBy('seq', 'desc')
          .executeTakeFirst();
        const seq = (latest?.seq ?? 0) + 1;
        await db
          .insertInto('order_settlements')
          .values({
            app_id: target.appId,
            order_id: current.order_id,
            seq,
            source: 'STATEMENT',
            settle_commission_fen: SETTLED_FEN,
            settled_at: RECEIVED_AT,
            content_hash: randomUUID(),
            created_at: clock.now(),
          })
          .execute();
        await db
          .updateTable('orders')
          .set({ settle_commission_fen: SETTLED_FEN, row_version: current.row_version + 1 })
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .execute();
        return seq;
      }

      /**
       * Fixture: the row as the credit CAS of B2-04m leaves it (CREDITED, booked pair, the refunded
       * count frozen at `refundedAtCredit`), without vouchers (only the status matters here).
       */
      async function credited(refundedAtCredit: number): Promise<void> {
        const current = await row();
        await db
          .updateTable('orders')
          .set({
            rebate_status: 'CREDITED',
            booked_base_fen: 500n,
            booked_n_fen: 1000n,
            refunded_quantity_at_credit: refundedAtCredit,
            row_version: current.row_version + 1,
          })
          .where('app_id', '=', target.appId)
          .where('order_id', '=', current.order_id)
          .execute();
      }

      return {
        subOrderId,
        platform,
        report,
        sync,
        receipt,
        row,
        history,
        voids,
        credits,
        eventsNamed,
        invalidated: () => eventsNamed('order.invalidated'),
        creditedEvents: () => eventsNamed('order.credited'),
        vouchers,
        alerts,
        settled,
        credited,
      };
    }

    /**
     * The CONFIRMED (IMMEDIATE) settle batch of `orders` as the bill and the confirmation leave it:
     * each order on a fresh settlement record, credit.enabled.<platform> on. Nothing runs it yet.
     */
    async function batch(
      target: App,
      platform: Platform,
      orders: readonly BatchOrder[],
    ): Promise<Batch> {
      await setConfig(target, `credit.enabled.${platform}`, true);
      const seqs = new Map<string, number>();
      for (const o of orders) seqs.set((await o.row()).order_id, await o.settled());
      const confirmedAt = clock.now();
      const batchId = randomUUID();
      await db
        .insertInto('settle_batches')
        .values({
          batch_id: batchId,
          app_id: target.appId,
          bill_id: BILL,
          platform,
          kind: 'main',
          status: 'CONFIRMED',
          settle_mode: 'IMMEDIATE',
          scheduled_at: null,
          confirmed_by: target.adminId,
          confirmed_at: confirmedAt,
          cancelled_reason: null,
          settle_run_id: null,
          order_count: orders.length,
          started_at: null,
          finished_at: null,
          paused_by_switch_at: null,
          row_version: 3,
          created_at: confirmedAt,
        })
        .execute();
      const items = new Map<string, string>();
      for (const [orderId, seq] of seqs) {
        const id = randomUUID();
        items.set(orderId, id);
        await db
          .insertInto('settle_batch_items')
          .values({
            id,
            app_id: target.appId,
            batch_id: batchId,
            item_type: 'order',
            order_id: orderId,
            user_id: null,
            role: null,
            beneficiary_credit_id: null,
            settle_seq: seq,
            b_settle_fen: SETTLED_FEN,
            amount_fen: null,
            result: null,
            skip_reason: null,
            created_at: confirmedAt,
          })
          .execute();
      }
      return { appId: target.appId, batchId, items };
    }

    /** One delivery of batch_execute to the worker's settle handler (errors are captured). */
    async function execute(b: Batch) {
      clock.advanceMs(CACHE_PASS_MS);
      const handler = settleHandler();
      return capture(() =>
        handler(
          Object.freeze({
            id: randomUUID(),
            queue: 'settle',
            name: 'batch_execute',
            payload: { app_id: b.appId, batch_id: b.batchId },
            attempt: 1,
          }),
        ),
      );
    }

    /** execute() that must go through. */
    async function settle(b: Batch): Promise<void> {
      const result = await execute(b);
      expect(result, 'the settle handler delivery').toMatchObject({ ok: true });
    }

    async function batchOf(b: Batch) {
      return db
        .selectFrom('settle_batches')
        .selectAll()
        .where('app_id', '=', b.appId)
        .where('batch_id', '=', b.batchId)
        .executeTakeFirstOrThrow();
    }

    /** The batch item of `o`: result, skip_reason and amount_fen. */
    async function itemOf(b: Batch, o: Pick<BatchOrder, 'row'>) {
      const id = b.items.get((await o.row()).order_id);
      if (id === undefined) throw new Error('kit: the order is not in this batch');
      return db
        .selectFrom('settle_batch_items')
        .select(['result', 'skip_reason', 'amount_fen'])
        .where('app_id', '=', b.appId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    }

    /**
     * The one-shot CLI over settlement's re-evaluation on this database: the worker's clock and
     * event bus, content's configuration reader as app.module hands it to the worker, admin's audit
     * writer on the order's transaction. run() passes the caches first; `output` collects every line
     * the CLI writes (stdout and stderr).
     */
    async function cli() {
      const ports = await capturedPorts('worker');
      expect(ports, 'app.module assembles SettlementModule.forWorker').not.toBeNull();
      if (ports === null) throw new Error('unreachable: the expect above failed');
      const logger = createRootLogger(
        { level: 'info', entry: 'worker', appEnv: 'test' },
        {
          write() {
            // Lines are not asserted here.
          },
        },
      );
      const reevaluation = createJdRemainingZeroReevaluation({
        db,
        clock,
        logger,
        events,
        config: ports.config(db, clock),
        audit: (trx) => createAuditWriter({ db: trx, clock }),
      });
      const output: string[] = [];
      const deps: JdRemainingZeroReevaluateDeps = {
        reevaluation,
        terminal: {
          write: (message: string) => {
            output.push(message);
          },
          error: (message: string) => {
            output.push(message);
          },
        },
      };
      return {
        output,
        async run(argv: readonly string[]): Promise<JdRemainingZeroReevaluateResult> {
          clock.advanceMs(CACHE_PASS_MS);
          return reevaluate(argv, deps);
        },
      };
    }

    return {
      clock,
      events,
      fault,
      app,
      setConfig,
      eventsOf,
      ledgerOf,
      auditsOf,
      stateOf,
      order,
      batch,
      execute,
      settle,
      batchOf,
      itemOf,
      cli,
      close: worker.close,
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

export type Worker = Awaited<ReturnType<typeof startWorker>>;
export type SyncedOrder = ReturnType<Worker['order']>;

/** Runs `test` on a production worker over `db`, with its pino lines, and always closes it. */
export async function withWorker(
  db: Kysely<DB>,
  test: (w: Worker, logs: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const original = workerPorts.ports;
  const logs: Record<string, unknown>[] = [];
  const spy = vi.spyOn(workerPorts, 'ports').mockImplementation(async () => {
    const p = await original();
    const push = p.lines.push.bind(p.lines);
    p.lines.push = (...lines: string[]) => {
      for (const line of lines) logs.push(JSON.parse(line) as Record<string, unknown>);
      return push(...lines);
    };
    return p;
  });
  try {
    const worker = await startWorker(db);
    try {
      await test(worker, logs);
    } finally {
      await worker.close();
    }
  } finally {
    spy.mockRestore();
  }
}

/**
 * An attributed order of `platform` brought to `status` with `quantity` items and none refunded
 * (or the counts given): ESTIMATED after the first report, WAITING after a receipt.
 */
export async function precredit(
  w: Worker,
  target: App,
  platform: Platform,
  status: 'ESTIMATED' | 'WAITING',
  given: Patch = counts(2, 0),
): Promise<SyncedOrder> {
  const o = w.order(target, platform, given);
  await o.sync();
  if (status === 'WAITING') await o.sync(o.receipt(1));
  expect(await o.row()).toMatchObject({
    rebate_status: status,
    quantity: given.quantity ?? null,
    refunded_quantity: given.refunded_quantity ?? null,
    reason: null,
  });
  return o;
}

/**
 * A jd order of `status` whose 2 items were both refunded while the switch was off (B2-04zzg: the
 * sync only alerts, the status stays). The caller must not have turned the switch on yet.
 */
export async function zeroed(
  w: Worker,
  target: App,
  status: 'ESTIMATED' | 'WAITING',
): Promise<SyncedOrder> {
  const o = await precredit(w, target, 'jd', status);
  await o.sync(touched(5, counts(2, 2)));
  expect(await o.row()).toMatchObject({
    rebate_status: status,
    reason: null,
    quantity: 2,
    refunded_quantity: 2,
  });
  return o;
}
