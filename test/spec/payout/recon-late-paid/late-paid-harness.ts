// B2-09t / BR-WDR-23、16 / D10-628②、D10-632. Real PG, queue and recon handler;
// bills enter only through FakeChannel + runDay. No W10 or production adapters.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import { fixture, type ReviewFixture } from '../admin-manual-paid/manual-paid-harness.ts';
import {
  BILL_DATE,
  books,
  close,
  diffsOf,
  expectDiff,
  expectReconHold,
  holdsOf,
  open,
  setup,
  type Harness,
  type ReconFixture,
  type Seeded,
} from '../recon-channel/kit.ts';

interface Testing {
  createTestDatabase(): Promise<Harness['database']>;
  acquireTestRedis(): Promise<{ url: string; stop(): Promise<void> }>;
}

export function suite(redis = false) {
  let h: Harness;
  let server: Awaited<ReturnType<Testing['acquireTestRedis']>> | undefined;
  beforeAll(async () => {
    const testing = (await import(
      new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
    )) as Testing;
    h = await open(testing.createTestDatabase);
    if (redis) server = await testing.acquireTestRedis();
  }, 180_000);
  afterAll(async () => {
    try {
      await close(h);
    } finally {
      await server?.stop();
    }
  }, 60_000);
  return {
    h: () => h,
    setup: () => setup(h),
    admin(f: ReconFixture): ReviewFixture {
      const s = {
        db: () => h.db,
        holder: () => h.observer,
        payout: () => h.payout,
        redisUrl: () => {
          expect(server).toBeDefined();
          return server!.url;
        },
      };
      const admin = fixture(s);
      f.clock.set(admin.clock.now());
      return { ...admin, appId: f.appId };
    },
  };
}

export function lateJob(f: ReconFixture, id: string, round = 0): ReceivedJob {
  return {
    id: randomUUID(),
    queue: 'payout-recon',
    name: 'late_paid_check',
    payload: { app_id: f.appId, withdrawal_id: id, round },
    attempt: 1,
  };
}

/** Acceptance includes dispatch: a valid late-paid job must not be silently discarded. */
export async function runLate(f: ReconFixture, id: string, round = 0, job = lateJob(f, id, round)) {
  const before = f.logger.warn.mock.calls.length;
  const untouched = await readOnlyState(f);
  await expect(f.reconJob()(job)).resolves.toBeUndefined();
  expect(f.logger.warn.mock.calls.slice(before).map((call) => call[1])).not.toContain(
    'payout_recon_bad_payload',
  );
  expect(await readOnlyState(f)).toEqual(untouched);
}

export async function jobs(f: ReconFixture) {
  return (
    await sql<{
      id: string;
      name: string;
      data: { name: string; payload: ReceivedJob['payload'] };
      start_after: Date;
      created_on: Date;
    }>`SELECT id::text, name, data, start_after, created_on FROM pgboss.job
    WHERE data->'payload'->>'app_id' = ${f.appId} ORDER BY name, id`.execute(f.h.observer)
  ).rows;
}

export async function lateJobs(f: ReconFixture) {
  return (await jobs(f)).filter(
    (j) => j.name === 'payout-recon' && j.data.name === 'late_paid_check',
  );
}

export async function expectQueued(f: ReconFixture, id: string) {
  const found = (await lateJobs(f)).filter((j) => j.data.payload['withdrawal_id'] === id);
  expect(found).toHaveLength(1);
  expect(found[0]!.data).toEqual({
    name: 'late_paid_check',
    payload: {
      app_id: f.appId,
      withdrawal_id: id,
      round: 0,
    },
  });
  expect(found[0]!.start_after.getTime()).toBeLessThanOrEqual(
    found[0]!.created_on.getTime() + 1000,
  );
  return found[0]!;
}

export async function stored(f: ReconFixture) {
  const rows = await sql`SELECT * FROM app.recon_channel WHERE app_id = ${f.appId}
    ORDER BY id`.execute(f.h.observer);
  const runs = await sql`SELECT * FROM app.payout_recon_runs WHERE app_id = ${f.appId}
    ORDER BY id`.execute(f.h.observer);
  return { rows: rows.rows, runs: runs.rows };
}

/** Every branch is read-only except recon diffs, holds, and its own delayed continuation. */
async function readOnlyState(f: ReconFixture) {
  return {
    stored: await stored(f),
    books: await books(f),
    channelCalls: [...f.fake.calls],
    otherJobs: (await jobs(f)).filter(
      (j) => !(j.name === 'payout-recon' && j.data.name === 'late_paid_check'),
    ),
  };
}

