// B3-09m · BR-AI-16 (全局日预算与成本记账, 2026-11-25 负责人取「甲」; D10-2970 ⑦, D10-2975): the
// platform-wide daily model budget. Rule tests: test/spec/agent/daily-budget/**.
// - parseBudgetConfig / budgetConfigAcrossApps: agent.daily_budget_fen (fen, default 100,000) and
//   agent.budget.reserve_mfen_per_run (mfen, default 5,000); 0 kept as is; an invalid value takes
//   the default and is named in `invalid`. Across apps the budget is the smallest, the reservation
//   the largest (one daily total for the whole platform).
// - parseModelPrices: agent.models of ONE app ({<model>: {in_mfen_per_m, out_mfen_per_m,
//   version}}); an entry without positive integer prices and a non-empty version has no price
//   (fail-close: that model is never called).
// - callAllowance: 细则「一次调用最多可能花多少」「输出上限按剩余额度定」: W_in from the request's
//   UTF-8 bytes, Rem = R − U − W_in, M = min(M_cfg, floor(Rem × 1e6 / out)); Rem ≤ 0 or M < 256
//   → null (the call is not made).
// - createDailyBudget: the two bookings, both inside the caller's transaction:
//   reserve() (admission): day row INSERT … ON CONFLICT DO NOTHING, SELECT … FOR UPDATE, committed
//   actual + reserved ≥ budget (or R = 0) → exhausted, nothing reserved; else reserved += R and the
//   run's reservation row (admission day, R, price version).
//   settle() (the run's one finalization): UPDATE reservation SET settled_at WHERE settled_at IS
//   NULL RETURNING (at most once), then on the admission day reserved −= R, actual += cost; cost =
//   the live spend U (null without any call), or R when there is no live detail.
//   Both try to claim the day's 80% / 100% alert markers (conditional UPDATE … IS NULL); a claim
//   logs agent.budget_80 / agent.budget_100 (pino, best effort) and calls onAlert.
// All amounts are bigint mfen through @couli/money; the day is packages/domain's accountingDate
// (Asia/Shanghai) of the admission instant; times only from the injected Clock.
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { addFen, callCostMfen, mulDivCeil, subFen, tokensWithinMfen } from '@couli/money';
import { sql, type Kysely, type RawBuilder } from 'kysely';

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

/** The statement runner of an open transaction (the stream PG ports' Queries has this shape). */
export interface BudgetQueries {
  query<T>(statement: RawBuilder<T>): Promise<T[]>;
}

/** DailyBudget over a statement runner instead of a Kysely handle (same semantics). */
export interface DailyBudgetOn {
  reserve(q: BudgetQueries, reservation: BudgetReservation): Promise<{ exhausted: boolean }>;
  settle(
    q: BudgetQueries,
    settlement: BudgetSettlement,
  ): Promise<{ costMfen: bigint | null; priceVersion: string | null; settled: boolean }>;
}

const DEFAULT_BUDGET_FEN = 100_000n;
const DEFAULT_RESERVE_MFEN = 5_000n;
const MFEN_PER_FEN = 1_000n;
/** 细则: an output cap below this answers nothing useful; the call is not made (fixed for now). */
const MIN_OUTPUT_TOKENS = 256n;
const MAX_SAFE_TOKENS = BigInt(Number.MAX_SAFE_INTEGER);
const BP = 10_000n;
const ALERT_80_BP = 8_000n;

export const BUDGET_KEYS = Object.freeze({
  dailyBudgetFen: 'agent.daily_budget_fen',
  reserveMfenPerRun: 'agent.budget.reserve_mfen_per_run',
  models: 'agent.models',
});

const ALERT_EVENT: Readonly<Record<BudgetAlert, string>> = Object.freeze({
  budget_80: 'agent.budget_80',
  budget_100: 'agent.budget_100',
  budget_price_missing: 'agent.budget_price_missing',
});

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBudgetConfig(raw: BudgetConfigInput): BudgetConfig {
  const invalid: ('daily_budget_fen' | 'reserve_mfen_per_run')[] = [];
  let budgetFen = DEFAULT_BUDGET_FEN;
  if (nonNegativeInteger(raw.dailyBudgetFen)) budgetFen = BigInt(raw.dailyBudgetFen);
  else if (raw.dailyBudgetFen !== undefined) invalid.push('daily_budget_fen');
  let reserveMfen = DEFAULT_RESERVE_MFEN;
  if (nonNegativeInteger(raw.reserveMfenPerRun)) reserveMfen = BigInt(raw.reserveMfenPerRun);
  else if (raw.reserveMfenPerRun !== undefined) invalid.push('reserve_mfen_per_run');
  return { budgetMfen: budgetFen * MFEN_PER_FEN, reserveMfen, invalid };
}

/**
 * The platform-wide budget config (D10-2864 S1-1): each app's values parsed on their own (a
 * missing or invalid value takes the BR default, which takes part in the choice too), then the
 * smallest budget and the largest reservation. No app at all: the BR defaults.
 */
