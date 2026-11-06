// B2-04zw rule tests (D10-719 ③; db/AGENTS.md 迁移规则 3、11): shape of the two migrations behind
// settle_runs_part_outcome_check, located by content (numbers are taken at landing time).
//   - One migration adds the CHECK by name, NOT VALID, and does nothing else besides its timeouts.
//   - The very next migration only validates it (a fund table is not validated in the adding
//     transaction; precedent 0119 / 0120).
//   - Neither touches the columns or the primary key of app.settle_runs (第 27 项 RUN-KEY 暂缓).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { CHECK, TIMEOUT, body, close, migrations, open, ready, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const ADDS = new RegExp(`\\bADD CONSTRAINT ${CHECK}\\b`, 'i');
const VALIDATES = new RegExp(`\\bVALIDATE CONSTRAINT ${CHECK}\\b`, 'i');
const ADD_NOT_VALID = new RegExp(
  `^ALTER TABLE (?:ONLY )?app\\.settle_runs ADD CONSTRAINT ${CHECK} CHECK ?\\(.+\\) NOT VALID$`,
  'i',
);
const VALIDATE_ONLY = new RegExp(
  `^ALTER TABLE (?:ONLY )?app\\.settle_runs VALIDATE CONSTRAINT ${CHECK}$`,
  'i',
);
// What would change the columns or the key of the table.
const RESHAPES = [
  ['ADD COLUMN', /\bADD (?:COLUMN\b|(?!CONSTRAINT\b)\w+ \w+)/i],
  ['DROP', /\bDROP\b/i],
  ['ALTER COLUMN', /\bALTER COLUMN\b/i],
  ['RENAME', /\bRENAME\b/i],
  ['PRIMARY KEY', /\bPRIMARY KEY\b/i],
  ['UNIQUE', /\bUNIQUE\b/i],
] as const;

it(
  '[AC-B2-04zw#4][BR-FUND-04] 迁移形状：恰好一个迁移显式具名地 ADD CONSTRAINT settle_runs_part_outcome_check … NOT VALID 且不做别的；紧接的下一号迁移只 VALIDATE 它；两者都不改 settle_runs 的列与主键',
  async () => {
    await ready(h.app);
    const all = migrations();
    const adds = all.filter((m) => m.statements.some((s) => ADDS.test(s)));
    const validates = all.filter((m) => m.statements.some((s) => VALIDATES.test(s)));
    expect(
      adds.map((m) => m.name),
      `恰好一个迁移添加 ${CHECK}`,
    ).toHaveLength(1);
    expect(
      validates.map((m) => m.name),
      `恰好一个迁移 VALIDATE ${CHECK}`,
    ).toHaveLength(1);
    const add = adds[0]!;
    const validate = validates[0]!;

    // 先 NOT VALID：添加的迁移里只有这一条，不在同一事务里 VALIDATE。
    expect(body(add), add.name).toEqual([expect.stringMatching(ADD_NOT_VALID)]);
    const check = body(add)[0] ?? '';
    expect(check, '约束读 part').toMatch(/\bpart\b/i);
    expect(check, '约束读 last_outcome').toMatch(/\blast_outcome\b/i);
    // 后 VALIDATE：紧接的下一号迁移只做这一件事。
    expect(validate.number, `${validate.name} 是 ${add.name} 的下一号`).toBe(add.number + 1);
    expect(body(validate), validate.name).toEqual([expect.stringMatching(VALIDATE_ONLY)]);

    for (const migration of [add, validate]) {
      for (const statement of body(migration)) {
        for (const [label, pattern] of RESHAPES) {
          expect(statement, `${migration.name} 不 ${label}`).not.toMatch(pattern);
        }
      }
    }
    // 主键仍恰为 settle_run_id。
    const primary = await sql<{ keys: string[] }>`
      SELECT ARRAY(
        SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos
      ) AS keys
      FROM pg_constraint c
      WHERE c.conrelid = to_regclass('app.settle_runs') AND c.contype = 'p'
    `.execute(h.app);
    expect(primary.rows).toEqual([{ keys: ['settle_run_id'] }]);
  },
  TIMEOUT,
);
