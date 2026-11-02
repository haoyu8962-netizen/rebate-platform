// B1-04zv: the worker's real order-sync runtime (OrdersModule.forWorker over the test database)
// with the real jd adapter over a fake transport. Real: the registered order-sync handler, the
// attribution pipeline, the update step, the cursor store, order_sync_requests progress and the
// logger. Replaced: the transport, and the credential owner lookup (demo endpoints have no owner).
// Nothing here names how a bad row travels from the adapter to order_sync_pending: the tests feed
// raw upstream rows and read the tables, the cursors and the log. Every run goes through `capture`:
// before the implementation a bad row escapes the job as a UnionError, and that has to be an
// assertion failure in the test. Only the container runner executes the tests that import this.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { JobPayload, ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import { BEFORE, level } from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { inner, num, reply, row, wire } from '../../union/jd-orders/kit.ts';
import { capture } from '../attribution/kit.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';
import { account, pid, user } from '../wiring/db-kit.ts';

/** The three paths that fetch a window. */
export const ROUTES = ['increment', 'rescan', 'manual'] as const;
export type Route = (typeof ROUTES)[number];

/** A value no mapper can read as an amount, and that must never reach a table or a log. */
export const BAD_AMOUNT = 'rq-bad-amount-2718';

export const REASON = 'ORDER_ROW_INVALID';

/** A whole page of at least this many bad rows stops the window (D10-570 ⑥). */
export const WHOLE_PAGE_BAD = 5;

/** Overrides of a finished order (17): the mapper reads actualFee and actualCosPrice. */
export const FINISHED = {
  validCode: num('17'),
  actualFee: num('1.23'),
  actualCosPrice: num('45.60'),
  finishTime: '2026-10-14 09:00:00',
};

/** The attr_code of `member()`: eight of [0-9a-z], as jd's subUnionId carries it (BR-ATTR-06). */
const MEMBER_CODE = 'rqmember';

/** One upstream page: its rows and its archive row id. */
export interface UpstreamPage {
  readonly id: string;
  readonly rows: readonly unknown[];
}

/** 'outage': the upstream fails on this page. */
export type ScriptedPage = UpstreamPage | 'outage';

const WORKER_NOW = '2026-10-14T16:00:00.000Z';
const FIRST_WINDOW_MS = Date.parse('2026-10-14T01:00:00.000Z');
const HOUR_MS = 3_600_000;

interface Bounds {
  readonly window_start: string;
  readonly window_end: string;
}

/** Hour `index` of the fixture: inside jd's one-hour cap and its 90 days. */
export function boundsOf(index: number): Bounds {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const start = FIRST_WINDOW_MS + index * HOUR_MS;
  return { window_start: iso(start), window_end: iso(start + HOUR_MS) };
}

/** A 19-digit jd sub-order id of its own: order_keys is global across apps. */
export function decimalId(): string {
  return `${1_000_000_000_000_000_000n + BigInt(`0x${randomBytes(7).toString('hex')}`)}`;
}

let slotSequence = 0;

export type World = Awaited<ReturnType<typeof worldOf>>;

/**
 * One app with a jd account and its promotion slot, in a worker of its own. `watched` is the handle
 * the worker writes through (sabotage below); the fixture itself always writes through `db`.
 */
