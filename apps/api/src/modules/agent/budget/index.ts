import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import type { Clock } from '../../platform/index.ts';

export interface BudgetConfigInput {
  dailyBudgetFen: unknown;
  reserveMfenPerRun: unknown;
}

export interface BudgetConfig {
  budgetMfen: bigint;
  reserveMfen: bigint;
  invalid: readonly ('daily_budget_fen' | 'reserve_mfen_per_run')[];
}

export interface ModelPrice {
  inMfenPerM: bigint;
  outMfenPerM: bigint;
  version: string;
}

export interface ModelPrices {
  priceOf(modelId: string): ModelPrice | undefined;
}

export interface CallAllowanceInput {
  reserveMfen: bigint;
  spentMfen: bigint;
  requestBytes: number;
  inMfenPerM: bigint;
  outMfenPerM: bigint;
  configuredMaxTokens?: number;
}

export interface CallAllowance {
  maxTokens: number;
  worstMfen: bigint;
}

export type BudgetAlert = 'budget_80' | 'budget_100' | 'budget_price_missing';

export interface DailyBudgetDeps {
  clock: Clock;
  logger?: { warn(obj: object, msg: string): void };
  onAlert?: (kind: BudgetAlert) => void;
}

export interface BudgetReservation {
  runId: string;
  acceptedAt: Date;
  budgetMfen: bigint;
  reserveMfen: bigint;
  priceVersion: string | null;
}

export interface BudgetSettlement {
  runId: string;
  budgetMfen?: bigint;
  live: { spentMfen: bigint; calls: number } | null;
}

export interface DailyBudget {
  reserve(q: Kysely<DB>, reservation: BudgetReservation): Promise<{ exhausted: boolean }>;
  settle(
    q: Kysely<DB>,
    settlement: BudgetSettlement,
  ): Promise<{ costMfen: bigint | null; priceVersion: string | null; settled: boolean }>;
}

export function parseBudgetConfig(raw: BudgetConfigInput): BudgetConfig {
  void raw;
  throw new Error('NotImplemented: parseBudgetConfig');
}

export function parseModelPrices(raw: unknown): ModelPrices {
  void raw;
  throw new Error('NotImplemented: parseModelPrices');
}

export function callAllowance(input: CallAllowanceInput): CallAllowance | null {
  void input;
  throw new Error('NotImplemented: callAllowance');
}

export function createDailyBudget(deps: DailyBudgetDeps): DailyBudget {
  void deps;
  throw new Error('NotImplemented: createDailyBudget');
}
