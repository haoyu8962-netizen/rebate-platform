// B2-04zk rule-test kit (claude-independent; FU-CREDITED-AMOUNT-ROWS 余下, D10-583, D10-792; BR-CALC-15,
// BR-CALC-27, BR-FUND-08 ②). What is under test is the production assembly, nothing stood in for:
// the worker entry of ../settlement-records/kit.ts (AppModule.forEntry({ entry: 'worker' }) over a
// real field keyring), its pipeline, update step, rebate port, commission estimates, bill and credit,
// and the rights_import job that worker registered on order-sync. That job hands each row to
// settlement's rights.record, which on a CREDITED order calls the clawback's apply with ref rights
// (`R{order_rights.id}`) and rightsDeductFen — the one R9 whose N_new is booked_n − 应扣 (BR-FUND-08 ②).
// Synthetic only: the rights_imports task row and its admin as the console upload leaves them, the
// xlsx bytes behind the in-memory import store (local / test stand-in), the column template
// (../../orders/rights-mounts/templates.ts; each test file mocks it in, as K-3 has no real one),
// and, where a test says so, orders' refunded_quantity (UnionOrder carries no quantity).
// Every order is settle-diff-sync's credited(): pdd, fee 0, own share 50 % (role share), here with a
// snapshot reserve of 1000 bp. Expected amounts are written by hand in the tests, never computed by
// the planner. Integration tests pass the database in: this file never imports @couli/db/testing.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { MemoryImportStore } from '../../../../apps/api/src/modules/platform/import-store/index.ts';
import type { JobHandler, ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import { xlsx } from '../../orders/rights-import-task/kit.ts';
import * as wiring from '../../orders/rebate-wiring/kit.ts';
import { TEMPLATES } from '../../orders/rights-mounts/templates.ts';
import { MEMBER_ROLE, credited, type SyncedOrder } from '../settle-diff-sync/kit.ts';
import { withWorker, type App, type Worker } from '../settlement-records/kit.ts';

export { databaseFixture, failAfter, tracing } from '../credit/kit.ts';
export { MEMBER_ROLE } from '../settle-diff-sync/kit.ts';
export type { SyncedOrder } from '../settle-diff-sync/kit.ts';
export { settled, touched } from '../settlement-records/kit.ts';
export type { App, Worker } from '../settlement-records/kit.ts';

export const TIMEOUT = 180_000;
/** The snapshot's pdd reserve of every order here (BR-CALC-02): N 1000 → reserve 100, B 900. */
export const RESERVE_BP = 1000;
/** The rights sheet columns, in the order of the synthetic template. */
const HEADER = Object.values(TEMPLATES.rights.columns);
/** 维权金额 of every row (stored only; the clawback reads the deduction). */
const RIGHTS_AMOUNT = '29.90';
/** 发生时间 of every row: before the bill day, so never after the worker's clock. */
const OCCURRED_AT = '2026-11-20T10:00:00+08:00';

/** One row of a rights sheet: result SUCCEEDED, 扣回佣金 in yuan as the sheet carries it. */
export interface RightsLine {
  readonly rightsNo: string;
  /** null leaves the cell empty (BR-FUND-08 ③: no deduction). */
  readonly deduction: string | null;
}

export interface RightsTask {
  readonly importId: string;
  /** One delivery of this task's rights_import job to the worker's order-sync handler. */
  run(): Promise<void>;
}

/** The worker's queue stub (keyedWorker): the handlers the assembly registered. */
interface QueueStub {
  readonly register: { readonly mock: { readonly calls: [string, JobHandler][] } };
}

type StartedWorker = Awaited<ReturnType<typeof wiring.keyedWorker>>;

function rightsWorker(db: Kysely<DB>, w: Worker, queue: QueueStub, files: Map<string, Uint8Array>) {
  const admins = new Map<string, string>();

  function orderSync(): JobHandler {
    const handlers = queue.register.mock.calls.filter(([name]) => name === 'order-sync');
    expect(handlers, 'the order-sync handler of the worker entry').toHaveLength(1);
    return handlers[0]![1];
  }

  /** The console admin who uploaded the app's tasks (rights_imports.created_by). */
  async function adminOf(app: App): Promise<string> {
    const known = admins.get(app.appId);
    if (known !== undefined) return known;
    const id = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id,
        app_id: app.appId,
        login_name: `credited-amount-rows-${id}`,
        password_hash: 'test-only',
        is_super: true,
        status: 'active',
      })
      .execute();
    admins.set(app.appId, id);
    return id;
  }

  /** A queued kind=rights task of the order's sub-order, as the upload leaves it; nothing ran it. */
  async function queued(app: App, o: SyncedOrder, lines: readonly RightsLine[]) {
    const importId = randomUUID();
    const path = `${app.appId}/${importId}.xlsx`;
    const rows = lines.map((line) => [
      o.subOrderId,
      line.rightsNo,
      'SUCCEEDED',
      RIGHTS_AMOUNT,
      line.deduction,
      OCCURRED_AT,
    ]);
    files.set(path, new Uint8Array(xlsx([HEADER, ...rows])));
    await db
      .insertInto('rights_imports')
      .values({
        id: importId,
        app_id: app.appId,
        kind: 'rights',
        platform: 'pdd',
        union_account_id: null,
        time_basis: null,
        from: null,
        to: null,
        file_path: path,
        status: 'queued',
        created_by: await adminOf(app),
        created_at: w.clock.now(),
      })
      .execute();
    const run = (): Promise<void> => {
      const job: ReceivedJob = Object.freeze({
        id: randomUUID(),
        queue: 'order-sync',
        name: 'rights_import',
        payload: { app_id: app.appId, import_id: importId },
        attempt: 1,
      });
      return orderSync()(job);
    };
    const task: RightsTask = { importId, run };
    return task;
  }

  /** queued() and one delivery of its job. */
  async function imported(app: App, o: SyncedOrder, lines: readonly RightsLine[]) {
    const task = await queued(app, o, lines);
    await task.run();
    return task;
  }

  /** The task row's status and tallies. */
  function task(app: App, importId: string) {
    return db
      .selectFrom('rights_imports')
      .select([
        'status',
        'total_rows',
        'succeeded_rows',
        'failed_rows',
        'skipped_rows',
        'duplicate_rows',
      ])
      .where('app_id', '=', app.appId)
      .where('id', '=', importId)
      .executeTakeFirstOrThrow();
  }

  return { w, queued, imported, task };
}