export function budgetConfigAcrossApps(
  budgets: readonly { readonly appId: string; readonly value: unknown }[],
  reserves: readonly { readonly appId: string; readonly value: unknown }[],
): BudgetConfig {
  const apps = new Set([...budgets, ...reserves].map((entry) => entry.appId));
  const budgetOf = new Map(budgets.map((entry) => [entry.appId, entry.value]));
  const reserveOf = new Map(reserves.map((entry) => [entry.appId, entry.value]));
  if (apps.size === 0)
    return parseBudgetConfig({ dailyBudgetFen: undefined, reserveMfenPerRun: undefined });
  let budgetMfen: bigint | undefined;
  let reserveMfen: bigint | undefined;
  const invalid = new Set<'daily_budget_fen' | 'reserve_mfen_per_run'>();
  for (const appId of [...apps].sort()) {
    const one = parseBudgetConfig({
      dailyBudgetFen: budgetOf.get(appId),
      reserveMfenPerRun: reserveOf.get(appId),
    });
    for (const key of one.invalid) invalid.add(key);
    if (budgetMfen === undefined || one.budgetMfen < budgetMfen) budgetMfen = one.budgetMfen;
    if (reserveMfen === undefined || one.reserveMfen > reserveMfen) reserveMfen = one.reserveMfen;
  }
  const order = ['daily_budget_fen', 'reserve_mfen_per_run'] as const;
  return {
    budgetMfen: budgetMfen!,
    reserveMfen: reserveMfen!,
    invalid: order.filter((key) => invalid.has(key)),
  };
}

export function parseModelPrices(raw: unknown): ModelPrices {
  const prices = new Map<string, ModelPrice>();
  if (isRecord(raw)) {
    for (const [modelId, entry] of Object.entries(raw)) {
      if (!isRecord(entry)) continue;
      const input = entry['in_mfen_per_m'];
      const output = entry['out_mfen_per_m'];
      const version = entry['version'];
      if (!positiveInteger(input) || !positiveInteger(output)) continue;
      if (typeof version !== 'string' || version.trim() === '') continue;
      prices.set(modelId, { inMfenPerM: BigInt(input), outMfenPerM: BigInt(output), version });
    }
  }
  return {
    priceOf(modelId) {
      const price = prices.get(modelId);
      return price === undefined ? undefined : { ...price };
    },
  };
}

export function callAllowance(input: CallAllowanceInput): CallAllowance | null {
  const { reserveMfen, spentMfen, requestBytes, inMfenPerM, outMfenPerM } = input;
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) return null;
  if (inMfenPerM <= 0n || outMfenPerM <= 0n) return null;
  const configured = input.configuredMaxTokens;
  if (configured !== undefined && (!Number.isSafeInteger(configured) || configured <= 0)) {
    return null;
  }
  const bytes = BigInt(requestBytes);
  const worstInput = callCostMfen(bytes, 0n, inMfenPerM, outMfenPerM);
  const rem = subFen(subFen(reserveMfen, spentMfen), worstInput);
  if (rem <= 0n) return null;
  let maxTokens = tokensWithinMfen(rem, outMfenPerM);
  if (configured !== undefined && BigInt(configured) < maxTokens) maxTokens = BigInt(configured);
  if (maxTokens > MAX_SAFE_TOKENS) maxTokens = MAX_SAFE_TOKENS;
  if (maxTokens < MIN_OUTPUT_TOKENS) return null;
  return {
    maxTokens: Number(maxTokens),
    worstMfen: callCostMfen(bytes, maxTokens, inMfenPerM, outMfenPerM),
  };
}

const alertCounts = new Map<BudgetAlert, number>();

/** Adds one to the process-local alert counter (the onAlert the runtime and PG ports pass). */
export function countBudgetAlert(kind: BudgetAlert): void {
  alertCounts.set(kind, (alertCounts.get(kind) ?? 0) + 1);
}

/** The process-local alert counter (one per process; read for metrics, never reset). */
export function budgetAlertCounts(): Readonly<Record<BudgetAlert, number>> {
  return {
    budget_80: alertCounts.get('budget_80') ?? 0,
    budget_100: alertCounts.get('budget_100') ?? 0,
    budget_price_missing: alertCounts.get('budget_price_missing') ?? 0,
  };
}

/**
 * One budget alert (best effort): a warn line whose message and `event` field are
 * agent.budget_80 / agent.budget_100 / agent.budget_price_missing, then onAlert (the runtime
 * passes countBudgetAlert). Never throws (a failing logger or hook does not change any booking).
 */
export function raiseBudgetAlert(
  deps: Pick<DailyBudgetDeps, 'logger' | 'onAlert'>,
  kind: BudgetAlert,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  try {
    deps.logger?.warn({ ...fields, event: ALERT_EVENT[kind] }, ALERT_EVENT[kind]);
  } catch {
    // Best effort.
  }
  try {
    deps.onAlert?.(kind);
  } catch {
    // Best effort.
  }
}

function toBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  throw new TypeError('agent budget: expected an integer column');
}

function kyselyQueries(db: Kysely<DB>): BudgetQueries {
  return { query: async (statement) => (await statement.execute(db)).rows };
}

