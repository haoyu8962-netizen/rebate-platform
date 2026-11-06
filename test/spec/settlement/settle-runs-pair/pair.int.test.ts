// B2-04zw rule tests (D10-719 ③; 规划/08 BR-FUND-04 ⑦、BR-TEXT-09): app.settle_runs only holds
// (part = 0, last_outcome NULL) or (part ≥ 1, last_outcome 'done' / 'partial'). The CHECK
// settle_runs_part_outcome_check exists, is validated, and rejects every other pair on INSERT and on
// UPDATE with 23514, leaving the row as it was; legal pairs and a publish's moves between them pass.
import { createTestDatabase } from '@couli/db/testing';
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CHECK,
  ILLEGAL,
  LEGAL,
  TIMEOUT,
  close,
  insertPair,
  legal,
  open,
  pairCheck,
  pairOf,
  ready,
  requirePairCheck,
  updatePair,
  type Harness,
  type Outcome,
  type Pair,
} from './kit.ts';

// Each run is two round trips to the one-off database; PROP_RUNS still applies below this cap and
// PROP_SEED always applies.
const PAIR_RUNS = Math.min(propRuns(), 200);

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it(
  '[AC-B2-04zw#1][BR-FUND-04] app.settle_runs 上有 CHECK settle_runs_part_outcome_check，只读 part 与 last_outcome，且已生效（convalidated = true，迁移最终已 VALIDATE）',
  async () => {
    await ready(h.app);
    expect(await pairCheck(h.app), CHECK).toEqual([
      {
        schema: 'app',
        relation: 'settle_runs',
        kind: 'c',
        valid: true,
        columns: ['last_outcome', 'part'],
      },
    ]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zw#2][BR-FUND-04] 非法配对写不进去：插入 (0, done)、(0, partial)、(1, NULL)、(2, NULL) 报 23514 且没有行；把合法行改成这些配对同样报 23514，行不变',
  async () => {
    await ready(h.app);
    for (const pair of ILLEGAL) {
      const { row, state } = await insertPair(h.app, pair);
      expect(state, `INSERT ${JSON.stringify(pair)}`).toBe('23514');
      expect(await pairOf(h.app, row['settle_run_id'])).toEqual([]);
    }

    // 先插三种合法行，再逐个改成非法配对：都被拒绝，行保持原配对。
    const rows: { id: unknown; pair: Pair }[] = [];
    for (const pair of LEGAL) {
      const { row, state } = await insertPair(h.app, pair);
      expect(state, `INSERT ${JSON.stringify(pair)}`).toBe('ok');
      rows.push({ id: row['settle_run_id'], pair });
    }
    for (const { id, pair } of rows) {
      for (const target of ILLEGAL) {
        expect(
          await updatePair(h.app, id, target),
          `UPDATE ${JSON.stringify(pair)} → ${JSON.stringify(target)}`,
        ).toBe('23514');
        expect(await pairOf(h.app, id)).toEqual([pair]);
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zw#3][BR-FUND-04] 合法配对可写：插入 (0, NULL)、(1, done)、(2, partial) 读回原值；按发布推进 (0, NULL) → (1, partial) → (2, done) 每步成功',
  async () => {
    await ready(h.app);
    await requirePairCheck(h.app);
    for (const pair of LEGAL) {
      const { row, state } = await insertPair(h.app, pair);
      expect(state, `INSERT ${JSON.stringify(pair)}`).toBe('ok');
      expect(await pairOf(h.app, row['settle_run_id'])).toEqual([pair]);
    }

    const { row, state } = await insertPair(h.app, [0, null]);
    expect(state).toBe('ok');
    const id = row['settle_run_id'];
    for (const step of [
      [1, 'partial'],
      [2, 'done'],
    ] as const) {
      expect(await updatePair(h.app, id, step), `UPDATE → ${JSON.stringify(step)}`).toBe('ok');
      expect(await pairOf(h.app, id)).toEqual([step]);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zw#2][AC-B2-04zw#3][BR-FUND-04] 任意 part ≥ 0 与 last_outcome ∈ {NULL, done, partial}：插入成功当且仅当 part = 0 ⇔ last_outcome 为空，被拒的报 23514 且没有行',
  async () => {
    await ready(h.app);
    await requirePairCheck(h.app);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom<Outcome>(null, 'done', 'partial'),
        async (part, outcome) => {
          const pair = [part, outcome] as const;
          const { row, state } = await insertPair(h.app, pair);
          expect(state, JSON.stringify(pair)).toBe(legal(pair) ? 'ok' : '23514');
          expect(await pairOf(h.app, row['settle_run_id'])).toEqual(legal(pair) ? [pair] : []);
          return true;
        },
      ),
      { numRuns: PAIR_RUNS, seed: propSeed() },
    );
  },
  TIMEOUT,
);
