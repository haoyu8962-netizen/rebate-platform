import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  TABLES,
  candidate,
  harness,
  insert,
  manual,
  parents,
  prefill,
  ready,
  sqlState,
  voucher,
  type Table,
} from './kit.ts';

const h = harness(createTestDatabase);

// 批准、驳回与核销时要写的列；note、row_version 本单不规定。
const MUTABLE: Record<Table, string[]> = {
  admin_adjustments: [
    'amount_fen',
    'status',
    'reviewed_by',
    'reviewed_at',
    'reject_note',
    'voucher_id',
  ],
  bad_debt_writeoffs: ['status', 'approver_id', 'approved_at', 'voucher_id'],
};
// 发起时定下、之后不得改的列。
const IMMUTABLE: Record<Table, string[]> = {
  admin_adjustments: [
    'adjust_id',
    'app_id',
    'user_id',
    'direction',
    'reason_code',
    'refs',
    'contra_subject',
    'contra_platform',
    'reverses_adjust_id',
    'created_by',
    'created_at',
  ],
  bad_debt_writeoffs: [
    'id',
    'app_id',
    'account_id',
    'negative_since',
    'candidate_fen',
    'initiator_id',
    'created_at',
  ],
};
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

it.each(TABLES)(
  '[AC-B2-12a#24] %s：couli_app 只有 SELECT、INSERT 与所需列级 UPDATE，couli_readonly 只读',
  async (table) => {
    await ready(h.app);
    const identity =
      await sql`SELECT current_user, current_setting('is_superuser') AS superuser`.execute(h.app);
    expect(identity.rows).toEqual([{ current_user: 'couli_app', superuser: 'off' }]);
    for (const [role, granted] of [
      ['couli_app', ['SELECT', 'INSERT']],
      ['couli_readonly', ['SELECT']],
    ] as const) {
      for (const privilege of PRIVILEGES) {
        const result =
          await sql`SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS granted`.execute(
            h.app,
          );
        expect(result.rows, `${role} ${table}/${privilege}`).toEqual([
          { granted: (granted as readonly string[]).includes(privilege) },
        ]);
      }
    }
    for (const column of [...MUTABLE[table], ...IMMUTABLE[table]]) {
      const result =
        await sql`SELECT has_column_privilege('couli_app', ${`app.${table}`}, ${column}, 'UPDATE') AS granted`.execute(
          h.app,
        );
      expect(result.rows, `${table}.${column}`).toEqual([
        { granted: MUTABLE[table].includes(column) },
      ]);
    }
  },
);

it('[AC-B2-12a#25] couli_app 实际 DELETE、TRUNCATE 与改身份列被拒，数据保留', async () => {
  await ready(h.app);
  const p = await parents(h.app);
  await insert(h.app, 'admin_adjustments', manual(p, await voucher(h.app, p)));
  await insert(h.app, 'admin_adjustments', prefill(p));
  await insert(h.app, 'bad_debt_writeoffs', candidate(p));
  for (const table of TABLES) {
    const before =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(
        h.app,
      );
    expect(before.rows.length).toBeGreaterThan(0);
    for (const column of IMMUTABLE[table]) {
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(column)} = ${sql.ref(column)} WHERE app_id = ${p.appId}`.execute(
            h.app,
          ),
        ),
        `${table}.${column}`,
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(h.app),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe('42501');
    const after =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE app_id = ${p.appId}`.execute(
        h.app,
      );
    expect(after.rows).toEqual(before.rows);
  }
});
