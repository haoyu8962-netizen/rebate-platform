import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';

import {
  createDailyBudget,
  type BudgetAlert,
  type BudgetReservation,
  type BudgetSettlement,
} from '../../../../apps/api/src/modules/agent/budget/index.ts';

export const DAY = '2026-10-06';
export const NEXT_DAY = '2026-10-07';
const BEFORE_MIDNIGHT = '2026-10-06T23:59:50+08:00';
const AFTER_MIDNIGHT = '2026-10-07T00:00:10+08:00';

export async function dayRow(db: Kysely<DB>, day: string = DAY) {
  const result = await sql<{
    actual_mfen: bigint;
    reserved_mfen: bigint;
    alert_80_at: Date | null;
    alert_100_at: Date | null;
  }>`SELECT actual_mfen, reserved_mfen, alert_80_at, alert_100_at
    FROM app.agent_budget_days WHERE day = ${day}::date`.execute(db);
  return result.rows[0];
}

export async function reservationRow(db: Kysely<DB>, runId: string) {
  const result = await sql<{
    day: string;
    reserved_mfen: bigint;
    price_version: string | null;
    settled_at: Date | null;
  }>`SELECT day::text AS day, reserved_mfen, price_version, settled_at
    FROM app.agent_budget_reservations WHERE run_id = ${runId}::uuid`.execute(db);
  return result.rows[0];
}

export function booking(db: Kysely<DB>) {
  let now = BEFORE_MIDNIGHT;
  const onAlert = vi.fn<(kind: BudgetAlert) => void>();
  const budget = createDailyBudget({ clock: { now: () => new Date(now) }, onAlert });
  return {
    onAlert,
    nextDay() {
      now = AFTER_MIDNIGHT;
    },
    async reserve(overrides: Partial<BudgetReservation> = {}) {
      const input: BudgetReservation = {
        runId: randomUUID(),
        acceptedAt: new Date(now),
        budgetMfen: 100_000n,
        reserveMfen: 5_000n,
        priceVersion: 'synthetic-v1',
        ...overrides,
      };
      const status = await db.transaction().execute((tx) => budget.reserve(tx, input));
      return { runId: input.runId, ...status };
    },
    settle(input: BudgetSettlement) {
      return db.transaction().execute((tx) => budget.settle(tx, input));
    },
  };
}
