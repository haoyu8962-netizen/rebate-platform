// B2-04zg rule-test kit (claude-independent, SPEC_REF 8127341): the catch-up of the monthly bill
// (D10-476; 08 BR-FUND-04 ③, BR-FUND-18). Builds on the B2-04ze kit (../worker/kit.ts, imported
// only). Conventions fixed by these tests (task brief §1 / §9):
// - the catch-up looks back at the latest bill day D* on or before the +08:00 day of the Clock
//   (settle.bill_day of the app, unset = 24) and only at it (earlier periods are not looked at);
// - it sends D*'s `bill` job with the daily seed's payload and singletonKey
//   (bill:<app_id>:<platform>:<D*>), outside a transaction, for every app × platform whose bill
//   month M (the month before D*) is not generated and has no live job;
// - "generated" comes from settle_jobs (done row of (bill, platform, D* 00:00 +08:00)) or
//   settle_bills (M with the platform in platform_order_counts), "live" from pgboss.job; a
//   completed job alone is not generated (deferred completes the delivery);
// - a deferred bill (asset snapshot not complete) completes the delivery: no queue retry is used.
// Real pieces where a test says so: PostgreSQL (couli_app) of @couli/db/testing handed in by the
// int tests, pg-boss on the test database (the api runtime of ../worker/kit.ts, or the production
// worker runtime here), the assembled settle handler of SettlementModule.forWorker. Synthetic: the
// other modules' ports, the fake queue and store, every row (low-entropy strings, no user data).
import { setTimeout as sleep } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { JobHandler, QueueRuntime } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  SettleBillCatchUpState,
  SettleCatchUpStore,
  SettlementConfigReader,
  SettlementWorkerPorts,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  BILL,
  QUEUE,
  billKey,
  failToDead,
  fakePorts,
  isTransaction,
  liveJobsUnder,
  messages,
  receivedJob,
  settleJobsOf,
  transition,
  type FakeQueue,
  type PortCalls,
  type PortState,
  type SentJob,
} from '../worker/kit.ts';

/** The day after the bill day 2032-07-24 (the bill day was missed). */
export const DAY_AFTER = '2032-07-25';
/** DAY_AFTER 10:00 +08:00. */
export const DAY_AFTER_NOW = '2032-07-25T02:00:00.000Z';
/** The bill day before 2032-07-24 and its bill month. */
export const PREV_BILL_DAY = '2032-06-24';
export const PREV_BILL_MONTH = '2032-05';
/** PREV_BILL_DAY 00:00 +08:00. */
export const PREV_BILL_DAY_START = '2032-06-23T16:00:00.000Z';
/** The next bill day after 2032-07-24 and its bill month. */
export const NEXT_BILL_DAY = '2032-08-24';
export const NEXT_BILL_MONTH = '2032-07';

/** Upper bound of a catch-up send's delay: it is sent again within minutes, not left for days. */
export const MAX_CATCH_UP_DELAY_SECONDS = 600;

// ---------------------------------------------------------------------------------------------
// Sends.

/** A send without its transaction handle and delay. */
export function plainView(job: SentJob) {
  return {
    queue: job.queue,
    name: job.name,
    payload: job.payload,
    singletonKey: job.options.singletonKey,
  };
}

/** The `bill` send of (app, platform, D) as plainView shows it. */
export function plainBillSend(appId: string, platform: string, day: string) {
  return {
    queue: QUEUE,
    name: BILL,
    payload: { app_id: appId, platform, accounting_date: day },
    singletonKey: billKey(appId, platform, day),
  };
}

/** Every send is outside a transaction, at once or within MAX_CATCH_UP_DELAY_SECONDS. */
export function sendShapes(sent: readonly SentJob[]) {
  return sent.map((job) => ({
    trx: job.options.trx,
    inTransaction: job.inTransaction,
    delayInRange:
      (job.options.delaySeconds ?? 0) >= 0 &&
      (job.options.delaySeconds ?? 0) <= MAX_CATCH_UP_DELAY_SECONDS,
  }));
}

export function outsideAndSoon(count: number) {
  return Array.from({ length: count }, () => ({
    trx: null,
    inTransaction: false,
    delayInRange: true,
  }));
}

