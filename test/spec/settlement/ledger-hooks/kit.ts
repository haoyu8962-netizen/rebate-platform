// B2-04zn rule-test kit (claude-independent, D10-587, split from B2-04zb; BR-WDR-05 (a), BR-FUND-12).
// The gap under test came from tests that build their own ledger with the bus and the hook, so
// nothing here does on the path under test: every credit runs on the settle handler and every
// clawback on the order pipeline of a real AppModule.forEntry({ entry: 'worker' }) (keyedWorker, the
// B1-09n assembly over a real field keyring). Only the job queue is a stub: the bus still writes
// event_log, and deliver() hands a recorded send to the handler payout registered.
// Fixtures, none of them on the path under test:
// - every order is jd: only jd.csv has an invalid code (3), so only jd reaches the clawback through
//   the sync (pdd.csv has none, taobao no status map);
// - jd.csv has no settled code, its settlement comes from the statement alone
//   (docs/changes/20261101-京东结算佣金只由账单导入.md), so waiting() writes the STATEMENT record and the
//   order column as that import leaves them;
// - settle batches are written CONFIRMED as the bill and finance leave them (those are B2-04zj's
//   and B2-09f's), and run on the worker's own settle handler; D-1's asset snapshot has timed out
//   at SYNCED (BR-FUND-18), so a batch runs;
// - adjust() and withdrawal() post with a plain ledger, no bus and no hook, on purpose: they write
//   balances and freezes other flows would have left, and must fire nothing themselves;
// - payout_attempts is written as couli_payout, the only role that may (migration 0094).
// A fixture that cannot be built throws a plain Error, never an assertion: only the missing assembly
// may turn these tests red, and such an Error does not pass the red check.
// Amounts are written by hand in the tests. The rule version is the commission fixture's: reserve 0,
// own share 50 %, and jd deducts no service fee, so N = 1000 gives the member 500 (BR-CALC-02).
// Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createLedger, type PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { OrderSyncRuntime } from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  EventBus,
  JobHandler,
  JobPayload,
} from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { BEFORE, PAID, level } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { order as unionOrder } from '../../orders/attribution/kit.ts';
import {
  ATTR_CODE,
  JD_INVALID,
  JD_RECEIVED,
  RECEIVED_AT,
  RELATION,
  SYNCED,
  keyedWorker,
} from '../../orders/rebate-wiring/kit.ts';
import { runtime } from '../../orders/wiring/context-kit.ts';
import { account, at, pid, user } from '../../orders/wiring/db-kit.ts';

export { capture } from '../../orders/attribution/kit.ts';

export const TIMEOUT = 120_000;
/** Queue of payout's account.went_negative consumer (platform/queue/catalog.ts). */
const NEGATIVE_QUEUE = 'evt.payout-went-negative';
const NEGATIVE_EVENT = 'account.went_negative';
const NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';
/** The bill month of RECEIVED_AT. */
const BILL = '2026-10';
const COMMISSION_FEN = 1000n;

type Patch = Partial<UnionOrder>;

/** The union's report that the order went invalid (jd 3): P6 from RECEIVED, R8 in full. */
export function invalidated(): Patch {
  return { raw_status: JD_INVALID, modified_at: at('2026-10-21T01:01:00.000Z') };
}

interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}

/** The test database, as couli_app and as couli_payout. */
export async function open(create: () => Promise<Database>) {
  const database = await create();
  return {
    database,
    db: createDb({ connectionString: database.urlFor('couli_app'), max: 8 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 2 }),
  };
}

export async function close(handles: Awaited<ReturnType<typeof open>> | undefined): Promise<void> {
  if (handles === undefined) return;
  try {
    await Promise.all([destroyDb(handles.db), destroyDb(handles.payout)]);
  } finally {
    await handles.database.drop();
  }
}

interface Handles {
  readonly db: Kysely<DB>;
  readonly payout: Kysely<DB>;
}

interface App {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly adminId: string;
  readonly slot: string;
}

