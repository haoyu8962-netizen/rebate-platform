// B2-04zzg rule-test kit (claude-independent; FU-JD-REMAINING-ZERO-VOID, D10-864 ②, D10-875, D10-878).
// Only synthetic setup and observations. The path under test is the production order sync of a real
// AppModule.forEntry({ entry: 'worker' }) (../../orders/rebate-wiring/kit.ts keyedWorker, over a real
// field keyring, so the rebate hook is settlement's port followed by the clawback's onUpdated); only
// the job queue is a stub, and the bus still writes event_log. Reports start at the normalized
// UnionOrder: jd's skuNum / skuReturnNum mapping to quantity / refunded_quantity is B1-08zi's
// (../../orders/refunded-quantity/jd-mapping.test.ts), the values here are synthetic.
// Every app has a jd and a pdd union account (one member, one rule version: reserve 0, own share
// 50 %), so one app can carry orders of both platforms. The switch is written to config_items, as
// an operator would; the worker reads it through content's config port.
// Pino lines are observed on the fixture's destination (../settle-diff-sync/kit.ts withSync does
// the same), never by replacing an application service.
// The one write outside the sync is credited(): a CREDITED row as the credit CAS leaves it, used
// only to show that a credited order is not this rule's (its R9 is B1-08zi's).
// Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import type { EventBus } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, PAID, level } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { capture, order as unionOrder } from '../../orders/attribution/kit.ts';
import { keyedWorker } from '../../orders/rebate-wiring/kit.ts';
import { runtime } from '../../orders/wiring/context-kit.ts';
import { account, at, pid, user } from '../../orders/wiring/db-kit.ts';
import * as workerPorts from '../../risk/freeze-expiry/kit.ts';

export { capture } from '../../orders/attribution/kit.ts';
export { databaseFixture } from '../credit/kit.ts';

export const TIMEOUT = 120_000;
/** The one switch of every jd refunded-quantity money effect (D10-864 ②). */
export const SWITCH = 'orders.jd.refunded_quantity_r9_enabled';
/** The alert of a jd order whose remaining quantity reached 0 while the switch is off. */
export const ALERT = 'jd_remaining_zero_r6_disabled';
/** The worker's Clock at start: after PAID and the receipt below. */
const SYNCED = '2026-10-22T03:00:00.000Z';
const ATTR_CODE = 'abcd1234';
const UNKNOWN_CODE = 'zzzz9999';
/** A receipt after PAID: settle_period 2026-10. */
const RECEIVED_AT = at('2026-10-21T02:00:00.000Z');

export type Platform = 'jd' | 'pdd';
type Patch = Partial<UnionOrder>;

/** specs/order-status-map/jd.csv and pdd.csv. */
const CODES: Record<Platform, { readonly paid: string; readonly received: string }> = {
  jd: { paid: '16', received: '17' },
  pdd: { paid: '0', received: '2' },
};
/** specs/order-status-map/jd.csv: 无效-取消. */
export const JD_INVALID = '3';

/** Each platform's own attribution field (BR-ATTR-06). */
function attrParams(platform: Platform, code: string): NonNullable<UnionOrder['attr_params']> {
  if (platform === 'jd') {
    return { relation_id: null, sub_union_id: `n_${code}`, custom_parameters: null };
  }
  const custom = JSON.stringify({ app: 'n', uid: code });
  return { relation_id: null, sub_union_id: null, custom_parameters: custom };
}

/** The same order with only the mtime moved (plus `patch`): its content hash changes. */
export function touched(minute: number, patch: Patch = {}): Patch {
  const minutes = String(minute).padStart(2, '0');
  return { modified_at: at(`2026-10-21T10:${minutes}:00.000Z`), ...patch };
}

/** The counts a report carries (synthetic skuNum / skuReturnNum after B1-08zi's mapping). */
export function counts(quantity: number | null, refunded: number | null): Patch {
  return { quantity, refunded_quantity: refunded };
}

export interface App {
  readonly appId: string;
  readonly userId: string;
  readonly accounts: Readonly<Record<Platform, string>>;
}

export interface EventRow {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

async function startWorker(db: Kysely<DB>) {
  const worker = await keyedWorker(db);
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(SYNCED);
    const events = worker.context.get(worker.platform.EVENT_BUS, { strict: false }) as EventBus;
    let sequence = 0;

    /** A new app: a jd and a pdd union account with a slot each, one member, one rule version. */
    async function app(): Promise<App> {
      const jd = await account(db, { platform: 'jd' });
      const pdd = await account(db, { platform: 'pdd', app_id: jd.app_id });
      const owner = await user(db, jd.app_id, { attr_code: ATTR_CODE });
      await pid(db, jd);
      await pid(db, pdd);
      await level(db, jd.app_id, owner.id, 'L1', BEFORE);
      await seedVersion(db, jd.app_id, version());
      return { appId: jd.app_id, userId: owner.id, accounts: { jd: jd.id, pdd: pdd.id } };
    }

    /** Upsert of one config_items row of the app (the value as JSON). */
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
        .onConflict((oc) =>
          oc.columns(['app_id', 'key']).doUpdateSet((eb) => ({
            value: JSON.stringify(value),
            version: eb('config_items.version', '+', 1),
            updated_by: 'fixture',
          })),
        )
        .execute();
    }

    /**
     * Every event_log row of the app, oldest first, with its business payload: the bus stores
     * `{ v, data }` (platform/events publish), so the event's own fields are those under `data`.
     */
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

      /**
       * The fields of every report that went through: the union keeps reporting what it reported
       * last (a received order stays received), so a later report never steps back by omission.
       */
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

      /** The order's rebate history rows that end in VOID. */
      async function voids() {
        return (await history()).filter((h) => h.to_status === 'VOID');
      }

      /** The app's order.invalidated events naming this order. */
      async function invalidated(): Promise<EventRow[]> {
        const current = await row();
        return (await eventsOf(target)).filter(
          (e) => e.name === 'order.invalidated' && e.payload['order_id'] === current.order_id,
        );
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
       * Fixture: the row as the credit CAS of B2-04m leaves it (CREDITED, booked pair, the refunded
       * count frozen at `refundedAtCredit`). No voucher is written: only the rebate status matters to
       * the rule under test, and the clawback finds no refund increase above that baseline.
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
        invalidated,
        totals,
        alerts,
        credited,
      };
    }

    return {
      clock,
      events,
      app,
      setConfig,
      eventsOf,
      ledgerOf,
      order,
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
 * An attributed order of `platform` brought to `status` with `quantity` items and none refunded:
 * ESTIMATED after the first report, WAITING after a receipt.
 */
export async function precredit(
  w: Worker,
  target: App,
  platform: Platform,
  status: 'ESTIMATED' | 'WAITING',
  quantity = 2,
): Promise<SyncedOrder> {
  const o = w.order(target, platform, counts(quantity, 0));
  await o.sync();
  if (status === 'WAITING') await o.sync(o.receipt(1));
  expect(await o.row()).toMatchObject({
    rebate_status: status,
    quantity,
    refunded_quantity: 0,
    reason: null,
  });
  return o;
}
