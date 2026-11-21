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
import { runFieldsSql } from './finalize.ts';
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
  const statement = sql`SET intent = ${run.intent}, input_passed = ${run.inputPassed}, model = ${run.model}, model_snapshot = ${run.snapshot}`;
  return statement.compile(compiler);
}

it('[AC-B3-08t#4][AC-B3-08t#6] exit F5/live: nothing checked → intent NULL parameter, a run that used no model output clears model and snapshot', () => {
  const out = compiled({ intent: null, inputPassed: true, modelUsed: false });
  expect(out.sql).toBe('SET intent = $1, input_passed = $2, model = NULL, model_snapshot = NULL');
  expect(out.parameters).toEqual([null, true]);
});

it('[AC-B3-08t#1][AC-B3-08t#6] exit F5/live: the checked intent is written; a used model leaves model / snapshot to the trace writer', () => {
  const out = compiled({ intent: 'order_query', inputPassed: true, modelUsed: true });
  expect(out.sql).toBe(
    'SET intent = $1, input_passed = $2, model = model, model_snapshot = model_snapshot',
  );
  expect(out.parameters).toEqual(['order_query', true]);
});

it('[AC-B3-08t#6] exit F5/live: use not known yet (core trace not recorded) → no model is written, the snapshot kept only beside a recorded model', () => {
  const out = compiled({ intent: null, inputPassed: false, modelUsed: null });
  expect(out.sql).toBe(
    'SET intent = $1, input_passed = $2, model = model, model_snapshot = CASE WHEN model IS NULL THEN NULL ELSE model_snapshot END',
  );
  expect(out.parameters).toEqual([null, false]);
});

it('[AC-B3-08t#5][AC-B3-08t#6] exit F5/recovery: another request finalizes → intent / input_passed / model untouched, snapshot cleared without a model', () => {
  const out = compiled(undefined);
  expect(out.sql).toBe(
    'SET intent = intent, input_passed = input_passed, model = model, model_snapshot = CASE WHEN model IS NULL THEN NULL ELSE model_snapshot END',
  );
  expect(out.parameters).toEqual([]);
});