export async function expectMissing(f: ReconFixture, w: Seeded) {
  const found = await diffsOf(f, [w.id]);
  expect(found).toHaveLength(1);
  expectDiff(f, found[0], {
    refType: 'withdrawal',
    refIds: [w.id],
    expectedFen: w.net,
    actualFen: 0n,
    periods: [BILL_DATE],
  });
  expect(found[0]).toMatchObject({
    dedupe_key: `R2:alipay:missing:wd:${w.id}`,
    resolution: { case: 'paid_not_in_bill' },
  });
  await expectReconHold(f, w.userId, found[0]);
  return found[0]!;
}

export async function expectClean(f: ReconFixture, w: Seeded) {
  expect(await diffsOf(f, [w.id])).toEqual([]);
  expect(await holdsOf(f, w.userId)).toEqual([]);
}

export async function incomplete(f: ReconFixture, status: 'failed' | 'partial') {
  await sql`INSERT INTO app.payout_recon_runs
    (id, app_id, channel, bill_date, status, started_at, finished_at, bill_rows, matched, diffs)
    VALUES (${randomUUID()}, ${f.appId}, 'alipay', ${BILL_DATE}::date, ${status},
      ${f.clock.now()}, ${f.clock.now()}, 0, 0, 0)`.execute(f.h.db);
}

export async function expectRetry(f: ReconFixture, w: Seeded, from: number) {
  const start = f.clock.now().getTime();
  const sent = f.send.mock.calls.filter(
    (c) => c[0] === 'payout-recon' && c[1] === 'late_paid_check',
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]![2]).toEqual({ app_id: f.appId, withdrawal_id: w.id, round: from + 1 });
  expect(sent[0]![3].delaySeconds).toBe(3600);
  expect(start + sent[0]![3].delaySeconds! * 1000).toBe(start + 3_600_000);
  const queued = await lateJobs(f);
  expect(queued).toHaveLength(1);
  expect(queued[0]!.data.payload).toEqual(sent[0]![2]);
  // pg-boss schedules relative to PostgreSQL's clock, not the injected business clock.
  expect(
    Math.abs(queued[0]!.start_after.getTime() - queued[0]!.created_on.getTime() - 3_600_000),
  ).toBeLessThan(1000);
  await expectClean(f, w);
}

/** Uncommitted unique-key winner; pg_blocking_pids proves the worker reaches that conflict. */
export async function compete(f: ReconFixture, w: Seeded) {
  const untouched = await readOnlyState(f);
  const id = randomUUID();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let ready!: (pid: number) => void;
  const locked = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const owner = f.h.observer.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.recon_diffs
      (id, app_id, type, source, period, ref_type, ref_id, expected_fen, actual_fen,
       diff_fen, status, dedupe_key, resolution, created_at, updated_at)
      VALUES (${id}, ${f.appId}, 'channel_mismatch', 'R2', ${BILL_DATE}, 'withdrawal', ${w.id},
        ${w.net}, 0, ${w.net}, 'open', ${`R2:alipay:missing:wd:${w.id}`},
        '{"case":"paid_not_in_bill"}'::jsonb, ${f.clock.now()}, ${f.clock.now()})`.execute(trx);
    const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
    ready(pid.rows[0]!.pid);
    await gate;
  });
  const pid = await Promise.race([
    locked,
    owner.then(() => {
      throw new Error('holder ended early');
    }),
  ]);
  let settled = false;
  const task = f.reconJob()(lateJob(f, w.id));
  const result = task.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  let blocked = false;
  try {
    const deadline = performance.now() + 10_000;
    while (!settled && performance.now() < deadline) {
      const rows = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND ${pid} = ANY(pg_blocking_pids(pid))
      ) AS waiting`.execute(f.h.db);
      if (rows.rows[0]!.waiting) {
        blocked = true;
        break;
      }
    }
    expect(blocked, 'worker must wait for the uncommitted dedupe_key, proven by PostgreSQL').toBe(
      true,
    );
  } finally {
    unlock();
    await owner;
    await result;
  }
  await expect(task).resolves.toBeUndefined();
  const found = await diffsOf(f, [w.id]);
  expect(found.map((d) => d.id)).toEqual([id]);
  expect(await holdsOf(f, w.userId)).toEqual([]);
  expect(await readOnlyState(f)).toEqual(untouched);
}
