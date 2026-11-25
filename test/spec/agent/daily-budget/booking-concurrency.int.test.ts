import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { createDailyBudget } from '../../../../apps/api/src/modules/agent/budget/index.ts';
import { until, usePgEach } from '../stream-recovery/kit.ts';
import { booking, DAY, dayRow, reservationRow } from './pg-kit.ts';

const pg = usePgEach(createTestDatabase);
const ACCEPTED_AT = `${DAY}T23:59:50+08:00`;
const orders = [
  { first: 'A', second: 'B' },
  { first: 'B', second: 'A' },
] as const;

function budgetWorkers() {
  const clock = { now: () => new Date(ACCEPTED_AT) };
  return {
    A: { db: pg.db, budget: createDailyBudget({ clock }) },
    B: { db: pg.pool(), budget: createDailyBudget({ clock }) },
  };
}

async function backendPid(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
  return result.rows[0]!.pid;
}

interface Attempt<Result> {
  db: Kysely<DB>;
  run(tx: Kysely<DB>): Promise<Result>;
}

async function overlap<Result>(
  first: Attempt<Result>,
  second: Attempt<Result>,
): Promise<[Result, Result]> {
  const pending: { second?: Promise<Result> } = {};
  try {
    const outcomes = await first.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (tx) => {
        const firstPid = await backendPid(tx);
        const firstResult = await first.run(tx);
        let secondPid: number | undefined;
        let returned = false;
        const secondResult = second.db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (otherTx) => {
            secondPid = await backendPid(otherTx);
            return second.run(otherTx);
          });
        pending.second = secondResult;
        const markReturned = () => {
          returned = true;
        };
        void secondResult.then(markReturned, markReturned);

        // Keep the first write uncommitted until the second either waits for it or returns.
        await until('the second transaction waits for the first or returns', async () => {
          if (returned) return true;
          if (secondPid === undefined) return false;
          const result = await sql<{ blocked: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_locks
            WHERE pid = ${secondPid}::int AND NOT granted
              AND ${firstPid}::int = ANY(pg_catalog.pg_blocking_pids(pid))
          ) AS blocked`.execute(first.db);
          return result.rows[0]?.blocked === true;
        });
        return { firstResult, secondResult };
      });
    return [outcomes.firstResult, await outcomes.secondResult];
  } finally {
    // If polling fails, let the first transaction roll back before draining the second.
    await pending.second?.catch(() => {});
  }
}

it.each(orders)(
  '[AC-B3-09m#40] $first 先于 $second 预占且尚未提交时，只有先受理的 run 能跨过上限',
  async ({ first, second }) => {
    const { exhausted } = await booking(pg.db).reserve({ budgetMfen: 1_000n, reserveMfen: 700n });
    expect(exhausted).toBe(false);

    const workers = budgetWorkers();
    const shared = {
      acceptedAt: new Date(ACCEPTED_AT),
      budgetMfen: 1_000n,
      reserveMfen: 400n,
      priceVersion: 'synthetic-v1',
    };
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const [admitted, blocked] = await overlap(
      {
        db: workers[first].db,
        run: (tx) => workers[first].budget.reserve(tx, { ...shared, runId: firstRunId }),
      },
      {
        db: workers[second].db,
        run: (tx) => workers[second].budget.reserve(tx, { ...shared, runId: secondRunId }),
      },
    );

    expect(admitted).toMatchObject({ exhausted: false });
    expect(blocked).toMatchObject({ exhausted: true });
    expect(await reservationRow(pg.db, firstRunId)).toMatchObject({ reserved_mfen: 400n });
    expect(await reservationRow(pg.db, secondRunId)).toBeUndefined();
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 0n, reserved_mfen: 1_100n });
  },
  60_000,
);

it.each(orders)(
  '[AC-B3-09m#41] $first 先于 $second 接手同一 run 且尚未提交时，只按预占结清一次',
  async ({ first, second }) => {
    const { runId } = await booking(pg.db).reserve();
    const workers = budgetWorkers();
    const input = { runId, live: null };
    const [settled, repeated] = await overlap(
      { db: workers[first].db, run: (tx) => workers[first].budget.settle(tx, input) },
      { db: workers[second].db, run: (tx) => workers[second].budget.settle(tx, input) },
    );

    expect(settled).toMatchObject({
      costMfen: 5_000n,
      priceVersion: 'synthetic-v1',
      settled: true,
    });
    expect(repeated).toMatchObject({ settled: false });
    expect(await reservationRow(pg.db, runId)).toMatchObject({ settled_at: expect.any(Date) });
    expect(await dayRow(pg.db)).toMatchObject({ actual_mfen: 5_000n, reserved_mfen: 0n });
  },
  60_000,
);