interface WithdrawalSeed {
  readonly amount: bigint;
  readonly status: 'PENDING_REVIEW' | 'APPROVED';
  /** The block as the went-negative consumer leaves it. */
  readonly blocked?: boolean;
}

/** The worker's queue stub (keyedWorker): what the assembly registered and what was sent. */
interface QueueStub {
  readonly register: { readonly mock: { readonly calls: [string, JobHandler][] } };
  readonly send: {
    readonly mock: {
      readonly calls: [string, string, JobPayload, { readonly id?: string } | undefined][];
    };
  };
}

async function startWorker({ db, payout }: Handles) {
  const worker = await keyedWorker(db);
  try {
    const r: OrderSyncRuntime = await runtime(worker.context);
    const clock = worker.clock;
    clock.set(SYNCED);
    const events = worker.context.get(worker.platform.EVENT_BUS, { strict: false }) as EventBus;
    const queue = worker.context.get(worker.platform.JOB_QUEUE, { strict: false }) as QueueStub;
    // Fixtures and reads only: the path under test never sees this ledger.
    const plainLedger = createLedger({ clock });
    let sequence = 0;

    /** A new app: union account, promotion slot, rule version, member, finance admin, switch on. */
    async function app(): Promise<App> {
      const a = await account(db, { platform: 'jd' });
      const owner = await user(db, a.app_id, { attr_code: ATTR_CODE });
      const slot = `slot-${randomUUID()}`;
      await pid(db, a, { pid: slot });
      await level(db, a.app_id, owner.id, 'L1', BEFORE);
      await seedVersion(db, a.app_id, version());
      const adminId = randomUUID();
      await db
        .insertInto('admin_users')
        .values({
          id: adminId,
          app_id: a.app_id,
          login_name: `ledger-hooks-${adminId}`,
          password_hash: 'test-only',
          is_super: true,
          status: 'active',
        })
        .execute();
      await db
        .insertInto('config_items')
        .values({
          app_id: a.app_id,
          key: 'credit.enabled.jd',
          value: JSON.stringify(true),
          version: 1,
          updated_by: 'fixture',
        })
        .execute();
      return { appId: a.app_id, userId: owner.id, accountId: a.id, adminId, slot };
    }

    /** One sub-order of the app's member as jd reports it: received, commission 1000. */
    function order(target: App) {
      const subOrderId = randomUUID();
      const incoming = unionOrder({
        platform: 'jd',
        order_id: subOrderId,
        sub_order_id: subOrderId,
        parent_order_id: subOrderId,
        promotion_slot: target.slot,
        raw_status: JD_RECEIVED,
        attr_params: {
          relation_id: RELATION,
          sub_union_id: `n_${ATTR_CODE}`,
          custom_parameters: null,
        },
        commission_fen: COMMISSION_FEN,
        est_commission_fen: COMMISSION_FEN,
        paid_at: PAID,
        received_at: RECEIVED_AT,
        modified_at: at('2026-10-20T03:00:00.000Z'),
      });

      /** One report through the production pipeline, one minute after the last. */
      function report(next: Patch = {}) {
        sequence += 1;
        clock.advanceMs(60_000);
        return r.pipeline.process(
          { ...incoming, ...next, raw_payload_id: `${100 + sequence}` },
          {
            app_id: target.appId,
            platform: 'jd',
            union_account_id: target.accountId,
            query_kind: 'increment',
            scene: '-',
            window_start: '2026-10-01T02:03:04.000Z',
            window_end: clock.now().toISOString(),
            requestId: randomUUID(),
          },
        );
      }

      async function row() {
        const found = await db
          .selectFrom('orders')
          .selectAll()
          .where('app_id', '=', target.appId)
          .where('sub_order_id', '=', subOrderId)
          .executeTakeFirst();
        if (found === undefined) throw new Error('kit: the order row is missing');
        return found;
      }

      return { subOrderId, report, row };
    }

    type Order = ReturnType<typeof order>;

    /** An order synced to WAITING, with the settlement record the statement import leaves. */
    async function waiting(target: App): Promise<Order> {
      const o = order(target);
      await o.report();
      const current = await o.row();
      if (current.rebate_status !== 'WAITING') {
        throw new Error(`kit: the synced order is ${current.rebate_status}, not WAITING`);
      }
      await db
        .insertInto('order_settlements')
        .values({
          app_id: target.appId,
          order_id: current.order_id,
          seq: 1,
          source: 'STATEMENT',
          settle_commission_fen: COMMISSION_FEN,
          settled_at: RECEIVED_AT,
          content_hash: randomUUID(),
          created_at: clock.now(),
        })
        .execute();
      await db
        .updateTable('orders')
        .set({ settle_commission_fen: COMMISSION_FEN, row_version: current.row_version + 1 })
        .where('app_id', '=', target.appId)
        .where('order_id', '=', current.order_id)
        .execute();
      return o;
    }

    /** A handler the worker assembly registered on `name`. */
    function registered(name: string): JobHandler {
      const handlers = queue.register.mock.calls.filter(([queueName]) => queueName === name);
      expect(handlers, `the ${name} handler of the worker entry`).toHaveLength(1);
      return handlers[0]![1];
    }

    /** One delivery of batch_execute to the settle handler of the worker entry. */
    function execute(target: App, batchId: string): Promise<void> {
      return registered('settle')({
        id: randomUUID(),
        queue: 'settle',
        name: 'batch_execute',
        payload: { app_id: target.appId, batch_id: batchId },
        attempt: 1,
      });
    }

    /** A batch as the bill and finance's confirmation leave it, without items. */
    async function confirmedBatch(target: App, orderCount: number): Promise<string> {
      const now = clock.now();
      await db
        .insertInto('settle_bills')
        .values({
          app_id: target.appId,
          bill_id: BILL,
          generation_started_at: now,
          generated_at: now,
          created_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      const batchId = randomUUID();
      await db
        .insertInto('settle_batches')
        .values({
          batch_id: batchId,
          app_id: target.appId,
          bill_id: BILL,
          platform: 'jd',
          kind: 'main',
          status: 'CONFIRMED',
          settle_mode: 'IMMEDIATE',
          scheduled_at: null,
          confirmed_by: target.adminId,
          confirmed_at: now,
          cancelled_reason: null,
          settle_run_id: null,
          order_count: orderCount,
          started_at: null,
          finished_at: null,
          paused_by_switch_at: null,
          row_version: 3,
          created_at: now,
        })
        .execute();
      return batchId;
    }

    /** A confirmed batch of one R5 item for the order. */
    async function orderBatch(target: App, o: Order): Promise<string> {
      const current = await o.row();
      const batchId = await confirmedBatch(target, 1);
      await db
        .insertInto('settle_batch_items')
        .values({
          id: randomUUID(),
          app_id: target.appId,
          batch_id: batchId,
          item_type: 'order',
          order_id: current.order_id,
          user_id: null,
          role: null,
          beneficiary_credit_id: null,
          settle_seq: 1,
          b_settle_fen: COMMISSION_FEN,
          amount_fen: null,
          result: null,
          skip_reason: null,
          created_at: clock.now(),
        })
        .execute();
      return batchId;
    }

    function items(target: App, batchId: string) {
      return db
        .selectFrom('settle_batch_items')
        .select(['result', 'amount_fen', 'skip_reason'])
        .where('app_id', '=', target.appId)
        .where('batch_id', '=', batchId)
        .execute();
    }

    /** R5 of the order on the worker's settle handler. */
    async function credit(target: App, o: Order): Promise<void> {
      const batchId = await orderBatch(target, o);
      await execute(target, batchId);
      const rows = await items(target, batchId);
      if (rows.length !== 1 || rows[0]!.result !== 'credited') {
        throw new Error(`kit: the R5 item ended ${JSON.stringify(rows[0]?.skip_reason ?? null)}`);
      }
    }

    /** R5a of the member's one open obligation on the order; the item as it ended. */
    async function supplement(target: App, o: Order) {
      const current = await o.row();
      const open = await db
        .selectFrom('beneficiary_credits')
        .selectAll()
        .where('app_id', '=', target.appId)
        .where('order_id', '=', current.order_id)
        .where('user_id', '=', target.userId)
        .where('status', '=', 'open')
        .execute();
      const obligation = open[0];
      if (open.length !== 1 || obligation === undefined) {
        throw new Error(`kit: ${open.length} open obligations, expected one`);
      }
      const batchId = await confirmedBatch(target, 0);
      await db
        .insertInto('settle_batch_items')
        .values({
          id: randomUUID(),
          app_id: target.appId,
          batch_id: batchId,
          item_type: 'beneficiary',
          order_id: current.order_id,
          user_id: obligation.user_id,
          role: obligation.role,
          beneficiary_credit_id: obligation.beneficiary_credit_id,
          settle_seq: 1,
          b_settle_fen: null,
          amount_fen: null,
          result: null,
          skip_reason: null,
          created_at: clock.now(),
        })
        .execute();
      await execute(target, batchId);
      return (await items(target, batchId))[0];
    }

    /** R8 of a credited order through the sync: the union reports it invalid. */
    async function clawback(o: Order): Promise<void> {
      await o.report(invalidated());
      const current = await o.row();
      if (current.rebate_status !== 'CLAWED_BACK') {
        throw new Error(`kit: the reported order is ${current.rebate_status}, not CLAWED_BACK`);
      }
    }

    /** Moves the member's available by `delta`, with no bus and no hook (see the file header). */
    async function adjust(target: App, delta: bigint): Promise<void> {
      await db.transaction().execute(async (trx) => {
        const who = { appId: target.appId, userId: target.userId };
        await lockUsersForUpdate(trx, { appId: who.appId, userIds: [who.userId] });
        const wallet = await plainLedger.openUserAccount(trx, who);
        await plainLedger.lockBalances(trx, { appId: who.appId, userIds: [who.userId] });
        const posting = voucher(who.appId, wallet.account_id, -delta);
        await plainLedger.post(
          trx,
          delta > 0n
            ? posting
            : {
                ...posting,
                entries: posting.entries.map((e) => ({ ...e, ledger_type: 'ADMIN_ADJUST' })),
              },
        );
      });
    }

    /** A withdrawal of the member with its W1 freeze; fund the member first. */
    async function withdrawal(target: App, seed: WithdrawalSeed): Promise<string> {
      const id = randomUUID();
      const now = clock.now();
      const { appId, userId } = target;
      await db.transaction().execute(async (trx) => {
        await sql`INSERT INTO app.withdrawals
          (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
           payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
           review_mode, blocked_reason, created_at, updated_at)
          VALUES (${id}, ${appId}, ${userId}, ${seed.amount}, 0, 0, ${seed.amount}, 'SERVICE_FEE',
           'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
           ${randomBytes(32).toString('hex')}, ${seed.status}, ${randomBytes(16).toString('hex')},
           'alipay', 'manual', ${seed.blocked === true ? NEGATIVE_BALANCE : null}, ${now}, ${now})`.execute(
          trx,
        );
        await lockUsersForUpdate(trx, { appId, userIds: [userId] });
        const wallet = await plainLedger.openUserAccount(trx, { appId, userId });
        await plainLedger.lockBalances(trx, { appId, userIds: [userId] });
        const [built] = buildVouchers('WITHDRAW:FREEZE', {
          withdrawal_id: id,
          user_id: userId,
          withdraw_fen: seed.amount,
        });
        if (built === undefined) throw new Error('kit: WITHDRAW:FREEZE built no voucher');
        const entries: PostingEntry[] = built.entries.map((entry) => ({
          account: { ownerType: 'user', accountId: wallet.account_id },
          sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
          amount_fen: entry.amount_fen,
          ledger_type: entry.ledger_type,
          sub_type: entry.sub_type,
          income_type: null,
        }));
        await plainLedger.post(trx, {
          appId,
          uniqKey: built.uniq_key,
          bizType: 'withdrawal',
          bizId: id,
          operator: 'system',
          memo: null,
          orderKey: null,
          beneficiaryUserId: null,
          role: null,
          voucherKind: null,
          entries,
        });
      });
      return id;
    }

    /** A transfer attempt as the payout process writes it: the withdrawal cannot be W3-rejected. */
    async function transferAttempt(target: App, withdrawalId: string): Promise<void> {
      await sql`INSERT INTO app.payout_attempts (id, app_id, withdrawal_id, kind, request, result, at)
        VALUES (${randomUUID()}, ${target.appId}, ${withdrawalId}, 'transfer',
          ${JSON.stringify({ logon_id: 'synthetic' })}::jsonb, 'pending', ${clock.now()})`.execute(
        payout,
      );
    }

    /** The member's risk state, read by the real beneficiary gate. */
    async function setRisk(target: App, state: 'normal' | 'frozen'): Promise<void> {
      const reasonCategory = state === 'normal' ? null : 'other';
      await db
        .insertInto('user_risk_state')
        .values({
          user_id: target.userId,
          app_id: target.appId,
          state,
          reason: null,
          reason_category: reasonCategory,
          frozen_until: null,
          changed_by: 'test',
          changed_at: clock.now(),
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            state,
            reason_category: reasonCategory,
            changed_at: clock.now(),
          }),
        )
        .execute();
    }

    /**
     * A member at available = -debt with one blocked APPROVED withdrawal of 100 (frozen 100), as
     * the went-negative consumer leaves an attempted withdrawal. Returns the withdrawal's id.
     */
    async function blockedMember(target: App, debt: bigint): Promise<string> {
      await adjust(target, 100n);
      const id = await withdrawal(target, { amount: 100n, status: 'APPROVED', blocked: true });
      await adjust(target, -debt);
      return id;
    }

    async function balance(target: App) {
      const rows = await plainLedger.getBalances(db, {
        appId: target.appId,
        userIds: [target.userId],
      });
      return { available: rows[0]?.available_fen ?? 0n, frozen: rows[0]?.frozen_fen ?? 0n };
    }

    async function withdrawalRow(target: App, id: string, on: Kysely<DB> = db) {
      const found = await on
        .selectFrom('withdrawals')
        .selectAll()
        .where('app_id', '=', target.appId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (found === undefined) throw new Error('kit: the withdrawal row is missing');
      return found;
    }

    /** The app's account.went_negative rows of event_log, on `on` (a transaction sees its own). */
    function wentNegative(target: App, on: Kysely<DB> = db) {
      return on
        .selectFrom('event_log')
        .select(['event_id', 'app_id', 'payload'])
        .where('app_id', '=', target.appId)
        .where('name', '=', NEGATIVE_EVENT)
        .orderBy('id')
        .execute();
    }

    /**
     * Hands every committed account.went_negative of the app to the handler payout registered, with
     * the job the bus sent. The stub also recorded the sends of rolled-back transactions, which
     * pg-boss would have rolled back with them: the event_log row decides.
     */
    async function deliver(target: App): Promise<void> {
      const handler = registered(NEGATIVE_QUEUE);
      for (const event of await wentNegative(target)) {
        const sends = queue.send.mock.calls.filter(
          ([name, , , options]) => name === NEGATIVE_QUEUE && options?.id === event.event_id,
        );
        expect(sends, 'one job of the committed event').toHaveLength(1);
        const [, name, payload] = sends[0]!;
        await handler({
          id: event.event_id,
          queue: NEGATIVE_QUEUE,
          name,
          payload,
          attempt: 1,
        });
      }
    }

    return {
      clock,
      events,
      app,
      waiting,
      execute,
      orderBatch,
      credit,
      supplement,
      clawback,
      adjust,
      withdrawal,
      transferAttempt,
      setRisk,
      blockedMember,
      balance,
      withdrawalRow,
      wentNegative,
      deliver,
      close: worker.close,
    };
  } catch (error) {
    await worker.close();
    throw error;
  }
}

/** Runs `test` on a production worker over `handles` and always closes it. */
export async function withWorker(
  handles: Handles,
  test: (worker: Awaited<ReturnType<typeof startWorker>>) => Promise<void>,
): Promise<void> {
  const worker = await startWorker(handles);
  try {
    await test(worker);
  } finally {
    await worker.close();
  }
}
