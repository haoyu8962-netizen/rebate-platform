// B2-04zh rule tests (编排裁定 D10-538, D10-589; db/AGENTS.md 迁移规则 4): grants of
// app.union_receipts. settlement (couli_app) reads, inserts and writes only the three reversal
// columns; every other column is fixed once entered and rows are never deleted. couli_readonly
// only reads. No other role gets any privilege.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  REVERSAL,
  ROLES,
  SHAPE,
  TIMEOUT,
  close,
  columnPrivilege,
  columns,
  insert,
  migration,
  open,
  ready,
  receipt,
  remove,
  reversal,
  sqlState,
  stored,
  tablePrivilege,
  tenant,
  truncate,
  update,
  type Harness,
  type Role,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// MAINTAIN is PostgreSQL 17's table privilege for VACUUM / ANALYZE / REINDEX and the like.
const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
const TABLE_GRANTS: Record<Role, readonly string[]> = {
  couli_app: ['SELECT', 'INSERT'],
  couli_readonly: ['SELECT'],
  couli_payout: [],
  couli_maint: [],
};
const FIXED = Object.keys(SHAPE).filter((name) => !(REVERSAL as readonly string[]).includes(name));

async function expectGrants(role: Role): Promise<void> {
  const grants = TABLE_GRANTS[role];
  for (const privilege of TABLE_PRIVILEGES) {
    expect(await tablePrivilege(h.app, role, privilege), `${role}/${privilege}`).toEqual([
      { granted: grants.includes(privilege) },
    ]);
  }
  for (const { name } of await columns(h.app)) {
    for (const privilege of COLUMN_PRIVILEGES) {
      const reversible =
        role === 'couli_app' &&
        privilege === 'UPDATE' &&
        (REVERSAL as readonly string[]).includes(name);
      expect(
        await columnPrivilege(h.app, role, name, privilege),
        `${role}/${name}/${privilege}`,
      ).toEqual([{ granted: grants.includes(privilege) || reversible }]);
    }
  }
}

it('[AC-B2-04zh#17] couli_app 表级只有 SELECT、INSERT；列级 UPDATE 只在 reversed_at、reversed_by、reversal_voucher_id 上', async () => {
  await ready(h.app);
  await expectGrants('couli_app');
});

it('[AC-B2-04zh#18] couli_readonly 只有 SELECT；couli_payout、couli_maint 表级与逐列都没有任何权限', async () => {
  await ready(h.app);
  for (const role of ROLES.filter((r) => r !== 'couli_app')) await expectGrants(role);
});

it('[AC-B2-04zh#19] couli_app 能插入、能写红冲三列；UPDATE 其他任一列、DELETE、TRUNCATE 都以 42501 拒绝，行不变', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const row = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  expect(await sqlState(update(h.app, row['receipt_id'], await reversal(h.app, t)))).toBe('ok');
  const before = await stored(h.app, row['receipt_id']);
  expect(before).toHaveLength(1);

  expect(FIXED).toHaveLength(11);
  for (const column of FIXED) {
    expect(
      await sqlState(update(h.app, row['receipt_id'], { [column]: row[column] })),
      `couli_app/UPDATE ${column}`,
    ).toBe('42501');
  }
  // 红冲时顺手改金额也不行。
  expect(
    await sqlState(
      update(h.app, row['receipt_id'], { reversed_at: before[0]!['reversed_at'], amount_fen: 1n }),
    ),
    'couli_app/UPDATE 红冲列加金额',
  ).toBe('42501');
  expect(await sqlState(remove(h.app, row['receipt_id'])), 'couli_app/DELETE').toBe('42501');
  expect(await sqlState(truncate(h.app)), 'couli_app/TRUNCATE').toBe('42501');
  expect(await stored(h.app, row['receipt_id'])).toEqual(before);
});

it('[AC-B2-04zh#20] couli_readonly 读到同一行，写、删、清表都以 42501 拒绝；couli_payout、couli_maint 连读也被拒绝；行不变', async () => {
  await ready(h.app);
  const t = await tenant(h.app);
  const row = await receipt(h.app, t);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['receipt_id']);
  expect(before).toHaveLength(1);
  const full = await reversal(h.app, t);
  const changed = { amount_fen: 1n };

  expect(await stored(h.roles.couli_readonly, row['receipt_id'])).toEqual(before);
  for (const role of ROLES.filter((r) => r !== 'couli_app')) {
    const db = h.roles[role];
    if (role !== 'couli_readonly') {
      expect(await sqlState(stored(db, row['receipt_id'])), `${role}/SELECT`).toBe('42501');
    }
    expect(await sqlState(insert(db, await receipt(h.app, t))), `${role}/INSERT`).toBe('42501');
    expect(await sqlState(update(db, row['receipt_id'], full)), `${role}/reverse`).toBe('42501');
    expect(await sqlState(update(db, row['receipt_id'], changed)), `${role}/UPDATE`).toBe('42501');
    expect(await sqlState(remove(db, row['receipt_id'])), `${role}/DELETE`).toBe('42501');
    expect(await sqlState(truncate(db)), `${role}/TRUNCATE`).toBe('42501');
  }
  expect(await stored(h.app, row['receipt_id'])).toEqual(before);
});

it('[AC-B2-04zh#21] 授权写在建表的同一个迁移里：授给 couli_app 与 couli_readonly，不授其他角色或 PUBLIC，不带 WITH GRANT OPTION', async () => {
  await ready(h.app);
  const { source } = migration();
  expect(source).toMatch(
    /GRANT\s+[^;]+\bON\s+(?:TABLE\s+)?app\.union_receipts\b[^;]*\bTO\b[^;]*\bcouli_app\b/i,
  );
  expect(source).toMatch(
    /GRANT\s+[^;]*\bSELECT\b[^;]*\bON\s+(?:TABLE\s+)?app\.union_receipts\b[^;]*\bTO\b[^;]*\bcouli_readonly\b/i,
  );
  for (const statement of source.match(/GRANT\s+[^;]+;/gi) ?? []) {
    expect(statement, '只授 couli_app、couli_readonly').not.toMatch(
      /\bTO\b[^;]*\b(couli_payout|couli_maint|couli_migrator|PUBLIC)\b/i,
    );
    expect(statement, '不可转授').not.toMatch(/\bWITH\s+GRANT\s+OPTION\b/i);
  }
});