// ---------------------------------------------------------------------------------------------
// Synthetic store and configuration.

export interface FakeCatchUpStore extends SettleCatchUpStore {
  /** billKey(app, platform, D) → state; a missing key is 'absent'. */
  readonly states: Map<string, SettleBillCatchUpState>;
  /** billKey(app, platform, D) of every read, in order. */
  readonly reads: string[];
}

export function fakeCatchUpStore(): FakeCatchUpStore {
  const states = new Map<string, SettleBillCatchUpState>();
  const reads: string[] = [];
  return {
    states,
    reads,
    async billCatchUpStateOf(appId, platform, day) {
      const key = billKey(appId, platform, day);
      reads.push(key);
      return states.get(key) ?? 'absent';
    },
  };
}

/** content's reader over `${app_id}|${key}` → value; a missing entry is unset (undefined). */
export function fakeConfig(values: ReadonlyMap<string, unknown>): SettlementConfigReader {
  return {
    async get(appId, key) {
      return values.get(`${appId}|${key}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Outcomes.

export type Outcome = { readonly resolved: true } | { readonly rejected: string };

/** How `run` settled (a rejection's messages, chained causes included). */
export async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  return Promise.resolve()
    .then(run)
    .then(
      (): Outcome => ({ resolved: true }),
      (error: unknown): Outcome => ({ rejected: messages(error) }),
    );
}

// ---------------------------------------------------------------------------------------------
// The database.

export interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

/** A fresh database; `db` (`max` connections) and `observer` (2) as couli_app. */
export async function withPools(
  create: () => Promise<TestDatabase>,
  max: number,
  run: (db: Kysely<DB>, observer: Kysely<DB>) => Promise<void>,
): Promise<void> {
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  try {
    await run(db, observer);
  } finally {
    await Promise.all([destroyDb(db), destroyDb(observer)]);
    await database.drop();
  }
}

/** settle_jobs of the app as plain values (run_at in ISO form). */
export async function billRunsOf(db: Kysely<DB>, appId: string) {
  const rows = await settleJobsOf(db, appId);
  return rows
    .filter((row) => row.job === 'bill')
    .map((row) => ({
      job: row.job,
      platform: row.platform,
      run_at: row.run_at.toISOString(),
      status: row.status,
    }));
}

/** settle_bills of the app (generated_at in ISO form or null). */
export async function billsOf(db: Kysely<DB>, appId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('settle_bills')
    .select(['bill_id', 'generated_at', 'platform_order_counts'])
    .where('app_id', '=', appId)
    .orderBy('bill_id')
    .execute();
  return rows.map((row) => ({
    billId: row.bill_id,
    generatedAt: row.generated_at === null ? null : row.generated_at.toISOString(),
    counts: row.platform_order_counts as unknown,
  }));
}

/** What CouliSettleBillJobFailed counts: settle_jobs rows of job bill in status failed. */
export async function failedBillRunCount(db: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.settle_jobs WHERE job = 'bill' AND status = 'failed'
  `.execute(db);
  return rows[0]?.n ?? Number.NaN;
}

/** A settle_bills row of (app, M) generated at `at` with the given platform counts. */
export async function seedGeneratedBill(
  db: Kysely<DB>,
  appId: string,
  billId: string,
  counts: Readonly<Record<string, number>>,
  at: string,
): Promise<void> {
  const totals = Object.fromEntries(Object.keys(counts).map((platform) => [platform, '0']));
  await sql`
    INSERT INTO app.settle_bills (app_id, bill_id, generation_started_at, generated_at,
      platform_order_counts, platform_settle_commission_totals, beneficiary_total_fen,
      platform_retained_fen, error_count, held_count, created_at)
    VALUES (${appId}, ${billId}, ${new Date(at)}, ${new Date(at)},
      ${JSON.stringify(counts)}::jsonb, ${JSON.stringify(totals)}::jsonb, 0, 0, 0, 0, ${new Date(at)})
  `.execute(db);
}

export interface BillJobRow {
  readonly id: string;
  readonly singletonKey: string | null;
  readonly state: string;
  readonly retryCount: number;
}

/** Every `bill` job of (app, platform, D) on `queueName` under any key, oldest first. */
export async function billJobsFor(
  db: Kysely<DB>,
  appId: string,
  platform: string,
  day: string,
  queueName: string,
): Promise<BillJobRow[]> {
  const { rows } = await sql<{
    id: string;
    singleton_key: string | null;
    state: string;
    retry_count: number;
  }>`
    SELECT id::text AS id, singleton_key, state::text AS state, retry_count
    FROM pgboss.job
    WHERE name = ${queueName} AND data->>'name' = ${BILL}
      AND data->'payload'->>'app_id' = ${appId}
      AND data->'payload'->>'platform' = ${platform}
      AND data->'payload'->>'accounting_date' = ${day}
    ORDER BY created_on, id
  `.execute(db);
  return rows.map((row) => ({
    id: row.id,
    singletonKey: row.singleton_key,
    state: row.state,
    retryCount: Number(row.retry_count),
  }));
}

/** Time passes for the delayed jobs of the app on queue settle: they are due now. */
export async function makeDue(db: Kysely<DB>, appId: string): Promise<void> {
  await sql`
    UPDATE pgboss.job SET start_after = now()
    WHERE name = ${QUEUE} AND state IN ('created', 'retry') AND start_after > now()
      AND data->'payload'->>'app_id' = ${appId}
  `.execute(db);
}

/** Polls `check` every 250 ms until it holds or `attempts` polls have failed; never rejects. */
export async function until(check: () => Promise<boolean>, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check().catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * What a worker does with the one live job under `key`: takes it (active), runs `handler` on its
 * payload, completes it when the handler resolves, or fails it for good (settle.dead) when it
 * rejects. Returns the job's payload and the handler's outcome; null when no job is live.
 */
export async function deliver(
  db: Kysely<DB>,
  handler: JobHandler,
  key: string,
): Promise<{ readonly payload: unknown; readonly outcome: Outcome } | null> {
  const live = await liveJobsUnder(db, key);
  const job = live[0];
  if (live.length !== 1 || job === undefined || job.payload === null) return null;
  await transition(db, job.id, 'active');
  const payload = job.payload;
  const outcome = await outcomeOf(() => handler(receivedJob(BILL, payload)));
  if ('resolved' in outcome) await transition(db, job.id, 'completed');
  else await failToDead(db, job.id);
  return { payload, outcome };
}

// ---------------------------------------------------------------------------------------------
// Ports and queues.

export interface PortSwitches {
  /** When true, the union read of the bill source throws (the bill run fails). */
  failUnion: boolean;
  /** accountingDate of every asset snapshot status read, in order. */
  readonly snapshotDays: string[];
}

/** kit.ts's synthetic ports, recording the snapshot days asked for and able to fail the bill. */
export function recordingPorts(state: PortState): {
  ports: SettlementWorkerPorts;
  calls: PortCalls;
  switches: PortSwitches;
} {
  const { ports, calls } = fakePorts(state);
  const switches: PortSwitches = { failUnion: false, snapshotDays: [] };
  const wrapped: SettlementWorkerPorts = {
    ...ports,
    snapshotStatus: async (db, input, clock) => {
      switches.snapshotDays.push(input.accountingDate);
      return ports.snapshotStatus(db, input, clock);
    },
    readUnionAuthoritative: async (db, selection) => {
      if (switches.failUnion) throw new Error('synthetic union read failure');
      return ports.readUnionAuthoritative(db, selection);
    },
  };
  return { ports: wrapped, calls, switches };
}

/**
 * A started-later production queue runtime behind the FakeQueue shape: sends are recorded and
 * forwarded; register records and registers on the runtime (before its start).
 */
export function runtimeQueue(runtime: QueueRuntime): FakeQueue {
  const sent: SentJob[] = [];
  const failing = new Set<string>();
  const registered: FakeQueue['registered'][number][] = [];
  return {
    sent,
    failing,
    registered,
    async send(queueName, name, payload, options) {
      const id = await runtime.send(queueName, name, payload, options);
      sent.push({
        queue: queueName,
        name,
        payload,
        options,
        inTransaction: isTransaction(options.trx),
      });
      return id;
    },
    register(queueName, handler) {
      registered.push({ queue: queueName, handler });
      runtime.register(queueName, handler);
    },
    start: () => runtime.start(),
    stop: () => runtime.stop(),
  };
}