export type RightsWorker = ReturnType<typeof rightsWorker>;

/**
 * Runs `test` on the production worker over `db` (settlement-records' withWorker), with the
 * worker's order-sync handler reachable for rights_import jobs, and always closes it.
 */
export async function withRights(
  db: Kysely<DB>,
  test: (r: RightsWorker) => Promise<void>,
): Promise<void> {
  const original = wiring.keyedWorker;
  const started: StartedWorker[] = [];
  const entry = vi.spyOn(wiring, 'keyedWorker').mockImplementation(async (handle) => {
    const worker = await original(handle);
    started.push(worker);
    return worker;
  });
  const files = new Map<string, Uint8Array>();
  const store = vi
    .spyOn(MemoryImportStore.prototype, 'get')
    .mockImplementation(async (path: string) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : new Uint8Array(bytes);
    });
  try {
    await withWorker(db, async (w) => {
      expect(started, 'the worker entry').toHaveLength(1);
      const worker = started[0]!;
      const queue = worker.context.get(worker.platform.JOB_QUEUE, { strict: false }) as QueueStub;
      await test(rightsWorker(db, w, queue, files));
    });
  } finally {
    entry.mockRestore();
    store.mockRestore();
  }
}

/** The commission versions of one order: amount rows and totals (BR-CALC-15, BR-CALC-27). */
export function versionsOf(db: Kysely<DB>, app: App, o: SyncedOrder) {
  const orderIdOf = async () => (await o.row()).order_id;
  const amountRows = async () =>
    db
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', await orderIdOf())
      .orderBy('commission_version')
      .orderBy('role')
      .orderBy('user_id')
      .execute();
  const totalRows = async () =>
    db
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('app_id', '=', app.appId)
      .where('order_id', '=', await orderIdOf())
      .orderBy('commission_version')
      .execute();

  return {
    /** The versions that have amount rows, and those that have totals. */
    async versions() {
      const amounts = (await amountRows()).map((row) => row.commission_version);
      const totals = (await totalRows()).map((row) => row.commission_version);
      return { amounts: [...new Set(amounts)], totals };
    },
    /** One version's amount rows without the write time. */
    async amounts(version: number) {
      return (await amountRows())
        .filter((row) => row.commission_version === version)
        .map((row) => ({
          user_id: row.user_id,
          role: row.role,
          base_fen: row.base_fen,
          amount_fen: row.amount_fen,
        }));
    },
    /** One version's four amounts and Σ shares; undefined when it has none. */
    async fourAmounts(version: number) {
      const row = (await totalRows()).find((t) => t.commission_version === version);
      if (row === undefined) return undefined;
      return {
        n_total_fen: row.n_total_fen,
        pre_base_deduct_fen: row.pre_base_deduct_fen,
        base_fen: row.base_fen,
        user_share_total_fen: row.user_share_total_fen,
        tlj_redpacket_fen: row.tlj_redpacket_fen,
        platform_est_profit_fen: row.platform_est_profit_fen,
      };
    },
    /** Every stored column of one version, for "left exactly as it was". */
    async stored(version: number) {
      return {
        amounts: (await amountRows()).filter((row) => row.commission_version === version),
        totals: (await totalRows()).filter((row) => row.commission_version === version),
      };
    },
  };
}