export async function worldOf(db: Kysely<DB>, watched: Kysely<DB> = db) {
  const acc = await account(db, {
    app_id: `quarantine-${randomUUID()}`,
    platform: 'jd',
    status: 'active',
  });
  slotSequence += 1;
  const slot = String(3_100_000_000 + slotSequence);
  await pid(db, acc, { pid: slot });
  const f = await contextOf('worker', true, watched);
  const r = await runtime(f.context);
  const handle = f.queue.register.mock.calls.find(([name]) => name === 'order-sync')?.[1];
  expect(typeof handle, 'order-sync handler registered by the worker').toBe('function');
  const clock = f.context.get(f.platform.CLOCK) as FixedClock;
  clock.set(WORKER_NOW);

  let script: readonly ScriptedPage[] = [];
  const { adapter } = wire(
    (body) => {
      const index = Number(body.pageIndex) - 1;
      const page = script[index];
      if (page === 'outage') throw new Error('synthetic upstream outage');
      return reply(inner(page?.rows ?? [], index + 1 < script.length), page?.id);
    },
    { clock },
  );
  vi.spyOn(r.registry, 'get').mockReturnValue(adapter);
  expect(typeof r.access.queryableAccount).toBe('function');
  vi.spyOn(r.access, 'queryableAccount').mockResolvedValue(acc.id);
  const advance = vi.spyOn(r.cursors, 'advance');

  const app = acc.app_id;
  const stream = { app_id: app, platform: 'jd' as const, union_account_id: acc.id };
  let adminId: string | undefined;
  let jobSequence = 0;

  /** The admin a manual request needs (order_sync_requests.requested_by has a foreign key). */
  async function requester(): Promise<string> {
    if (adminId !== undefined) return adminId;
    const id = randomUUID();
    await db
      .insertInto('admin_users')
      .values({
        id,
        app_id: app,
        login_name: `quarantine_${id}`,
        password_hash: 'synthetic-unused',
        is_super: false,
        status: 'active',
        created_at: clock.now(),
        updated_at: clock.now(),
      })
      .execute();
    adminId = id;
    return id;
  }

  /** What the console's dispatch leaves: one request, one queued job row. */
  async function manualRequest(bounds: Bounds): Promise<string> {
    const id = randomUUID();
    const now = clock.now();
    await db
      .insertInto('order_sync_requests')
      .values({
        id,
        app_id: app,
        platform: 'jd',
        mode: 'window',
        from: bounds.window_start,
        to: bounds.window_end,
        status_filter: null,
        order_nos: null,
        filter_digest: createHash('sha256').update(id).digest('hex'),
        status: 'queued',
        requested_by: await requester(),
        fetched_count: 0,
        stored_count: 0,
        error: null,
        finished_at: null,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('order_sync_request_windows')
      .values({
        app_id: app,
        sync_id: id,
        seq: 0,
        union_account_id: acc.id,
        ...bounds,
        status: 'queued',
        fetched_count: 0,
        stored_count: 0,
        error: null,
        finished_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  async function jobOf(route: Route, bounds: Bounds, attempt: number): Promise<ReceivedJob> {
    jobSequence += 1;
    const id = `quarantine-job-${jobSequence}`;
    const base = { ...stream, scene: '-', ...bounds };
    const queue = 'order-sync';
    if (route === 'increment') {
      const payload: JobPayload = { ...base, query_kind: 'increment' };
      return { id, queue, name: 'window', payload, attempt };
    }
    if (route === 'rescan') {
      const payload: JobPayload = { ...base, query_kind: 'rescan' };
      return { id, queue, name: 'rescan.window', payload, attempt };
    }
    const payload: JobPayload = {
      ...base,
      query_kind: 'increment',
      sync_id: await manualRequest(bounds),
      sync_seq: 0,
    };
    return { id, queue, name: 'manual_window', payload, attempt };
  }

  const pending = () =>
    db
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', app)
      .orderBy('id')
      .execute();
  const orders = () =>
    db.selectFrom('orders').selectAll().where('app_id', '=', app).orderBy('sub_order_id').execute();

  return {
    app,
    accountId: acc.id,
    clock,
    advance,
    /** Upstream serves `pages`, then the worker's handler takes one job of hour `window`. */
    async run(
      route: Route,
      pages: readonly ScriptedPage[],
      options: { readonly window?: number; readonly attempt?: number } = {},
    ) {
      script = pages;
      const job = await jobOf(route, boundsOf(options.window ?? 0), options.attempt ?? 1);
      return capture(() => handle!(job));
    },
    /**
     * A member with a level and a published rule version: a good row carrying `attribution` gets
     * the worker's real commission snapshot. Without it a row stays unattributed and no row of any
     * kind gets a snapshot, so "no snapshot" proves nothing.
     */
    async member() {
      const owner = await user(db, app, { level: 'L1', attr_code: MEMBER_CODE });
      await level(db, app, owner.id, 'L1', BEFORE);
      await seedVersion(db, app, version());
      return { userId: owner.id, attribution: { subUnionId: `n_${MEMBER_CODE}` } };
    },
    /** A row the jd mapper accepts, on this app's promotion slot. */
    good(id: string, overrides: Record<string, unknown> = {}) {
      return row({
        id,
        positionId: num(slot),
        orderTime: '2026-10-14 08:00:01',
        modifyTime: '2026-10-14 08:30:02',
        ...overrides,
      });
    },
    /** A row the jd mapper refuses: the amount it must read is not a number. */
    bad(id: string, overrides: Record<string, unknown> = {}) {
      return row({
        id,
        positionId: num(slot),
        orderTime: '2026-10-14 08:00:01',
        modifyTime: '2026-10-14 08:30:02',
        estimateFee: BAD_AMOUNT,
        ...overrides,
      });
    },
    /** A bad row with no sub-order number at all. */
    nameless(overrides: Record<string, unknown> = {}) {
      return row({ id: undefined, positionId: num(slot), estimateFee: BAD_AMOUNT, ...overrides });
    },
    pending,
    orders,
    /** The sub-order ids that have an orders row, sorted. */
    async subOrders() {
      return (await orders()).map((order) => order.sub_order_id);
    },
    keys: () => db.selectFrom('order_keys').selectAll().where('app_id', '=', app).execute(),
    history: () =>
      db
        .selectFrom('order_status_history')
        .selectAll()
        .where('app_id', '=', app)
        .orderBy('id')
        .execute(),
    splits: () =>
      db.selectFrom('commission_splits').selectAll().where('app_id', '=', app).execute(),
    requests: () =>
      db.selectFrom('order_sync_requests').selectAll().where('app_id', '=', app).execute(),
    /** The stream's cursor, null without a row. */
    cursor: (kind: 'increment' | 'rescan') =>
      r.cursors.read({ ...stream, query_kind: kind, scene: '-' }),
    /** Every log line of the quarantine alert. */
    alerts() {
      return (f.lines() as unknown as Record<string, unknown>[]).filter(
        (line) => line['alert'] === 'P1' && line['event'] === 'order_row_invalid',
      );
    },
    close: () => f.context.close(),
  };
}

export async function withWorld(
  db: Kysely<DB>,
  body: (w: World) => Promise<void>,
  watched: Kysely<DB> = db,
): Promise<void> {
  const w = await worldOf(db, watched);
  try {
    await body(w);
  } finally {
    await w.close();
  }
}

/** The open row of one quarantined bad row. */
export function quarantined(
  w: Pick<World, 'app'>,
  subOrderId: string,
  payloadId: bigint,
  patch: Record<string, unknown> = {},
) {
  return expect.objectContaining({
    app_id: w.app,
    platform: 'jd',
    sub_order_id: subOrderId,
    reason: REASON,
    raw_payload_id: payloadId,
    detail: expect.stringContaining('estimateFee'),
    status: 'open',
    ...patch,
  });
}

export const PENDING_INSERT = /insert\s+into\s+("?app"?\.)?"?order_sync_pending\b/i;
export const PENDING_UPDATE = /update\s+("?app"?\.)?"?order_sync_pending\b/i;

/**
 * A handle whose statements matching `statement` fail while `state.armed`. The statement is found
 * in its compiled text, so it does not matter whether the writer used the query builder or raw
 * SQL. `state.hits` says it was really reached: a job can fail for plenty of other reasons.
 */
export function sabotage(db: Kysely<DB>, statement: RegExp) {
  const state = { armed: false, hits: 0 };
  const broken = db.withPlugin({
    transformQuery(args) {
      if (state.armed) {
        const compiled = new PostgresQueryCompiler().compileQuery(args.node, args.queryId);
        if (statement.test(compiled.sql)) {
          state.hits += 1;
          throw new Error('synthetic write failure');
        }
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  return { db: broken, state };
}
