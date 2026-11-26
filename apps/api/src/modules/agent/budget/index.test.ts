// B3-09m · BR-AI-16: implementation unit tests of the daily budget's bookings over a scripted
// statement runner (the real SQL compiler; nothing connects to a database).
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
} from 'kysely';
import { expect, it, vi } from 'vitest';

import {
  budgetConfigAcrossApps,
  createDailyBudgetOn,
  type BudgetAlert,
  type BudgetQueries,
} from './index.ts';

const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** Answers each statement by the first matching pattern; records the compiled SQL. */
function runner(answers: readonly [RegExp, unknown[]][]): { q: BudgetQueries; sqls: string[] } {
  const sqls: string[] = [];
  return {
    sqls,
    q: {
      async query<T>(statement: RawBuilder<T>): Promise<T[]> {
        const text = statement.compile(compiler).sql.replace(/\s+/g, ' ');
        sqls.push(text);
        const found = answers.find(([pattern]) => pattern.test(text));
        return (found?.[1] ?? []) as T[];
      },
    },
  };
}

function budget() {
  const onAlert = vi.fn<(kind: BudgetAlert) => void>();
  const warn = vi.fn();
  const daily = createDailyBudgetOn({
    clock: { now: () => new Date('2026-10-06T12:00:00+08:00') },
    logger: { warn },
    onAlert,
  });
  return { daily, onAlert, warn };
}

it('[AC-B3-09m#u19] 别处收尾（live = null）按预占记满，并照样抢 80% / 100% 告警', async () => {
  const { daily, onAlert, warn } = budget();
  const { q, sqls } = runner([
    [
      /UPDATE app\.agent_budget_reservations/,
      [{ day: '2026-10-06', reserved_mfen: 5_000n, price_version: 'v1' }],
    ],
    [
      /UPDATE app\.agent_budget_days SET reserved_mfen/,
      [{ actual_mfen: 9_500n, reserved_mfen: 500n }],
    ],
    [/alert_80_at = /, [{ day: '2026-10-06' }]],
    [/alert_100_at = /, [{ day: '2026-10-06' }]],
  ]);
  expect(await daily.settle(q, { runId: 'run-1', live: null, budgetMfen: 10_000n })).toEqual({
    costMfen: 5_000n,
    priceVersion: 'v1',
    settled: true,
  });
  expect(onAlert.mock.calls.map(([kind]) => kind)).toEqual(['budget_80', 'budget_100']);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'agent.budget_100' }),
    'agent.budget_100',
  );
  expect(sqls.some((text) => text.includes('alert_80_at IS NULL'))).toBe(true);
});

it('[AC-B3-09m#u20] 已结清的 run 再收尾不动日账、不告警', async () => {
  const { daily, onAlert } = budget();
  const { q, sqls } = runner([]);
  expect(await daily.settle(q, { runId: 'run-1', live: null, budgetMfen: 1n })).toEqual({
    costMfen: null,
    priceVersion: null,
    settled: false,
  });
  expect(sqls).toHaveLength(1);
  expect(onAlert).not.toHaveBeenCalled();
});

it('[AC-B3-09m#u21] 没给预算时不判告警（尽力而为）', async () => {
  const { daily, onAlert } = budget();
  const { q, sqls } = runner([
    [
      /UPDATE app\.agent_budget_reservations/,
      [{ day: '2026-10-06', reserved_mfen: 5_000n, price_version: null }],
    ],
    [
      /UPDATE app\.agent_budget_days SET reserved_mfen/,
      [{ actual_mfen: 5_000n, reserved_mfen: 0n }],
    ],
  ]);
  await daily.settle(q, { runId: 'run-1', live: { spentMfen: 700n, calls: 2 } });
  expect(onAlert).not.toHaveBeenCalled();
  expect(sqls.some((text) => text.includes('alert_'))).toBe(false);
});

it('[AC-B3-09m#u22] 受理按上海自然日记账，预占为 0 时不预占', async () => {
  const { daily } = budget();
  const { q, sqls } = runner([[/FOR UPDATE/, [{ actual_mfen: 0n, reserved_mfen: 0n }]]]);
  const reservation = {
    runId: '00000000-0000-7000-8000-000000000001',
    acceptedAt: new Date('2026-10-06T23:59:50+08:00'),
    budgetMfen: 10_000n,
    priceVersion: 'v1',
  };
  expect(await daily.reserve(q, { ...reservation, reserveMfen: 0n })).toEqual({ exhausted: true });
  expect(sqls.some((text) => text.includes('INSERT INTO app.agent_budget_reservations'))).toBe(
    false,
  );
  expect(await daily.reserve(q, { ...reservation, reserveMfen: 5_000n })).toEqual({
    exhausted: false,
  });
  expect(sqls.some((text) => text.includes('INSERT INTO app.agent_budget_reservations'))).toBe(
    true,
  );
});

it('[AC-B3-09m#u23] 全平台取最小预算、最大预占；缺键或非法的 app 按默认值参与并报出', () => {
  expect(
    budgetConfigAcrossApps(
      [
        { appId: 'a', value: 120_000 },
        { appId: 'b', value: undefined },
        { appId: 'c', value: 12.5 },
      ],
      [
        { appId: 'a', value: 1_500 },
        { appId: 'b', value: undefined },
        { appId: 'c', value: '9000' },
      ],
    ),
  ).toEqual({
    budgetMfen: 100_000_000n,
    reserveMfen: 5_000n,
    invalid: ['daily_budget_fen', 'reserve_mfen_per_run'],
  });
  expect(budgetConfigAcrossApps([], [])).toEqual({
    budgetMfen: 100_000_000n,
    reserveMfen: 5_000n,
    invalid: [],
  });
});
