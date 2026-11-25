// B3-08t (BR-AI-19 细则「运行级字段」) · exit point finalize.ts F5: the run-level columns of the
// terminal UPDATE (统一原则 D10-2368: 只落核对过的，没核对过就留空). Compiled only, no database.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import { expect, it } from 'vitest';
import { runCostSql, runFieldsSql, settlementOf } from './finalize.ts';
import type { LiveRunFields } from './types.ts';

const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

function compiled(fields: LiveRunFields | undefined) {
  const run = runFieldsSql(fields);
  const statement = sql`SET intent = ${run.intent}, input_passed = ${run.inputPassed}`;
  return statement.compile(compiler);
}

it('[AC-B3-08t#4] exit F5/live: nothing checked → intent NULL parameter, input_passed as reported', () => {
  const out = compiled({ intent: null, inputPassed: true });
  expect(out.sql).toBe('SET intent = $1, input_passed = $2');
  expect(out.parameters).toEqual([null, true]);
});

it('[AC-B3-08t#1] exit F5/live: the checked intent is written', () => {
  const out = compiled({ intent: 'order_query', inputPassed: false });
  expect(out.sql).toBe('SET intent = $1, input_passed = $2');
  expect(out.parameters).toEqual(['order_query', false]);
});

it('[AC-B3-08t#5] exit F5/recovery: another request finalizes → intent / input_passed untouched', () => {
  const out = compiled(undefined);
  expect(out.sql).toBe('SET intent = intent, input_passed = input_passed');
  expect(out.parameters).toEqual([]);
});

it('[AC-B3-08t#5] exit F5: the run-level columns never include model or model_snapshot', () => {
  expect(Object.keys(runFieldsSql(undefined)).sort()).toEqual(['inputPassed', 'intent']);
  expect(Object.keys(runFieldsSql({ intent: null, inputPassed: true })).sort()).toEqual([
    'inputPassed',
    'intent',
  ]);
});

it('[AC-B3-09m#u16] 别处收尾（无活进程明细）按预占记满，并带上登记的预算去抢告警', () => {
  expect(settlementOf('run-1', undefined, 5_000n)).toEqual({
    runId: 'run-1',
    live: null,
    budgetMfen: 5_000n,
  });
  expect(settlementOf('run-1', undefined, undefined)).toEqual({ runId: 'run-1', live: null });
});

it('[AC-B3-09m#u17] 活进程收尾带 U、调用次数和当时的预算', () => {
  expect(settlementOf('run-1', { spentMfen: 700n, calls: 2, budgetMfen: 9n }, 5_000n)).toEqual({
    runId: 'run-1',
    live: { spentMfen: 700n, calls: 2 },
    budgetMfen: 9n,
  });
});

it('[AC-B3-09m#u18] 结清且有成本才写 cost_mfen / price_version，否则两列不动', () => {
  const write = runCostSql({ costMfen: 700n, priceVersion: 'synthetic-v1', settled: true });
  const out = sql`SET cost_mfen = ${write.costMfen}, price_version = ${write.priceVersion}`.compile(
    compiler,
  );
  expect(out.parameters).toEqual([700n, 'synthetic-v1']);
  for (const settled of [
    { costMfen: null, priceVersion: 'synthetic-v1', settled: true },
    { costMfen: null, priceVersion: null, settled: false },
  ]) {
    const keep = runCostSql(settled);
    expect(
      sql`SET cost_mfen = ${keep.costMfen}, price_version = ${keep.priceVersion}`.compile(compiler)
        .sql,
    ).toBe('SET cost_mfen = cost_mfen, price_version = price_version');
  }
});
