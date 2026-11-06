// B2-04zfa rule tests (编排裁定 D10-492 ②): grants of app.settle_runs. settlement (couli_app) is
// the only writer: it reads, inserts a run and moves part / last_outcome / the start column /
// row_version / updated_at on publish (and, since B2-04zy, the watermark published_credited_count);
// the identity columns are never rewritten and rows are never deleted. No other role gets any
// privilege.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  IMMUTABLE,
  MUTABLE,
  ROLES,
  TIMEOUT,
  close,
  columnPrivilege,
  columns,
  insert,
  migrationSource,
  open,
  ready,
  run,
  sqlState,
  startColumn,
  startValue,
  stored,
  tablePrivilege,
  type Harness,
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

it('[AC-B2-04zfa#4] couli_app 表级只有 SELECT、INSERT；UPDATE 只在 part、last_outcome、起点列、row_version、updated_at 上，身份列不可改；不可删、不可清表', async () => {
  await ready(h.app);
  for (const privilege of TABLE_PRIVILEGES) {
    expect(await tablePrivilege(h.app, 'couli_app', privilege), privilege).toEqual([
      { granted: privilege === 'SELECT' || privilege === 'INSERT' },
    ]);
  }
  const start = await startColumn(h.app);
  const mutable: string[] = [...MUTABLE, start.name];
  for (const column of (await columns(h.app)).map((c) => c.name)) {
    for (const privilege of ['SELECT', 'INSERT']) {
      expect(
        await columnPrivilege(h.app, 'couli_app', column, privilege),
        `${column}/${privilege}`,
      ).toEqual([{ granted: true }]);
    }
    expect(await columnPrivilege(h.app, 'couli_app', column, 'UPDATE'), `${column}/UPDATE`).toEqual(
      [{ granted: mutable.includes(column) }],
    );
  }
  for (const column of IMMUTABLE) {
    expect(await columnPrivilege(h.app, 'couli_app', column, 'UPDATE'), column).toEqual([
      { granted: false },
    ]);
  }
});

it('[AC-B2-04zfa#4] 其他角色（couli_readonly、couli_payout、couli_maint）表级与逐列都没有任何权限', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  for (const role of ROLES.filter((r) => r !== 'couli_app')) {
    for (const privilege of TABLE_PRIVILEGES) {
      expect(await tablePrivilege(h.app, role, privilege), `${role}/${privilege}`).toEqual([
        { granted: false },
      ]);
    }
    for (const column of names) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        expect(
          await columnPrivilege(h.app, role, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toEqual([{ granted: false }]);
      }
    }
  }
});

it('[AC-B2-04zfa#4] couli_app 能插入并按发布推进 part / last_outcome / 起点 / row_version / updated_at；改身份列、删行、清表被拒绝；其他角色读写删都被拒绝，行不变', async () => {
  await ready(h.app);
  const start = await startColumn(h.app);
  const row = await run(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');

  // 一次发布（按 row_version 比较并更新，同时写入新水位）由 couli_app 完成。
  const later = startValue(start, 5);
  const published = await sql`
    UPDATE app.settle_runs
    SET part = part + 1, last_outcome = 'partial', ${sql.ref(start.name)} = ${later},
      row_version = row_version + 1, updated_at = ${new Date('2032-07-01T10:00:00+08:00')},
      published_credited_count = published_credited_count + 1
    WHERE settle_run_id = ${row['settle_run_id']} AND row_version = 0
  `.execute(h.app);
  expect(published.numAffectedRows).toBe(1n);
  const before = await stored(h.app, row['settle_run_id']);
  expect(before).toEqual([
    expect.objectContaining({
      part: 1,
      last_outcome: 'partial',
      row_version: 1,
      published_credited_count: 1,
    }),
  ]);

  for (const [column, value] of [
    ['settle_run_id', row['settle_run_id']],
    ['app_id', row['app_id']],
    ['bill_id', row['bill_id']],
  ] as const) {
    expect(
      await sqlState(
        sql`UPDATE app.settle_runs SET ${sql.ref(column)} = ${value}
          WHERE settle_run_id = ${row['settle_run_id']}`.execute(h.app),
      ),
      `couli_app/UPDATE ${column}`,
    ).toBe('42501');
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.settle_runs WHERE settle_run_id = ${row['settle_run_id']}`.execute(h.app),
    ),
    'couli_app/DELETE',
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE app.settle_runs`.execute(h.app)), 'couli_app/TRUNCATE').toBe(
    '42501',
  );

  for (const role of ROLES.filter((r) => r !== 'couli_app')) {
    const db = h.roles[role];
    expect(await sqlState(stored(db, row['settle_run_id'])), `${role}/SELECT`).toBe('42501');
    expect(await sqlState(insert(db, await run(h.app))), `${role}/INSERT`).toBe('42501');
    const update = sql`
      UPDATE app.settle_runs SET part = 9 WHERE settle_run_id = ${row['settle_run_id']}
    `;
    expect(await sqlState(update.execute(db)), `${role}/UPDATE`).toBe('42501');
    expect(
      await sqlState(
        sql`DELETE FROM app.settle_runs WHERE settle_run_id = ${row['settle_run_id']}`.execute(db),
      ),
      `${role}/DELETE`,
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE app.settle_runs`.execute(db)), `${role}/TRUNCATE`).toBe(
      '42501',
    );
  }
  expect(await stored(h.app, row['settle_run_id'])).toEqual(before);
});

it('[AC-B2-04zfa#4] 授权写在建表的同一个迁移里，只授给 couli_app，不授其他角色或 PUBLIC', async () => {
  await ready(h.app);
  const source = migrationSource();
  expect(source).toMatch(
    /GRANT\s+[^;]+\bON\s+(?:TABLE\s+)?[^;]*\bapp\.settle_runs\b[^;]*\bTO\s+couli_app\b/i,
  );
  const grants = source.match(/GRANT\s+[^;]+;/gi) ?? [];
  for (const statement of grants.filter((g) => /\bapp\.settle_runs\b/i.test(g))) {
    expect(statement, '只授 couli_app').not.toMatch(
      /\bTO\b[^;]*\b(couli_readonly|couli_payout|couli_maint|couli_migrator|PUBLIC)\b/i,
    );
  }
});