/** DailyBudget over the caller's statement runner (both bookings in the caller's transaction). */
export function createDailyBudgetOn(deps: DailyBudgetDeps): DailyBudgetOn {
  /** Claims the day's markers the total has reached (best effort; a failed claim is logged). */
  async function claimAlerts(
    q: BudgetQueries,
    day: string,
    totalMfen: bigint,
    budgetMfen: bigint | undefined,
  ): Promise<void> {
    if (budgetMfen === undefined || budgetMfen < 0n) return;
    const marks: [BudgetAlert, boolean][] = [
      ['budget_80', totalMfen >= mulDivCeil(budgetMfen, ALERT_80_BP, BP)],
      ['budget_100', totalMfen >= budgetMfen],
    ];
    for (const [kind, reached] of marks) {
      if (!reached) continue;
      const now = deps.clock.now();
      const claimed =
        kind === 'budget_80'
          ? await q.query(sql<{ day: string }>`UPDATE app.agent_budget_days SET alert_80_at = ${now}
              WHERE day = ${day}::date AND alert_80_at IS NULL RETURNING day::text AS day`)
          : await q.query(sql<{
              day: string;
            }>`UPDATE app.agent_budget_days SET alert_100_at = ${now}
              WHERE day = ${day}::date AND alert_100_at IS NULL RETURNING day::text AS day`);
      if (claimed.length > 0) raiseBudgetAlert(deps, kind, { day });
    }
  }

  return {
    async reserve(q, reservation) {
      const day = accountingDate(reservation.acceptedAt);
      await q.query(sql`INSERT INTO app.agent_budget_days (day) VALUES (${day}::date)
        ON CONFLICT (day) DO NOTHING`);
      const row = (
        await q.query(sql<{ actual_mfen: unknown; reserved_mfen: unknown }>`SELECT actual_mfen,
          reserved_mfen FROM app.agent_budget_days WHERE day = ${day}::date FOR UPDATE`)
      )[0];
      if (row === undefined) throw new Error('agent budget: day row missing');
      const committed = addFen(toBigint(row.actual_mfen), toBigint(row.reserved_mfen));
      const reserve = reservation.reserveMfen;
      if (reserve <= 0n || committed >= reservation.budgetMfen) {
        await claimAlerts(q, day, committed, reservation.budgetMfen);
        return { exhausted: true };
      }
      await q.query(sql`UPDATE app.agent_budget_days SET reserved_mfen = reserved_mfen + ${reserve}
        WHERE day = ${day}::date`);
      await q.query(sql`INSERT INTO app.agent_budget_reservations
        (run_id, day, reserved_mfen, price_version)
        VALUES (${reservation.runId}::uuid, ${day}::date, ${reserve}, ${reservation.priceVersion})`);
      await claimAlerts(q, day, addFen(committed, reserve), reservation.budgetMfen);
      return { exhausted: false };
    },

    async settle(q, settlement) {
      const now = deps.clock.now();
      const taken = (
        await q.query(sql<{
          day: string;
          reserved_mfen: unknown;
          price_version: string | null;
        }>`UPDATE app.agent_budget_reservations SET settled_at = ${now}
          WHERE run_id = ${settlement.runId}::uuid AND settled_at IS NULL
          RETURNING day::text AS day, reserved_mfen, price_version`)
      )[0];
      if (taken === undefined) return { costMfen: null, priceVersion: null, settled: false };
      const reserved = toBigint(taken.reserved_mfen);
      const live = settlement.live;
      // Live normal finish: U (null cost without any call); any other finish: R in full.
      let costMfen: bigint | null;
      if (live === null) costMfen = reserved;
      else if (live.calls === 0 && live.spentMfen === 0n) costMfen = null;
      else costMfen = live.spentMfen < 0n ? 0n : live.spentMfen;
      if (costMfen !== null && costMfen > reserved) {
        // 细则: the premise failed (usage beyond the worst case); booked as is, not capped.
        deps.logger?.warn(
          {
            run_id: settlement.runId,
            cost_mfen: costMfen.toString(),
            reserved_mfen: reserved.toString(),
          },
          'agent.budget_over_reserve',
        );
      }
      const totals = (
        await q.query(sql<{ actual_mfen: unknown; reserved_mfen: unknown }>`UPDATE
          app.agent_budget_days SET reserved_mfen = reserved_mfen - ${reserved},
          actual_mfen = actual_mfen + ${costMfen ?? 0n}
          WHERE day = ${taken.day}::date RETURNING actual_mfen, reserved_mfen`)
      )[0];
      if (totals === undefined) throw new Error('agent budget: day row missing');
      await claimAlerts(
        q,
        taken.day,
        addFen(toBigint(totals.actual_mfen), toBigint(totals.reserved_mfen)),
        settlement.budgetMfen,
      );
      return { costMfen, priceVersion: taken.price_version, settled: true };
    },
  };
}

export function createDailyBudget(deps: DailyBudgetDeps): DailyBudget {
  const on = createDailyBudgetOn(deps);
  return {
    reserve: (q, reservation) => on.reserve(kyselyQueries(q), reservation),
    settle: (q, settlement) => on.settle(kyselyQueries(q), settlement),
  };
}