/** The order's rights records, oldest first. */
export async function rightsOf(db: Kysely<DB>, app: App, o: SyncedOrder) {
  const { order_id: orderId } = await o.row();
  return db
    .selectFrom('order_rights')
    .select(['id', 'platform_rights_no', 'source', 'type', 'status', 'deduction_commission_fen'])
    .where('app_id', '=', app.appId)
    .where('order_id', '=', orderId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** The rights_event_id of the one record imported under `rightsNo`: `R{order_rights.id}`. */
export async function rightsEvent(
  db: Kysely<DB>,
  app: App,
  o: SyncedOrder,
  rightsNo: string,
): Promise<string> {
  const rows = (await rightsOf(db, app, o)).filter((row) => row.platform_rights_no === rightsNo);
  expect(rows, `the rights record ${rightsNo}`).toHaveLength(1);
  return `R${rows[0]!.id}`;
}

/** The app's order.clawed_back events (event_log). */
export function clawedBackEvents(db: Kysely<DB>, app: App) {
  return db
    .selectFrom('event_log')
    .select(['name', 'payload'])
    .where('app_id', '=', app.appId)
    .where('name', '=', 'order.clawed_back')
    .execute();
}

/** A real credit at N 1000 under the snapshot reserve; the preconditions every test starts from. */
export async function creditedOrder(db: Kysely<DB>, w: Worker) {
  const { app, o, read } = await credited(db, w, { reserveBp: RESERVE_BP });
  const rows = versionsOf(db, app, o);
  expect(await o.row(), 'the credited order').toMatchObject({
    rebate_status: 'CREDITED',
    commission_version: 1,
    booked_base_fen: 900n,
    booked_n_fen: 1000n,
  });
  expect(await read.balance(), 'the member after credit').toEqual({
    available_fen: 450n,
    frozen_fen: 0n,
  });
  expect(await rows.versions(), 'the snapshot version').toEqual({ amounts: [1], totals: [1] });
  expect(await rows.amounts(1), 'the snapshot amount row').toEqual([
    { user_id: app.userId, role: MEMBER_ROLE, base_fen: 900n, amount_fen: 450n },
  ]);

  /** Everything a replay or a rollback must leave as it was. */
  async function state() {
    const order = await o.row();
    const versions = await rows.versions();
    const stored: Awaited<ReturnType<typeof rows.stored>>[] = [];
    for (const version of versions.totals) stored.push(await rows.stored(version));
    return {
      order,
      versions,
      stored,
      vouchers: await read.vouchers(),
      lines: await read.lines(),
      balance: await read.balance(),
      rights: await rightsOf(db, app, o),
    };
  }

  return { app, o, read, rows, state };
}

export type Credited = Awaited<ReturnType<typeof creditedOrder>>;

/** The CLAWBACK lines of one rights_event_id, as `uniq|subject|owner|amount|type|sub_type|sub_account`. */
export async function clawbackLines(c: Credited, event: string): Promise<string[]> {
  return (await c.read.lines())
    .filter((line) => line.uniq_key.endsWith(`:CLAWBACK:${event}`))
    .map(
      (line) =>
        `${line.uniq_key}|${line.subject}|${line.owner_id}|${line.amount_fen}|${line.ledger_type}|${line.sub_type}|${line.sub_account}`,
    )
    .sort();
}

/**
 * The CLAWBACK vouchers of one event (BR-FUND-08): the member debits USER_BALANCE.available, the
 * platform debits COMMISSION_REVENUE, each credits UNION_RECEIVABLE:pdd; a 0 amount has no voucher.
 */
export function expectedClawback(
  c: Credited,
  event: string,
  userDebit: bigint,
  platformDebit: bigint,
  subType: string,
): string[] {
  const member = `${c.read.orderRef}:${c.app.userId}:${MEMBER_ROLE}:CLAWBACK:${event}`;
  const house = `${c.read.orderRef}:PLATFORM:CLAWBACK:${event}`;
  const tail = `CLAWBACK|${subType}|available`;
  const expected: string[] = [];
  if (userDebit !== 0n) {
    expected.push(
      `${member}|USER_BALANCE|${c.app.userId}|${userDebit}|${tail}`,
      `${member}|UNION_RECEIVABLE:pdd|platform|${-userDebit}|${tail}`,
    );
  }
  if (platformDebit !== 0n) {
    expected.push(
      `${house}|COMMISSION_REVENUE|platform|${platformDebit}|${tail}`,
      `${house}|UNION_RECEIVABLE:pdd|platform|${-platformDebit}|${tail}`,
    );
  }
  return expected.sort();
}

/** The rebate history events of the order after its credit, oldest first. */
export async function eventsAfterCredit(c: Credited): Promise<string[]> {
  return (await c.read.history()).map((row) => row.event);
}

export interface VersionWrite {
  /** The value SET for commission_version. */
  readonly to: unknown;
  /** The value commission_version is compared with in WHERE (the optimistic lock), if any. */
  readonly from: unknown;
  readonly set: string;
  readonly guard: string;
}

/** Every statement that writes commission_version on app.orders, with its SET and WHERE parts. */
export function versionWrites(
  queries: readonly { readonly sql: string; readonly parameters: readonly unknown[] }[],
): VersionWrite[] {
  const writes: VersionWrite[] = [];
  for (const query of queries) {
    if (!/^update\s+(?:"app"\.)?"orders"/i.test(query.sql)) continue;
    const [set = '', guard = ''] = query.sql.split(/\swhere\s/i);
    const to = /"commission_version" = \$(\d+)/.exec(set);
    if (to === null) continue;
    const from = /"commission_version" = \$(\d+)/.exec(guard);
    writes.push({
      to: query.parameters[Number(to[1]) - 1],
      from: from === null ? undefined : query.parameters[Number(from[1]) - 1],
      set,
      guard,
    });
  }
  return writes;
}
